import { EXAMPLE_PART_VALUES, type LabelValues, PART_LABEL, renderLabelPdf } from "@fleet/labels";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { PrintAdminStatus, PrintPrintersResponse } from "../../api-types.ts";
import { audit, requireRole } from "../auth.ts";
import type { AppEnv } from "../env.ts";
import {
  getSetting,
  LABEL_PRINTER_KEY,
  loadPrinter,
  PRINT_JOB_SELECT,
  type PrinterRow,
  type PrintJobDbRow,
  partLabelValues,
  setSetting,
  submitPrint,
  syncPrinters,
  toPrinter,
  toPrintJob,
  WEBHOOK_ID_KEY,
  WEBHOOK_TOKEN_KEY,
} from "../printing.ts";
import { PrintNodeError, printNodeFor } from "../printnode.ts";
import { intParam } from "../util.ts";
import { loadPartDetail } from "./parts.ts";

/**
 * Printing labels through PrintNode. Everyone sees printers and print history; operators print;
 * admins connect PrintNode, name printers and choose the label printer.
 */
export const print = new Hono<AppEnv>();

const NOT_CONFIGURED = "PrintNode isn't set up: add the PRINTNODE_API_KEY secret to the Worker.";

function printNodeError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof PrintNodeError) return c.json({ error: err.message }, 502);
  throw err;
}

// --- Printers --------------------------------------------------------------------------------------

print.get("/printers", async (c) => {
  const db = c.env.DB;
  const [rows, labelPrinter] = await Promise.all([
    db
      .prepare("SELECT * FROM print_printers WHERE removed_at IS NULL ORDER BY computer_name, name")
      .all<PrinterRow>(),
    getSetting(db, LABEL_PRINTER_KEY),
  ]);
  const body: PrintPrintersResponse = {
    configured: Boolean(c.env.PRINTNODE_API_KEY),
    labelPrinterId: labelPrinter ? Number(labelPrinter) : null,
    labelSizeMm: { width: PART_LABEL.widthMm, height: PART_LABEL.heightMm },
    printers: rows.results.map(toPrinter),
  };
  return c.json(body);
});

print.post("/printers/sync", requireRole("admin"), async (c) => {
  const client = printNodeFor(c.env);
  if (!client) return c.json({ error: NOT_CONFIGURED }, 409);
  try {
    return c.json({ printers: await syncPrinters(c.env, client) });
  } catch (err) {
    return printNodeError(c, err);
  }
});

const printerPatch = z.object({
  alias: z.string().trim().max(100).nullable().optional(),
  paper: z.string().max(200).nullable().optional(),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  format: z.enum(["pdf", "zpl"]).nullable().optional(),
  offsetMm: z.object({ x: z.number().min(-15).max(15), y: z.number().min(-15).max(15) }).optional(),
});

print.patch("/printers/:id", requireRole("admin"), async (c) => {
  const parsed = printerPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid printer settings" }, 400);
  const { alias, paper, rotate, format, offsetMm } = parsed.data;
  const id = Number(c.req.param("id"));
  const res = await c.env.DB.prepare(
    `UPDATE print_printers SET alias = CASE WHEN ? THEN ? ELSE alias END,
       paper = CASE WHEN ? THEN ? ELSE paper END, rotate = COALESCE(?, rotate),
       format = CASE WHEN ? THEN ? ELSE format END,
       offset_x_mm = COALESCE(?, offset_x_mm), offset_y_mm = COALESCE(?, offset_y_mm)
     WHERE id = ?`,
  )
    .bind(
      alias !== undefined ? 1 : 0,
      alias || null,
      paper !== undefined ? 1 : 0,
      paper || null,
      rotate ?? null,
      format !== undefined ? 1 : 0,
      format ?? null,
      offsetMm?.x ?? null,
      offsetMm?.y ?? null,
      id,
    )
    .run();
  if (res.meta.changes === 0) return c.json({ error: "Printer not found" }, 404);
  await audit(c, "print.printer.update", "print_printer", String(id), parsed.data);
  return c.json({ ok: true });
});

print.put("/label-printer", requireRole("admin"), async (c) => {
  const parsed = z
    .object({ printerId: z.number().int().nullable() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "printerId required" }, 400);
  const { printerId } = parsed.data;
  if (printerId !== null && !(await loadPrinter(c.env.DB, printerId)))
    return c.json({ error: "Printer not found" }, 404);
  await setSetting(c.env.DB, LABEL_PRINTER_KEY, printerId === null ? null : String(printerId)).run();
  await audit(c, "print.label-printer", "settings", LABEL_PRINTER_KEY, { printerId });
  return c.json({ ok: true });
});

// --- Labels and jobs -------------------------------------------------------------------------------

const labelSchema = z.object({
  /** part-label prints a part's label; test-label prints the same layout with example values. */
  kind: z.enum(["part-label", "test-label"]),
  partId: z.string().min(1).optional(),
  /** Quantity shown on the label ("50 pcs"); left off when empty. */
  qty: z.number().int().min(1).max(1_000_000).nullable().optional(),
});

type LabelRequest = z.infer<typeof labelSchema>;

/** Fill the part label for a request, or say why it can't be made. */
async function buildLabel(
  c: Context<AppEnv>,
  req: LabelRequest,
): Promise<
  { values: LabelValues; title: string; entityId: string | null } | { error: string; status: 400 | 404 }
> {
  if (req.kind === "test-label") return { values: EXAMPLE_PART_VALUES, title: "Test label", entityId: null };
  if (!req.partId) return { error: "partId required", status: 400 };
  const detail = await loadPartDetail(c.env.DB, req.partId);
  if (!detail || "mergedInto" in detail) return { error: "Part not found", status: 404 };
  const values = partLabelValues(detail, {
    qty: req.qty ?? null,
    now: Date.now(),
    origin: new URL(c.req.url).origin,
    timeZone: c.env.TIME_ZONE || "Europe/Copenhagen",
  });
  return { values, title: `Label ${values["part.number"]}`, entityId: detail.part.id };
}

/** The label as a PDF, exactly as it would print. */
print.get("/preview", async (c) => {
  const parsed = labelSchema.safeParse({
    kind: c.req.query("kind"),
    partId: c.req.query("partId"),
    qty: c.req.query("qty") ? Number(c.req.query("qty")) : null,
  });
  if (!parsed.success) return c.json({ error: "Invalid label request" }, 400);
  const label = await buildLabel(c, parsed.data);
  if ("error" in label) return c.json({ error: label.error }, label.status);
  const pdf = await renderLabelPdf(PART_LABEL, label.values);
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": "inline; filename=label.pdf",
      "cache-control": "no-store",
    },
  });
});

print.get("/jobs", async (c) => {
  const entity = c.req.query("entity");
  const entityId = c.req.query("entityId");
  const limit = intParam(c.req.query("limit"), 20, 1, 200);
  const rows =
    entity && entityId
      ? await c.env.DB.prepare(
          `${PRINT_JOB_SELECT} WHERE j.entity = ? AND j.entity_id = ? ORDER BY j.created_at DESC LIMIT ?`,
        )
          .bind(entity, entityId, limit)
          .all<PrintJobDbRow>()
      : await c.env.DB.prepare(`${PRINT_JOB_SELECT} ORDER BY j.created_at DESC LIMIT ?`)
          .bind(limit)
          .all<PrintJobDbRow>();
  return c.json(rows.results.map(toPrintJob));
});

print.post("/jobs", requireRole("operator"), async (c) => {
  const parsed = labelSchema
    .extend({
      printerId: z.number().int().optional(),
      copies: z.number().int().min(1).max(50).default(1),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid print request" }, 400);
  const client = printNodeFor(c.env);
  if (!client) return c.json({ error: NOT_CONFIGURED }, 409);

  const db = c.env.DB;
  const printerId = parsed.data.printerId ?? Number((await getSetting(db, LABEL_PRINTER_KEY)) ?? Number.NaN);
  const printer = Number.isFinite(printerId) ? await loadPrinter(db, printerId) : null;
  if (!printer) return c.json({ error: "Choose a printer first (Admin → Printing sets the default)." }, 400);

  const label = await buildLabel(c, parsed.data);
  if ("error" in label) return c.json({ error: label.error }, label.status);
  const job = await submitPrint(c.env, client, {
    printer,
    template: parsed.data.kind,
    title: label.title,
    label: PART_LABEL,
    values: label.values,
    copies: parsed.data.copies,
    entity: label.entityId ? "part" : null,
    entityId: label.entityId,
    requestedBy: c.get("user").email,
  });
  await audit(c, "print.label", "print_job", job.id, {
    kind: parsed.data.kind,
    partId: label.entityId,
    qty: parsed.data.qty ?? null,
    copies: job.copies,
    printerId: printer.id,
    state: job.state,
  });
  return job.state === "failed" ? c.json({ error: job.message, job }, 502) : c.json(job, 201);
});

// --- PrintNode account and webhook (admin) ---------------------------------------------------------

print.get("/admin", requireRole("admin"), async (c) => {
  const db = c.env.DB;
  const client = printNodeFor(c.env);
  const [token, webhookId] = await Promise.all([
    getSetting(db, WEBHOOK_TOKEN_KEY),
    getSetting(db, WEBHOOK_ID_KEY),
  ]);
  const body: PrintAdminStatus = {
    configured: Boolean(client),
    account: null,
    accountError: null,
    webhook: {
      url: token ? webhookUrl(c, token) : null,
      secret: token,
      id: webhookId ? Number(webhookId) : null,
      counts: null,
    },
  };
  if (!client) return c.json(body);
  try {
    const [account, hooks] = await Promise.all([client.whoami(), client.webhooks()]);
    body.account = {
      email: account.email,
      credits: account.credits ?? null,
      computers: account.numComputers ?? null,
      totalPrints: account.totalPrints ?? null,
    };
    const hook = hooks.find((h) => h.webhookId === body.webhook.id || (token && h.url.endsWith(token)));
    if (hook) {
      body.webhook.id = hook.webhookId;
      body.webhook.counts = hook.counts
        ? {
            received: hook.counts.receivedEvents,
            successful: hook.counts.successfulRequests,
            failed: hook.counts.failedRequests,
            dropped: hook.counts.droppedEvents,
          }
        : null;
    }
  } catch (err) {
    body.accountError = err instanceof PrintNodeError ? err.message : "PrintNode didn't answer";
  }
  return c.json(body);
});

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const webhookUrl = (c: Context<AppEnv>, token: string) =>
  `${new URL(c.req.url).origin}/webhooks/printnode/${token}`;

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Create a new webhook URL and secret, and register them with PrintNode, replacing the webhook made
 * before. The URL is kept even when registering fails, so it can be entered in PrintNode by hand.
 */
print.post("/webhook", requireRole("admin"), async (c) => {
  const client = printNodeFor(c.env);
  if (!client) return c.json({ error: NOT_CONFIGURED }, 409);
  if (LOCAL_HOSTS.has(new URL(c.req.url).hostname))
    return c.json(
      { error: "PrintNode can't reach localhost. Set up the webhook from the deployed dashboard." },
      400,
    );

  const db = c.env.DB;
  const token = newToken();
  const url = webhookUrl(c, token);
  const previous = await getSetting(db, WEBHOOK_ID_KEY);
  await db.batch([setSetting(db, WEBHOOK_TOKEN_KEY, token), setSetting(db, WEBHOOK_ID_KEY, null)]);
  await audit(c, "print.webhook.create", "settings", WEBHOOK_TOKEN_KEY);

  try {
    if (previous) await client.deleteWebhook(Number(previous)).catch(() => undefined);
    const created = await client.createWebhook(url, token);
    const id = created[0]?.webhookId;
    if (id !== undefined) await setSetting(db, WEBHOOK_ID_KEY, String(id)).run();
    return c.json({ url, secret: token, id: id ?? null });
  } catch (err) {
    const message = err instanceof PrintNodeError ? err.message : "PrintNode didn't answer";
    return c.json({ url, secret: token, id: null, error: `Registering failed: ${message}` }, 502);
  }
});
