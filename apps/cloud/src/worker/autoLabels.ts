import { ulid } from "ulidx";
import type { AutoLabelRun, AutoLabelSettings, PrintJobState } from "../api-types.ts";
import type { Env } from "./env.ts";
import { loadTemplate, resolveTemplate } from "./labelTemplates.ts";
import { getSetting, jobLabelValues, LABEL_PRINTER_KEY, loadPrinter, submitPrint } from "./printing.ts";
import { printNodeFor } from "./printnode.ts";
import { loadJobDetail } from "./routes/jobs.ts";

/** Shown as who asked for the print. */
export const AUTO_REQUESTER = "automatic";

export interface AutoLabelDbRow {
  part_id: string;
  enabled: number;
  threshold: number;
  tally: number;
  labels: number;
  template_id: string | null;
  printer_id: number | null;
  updated_by: string;
  updated_at: number;
}

export function toAutoLabelSettings(r: AutoLabelDbRow): AutoLabelSettings {
  return {
    enabled: r.enabled === 1,
    threshold: r.threshold,
    tally: r.tally,
    labels: r.labels,
    templateId: r.template_id,
    printerId: r.printer_id,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

interface RunDbRow {
  id: string;
  part_id: string;
  job_id: string;
  seq: number;
  qty: number;
  print_job_id: string | null;
  error: string | null;
  created_at: number;
  job_name: string | null;
  print_state: PrintJobState | null;
}

const RUN_SELECT = `
  SELECT r.*, j.name AS job_name, pj.state AS print_state
  FROM part_label_runs r
  LEFT JOIN jobs j ON j.id = r.job_id
  LEFT JOIN print_jobs pj ON pj.id = r.print_job_id`;

function toRun(r: RunDbRow): AutoLabelRun {
  return {
    id: r.id,
    seq: r.seq,
    qty: r.qty,
    jobId: r.job_id,
    jobName: r.job_name,
    createdAt: r.created_at,
    printJobId: r.print_job_id,
    printState: r.print_state,
    error: r.error,
  };
}

export async function listRuns(db: D1Database, partId: string, limit = 20): Promise<AutoLabelRun[]> {
  const rows = await db
    .prepare(`${RUN_SELECT} WHERE r.part_id = ? ORDER BY r.created_at DESC, r.seq DESC LIMIT ?`)
    .bind(partId, limit)
    .all<RunDbRow>();
  return rows.results.map(toRun);
}

export async function loadRun(
  db: D1Database,
  id: string,
): Promise<(AutoLabelRun & { partId: string }) | null> {
  const row = await db.prepare(`${RUN_SELECT} WHERE r.id = ?`).bind(id).first<RunDbRow>();
  return row ? { ...toRun(row), partId: row.part_id } : null;
}

/**
 * Add a finished job's good pieces to the tallies of parts with automatic labels, and print a job label
 * for each threshold reached. Pieces past the threshold carry over to the next label.
 *
 * A job counts once: only when it has finished and its part data has arrived (either can come first),
 * and the counting run claims the job in the same transaction that adds to the tallies.
 * Returns the labels it made.
 */
export async function countJobForLabels(env: Env, jobId: string, origin: string): Promise<AutoLabelRun[]> {
  const db = env.DB;
  const job = await db
    .prepare("SELECT status, labels_counted FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ status: string; labels_counted: string | null }>();
  if (job?.status !== "finished" || job.labels_counted) return [];

  const pieces = await db
    .prepare(
      `SELECT jp.part_id, SUM(CASE WHEN jp.skipped = 0 THEN 1 ELSE 0 END) AS n, a.enabled
       FROM job_parts jp LEFT JOIN part_auto_labels a ON a.part_id = jp.part_id
       WHERE jp.job_id = ? GROUP BY jp.part_id`,
    )
    .bind(jobId)
    .all<{ part_id: string; n: number; enabled: number | null }>();
  // No part data yet: count when it arrives.
  if (pieces.results.length === 0) return [];

  const token = ulid();
  const counting = pieces.results.filter((p) => p.enabled === 1 && p.n > 0);
  const results = await db.batch<{
    part_id: string;
    threshold: number;
    labels: number;
    last_labels: number;
  }>([
    db
      .prepare(
        "UPDATE jobs SET labels_counted = ? WHERE id = ? AND status = 'finished' AND labels_counted IS NULL",
      )
      .bind(token, jobId),
    ...counting.map((p) =>
      // SET expressions all read the row as it was, so last_labels is this job's share.
      db
        .prepare(
          `UPDATE part_auto_labels SET
             tally = (tally + CAST(? AS INTEGER)) % threshold,
             labels = labels + (tally + CAST(? AS INTEGER)) / threshold,
             last_labels = (tally + CAST(? AS INTEGER)) / threshold
           WHERE part_id = ? AND enabled = 1
             AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND labels_counted = ?)
           RETURNING part_id, threshold, labels, last_labels`,
        )
        .bind(p.n, p.n, p.n, p.part_id, jobId, token),
    ),
  ]);

  const now = Date.now();
  const made: Array<{ id: string; partId: string; seq: number; qty: number }> = [];
  for (const result of results.slice(1)) {
    for (const r of result.results) {
      for (let seq = r.labels - r.last_labels + 1; seq <= r.labels; seq++)
        made.push({ id: ulid(), partId: r.part_id, seq, qty: r.threshold });
    }
  }
  if (made.length === 0) return [];
  await db.batch(
    made.map((m) =>
      db
        .prepare(
          "INSERT INTO part_label_runs (id, part_id, job_id, seq, qty, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(m.id, m.partId, jobId, m.seq, m.qty, now),
    ),
  );
  for (const m of made) await printRun(env, m.id, origin);
  const runs = await Promise.all(made.map((m) => loadRun(db, m.id)));
  return runs.filter((r): r is NonNullable<typeof r> => r !== null);
}

/**
 * Print (or print again) an automatic label with the part's current template and printer, and record
 * the print job on the run, or why there is none.
 */
export async function printRun(
  env: Env,
  runId: string,
  origin: string,
  requestedBy = AUTO_REQUESTER,
): Promise<{ printJobId: string | null; error: string | null }> {
  const db = env.DB;
  const run = await loadRun(db, runId);
  if (!run) return { printJobId: null, error: "Label not found" };
  const result = await sendRun(env, run, origin, requestedBy).catch((err: unknown) => {
    console.error("automatic label failed", err);
    return { printJobId: null, error: "The label couldn't be made" };
  });
  await db
    .prepare("UPDATE part_label_runs SET print_job_id = COALESCE(?, print_job_id), error = ? WHERE id = ?")
    .bind(result.printJobId, result.error, runId)
    .run();
  return result;
}

async function sendRun(
  env: Env,
  run: AutoLabelRun & { partId: string },
  origin: string,
  requestedBy: string,
): Promise<{ printJobId: string | null; error: string | null }> {
  const db = env.DB;
  const settings = await db
    .prepare("SELECT template_id, printer_id FROM part_auto_labels WHERE part_id = ?")
    .bind(run.partId)
    .first<{ template_id: string | null; printer_id: number | null }>();

  const client = printNodeFor(env);
  if (!client) return { printJobId: null, error: "PrintNode isn't set up" };
  const printerId = settings?.printer_id ?? Number((await getSetting(db, LABEL_PRINTER_KEY)) ?? Number.NaN);
  const printer = Number.isFinite(printerId) ? await loadPrinter(db, printerId) : null;
  if (!printer) return { printJobId: null, error: "No label printer is chosen, or it was removed" };

  // A template that was deleted, or isn't a job label, falls back to the default job label.
  const chosen = settings?.template_id ? await loadTemplate(db, settings.template_id) : null;
  const template = chosen?.source === "job" ? chosen : await resolveTemplate(db, undefined, "job");
  if (!template) return { printJobId: null, error: "No job label template" };

  const job = await loadJobDetail(db, run.jobId);
  if (!job) return { printJobId: null, error: "The job no longer exists" };
  const values = jobLabelValues(job, {
    qty: run.qty,
    now: Date.now(),
    origin,
    timeZone: env.TIME_ZONE || "Europe/Copenhagen",
    partId: run.partId,
  });
  const printed = await submitPrint(env, client, {
    printer,
    template: template.id,
    title: `Auto label ${values["part.number"]} #${run.seq}`,
    label: template.template,
    values,
    copies: 1,
    entity: "job",
    entityId: run.jobId,
    requestedBy,
  });
  return {
    printJobId: printed.id,
    error: printed.state === "failed" ? (printed.message ?? "PrintNode refused the label") : null,
  };
}
