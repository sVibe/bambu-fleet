import { type AmsUnit, JOB_STATUSES, type JobStatus } from "@fleet/shared";
import { Hono } from "hono";
import type {
  FilamentChip,
  JobDetail,
  JobListItem,
  JobListResponse,
  PrinterSummary,
} from "../../api-types.ts";
import type { AppEnv } from "../env.ts";
import { fleetLive } from "../live.ts";
import { intParam, optionalInt, parseJson, thumbUrl } from "../util.ts";

export const jobs = new Hono<AppEnv>();

interface JobRow {
  id: string;
  name: string;
  printer_serial: string;
  printer_name: string;
  printer_model: string | null;
  status: JobStatus;
  started_at: number;
  ended_at: number | null;
  duration_s: number | null;
  est_weight_g: number | null;
  actual_weight_g: number | null;
  attribution: JobListItem["attribution"];
  thumb_key: string | null;
  part_count: number;
  filaments_json: string | null;
}

const JOB_COLUMNS = `
  j.id, j.name, j.printer_serial, p.name AS printer_name, p.model AS printer_model, j.status, j.started_at,
  j.ended_at, j.duration_s, j.est_weight_g, j.actual_weight_g, j.attribution, j.thumb_key,
  (SELECT COUNT(*) FROM job_parts jp WHERE jp.job_id = j.id) AS part_count,
  (SELECT json_group_array(json_object('idx', f.idx, 'material', f.material, 'color', f.color, 'weightG', f.weight_g))
     FROM job_filaments f WHERE f.job_id = j.id) AS filaments_json`;

function toListItem(r: JobRow): JobListItem {
  return {
    id: r.id,
    name: r.name,
    printerSerial: r.printer_serial,
    printerName: r.printer_name,
    printerModel: r.printer_model,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationS: r.duration_s,
    estWeightG: r.est_weight_g,
    actualWeightG: r.actual_weight_g,
    partCount: r.part_count,
    attribution: r.attribution,
    filaments: parseJson<FilamentChip[]>(r.filaments_json, []).sort((a, b) => a.idx - b.idx),
    thumbUrl: thumbUrl(r.id, r.thumb_key),
  };
}

jobs.get("/jobs", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.printer) {
    where.push("j.printer_serial = ?");
    params.push(q.printer);
  }
  if (q.status && (JOB_STATUSES as readonly string[]).includes(q.status)) {
    where.push("j.status = ?");
    params.push(q.status);
  }
  const from = optionalInt(q.from);
  const to = optionalInt(q.to);
  if (from !== null) {
    where.push("j.started_at >= ?");
    params.push(from);
  }
  if (to !== null) {
    where.push("j.started_at < ?");
    params.push(to);
  }
  if (q.q) {
    where.push("(j.name LIKE ? OR j.file_name LIKE ?)");
    params.push(`%${q.q}%`, `%${q.q}%`);
  }
  if (q.material) {
    where.push("EXISTS (SELECT 1 FROM job_filaments f WHERE f.job_id = j.id AND f.material = ?)");
    params.push(q.material);
  }
  if (q.part) {
    where.push("EXISTS (SELECT 1 FROM job_parts jp WHERE jp.job_id = j.id AND jp.part_id = ?)");
    params.push(q.part);
  }
  if (q.cursor) {
    const [startedAt, id] = q.cursor.split("_");
    if (startedAt && id) {
      where.push("(j.started_at < ? OR (j.started_at = ? AND j.id < ?))");
      params.push(Number(startedAt), Number(startedAt), id);
    }
  }
  const limit = intParam(q.limit, 50, 1, 200);
  const sql = `SELECT ${JOB_COLUMNS} FROM jobs j JOIN printers p ON p.serial = j.printer_serial
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY j.started_at DESC, j.id DESC LIMIT ?`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...params, limit + 1)
    .all<JobRow>();
  const items = rows.results.slice(0, limit).map(toListItem);
  const last = items.at(-1);
  const body: JobListResponse = {
    items,
    nextCursor: rows.results.length > limit && last ? `${last.startedAt}_${last.id}` : null,
  };
  return c.json(body);
});

jobs.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const row = await db
    .prepare(
      `SELECT ${JOB_COLUMNS}, j.task_id, j.plate_index, j.file_name, j.file_md5, j.printer_model_id, j.est_length_m,
        j.est_time_s, j.waste_g, j.progress_at_end, j.layer_at_end, j.total_layers, j.error_code,
        j.skipped_objects, j.ams_snapshot
       FROM jobs j JOIN printers p ON p.serial = j.printer_serial WHERE j.id = ?`,
    )
    .bind(id)
    .first<
      JobRow & {
        task_id: string | null;
        plate_index: number | null;
        file_name: string | null;
        file_md5: string | null;
        printer_model_id: string | null;
        est_length_m: number | null;
        est_time_s: number | null;
        waste_g: number | null;
        progress_at_end: number | null;
        layer_at_end: number | null;
        total_layers: number | null;
        error_code: number | null;
        skipped_objects: string | null;
        ams_snapshot: string | null;
      }
    >();
  if (!row) return c.json({ error: "Job not found" }, 404);

  const [filaments, parts] = await db.batch([
    db
      .prepare(
        "SELECT idx, tray_info_idx, material, color, weight_g, length_m, waste_g FROM job_filaments WHERE job_id = ? ORDER BY idx",
      )
      .bind(id),
    db
      .prepare(
        `SELECT jp.identify_id, jp.part_id, pt.name AS part_name, jp.object_name, jp.skipped, jp.weight_g,
           jp.waste_share_g, jp.per_filament
         FROM job_parts jp JOIN parts pt ON pt.id = jp.part_id WHERE jp.job_id = ? ORDER BY jp.object_name, jp.identify_id`,
      )
      .bind(id),
  ]);

  const base = toListItem(row);
  const detail: JobDetail = {
    ...base,
    taskId: row.task_id,
    plateIndex: row.plate_index,
    fileName: row.file_name,
    fileMd5: row.file_md5,
    printerModelId: row.printer_model_id,
    estLengthM: row.est_length_m,
    estTimeS: row.est_time_s,
    wasteG: row.waste_g,
    progressAtEnd: row.progress_at_end,
    layerAtEnd: row.layer_at_end,
    totalLayers: row.total_layers,
    errorCode: row.error_code,
    skippedObjects: parseJson<string[]>(row.skipped_objects, []),
    amsSnapshot: parseJson<AmsUnit[]>(row.ams_snapshot, []),
    filaments: (filaments?.results ?? []).map((f) => {
      const r = f as Record<string, unknown>;
      return {
        idx: r.idx as number,
        trayInfoIdx: r.tray_info_idx as string | null,
        material: r.material as string | null,
        color: r.color as string | null,
        weightG: r.weight_g as number | null,
        lengthM: r.length_m as number | null,
        wasteG: r.waste_g as number | null,
      };
    }),
    parts: (parts?.results ?? []).map((p) => {
      const r = p as Record<string, unknown>;
      return {
        identifyId: r.identify_id as string,
        partId: r.part_id as string,
        partName: r.part_name as string,
        objectName: r.object_name as string,
        skipped: r.skipped === 1,
        weightG: r.weight_g as number | null,
        wasteShareG: r.waste_share_g as number | null,
        perFilament: parseJson<Record<string, number>>(r.per_filament as string | null, {}),
      };
    }),
  };
  return c.json(detail);
});

jobs.get("/thumbs/:jobId", async (c) => {
  const object = await c.env.FILES.get(`thumbs/${c.req.param("jobId")}.png`);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" },
  });
});

jobs.get("/printers", async (c) => {
  const db = c.env.DB;
  const [printers, current] = await db.batch([
    db.prepare("SELECT serial, name, model, last_seen_at FROM printers WHERE archived = 0 ORDER BY name"),
    db.prepare(
      "SELECT id, printer_serial, name, started_at, thumb_key FROM jobs WHERE status = 'printing' ORDER BY started_at DESC",
    ),
  ]);
  const live = new Map((await fleetLive(c.env).snapshot()).map((s) => [s.serial, s]));
  const currentBySerial = new Map<string, PrinterSummary["currentJob"]>();
  for (const r of (current?.results ?? []) as Array<Record<string, unknown>>) {
    const serial = r.printer_serial as string;
    if (currentBySerial.has(serial)) continue;
    currentBySerial.set(serial, {
      id: r.id as string,
      name: r.name as string,
      startedAt: r.started_at as number,
      thumbUrl: thumbUrl(r.id as string, r.thumb_key as string | null),
    });
  }
  const body: PrinterSummary[] = ((printers?.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    serial: r.serial as string,
    name: r.name as string,
    model: r.model as string | null,
    lastSeenAt: r.last_seen_at as number | null,
    live: live.get(r.serial as string) ?? null,
    currentJob: currentBySerial.get(r.serial as string) ?? null,
  }));
  return c.json(body);
});

jobs.get("/live", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    return c.json({ error: "Expected WebSocket" }, 426);
  return fleetLive(c.env).fetch(c.req.raw);
});
