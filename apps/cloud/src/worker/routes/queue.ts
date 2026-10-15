import {
  modelForPrinterModelId,
  OPEN_QUEUE_STATUSES,
  type QueuePlate,
  type QueueStatus,
  queuePlateSchema,
} from "@fleet/shared";
import { Hono } from "hono";
import { ulid } from "ulidx";
import { z } from "zod";
import type { QueueFile, QueueItem } from "../../api-types.ts";
import { audit, requireRole } from "../auth.ts";
import type { AppEnv } from "../env.ts";
import { fleetLive } from "../live.ts";
import { type MatchPrinter, rankPrinters } from "../matcher.ts";
import { parseJson } from "../util.ts";

/**
 * Assisted job queue. Everyone can see the queue; operators upload files, queue plates and dispatch them.
 * Dispatch only records the hand-off: the operator starts the print in Bambu Connect or Studio, because
 * printers stay in cloud mode and the dashboard never sends print commands.
 */
export const queue = new Hono<AppEnv>();

const MD5 = /^[0-9a-f]{32}$/;
/** Workers accept request bodies up to 100 MB on the Free and Pro plans. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

const fileKey = (md5: string) => `queue/${md5}.gcode.3mf`;
const plateThumbKey = (md5: string, plate: number) => `queue/${md5}/plate_${plate}.png`;
const downloadUrl = (md5: string) => `/api/queue/files/${md5}/download`;

interface FileRow {
  md5: string;
  filename: string;
  size: number;
  printer_model_id: string | null;
  plates_json: string;
  uploaded_by: string;
  uploaded_at: number;
}

function toFile(r: FileRow): QueueFile {
  return {
    md5: r.md5,
    filename: r.filename,
    size: r.size,
    printerModelId: r.printer_model_id,
    model: modelForPrinterModelId(r.printer_model_id),
    plates: parseJson<QueuePlate[]>(r.plates_json, []),
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at,
    downloadUrl: downloadUrl(r.md5),
  };
}

// --- Files -----------------------------------------------------------------------------------------

queue.get("/files/:md5", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM files WHERE md5 = ?")
    .bind(c.req.param("md5"))
    .first<FileRow>();
  return row ? c.json(toFile(row)) : c.json({ error: "File not found" }, 404);
});

/**
 * Upload the raw bytes of a file whose MD5 the browser computed. R2 verifies the MD5 while storing, so a
 * file can't end up under someone else's hash. Uploading a file that is already stored is a no-op.
 */
queue.put("/files/:md5", requireRole("operator"), async (c) => {
  const md5 = c.req.param("md5").toLowerCase();
  if (!MD5.test(md5)) return c.json({ error: "Invalid MD5" }, 400);
  const length = Number(c.req.header("content-length"));
  if (!Number.isFinite(length) || length <= 0) return c.json({ error: "Content-Length required" }, 411);
  if (length > MAX_FILE_BYTES) return c.json({ error: "File too large (max 100 MB)" }, 413);
  const key = fileKey(md5);
  const existing = await c.env.FILES.head(key);
  if (existing) return c.json({ md5, size: existing.size, stored: false });
  if (!c.req.raw.body) return c.json({ error: "Empty body" }, 400);
  try {
    const object = await c.env.FILES.put(key, c.req.raw.body, {
      md5,
      httpMetadata: { contentType: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" },
    });
    return c.json({ md5, size: object?.size ?? length, stored: true }, 201);
  } catch (err) {
    console.warn("queue upload rejected", err);
    return c.json({ error: "Upload did not match its MD5" }, 400);
  }
});

const registerSchema = z.object({
  md5: z.string().regex(MD5),
  filename: z.string().trim().min(1).max(255),
  plates: z.array(queuePlateSchema).min(1).max(64),
});

/** Record a stored file's plate summaries (parsed in the browser) and its plate thumbnails. */
queue.post("/files", requireRole("operator"), async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "Invalid file metadata", issues: parsed.error.issues.slice(0, 10) }, 400);
  const { md5, filename, plates } = parsed.data;
  const object = await c.env.FILES.head(fileKey(md5));
  if (!object) return c.json({ error: "Upload the file before registering it" }, 409);

  const stored: QueuePlate[] = [];
  for (const { thumbnailPngBase64, ...plate } of plates) {
    let thumbUrl: string | null = null;
    if (thumbnailPngBase64) {
      const bytes = Uint8Array.from(atob(thumbnailPngBase64), (ch) => ch.charCodeAt(0));
      await c.env.FILES.put(plateThumbKey(md5, plate.index), bytes, {
        httpMetadata: { contentType: "image/png" },
      });
      thumbUrl = `/api/queue/files/${md5}/plates/${plate.index}.png`;
    }
    stored.push({ ...plate, thumbUrl });
  }
  const printerModelId = plates.find((p) => p.printerModelId)?.printerModelId ?? null;
  const user = c.get("user").email;
  // A re-upload refreshes the metadata but keeps who uploaded it first.
  await c.env.DB.prepare(
    `INSERT INTO files (md5, filename, r2_key, size, printer_model_id, plates_json, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(md5) DO UPDATE SET filename = excluded.filename, printer_model_id = excluded.printer_model_id,
       plates_json = excluded.plates_json`,
  )
    .bind(md5, filename, fileKey(md5), object.size, printerModelId, JSON.stringify(stored), user, Date.now())
    .run();
  await audit(c, "file.upload", "file", md5, { filename, size: object.size, plates: plates.length });
  const row = await c.env.DB.prepare("SELECT * FROM files WHERE md5 = ?").bind(md5).first<FileRow>();
  return c.json(toFile(row as FileRow), 201);
});

queue.get("/files/:md5/download", requireRole("operator"), async (c) => {
  const md5 = c.req.param("md5");
  const row = await c.env.DB.prepare("SELECT filename, r2_key FROM files WHERE md5 = ?")
    .bind(md5)
    .first<{ filename: string; r2_key: string }>();
  const object = row ? await c.env.FILES.get(row.r2_key) : null;
  if (!row || !object) return c.json({ error: "File not found" }, 404);
  const ascii = row.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      "cache-control": "private, no-store",
    },
  });
});

queue.get("/files/:md5/plates/:plate{[0-9]+\\.png}", async (c) => {
  const plate = Number.parseInt(c.req.param("plate"), 10);
  const object = await c.env.FILES.get(plateThumbKey(c.req.param("md5"), plate));
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" },
  });
});

// --- Queue items -----------------------------------------------------------------------------------

interface ItemRow {
  id: string;
  file_md5: string;
  plate_index: number;
  title: string;
  quantity: number;
  completed: number;
  priority: number;
  status: QueueStatus;
  assigned_printer: string | null;
  printer_name: string | null;
  job_id: string | null;
  dispatched_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  filename: string;
  size: number;
  printer_model_id: string | null;
  plates_json: string;
}

const ITEM_SELECT = `
  SELECT q.*, p.name AS printer_name, f.filename, f.size, f.printer_model_id, f.plates_json
  FROM queue_items q
  JOIN files f ON f.md5 = q.file_md5
  LEFT JOIN printers p ON p.serial = q.assigned_printer`;

/** Open items first by priority then age; finished ones after, newest first. */
const ITEM_ORDER = `ORDER BY CASE WHEN q.status IN ('queued', 'assigned', 'dispatched', 'printing') THEN 0 ELSE 1 END,
  CASE WHEN q.status IN ('queued', 'assigned', 'dispatched', 'printing') THEN -q.priority ELSE 0 END,
  CASE WHEN q.status IN ('queued', 'assigned', 'dispatched', 'printing') THEN q.created_at ELSE -q.updated_at END`;

interface Fleet {
  printers: MatchPrinter[];
  /** Items already assigned or dispatched to a printer, so other items can warn about them. */
  reservations: Array<{ itemId: string; serial: string; title: string }>;
}

async function loadFleet(env: AppEnv["Bindings"]): Promise<Fleet> {
  const [printers, reserved] = await env.DB.batch([
    env.DB.prepare("SELECT serial, name, model FROM printers WHERE archived = 0 ORDER BY name"),
    env.DB.prepare(
      `SELECT id AS itemId, assigned_printer AS serial, title FROM queue_items
       WHERE status IN ('assigned', 'dispatched') AND assigned_printer IS NOT NULL`,
    ),
  ]);
  const live = new Map((await fleetLive(env).snapshot()).map((s) => [s.serial, s]));
  return {
    printers: (
      (printers?.results ?? []) as Array<{ serial: string; name: string; model: string | null }>
    ).map((r) => ({ ...r, live: live.get(r.serial) ?? null })),
    reservations: (reserved?.results ?? []) as Fleet["reservations"],
  };
}

function toItem(r: ItemRow, fleet: Fleet | null, now: number): QueueItem {
  const plates = parseJson<QueuePlate[]>(r.plates_json, []);
  const plate = plates.find((p) => p.index === r.plate_index) ?? null;
  const open = OPEN_QUEUE_STATUSES.has(r.status);
  return {
    id: r.id,
    title: r.title,
    plateIndex: r.plate_index,
    quantity: r.quantity,
    completed: r.completed,
    priority: r.priority,
    status: r.status,
    file: {
      md5: r.file_md5,
      filename: r.filename,
      size: r.size,
      printerModelId: r.printer_model_id,
      model: modelForPrinterModelId(r.printer_model_id),
      downloadUrl: downloadUrl(r.file_md5),
    },
    plate,
    assignedPrinter: r.assigned_printer
      ? { serial: r.assigned_printer, name: r.printer_name ?? r.assigned_printer }
      : null,
    jobId: r.job_id,
    dispatchedAt: r.dispatched_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    suggestions:
      open && plate && fleet
        ? rankPrinters(
            { printerModelId: plate.printerModelId ?? r.printer_model_id, filaments: plate.filaments },
            fleet.printers.map((p) => ({
              ...p,
              reservedFor: fleet.reservations
                .filter((x) => x.serial === p.serial && x.itemId !== r.id)
                .map((x) => x.title),
            })),
            now,
          )
        : [],
  };
}

queue.get("/", async (c) => {
  const view = c.req.query("view") === "history" ? "history" : "active";
  const where =
    view === "active"
      ? "WHERE q.status IN ('queued', 'assigned', 'dispatched', 'printing')"
      : "WHERE q.status IN ('done', 'failed', 'cancelled')";
  const rows = await c.env.DB.prepare(`${ITEM_SELECT} ${where} ${ITEM_ORDER} LIMIT 500`).all<ItemRow>();
  const fleet = view === "active" ? await loadFleet(c.env) : null;
  const now = Date.now();
  return c.json(rows.results.map((r) => toItem(r, fleet, now)));
});

async function loadItem(env: AppEnv["Bindings"], id: string): Promise<QueueItem | null> {
  const row = await env.DB.prepare(`${ITEM_SELECT} WHERE q.id = ?`).bind(id).first<ItemRow>();
  if (!row) return null;
  return toItem(row, OPEN_QUEUE_STATUSES.has(row.status) ? await loadFleet(env) : null, Date.now());
}

queue.get("/:id", async (c) => {
  const item = await loadItem(c.env, c.req.param("id"));
  return item ? c.json(item) : c.json({ error: "Queue item not found" }, 404);
});

const createSchema = z.object({
  fileMd5: z.string().regex(MD5),
  plateIndex: z.number().int().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  quantity: z.number().int().min(1).max(1000).default(1),
  priority: z.number().int().min(-100).max(100).default(0),
});

queue.post("/", requireRole("operator"), async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid queue item", issues: parsed.error.issues }, 400);
  const { fileMd5, plateIndex, quantity, priority } = parsed.data;
  const file = await c.env.DB.prepare("SELECT filename, plates_json FROM files WHERE md5 = ?")
    .bind(fileMd5)
    .first<{ filename: string; plates_json: string }>();
  if (!file) return c.json({ error: "File not found" }, 404);
  const plates = parseJson<QueuePlate[]>(file.plates_json, []);
  if (!plates.some((p) => p.index === plateIndex)) return c.json({ error: "Plate not in file" }, 400);

  const id = ulid();
  const now = Date.now();
  // Bambu Connect names the print after the file, so that is the default title and what reconcile matches.
  const title =
    parsed.data.title ??
    (plates.length > 1 ? `${stripExt(file.filename)} – plate ${plateIndex}` : stripExt(file.filename));
  await c.env.DB.prepare(
    `INSERT INTO queue_items (id, file_md5, plate_index, title, quantity, priority, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  )
    .bind(id, fileMd5, plateIndex, title, quantity, priority, c.get("user").email, now, now)
    .run();
  await audit(c, "queue.create", "queue_item", id, { fileMd5, plateIndex, title, quantity, priority });
  return c.json(await loadItem(c.env, id), 201);
});

function stripExt(filename: string): string {
  return filename.replace(/(\.gcode)?\.3mf$/i, "");
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
});

queue.patch("/:id", requireRole("operator"), async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid queue item update" }, 400);
  const id = c.req.param("id");
  const { title, quantity, priority } = parsed.data;
  const res = await c.env.DB.prepare(
    `UPDATE queue_items SET title = COALESCE(?, title), quantity = MAX(completed, COALESCE(?, quantity)),
       priority = COALESCE(?, priority), updated_at = ? WHERE id = ?`,
  )
    .bind(title ?? null, quantity ?? null, priority ?? null, Date.now(), id)
    .run();
  if (res.meta.changes === 0) return c.json({ error: "Queue item not found" }, 404);
  await audit(c, "queue.update", "queue_item", id, parsed.data);
  return c.json(await loadItem(c.env, id));
});

/**
 * Operator actions and the statuses they may start from. Moving to printing, done and failed only
 * happens through reconcile in ingest.ts, when the printer reports the job.
 */
const ACTIONS = {
  assign: { from: ["queued", "assigned", "dispatched"], to: "assigned", printer: true },
  dispatch: { from: ["queued", "assigned", "dispatched"], to: "dispatched", printer: true },
  requeue: { from: ["assigned", "dispatched", "failed", "cancelled"], to: "queued", printer: false },
  cancel: { from: ["queued", "assigned", "dispatched", "failed"], to: "cancelled", printer: false },
} as const satisfies Record<string, { from: QueueStatus[]; to: QueueStatus; printer: boolean }>;
type Action = keyof typeof ACTIONS;

const actionSchema = z.object({ printer: z.string().min(1).optional() });

queue.post("/:id/:action{assign|dispatch|requeue|cancel}", requireRole("operator"), async (c) => {
  const id = c.req.param("id");
  const action = c.req.param("action") as Action;
  const rule = ACTIONS[action];
  const parsed = actionSchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const db = c.env.DB;

  const item = await db
    .prepare("SELECT status, assigned_printer FROM queue_items WHERE id = ?")
    .bind(id)
    .first<{ status: QueueStatus; assigned_printer: string | null }>();
  if (!item) return c.json({ error: "Queue item not found" }, 404);
  if (!(rule.from as readonly QueueStatus[]).includes(item.status)) {
    return c.json({ error: `Cannot ${action} an item that is ${item.status}` }, 409);
  }

  let printer: string | null = null;
  if (rule.printer) {
    printer = parsed.data.printer ?? item.assigned_printer;
    if (!printer) return c.json({ error: "printer required" }, 400);
    const known = await db
      .prepare("SELECT 1 FROM printers WHERE serial = ? AND archived = 0")
      .bind(printer)
      .first();
    if (!known) return c.json({ error: "Printer not found" }, 404);
  }

  const now = Date.now();
  // The status guard makes concurrent actions on the same item fail instead of overwriting each other.
  const res = await db
    .prepare(
      `UPDATE queue_items SET status = ?, assigned_printer = ?, updated_at = ?,
         dispatched_at = CASE WHEN ? = 'dispatched' THEN ? WHEN ? = 'queued' THEN NULL ELSE dispatched_at END
       WHERE id = ? AND status = ?`,
    )
    .bind(rule.to, printer, now, rule.to, now, rule.to, id, item.status)
    .run();
  if (res.meta.changes === 0) return c.json({ error: "Queue item changed, reload and try again" }, 409);
  await audit(c, `queue.${action}`, "queue_item", id, printer ? { printer } : undefined);
  return c.json(await loadItem(c.env, id));
});
