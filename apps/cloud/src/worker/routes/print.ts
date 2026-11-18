import {
  exampleValues,
  type LabelSource,
  type LabelTemplate,
  type LabelValues,
  renderLabelPdf,
} from "@fleet/labels";
import { type Context, Hono } from "hono";
import { ulid } from "ulidx";
import { z } from "zod";
import type {
  LabelTemplatesResponse,
  LabelValuesResponse,
  PrintAdminStatus,
  PrintBatchResponse,
  PrintJobRow,
  PrintPrintersResponse,
} from "../../api-types.ts";
import { audit, requireRole } from "../auth.ts";
import type { AppEnv } from "../env.ts";
import {
  defaultTemplateKey,
  labelSourceSchema,
  labelTemplateSchema,
  listTemplates,
  loadTemplate,
  resolveTemplate,
} from "../labelTemplates.ts";
import {
  getSetting,
  jobLabelValues,
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
import { loadJobDetail } from "./jobs.ts";
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
  const [rows, labelPrinter, partLabel] = await Promise.all([
    db
      .prepare("SELECT * FROM print_printers WHERE removed_at IS NULL ORDER BY computer_name, name")
      .all<PrinterRow>(),
    getSetting(db, LABEL_PRINTER_KEY),
    resolveTemplate(db, undefined, "part"),
  ]);
  const size = partLabel?.template ?? { widthMm: 57, heightMm: 32 };
  const body: PrintPrintersResponse = {
    configured: Boolean(c.env.PRINTNODE_API_KEY),
    labelPrinterId: labelPrinter ? Number(labelPrinter) : null,
    labelSizeMm: { width: size.widthMm, height: size.heightMm },
    printers: rows.results.map((r) => toPrinter(r, size)),
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

// --- Label templates -------------------------------------------------------------------------------

print.get("/templates", async (c) => {
  const body: LabelTemplatesResponse = { templates: await listTemplates(c.env.DB) };
  return c.json(body);
});

print.get("/templates/:id", async (c) => {
  const row = await loadTemplate(c.env.DB, c.req.param("id"));
  return row ? c.json(row) : c.json({ error: "Template not found" }, 404);
});

const templateName = z.string().trim().min(1).max(80);

print.post("/templates", requireRole("admin"), async (c) => {
  const parsed = z
    .object({ name: templateName, source: labelSourceSchema, template: labelTemplateSchema })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid template" }, 400);
  const { name, source, template } = parsed.data;
  const id = ulid();
  const now = Date.now();
  const email = c.get("user").email;
  await c.env.DB.prepare(
    `INSERT INTO label_templates (id, name, source, width_mm, height_mm, elements, created_by, created_at,
       updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      name,
      source,
      template.widthMm,
      template.heightMm,
      JSON.stringify(template.elements),
      email,
      now,
      email,
      now,
    )
    .run();
  await audit(c, "print.template.create", "label_template", id, { name, source });
  return c.json(await loadTemplate(c.env.DB, id), 201);
});

print.put("/templates/:id", requireRole("admin"), async (c) => {
  const parsed = z
    .object({ name: templateName, template: labelTemplateSchema, version: z.number().int() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid template" }, 400);
  const id = c.req.param("id");
  if (id.startsWith("builtin:"))
    return c.json({ error: "Built-in templates can't be changed; copy one instead" }, 400);
  const { name, template, version } = parsed.data;
  const res = await c.env.DB.prepare(
    `UPDATE label_templates SET name = ?, width_mm = ?, height_mm = ?, elements = ?, version = version + 1,
       updated_by = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND version = ?`,
  )
    .bind(
      name,
      template.widthMm,
      template.heightMm,
      JSON.stringify(template.elements),
      c.get("user").email,
      Date.now(),
      id,
      version,
    )
    .run();
  if (res.meta.changes === 0) {
    const current = await loadTemplate(c.env.DB, id);
    return current
      ? c.json(
          {
            error: `${current.updatedBy} saved this template after you opened it. Reload to see their changes.`,
          },
          409,
        )
      : c.json({ error: "Template not found" }, 404);
  }
  await audit(c, "print.template.update", "label_template", id, { name, version: version + 1 });
  return c.json(await loadTemplate(c.env.DB, id));
});

print.delete("/templates/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const row = await loadTemplate(c.env.DB, id);
  if (!row) return c.json({ error: "Template not found" }, 404);
  if (row.builtIn) return c.json({ error: "Built-in templates can't be deleted" }, 400);
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE label_templates SET deleted_at = ? WHERE id = ?").bind(Date.now(), id),
    db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").bind(defaultTemplateKey(row.source), id),
  ]);
  await audit(c, "print.template.delete", "label_template", id, { name: row.name });
  return c.json({ ok: true });
});

/** Make a template the one its kind prints by default. */
print.put("/templates/:id/default", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const row = await loadTemplate(c.env.DB, id);
  if (!row) return c.json({ error: "Template not found" }, 404);
  await setSetting(c.env.DB, defaultTemplateKey(row.source), row.builtIn ? null : id).run();
  await audit(c, "print.template.default", "label_template", id, { source: row.source });
  return c.json({ ok: true });
});

// --- Labels and jobs -------------------------------------------------------------------------------

const labelSchema = z.object({
  /** part-label and job-label fill a template from a part or job; test-label uses example values. */
  kind: z.enum(["part-label", "job-label", "test-label"]),
  partId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  /** Quantity shown on the label ("50 pcs"); left off when empty (job labels show the job's pieces). */
  qty: z.number().int().min(1).max(1_000_000).nullable().optional(),
  /** A saved or built-in template; the kind's default when left out. */
  templateId: z.string().min(1).max(40).optional(),
  /** An unsaved template from the editor, printed or previewed as it is. */
  template: labelTemplateSchema.optional(),
  /** For a test label without a templateId: which kind's example values to use. */
  source: labelSourceSchema.optional(),
});

type LabelRequest = z.infer<typeof labelSchema>;

interface BuiltLabel {
  template: LabelTemplate;
  templateId: string;
  values: LabelValues;
  title: string;
  entity: LabelSource | null;
  entityId: string | null;
}

const kindSource = (kind: LabelRequest["kind"]): LabelSource | null =>
  kind === "part-label" ? "part" : kind === "job-label" ? "job" : null;

const valueOptions = (c: Context<AppEnv>, qty: number | null) => ({
  qty,
  now: Date.now(),
  origin: new URL(c.req.url).origin,
  timeZone: c.env.TIME_ZONE || "Europe/Copenhagen",
});

/** Placeholder values of one part or job, or why there are none. */
async function entityValues(
  c: Context<AppEnv>,
  source: LabelSource,
  id: string | undefined,
  qty: number | null,
): Promise<{ values: LabelValues; title: string; entityId: string } | { error: string; status: 400 | 404 }> {
  if (!id) return { error: source === "part" ? "partId required" : "jobId required", status: 400 };
  if (source === "part") {
    const detail = await loadPartDetail(c.env.DB, id);
    if (!detail || "mergedInto" in detail) return { error: "Part not found", status: 404 };
    const values = partLabelValues(detail, valueOptions(c, qty));
    return { values, title: `Label ${values["part.number"]}`, entityId: detail.part.id };
  }
  const job = await loadJobDetail(c.env.DB, id);
  if (!job) return { error: "Job not found", status: 404 };
  return { values: jobLabelValues(job, valueOptions(c, qty)), title: `Label ${job.name}`, entityId: job.id };
}

/** The template and values for a request, or why the label can't be made. */
async function buildLabel(
  c: Context<AppEnv>,
  req: LabelRequest,
): Promise<BuiltLabel | { error: string; status: 400 | 404 }> {
  const wanted = kindSource(req.kind);
  let template: LabelTemplate;
  let templateId: string;
  let source: LabelSource;
  if (req.template) {
    template = req.template;
    templateId = "draft";
    source = wanted ?? req.source ?? "part";
  } else {
    const row = await resolveTemplate(c.env.DB, req.templateId, wanted ?? req.source ?? "part");
    if (!row) return { error: "Template not found", status: 404 };
    if (wanted && row.source !== wanted)
      return { error: `“${row.name}” is a ${row.source} label; choose a ${wanted} label`, status: 400 };
    template = row.template;
    templateId = row.id;
    source = row.source;
  }
  if (req.kind === "test-label")
    return {
      template,
      templateId,
      values: exampleValues(source),
      title: "Test label",
      entity: null,
      entityId: null,
    };
  const filled = await entityValues(c, source, source === "part" ? req.partId : req.jobId, req.qty ?? null);
  if ("error" in filled) return filled;
  return {
    template,
    templateId,
    values: filled.values,
    title: filled.title,
    entity: source,
    entityId: filled.entityId,
  };
}

/** A part's or job's placeholder values, for the editor's canvas. */
print.get("/values", async (c) => {
  const source = labelSourceSchema.safeParse(c.req.query("source"));
  if (!source.success) return c.json({ error: "source must be part or job" }, 400);
  const filled = await entityValues(c, source.data, c.req.query("id"), null);
  if ("error" in filled) return c.json({ error: filled.error }, filled.status);
  const body: LabelValuesResponse = { title: filled.title, values: filled.values };
  return c.json(body);
});

async function previewResponse(c: Context<AppEnv>, input: unknown) {
  const parsed = labelSchema.safeParse(input);
  if (!parsed.success) return c.json({ error: "Invalid label request" }, 400);
  const label = await buildLabel(c, parsed.data);
  if ("error" in label) return c.json({ error: label.error }, label.status);
  const pdf = await renderLabelPdf(label.template, label.values);
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": "inline; filename=label.pdf",
      "cache-control": "no-store",
    },
  });
}

/** The label as a PDF, exactly as it would print. */
print.get("/preview", (c) => {
  const q = (name: string) => c.req.query(name) || undefined;
  return previewResponse(c, {
    kind: q("kind"),
    partId: q("partId"),
    jobId: q("jobId"),
    templateId: q("templateId"),
    source: q("source"),
    qty: q("qty") ? Number(q("qty")) : null,
  });
});

/** The same for an unsaved template from the editor. */
print.post("/preview", async (c) => previewResponse(c, await c.req.json().catch(() => null)));

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

const printerAndCopies = {
  printerId: z.number().int().optional(),
  copies: z.number().int().min(1).max(50).default(1),
};

/** The printer asked for, else the default label printer. */
async function choosePrinter(db: D1Database, printerId: number | undefined): Promise<PrinterRow | null> {
  const id = printerId ?? Number((await getSetting(db, LABEL_PRINTER_KEY)) ?? Number.NaN);
  return Number.isFinite(id) ? loadPrinter(db, id) : null;
}

const NO_PRINTER = "Choose a printer first (Admin → Printing sets the default).";

print.post("/jobs", requireRole("operator"), async (c) => {
  const parsed = labelSchema.extend(printerAndCopies).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid print request" }, 400);
  const client = printNodeFor(c.env);
  if (!client) return c.json({ error: NOT_CONFIGURED }, 409);
  const printer = await choosePrinter(c.env.DB, parsed.data.printerId);
  if (!printer) return c.json({ error: NO_PRINTER }, 400);

  const label = await buildLabel(c, parsed.data);
  if ("error" in label) return c.json({ error: label.error }, label.status);
  const job = await submitPrint(c.env, client, {
    printer,
    template: label.templateId,
    title: label.title,
    label: label.template,
    values: label.values,
    copies: parsed.data.copies,
    entity: label.entity,
    entityId: label.entityId,
    requestedBy: c.get("user").email,
  });
  await audit(c, "print.label", "print_job", job.id, {
    kind: parsed.data.kind,
    template: label.templateId,
    entity: label.entity,
    entityId: label.entityId,
    qty: parsed.data.qty ?? null,
    copies: job.copies,
    printerId: printer.id,
    state: job.state,
  });
  return job.state === "failed" ? c.json({ error: job.message, job }, 502) : c.json(job, 201);
});

/** One job label for each of several jobs, e.g. a selection in History. */
print.post("/batch", requireRole("operator"), async (c) => {
  const parsed = z
    .object({
      jobIds: z.array(z.string().min(1)).min(1).max(50),
      templateId: z.string().min(1).max(40).optional(),
      qty: z.number().int().min(1).max(1_000_000).nullable().optional(),
      ...printerAndCopies,
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose between 1 and 50 jobs" }, 400);
  const client = printNodeFor(c.env);
  if (!client) return c.json({ error: NOT_CONFIGURED }, 409);
  const printer = await choosePrinter(c.env.DB, parsed.data.printerId);
  if (!printer) return c.json({ error: NO_PRINTER }, 400);

  // Check the template and every job before printing any, so a bad request prints nothing.
  const labels: BuiltLabel[] = [];
  for (const jobId of new Set(parsed.data.jobIds)) {
    const label = await buildLabel(c, {
      kind: "job-label",
      jobId,
      templateId: parsed.data.templateId,
      qty: parsed.data.qty,
    });
    if ("error" in label) return c.json({ error: label.error }, label.status);
    labels.push(label);
  }
  const printed: PrintJobRow[] = [];
  for (const label of labels)
    printed.push(
      await submitPrint(c.env, client, {
        printer,
        template: label.templateId,
        title: label.title,
        label: label.template,
        values: label.values,
        copies: parsed.data.copies,
        entity: label.entity,
        entityId: label.entityId,
        requestedBy: c.get("user").email,
      }),
    );
  await audit(c, "print.label.batch", "print_job", printed[0]?.id ?? "", {
    template: labels[0]?.templateId,
    jobs: labels.map((l) => l.entityId),
    copies: parsed.data.copies,
    printerId: printer.id,
    failed: printed.filter((j) => j.state === "failed").length,
  });
  const body: PrintBatchResponse = { jobs: printed };
  return c.json(body, 201);
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
