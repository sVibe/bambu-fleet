import {
  type LabelTemplate,
  type LabelValues,
  PART_LABEL,
  renderLabelPdf,
  renderLabelZpl,
  shiftTemplate,
} from "@fleet/labels";
import { ulid } from "ulidx";
import type {
  JobDetail,
  PartDetail,
  PrintFormat,
  PrintJobRow,
  PrintJobState,
  PrintPrinter,
} from "../api-types.ts";
import type { Env } from "./env.ts";
import {
  type PrintNode,
  type PrintNodeCapabilities,
  PrintNodeError,
  type PrintNodeState,
  printNodeFor,
} from "./printnode.ts";
import { parseJson } from "./util.ts";

export const LABEL_PRINTER_KEY = "print.label_printer";
export const WEBHOOK_TOKEN_KEY = "printnode.webhook_token";
export const WEBHOOK_ID_KEY = "printnode.webhook_id";

/** Labels that couldn't print within an hour (computer off, printer gone) are dropped by PrintNode. */
const LABEL_EXPIRE_S = 3600;

/** PrintNode's stable states; any other value it reports is ignored. */
const PRINTNODE_STATES = new Set(["new", "sent_to_client", "done", "error", "expired"]);
const FINAL_STATES = ["done", "error", "expired", "failed"] as const;

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export function setSetting(db: D1Database, key: string, value: string | null): D1PreparedStatement {
  return value === null
    ? db.prepare("DELETE FROM settings WHERE key = ?").bind(key)
    : db
        .prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key, value);
}

// --- Printers --------------------------------------------------------------------------------------

export interface PrinterRow {
  id: number;
  name: string;
  description: string | null;
  state: string | null;
  computer_id: number;
  computer_name: string;
  computer_state: string | null;
  capabilities: string | null;
  alias: string | null;
  paper: string | null;
  rotate: number;
  format: PrintFormat | null;
  offset_x_mm: number;
  offset_y_mm: number;
  removed_at: number | null;
  synced_at: number;
}

const tenthsToMm = (v: number | null | undefined) => (typeof v === "number" ? v / 10 : null);

/** Zebra's Windows driver is called ZDesigner; those printers take ZPL as is. */
export function speaksZpl(r: Pick<PrinterRow, "name" | "description">): boolean {
  return /zdesigner|zebra|\bzpl\b/i.test(`${r.name} ${r.description ?? ""}`);
}

/** A printer as the API shows it; labelPaper is matched to the given label size (the default part label's). */
export function toPrinter(
  r: PrinterRow,
  labelSize: { widthMm: number; heightMm: number } = PART_LABEL,
): PrintPrinter {
  const caps = parseJson<PrintNodeCapabilities | null>(r.capabilities, null);
  const dpi = Number.parseInt(caps?.dpis?.[0] ?? "", 10);
  const papers = Object.entries(caps?.papers ?? {}).map(([name, size]) => ({
    name,
    widthMm: tenthsToMm(size?.[0]),
    heightMm: tenthsToMm(size?.[1]),
  }));
  return {
    id: r.id,
    name: r.name,
    alias: r.alias,
    description: r.description,
    state: r.state,
    computerName: r.computer_name,
    computerState: r.computer_state,
    papers,
    paper: r.paper,
    labelPaper: r.paper ?? matchPaper(papers, labelSize.widthMm, labelSize.heightMm) ?? null,
    format: r.format === "pdf" || r.format === "zpl" ? r.format : null,
    sendsAs: r.format === "pdf" || r.format === "zpl" ? r.format : speaksZpl(r) ? "zpl" : "pdf",
    dpi: Number.isFinite(dpi) && dpi > 0 ? dpi : null,
    offsetMm: { x: r.offset_x_mm ?? 0, y: r.offset_y_mm ?? 0 },
    rotate: ([0, 90, 180, 270].includes(r.rotate) ? r.rotate : 0) as PrintPrinter["rotate"],
    syncedAt: r.synced_at,
  };
}

/** The driver's paper that matches a label size within 1 mm, either way round. */
export function matchPaper(
  papers: PrintPrinter["papers"],
  widthMm: number,
  heightMm: number,
): string | undefined {
  const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 1;
  return papers.find(
    (p) =>
      (near(p.widthMm, widthMm) && near(p.heightMm, heightMm)) ||
      (near(p.widthMm, heightMm) && near(p.heightMm, widthMm)),
  )?.name;
}

/** Copy the account's printers into print_printers, keeping the dashboard's own settings. */
export async function syncPrinters(env: Env, client: PrintNode): Promise<number> {
  const printers = await client.printers();
  const now = Date.now();
  const db = env.DB;
  const statements = printers.map((p) =>
    db
      .prepare(
        `INSERT INTO print_printers
           (id, name, description, state, computer_id, computer_name, computer_state, capabilities, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
           state = excluded.state, computer_id = excluded.computer_id, computer_name = excluded.computer_name,
           computer_state = excluded.computer_state, capabilities = excluded.capabilities,
           removed_at = NULL, synced_at = excluded.synced_at`,
      )
      .bind(
        p.id,
        p.name,
        p.description ?? null,
        p.state ?? null,
        p.computer.id,
        p.computer.name,
        p.computer.state ?? null,
        p.capabilities ? JSON.stringify(p.capabilities) : null,
        now,
      ),
  );
  statements.push(
    db
      .prepare("UPDATE print_printers SET removed_at = ? WHERE synced_at < ? AND removed_at IS NULL")
      .bind(now, now),
  );
  await db.batch(statements);
  return printers.length;
}

export async function loadPrinter(db: D1Database, id: number): Promise<PrinterRow | null> {
  return db
    .prepare("SELECT * FROM print_printers WHERE id = ? AND removed_at IS NULL")
    .bind(id)
    .first<PrinterRow>();
}

// --- Print jobs ------------------------------------------------------------------------------------

export interface PrintJobDbRow {
  id: string;
  printnode_id: number | null;
  printer_id: number;
  printer_name: string | null;
  template: string;
  entity: string | null;
  entity_id: string | null;
  title: string;
  copies: number;
  state: PrintJobState;
  message: string | null;
  requested_by: string;
  created_at: number;
  updated_at: number;
}

/** Print jobs with their printer's display name. */
export const PRINT_JOB_SELECT = `
  SELECT j.*, COALESCE(p.alias, p.name) AS printer_name
  FROM print_jobs j LEFT JOIN print_printers p ON p.id = j.printer_id`;

export function toPrintJob(r: PrintJobDbRow): PrintJobRow {
  return {
    id: r.id,
    printNodeId: r.printnode_id,
    printerId: r.printer_id,
    printerName: r.printer_name,
    template: r.template,
    entity: r.entity,
    entityId: r.entity_id,
    title: r.title,
    copies: r.copies,
    state: r.state,
    message: r.message,
    requestedBy: r.requested_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface PrintRequest {
  printer: PrinterRow;
  template: string;
  title: string;
  label: LabelTemplate;
  values: LabelValues;
  copies: number;
  entity: string | null;
  entityId: string | null;
  requestedBy: string;
}

/**
 * Record the job, then hand it to PrintNode. Our id is the idempotency key, so a retried request can
 * never print twice. Returns the stored job, in state "new" or "failed".
 */
export async function submitPrint(env: Env, client: PrintNode, req: PrintRequest): Promise<PrintJobRow> {
  const db = env.DB;
  const id = ulid();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO print_jobs (id, printer_id, template, entity, entity_id, title, copies, state, requested_by,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'submitting', ?, ?, ?)`,
    )
    .bind(
      id,
      req.printer.id,
      req.template,
      req.entity,
      req.entityId,
      req.title,
      req.copies,
      req.requestedBy,
      now,
      now,
    )
    .run();

  const printer = toPrinter(req.printer);
  const paper = printer.paper ?? matchPaper(printer.papers, req.label.widthMm, req.label.heightMm);
  try {
    // ZPL carries the label's size and is placed by the printer's gap sensor; a PDF depends on the paper
    // the driver is set up with, which put a Zebra's labels 7 mm too high.
    const document =
      printer.sendsAs === "zpl"
        ? {
            type: "raw" as const,
            bytes: new TextEncoder().encode(
              await renderLabelZpl(req.label, req.values, {
                dpi: printer.dpi ?? 203,
                upsideDown: printer.rotate === 180,
                offsetMm: printer.offsetMm,
              }),
            ),
          }
        : {
            type: "pdf" as const,
            bytes: await renderLabelPdf(
              shiftTemplate(req.label, printer.offsetMm.x, printer.offsetMm.y),
              req.values,
            ),
          };
    const printNodeId = await client.createJob({
      printerId: req.printer.id,
      title: req.title,
      document,
      qty: req.copies,
      // The PDF is exactly the label's size: print it as is. Scaling it to the driver's paper made a
      // label meant for 57×32 mm come out enlarged, turned and cut off on a driver still set to 4×6.
      options: {
        ...(paper ? { paper } : {}),
        ...(printer.rotate ? { rotate: printer.rotate } : {}),
        fit_to_page: false,
      },
      expireAfter: LABEL_EXPIRE_S,
      idempotencyKey: id,
    });
    await db
      .prepare(
        "UPDATE print_jobs SET printnode_id = ?, state = 'new', state_at = ?, updated_at = ? WHERE id = ?",
      )
      .bind(printNodeId, now, Date.now(), id)
      .run();
  } catch (err) {
    const message = err instanceof PrintNodeError ? err.message : "Couldn't send the job to PrintNode";
    if (!(err instanceof PrintNodeError)) console.error("print submit failed", err);
    await db
      .prepare("UPDATE print_jobs SET state = 'failed', message = ?, updated_at = ? WHERE id = ?")
      .bind(message, Date.now(), id)
      .run();
  }
  const row = await db.prepare(`${PRINT_JOB_SELECT} WHERE j.id = ?`).bind(id).first<PrintJobDbRow>();
  if (!row) throw new Error("print job vanished");
  return toPrintJob(row);
}

/**
 * Record a state PrintNode reported for one of our jobs. Older reports than the one stored are ignored,
 * and a finished job never goes back to an in-between state.
 */
export function applyState(
  db: D1Database,
  printNodeId: number,
  state: string,
  message: string | null,
  at: number,
): D1PreparedStatement | null {
  if (!PRINTNODE_STATES.has(state) || !Number.isFinite(at)) return null;
  const final = (FINAL_STATES as readonly string[]).includes(state) ? 1 : 0;
  // PrintNode often repeats the state as the message ("done"); keep only real explanations.
  const note = message?.trim() && message.trim().toLowerCase() !== state ? message.trim() : null;
  return db
    .prepare(
      `UPDATE print_jobs SET state = ?, message = ?, state_at = ?, updated_at = ?
       WHERE printnode_id = ? AND (state_at IS NULL OR state_at <= ?)
         AND (? = 1 OR state NOT IN (${FINAL_STATES.map((s) => `'${s}'`).join(", ")}))`,
    )
    .bind(state, note, at, Date.now(), printNodeId, at, final);
}

/** Jobs still on their way that webhooks may have missed (PrintNode retries a delivery only once). */
const POLL_WINDOW_MS = 3 * 24 * 3_600_000;
/** A job stuck in "submitting" means the Worker stopped before PrintNode answered. */
const SUBMIT_TIMEOUT_MS = 10 * 60_000;

/** Cron: refresh printers and the state of unfinished jobs. */
export async function pollPrinting(env: Env): Promise<{ printers: number; jobs: number } | null> {
  const client = printNodeFor(env);
  if (!client) return null;
  const db = env.DB;
  const now = Date.now();
  const printers = await syncPrinters(env, client);

  await db
    .prepare(
      `UPDATE print_jobs SET state = 'failed', message = 'Sending to PrintNode didn''t complete', updated_at = ?
       WHERE state = 'submitting' AND created_at < ?`,
    )
    .bind(now, now - SUBMIT_TIMEOUT_MS)
    .run();

  const open = await db
    .prepare(
      `SELECT printnode_id FROM print_jobs
       WHERE state IN ('new', 'sent_to_client') AND printnode_id IS NOT NULL AND created_at > ?
       ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(now - POLL_WINDOW_MS)
    .all<{ printnode_id: number }>();
  const ids = open.results.map((r) => r.printnode_id);
  if (ids.length === 0) return { printers, jobs: 0 };

  // Keep each job's latest stable state.
  const latest = new Map<number, PrintNodeState>();
  for (const s of await client.states(ids)) {
    if (!PRINTNODE_STATES.has(s.state)) continue;
    const seen = latest.get(s.printJobId);
    if (!seen || Date.parse(s.createTimestamp) >= Date.parse(seen.createTimestamp))
      latest.set(s.printJobId, s);
  }
  const statements = [...latest.values()].flatMap((s) => {
    const statement = applyState(db, s.printJobId, s.state, s.message, Date.parse(s.createTimestamp));
    return statement ? [statement] : [];
  });
  if (statements.length) await db.batch(statements);
  return { printers, jobs: ids.length };
}

// --- Label values ----------------------------------------------------------------------------------

function dateParts(at: number, timeZone: string): { date: string; time: string } {
  const format = (locale: string, options: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(at);
    } catch {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(at);
    }
  };
  return {
    date: format("da-DK", { day: "2-digit", month: "2-digit", year: "numeric" }),
    time: format("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

const num = (n: number | null | undefined, digits: number) =>
  n === null || n === undefined ? "–" : String(Math.round(n * 10 ** digits) / 10 ** digits);

interface LabelValueOptions {
  /** Quantity entered when printing, for label.qty. */
  qty: number | null;
  now: number;
  origin: string;
  timeZone: string;
}

const labelGroup = (opts: LabelValueOptions, qty: number | null): LabelValues => {
  const printed = dateParts(opts.now, opts.timeZone);
  return { "label.qty": qty ? `${qty} pcs` : "", "label.date": printed.date, "label.time": printed.time };
};

/** Values for part label placeholders (LABEL_VARIABLES.part in @fleet/labels). */
export function partLabelValues(detail: PartDetail, opts: LabelValueOptions): LabelValues {
  const { part, stats } = detail;
  return {
    "part.number": part.partNumber?.trim() || part.name,
    "part.name": part.name,
    "part.notes": part.notes ?? "",
    "part.material": stats.topFilament?.material ?? stats.materials[0] ?? "–",
    "part.materials": stats.materials.join(", ") || "–",
    "part.avg_g": num(stats.avgG, 1),
    "part.total_g": num(stats.totalG, 0),
    "part.printed": String(stats.printedQty),
    "part.failed": String(stats.failedQty),
    "part.jobs": String(stats.jobs),
    "part.last_printed": stats.lastPrintedAt ? dateParts(stats.lastPrintedAt, opts.timeZone).date : "–",
    "part.url": `${opts.origin}/parts/${part.id}`,
    ...labelGroup(opts, opts.qty),
  };
}

function durationText(seconds: number | null): string {
  if (seconds === null) return "–";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/**
 * Values for job label placeholders (LABEL_VARIABLES.job in @fleet/labels). The part.* values are
 * those of the part the job printed most pieces of; label.qty is those pieces unless a quantity is given.
 */
export function jobLabelValues(job: JobDetail, opts: LabelValueOptions): LabelValues {
  const groups = new Map<
    string,
    { number: string; name: string; qty: number; grams: number; weighed: number }
  >();
  for (const p of job.parts) {
    if (p.skipped) continue;
    const g = groups.get(p.partId) ?? {
      number: p.partNumber?.trim() || p.partName,
      name: p.partName,
      qty: 0,
      grams: 0,
      weighed: 0,
    };
    g.qty++;
    if (p.weightG !== null) {
      g.grams += p.weightG;
      g.weighed++;
    }
    groups.set(p.partId, g);
  }
  const parts = [...groups.values()].sort((a, b) => b.qty - a.qty);
  const main = parts[0];
  const pieces = parts.reduce((n, p) => n + p.qty, 0);
  const materials = [...new Set(job.filaments.map((f) => f.material).filter((m): m is string => Boolean(m)))];
  const started = dateParts(job.startedAt, opts.timeZone);
  return {
    "part.number": main?.number ?? job.name,
    "part.name": main?.name ?? job.name,
    "part.qty": main ? String(main.qty) : "",
    "part.g": main?.weighed ? num(main.grams / main.weighed, 1) : "–",
    "job.name": job.name,
    "job.printer": job.printerName,
    "job.status": job.status,
    "job.started": `${started.date} ${started.time}`,
    "job.ended": job.endedAt ? dateParts(job.endedAt, opts.timeZone).date : "–",
    "job.duration": durationText(job.durationS),
    "job.plate": job.plateIndex === null ? "–" : String(job.plateIndex),
    "job.file": job.fileName ?? "",
    "job.material": materials.join(", ") || "–",
    "job.grams": num(job.actualWeightG ?? job.estWeightG, 0),
    "job.waste_g": num(job.wasteG, 0),
    "job.pieces": String(pieces),
    "job.parts": parts.map((p) => `${p.number} ×${p.qty}`).join(", "),
    "job.url": `${opts.origin}/jobs/${job.id}`,
    ...labelGroup(opts, opts.qty ?? main?.qty ?? null),
  };
}
