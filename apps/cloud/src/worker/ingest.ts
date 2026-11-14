import {
  consumedWeight,
  type IngestEvent,
  type IngestEventOf,
  type IngestStateResponse,
  ingestBatchSchema,
  ingestStateSchema,
  type JobStatus,
  normalizeJobName,
  normalizePartName,
} from "@fleet/shared";
import { plateIndexFromPath } from "@fleet/threemf";
import { Hono } from "hono";
import { ulid } from "ulidx";
import { requireAgent } from "./auth.ts";
import type { AppEnv, Env } from "./env.ts";
import { fleetLive } from "./live.ts";
import { partImageKey } from "./util.ts";

export const ingest = new Hono<AppEnv>();
ingest.use("*", requireAgent);

ingest.post("/events", async (c) => {
  const parsed = ingestBatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "Invalid batch", issues: parsed.error.issues.slice(0, 10) }, 400);
  const agentId = c.get("agentId");
  const now = Date.now();
  let applied = 0;
  let duplicates = 0;
  for (const event of parsed.data.events) {
    if (await applyEvent(c.env, agentId, event, now)) applied++;
    else duplicates++;
  }
  await c.env.DB.prepare("UPDATE agents SET last_seen_at = ?, version = ? WHERE id = ?")
    .bind(now, parsed.data.agentVersion, agentId)
    .run();
  return c.json({ applied, duplicates });
});

ingest.post("/state", async (c) => {
  const parsed = ingestStateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "Invalid state", issues: parsed.error.issues.slice(0, 10) }, 400);
  const serverNow = Date.now();
  if (parsed.data.states.length === 0) {
    return c.json({ accepted: 0, rejected: [], serverNow } satisfies IngestStateResponse);
  }
  // Only accept state for printers this agent has registered. The rest are reported back, so the agent
  // can log that another agent owns them instead of the printers silently showing offline.
  const owned = await c.env.DB.prepare("SELECT serial FROM printers WHERE agent_id = ?")
    .bind(c.get("agentId"))
    .all<{ serial: string }>();
  const allowed = new Set(owned.results.map((r) => r.serial));
  // Freshness is judged by the server's clock, not the agent machine's.
  const states = parsed.data.states
    .filter((s) => allowed.has(s.serial))
    .map((s) => ({ ...s, receivedAt: serverNow }));
  const rejected = parsed.data.states.filter((s) => !allowed.has(s.serial)).map((s) => s.serial);
  if (states.length > 0) await fleetLive(c.env).update(states);
  return c.json({ accepted: states.length, rejected, serverNow } satisfies IngestStateResponse);
});

interface JobRow {
  status: JobStatus;
  est_weight_g: number | null;
  layer_curve: string | null;
  layer_at_end: number | null;
  progress_at_end: number | null;
  skipped_objects: string | null;
}

/**
 * Apply one agent event. The event id is inserted into `ingest_events` in the same D1 batch
 * (transaction) as its changes, so a redelivered event is either skipped or fails as a whole.
 * Returns false for an event that was already applied.
 */
export async function applyEvent(
  env: Env,
  agentId: string,
  event: IngestEvent,
  now: number,
): Promise<boolean> {
  const db = env.DB;
  const seen = await db.prepare("SELECT 1 FROM ingest_events WHERE id = ?").bind(event.id).first();
  if (seen) return false;

  const statements: D1PreparedStatement[] = [
    db
      .prepare("INSERT INTO ingest_events (id, agent_id, type, received_at) VALUES (?, ?, ?, ?)")
      .bind(event.id, agentId, event.type, now),
    // Job events can only arrive for printers the agent already announced, but don't depend on it.
    db
      .prepare(
        `INSERT INTO printers (serial, name, agent_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(serial) DO UPDATE SET agent_id = excluded.agent_id, last_seen_at = excluded.last_seen_at`,
      )
      .bind(event.serial, event.serial, agentId, now, now),
  ];

  switch (event.type) {
    case "printer.hello":
      statements.push(
        db
          .prepare("UPDATE printers SET name = ?, model = COALESCE(?, model), archived = 0 WHERE serial = ?")
          .bind(event.name, event.model, event.serial),
      );
      break;
    case "job.started":
      statements.push(jobStarted(db, event, now), ...(await linkQueueItem(db, event, now)));
      break;
    case "job.ended":
      statements.push(...(await jobEnded(db, event, now)), ...(await finishQueueItem(db, event, now)));
      break;
    case "job.analysis":
      statements.push(...(await jobAnalysis(env, event, now)));
      break;
  }
  await db.batch(statements);
  return true;
}

function jobStarted(db: D1Database, e: IngestEventOf<"job.started">, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO jobs (id, printer_serial, source, task_id, subtask_id, name, gcode_file, plate_index, status,
                         started_at, total_layers, ams_snapshot, created_at, updated_at)
       VALUES (?, ?, 'mqtt', ?, ?, ?, ?, ?, 'printing', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         task_id = excluded.task_id, subtask_id = excluded.subtask_id, name = excluded.name,
         gcode_file = excluded.gcode_file, plate_index = COALESCE(jobs.plate_index, excluded.plate_index),
         started_at = excluded.started_at, total_layers = COALESCE(jobs.total_layers, excluded.total_layers),
         ams_snapshot = excluded.ams_snapshot, updated_at = excluded.updated_at`,
    )
    .bind(
      e.jobId,
      e.serial,
      e.taskId,
      e.subtaskId,
      e.name,
      e.gcodeFile,
      plateIndexFromPath(e.gcodeFile),
      e.startedAt,
      e.totalLayers,
      JSON.stringify(e.amsSnapshot),
      now,
      now,
    );
}

/** A dispatched queue item is linked to a job that starts on its printer within this time after dispatch. */
export const RECONCILE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Allowance for the agent's clock running behind the Worker's. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Link a started job to the queue item that was dispatched to the same printer under the same name
 * (case-insensitive, without `.gcode.3mf`), oldest dispatch first, and mark the item printing.
 */
async function linkQueueItem(
  db: D1Database,
  e: IngestEventOf<"job.started">,
  now: number,
): Promise<D1PreparedStatement[]> {
  const name = normalizeJobName(e.name);
  if (!name) return [];
  const linked = await db.prepare("SELECT 1 FROM queue_items WHERE job_id = ?").bind(e.jobId).first();
  if (linked) return [];
  const candidates = await db
    .prepare(
      `SELECT q.id, q.title, f.filename FROM queue_items q JOIN files f ON f.md5 = q.file_md5
       WHERE q.status = 'dispatched' AND q.assigned_printer = ? AND q.dispatched_at BETWEEN ? AND ?
       ORDER BY q.dispatched_at, q.id`,
    )
    .bind(e.serial, e.startedAt - RECONCILE_WINDOW_MS, e.startedAt + CLOCK_SKEW_MS)
    .all<{ id: string; title: string; filename: string }>();
  const item = candidates.results.find(
    (q) => normalizeJobName(q.filename) === name || normalizeJobName(q.title) === name,
  );
  if (!item) return [];
  return [
    db
      .prepare(
        "UPDATE queue_items SET status = 'printing', job_id = ?, updated_at = ? WHERE id = ? AND status = 'dispatched'",
      )
      .bind(e.jobId, now, item.id),
    db.prepare("UPDATE jobs SET queue_item_id = ? WHERE id = ?").bind(item.id, e.jobId),
  ];
}

/**
 * Close the run of a printing queue item: a finished job counts towards its quantity and re-queues the
 * item until enough are printed; a failed or cancelled job marks it failed for an operator to look at.
 */
async function finishQueueItem(
  db: D1Database,
  e: IngestEventOf<"job.ended">,
  now: number,
): Promise<D1PreparedStatement[]> {
  const item = await db
    .prepare("SELECT id, quantity, completed FROM queue_items WHERE job_id = ? AND status = 'printing'")
    .bind(e.jobId)
    .first<{ id: string; quantity: number; completed: number }>();
  if (!item) return [];
  if (e.status !== "finished") {
    return [
      db.prepare("UPDATE queue_items SET status = 'failed', updated_at = ? WHERE id = ?").bind(now, item.id),
    ];
  }
  const completed = item.completed + 1;
  const status = completed >= item.quantity ? "done" : "queued";
  return [
    db
      .prepare(
        `UPDATE queue_items SET completed = ?, status = ?, updated_at = ?,
           assigned_printer = CASE WHEN ? = 'queued' THEN NULL ELSE assigned_printer END,
           dispatched_at = CASE WHEN ? = 'queued' THEN NULL ELSE dispatched_at END
         WHERE id = ?`,
      )
      .bind(completed, status, now, status, status, item.id),
  ];
}

async function loadJob(db: D1Database, jobId: string): Promise<JobRow | null> {
  return db
    .prepare(
      "SELECT status, est_weight_g, layer_curve, layer_at_end, progress_at_end, skipped_objects FROM jobs WHERE id = ?",
    )
    .bind(jobId)
    .first<JobRow>();
}

/** Grams consumed: the whole estimate for finished jobs, up to the stop layer otherwise. */
function actualWeight(
  status: JobStatus,
  est: number | null,
  curve: number[] | null,
  layer: number | null,
  progress: number | null,
) {
  if (status === "finished") return est;
  if (status === "printing") return null;
  return consumedWeight(est, curve, layer, progress);
}

/** Insert a placeholder row when an end/analysis event arrives for a job we haven't seen start. */
function ensureJob(db: D1Database, jobId: string, serial: string, startedAt: number, now: number) {
  return db
    .prepare(
      `INSERT INTO jobs (id, printer_serial, name, status, started_at, created_at, updated_at)
       VALUES (?, ?, 'Unknown job', 'printing', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(jobId, serial, startedAt, now, now);
}

async function jobEnded(
  db: D1Database,
  e: IngestEventOf<"job.ended">,
  now: number,
): Promise<D1PreparedStatement[]> {
  const job = await loadJob(db, e.jobId);
  const curve = job?.layer_curve ? (JSON.parse(job.layer_curve) as number[]) : null;
  const actual = actualWeight(e.status, job?.est_weight_g ?? null, curve, e.layer, e.progressPct);
  const statements = [
    ensureJob(db, e.jobId, e.serial, e.endedAt, now),
    db
      .prepare(
        `UPDATE jobs SET status = ?, ended_at = ?, duration_s = MAX(0, (? - started_at) / 1000),
           progress_at_end = ?, layer_at_end = ?, total_layers = COALESCE(?, total_layers), error_code = ?,
           skipped_objects = ?, actual_weight_g = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        e.status,
        e.endedAt,
        e.endedAt,
        e.progressPct,
        e.layer,
        e.totalLayers,
        e.printError,
        JSON.stringify(e.skippedObjects),
        actual,
        now,
        e.jobId,
      ),
  ];
  // D1 allows 100 bound parameters per statement.
  for (let i = 0; i < e.skippedObjects.length; i += 90) {
    const ids = e.skippedObjects.slice(i, i + 90);
    statements.push(
      db
        .prepare(
          `UPDATE job_parts SET skipped = 1 WHERE job_id = ? AND identify_id IN (${ids.map(() => "?").join(",")})`,
        )
        .bind(e.jobId, ...ids),
    );
  }
  return statements;
}

async function jobAnalysis(
  env: Env,
  e: IngestEventOf<"job.analysis">,
  now: number,
): Promise<D1PreparedStatement[]> {
  const db = env.DB;
  const a = e.analysis;
  const job = await loadJob(db, e.jobId);
  const skipped = new Set<string>(job?.skipped_objects ? (JSON.parse(job.skipped_objects) as string[]) : []);
  const actual = actualWeight(
    job?.status ?? "printing",
    a.estWeightG,
    a.layerCurve,
    job?.layer_at_end ?? null,
    job?.progress_at_end ?? null,
  );

  let thumbKey: string | null = null;
  if (a.thumbnailPngBase64) {
    thumbKey = `thumbs/${e.jobId}.png`;
    const bytes = Uint8Array.from(atob(a.thumbnailPngBase64), (ch) => ch.charCodeAt(0));
    await env.FILES.put(thumbKey, bytes, { httpMetadata: { contentType: "image/png" } });
  }

  const imageKeys = new Map<string, string>();
  await Promise.all(
    a.parts.map(async (p) => {
      if (!p.imagePngBase64 || !/^\d+$/.test(p.identifyId)) return;
      const key = partImageKey(e.jobId, p.identifyId);
      const bytes = Uint8Array.from(atob(p.imagePngBase64), (ch) => ch.charCodeAt(0));
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
      imageKeys.set(p.identifyId, key);
    }),
  );

  const statements: D1PreparedStatement[] = [
    ensureJob(db, e.jobId, e.serial, e.at, now),
    db
      .prepare(
        `UPDATE jobs SET file_md5 = ?, file_name = ?, plate_index = ?, printer_model_id = ?, est_weight_g = ?,
           est_length_m = ?, est_time_s = ?, waste_g = ?, attribution = ?, layer_curve = ?,
           thumb_key = COALESCE(?, thumb_key), actual_weight_g = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        a.fileMd5,
        a.fileName,
        a.plateIndex,
        a.printerModelId,
        a.estWeightG,
        a.estLengthM,
        a.estTimeS,
        a.wasteG,
        a.attribution,
        a.layerCurve ? JSON.stringify(a.layerCurve) : null,
        thumbKey,
        actual,
        now,
        e.jobId,
      ),
    db.prepare("DELETE FROM job_filaments WHERE job_id = ?").bind(e.jobId),
    db.prepare("DELETE FROM job_parts WHERE job_id = ?").bind(e.jobId),
  ];

  for (const f of a.filaments) {
    statements.push(
      db
        .prepare(
          `INSERT INTO job_filaments (job_id, idx, tray_info_idx, material, color, weight_g, length_m, waste_g)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(e.jobId, f.idx, f.trayInfoIdx, f.material, f.color, f.usedG, f.usedM, f.wasteG),
    );
  }

  const partNames = new Map<string, string>();
  for (const p of a.parts) {
    const key = normalizePartName(p.name);
    if (!partNames.has(key)) partNames.set(key, p.name.trim());
  }
  for (const [normalized, name] of partNames) {
    statements.push(
      db
        .prepare(
          "INSERT INTO parts (id, name, normalized_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(normalized_name) DO NOTHING",
        )
        .bind(ulid(), name, normalized, now),
    );
  }
  for (const p of a.parts) {
    statements.push(
      db
        .prepare(
          `INSERT INTO job_parts (job_id, identify_id, part_id, object_name, skipped, weight_g, waste_share_g, per_filament, image_key)
           VALUES (?, ?, (SELECT COALESCE(merged_into, id) FROM parts WHERE normalized_name = ?), ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          e.jobId,
          p.identifyId,
          normalizePartName(p.name),
          p.name,
          p.skipped || skipped.has(p.identifyId) ? 1 : 0,
          p.weightG,
          p.wasteShareG,
          JSON.stringify(p.perFilament),
          imageKeys.get(p.identifyId) ?? null,
        ),
    );
  }
  return statements;
}
