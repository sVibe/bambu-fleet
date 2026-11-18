import { Hono } from "hono";
import { z } from "zod";
import type { AutoLabelResponse } from "../../api-types.ts";
import { audit, requireRole } from "../auth.ts";
import { type AutoLabelDbRow, listRuns, loadRun, printRun, toAutoLabelSettings } from "../autoLabels.ts";
import type { AppEnv } from "../env.ts";
import { loadTemplate } from "../labelTemplates.ts";
import { loadPrinter } from "../printing.ts";

/** Automatic job labels per part, under /api/print/auto. Everyone sees them; operators change them. */
export const autoLabels = new Hono<AppEnv>();

const MAX_THRESHOLD = 100_000;

async function livePart(db: D1Database, id: string) {
  return db.prepare("SELECT id FROM parts WHERE id = ? AND merged_into IS NULL").bind(id).first();
}

autoLabels.get("/parts/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  if (!(await livePart(db, id))) return c.json({ error: "Part not found" }, 404);
  const [row, runs] = await Promise.all([
    db.prepare("SELECT * FROM part_auto_labels WHERE part_id = ?").bind(id).first<AutoLabelDbRow>(),
    listRuns(db, id),
  ]);
  const body: AutoLabelResponse = { settings: row ? toAutoLabelSettings(row) : null, runs };
  return c.json(body);
});

const settingsSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(1).max(MAX_THRESHOLD),
  templateId: z.string().min(1).max(40).nullable(),
  printerId: z.number().int().nullable(),
  /** Correct the count towards the next label, e.g. after scrapping pieces; left as it is when omitted. */
  tally: z.number().int().min(0).max(MAX_THRESHOLD).optional(),
});

autoLabels.put("/parts/:id", requireRole("operator"), async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid automatic label settings" }, 400);
  const { enabled, threshold, templateId, printerId, tally } = parsed.data;
  const db = c.env.DB;
  const id = c.req.param("id");
  if (!(await livePart(db, id))) return c.json({ error: "Part not found" }, 404);
  if (tally !== undefined && tally >= threshold)
    return c.json({ error: `The count must be below the threshold of ${threshold}` }, 400);
  if (templateId) {
    const template = await loadTemplate(db, templateId);
    if (!template) return c.json({ error: "Template not found" }, 404);
    if (template.source !== "job")
      return c.json({ error: `“${template.name}” is a part label; choose a job label` }, 400);
  }
  if (printerId !== null && !(await loadPrinter(db, printerId)))
    return c.json({ error: "Printer not found" }, 404);

  await db
    .prepare(
      `INSERT INTO part_auto_labels (part_id, enabled, threshold, tally, template_id, printer_id, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(part_id) DO UPDATE SET enabled = excluded.enabled, threshold = excluded.threshold,
         tally = CASE WHEN ? THEN excluded.tally ELSE tally END, template_id = excluded.template_id,
         printer_id = excluded.printer_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      enabled ? 1 : 0,
      threshold,
      tally ?? 0,
      templateId,
      printerId,
      c.get("user").email,
      Date.now(),
      tally !== undefined ? 1 : 0,
    )
    .run();
  await audit(c, "part.auto-label", "part", id, parsed.data);
  const row = await db
    .prepare("SELECT * FROM part_auto_labels WHERE part_id = ?")
    .bind(id)
    .first<AutoLabelDbRow>();
  return c.json(row ? toAutoLabelSettings(row) : null);
});

/** Print an automatic label again, e.g. after it got lost or PrintNode refused it. */
autoLabels.post("/runs/:id/print", requireRole("operator"), async (c) => {
  const id = c.req.param("id");
  const run = await loadRun(c.env.DB, id);
  if (!run) return c.json({ error: "Label not found" }, 404);
  const result = await printRun(c.env, id, new URL(c.req.url).origin, c.get("user").email);
  await audit(c, "part.auto-label.print", "part", run.partId, { run: id, seq: run.seq, ...result });
  return result.error ? c.json({ error: result.error }, 502) : c.json(result, 201);
});
