import type { LabelSource, LabelTemplate, LabelValues } from "@fleet/labels";
import type {
  AmsUnit,
  GcodeState,
  JobStatus,
  PrinterLiveState,
  QueuePlate,
  QueueStatus,
  Role,
} from "@fleet/shared";

/** Response shapes of the dashboard API, shared by the Worker and the web app. */

export interface Me {
  email: string;
  role: Role;
}

export interface PrinterSummary {
  serial: string;
  name: string;
  model: string | null;
  lastSeenAt: number | null;
  live: PrinterLiveState | null;
  currentJob: { id: string; name: string; startedAt: number; thumbUrl: string | null } | null;
}

export interface FilamentChip {
  idx: number;
  material: string | null;
  color: string | null;
  weightG: number | null;
}

export interface JobListItem {
  id: string;
  name: string;
  printerSerial: string;
  printerName: string;
  printerModel: string | null;
  status: JobStatus;
  startedAt: number;
  endedAt: number | null;
  durationS: number | null;
  estWeightG: number | null;
  actualWeightG: number | null;
  partCount: number;
  attribution: "gcode" | "even" | "none" | null;
  filaments: FilamentChip[];
  thumbUrl: string | null;
}

export interface JobListResponse {
  items: JobListItem[];
  nextCursor: string | null;
}

export interface JobFilament {
  idx: number;
  trayInfoIdx: string | null;
  material: string | null;
  color: string | null;
  weightG: number | null;
  lengthM: number | null;
  wasteG: number | null;
}

export interface JobPart {
  identifyId: string;
  partId: string;
  partName: string;
  partNumber: string | null;
  objectName: string;
  skipped: boolean;
  weightG: number | null;
  wasteShareG: number | null;
  perFilament: Record<string, number>;
}

export interface JobDetail extends Omit<JobListItem, "filaments"> {
  taskId: string | null;
  plateIndex: number | null;
  fileName: string | null;
  fileMd5: string | null;
  printerModelId: string | null;
  estLengthM: number | null;
  estTimeS: number | null;
  wasteG: number | null;
  progressAtEnd: number | null;
  layerAtEnd: number | null;
  totalLayers: number | null;
  errorCode: number | null;
  skippedObjects: string[];
  amsSnapshot: AmsUnit[];
  filaments: JobFilament[];
  parts: JobPart[];
}

export interface PartListItem {
  id: string;
  name: string;
  printedQty: number;
  failedQty: number;
  jobs: number;
  totalG: number | null;
  avgG: number | null;
  wasteG: number | null;
  lastPrintedAt: number | null;
  materials: string[];
  /**
   * Most used filament: each printed part counts under the filament that supplied most of its
   * grams; share is that material's fraction of printed parts. Null before any finished print.
   */
  topFilament: { material: string; color: string | null; count: number; share: number } | null;
  /**
   * Picture of the part: its own top-down cut-out from the newest job that has one ("part"), else
   * the plate preview of the job with the fewest other parts ("plate"). Null when no job has either.
   */
  image: { url: string; kind: "part" | "plate"; jobId: string; jobName: string } | null;
}

export interface PartDetail {
  part: { id: string; name: string; partNumber: string | null; notes: string | null; createdAt: number };
  stats: PartListItem;
  materials: Array<{ material: string | null; color: string | null; grams: number }>;
  history: Array<{
    jobId: string;
    jobName: string;
    printerName: string;
    status: JobStatus;
    startedAt: number;
    qty: number;
    skipped: number;
    grams: number | null;
  }>;
}

export type StatsBucket = "day" | "week" | "month";

export interface StatsResponse {
  range: { from: number; to: number; bucket: StatsBucket };
  totals: {
    jobs: number;
    finished: number;
    failed: number;
    cancelled: number;
    printing: number;
    grams: number;
    wasteG: number;
    printHours: number;
    /** finished / (finished + failed); cancellations excluded. Null without ended jobs. */
    successRate: number | null;
  };
  byPeriod: Array<{ period: string; material: string; grams: number }>;
  byPrinter: Array<{
    serial: string;
    name: string;
    jobs: number;
    finished: number;
    failed: number;
    grams: number;
    hours: number;
  }>;
  byColor: Array<{ material: string; color: string | null; grams: number }>;
  topParts: Array<{ id: string; name: string; qty: number; grams: number }>;
}

export interface UserRow {
  email: string;
  name: string | null;
  role: Role;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface AgentRow {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string | null;
  lastSeenAt: number | null;
  version: string | null;
  revokedAt: number | null;
  printers: number;
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  details: string | null;
}

export interface QueueFile {
  md5: string;
  filename: string;
  size: number;
  printerModelId: string | null;
  /** Model name for printerModelId, or null when the id is not in the mapping table. */
  model: string | null;
  plates: QueuePlate[];
  uploadedBy: string;
  uploadedAt: number;
  downloadUrl: string;
}

/** How one slicer filament of a plate would be fed from the printer's loaded trays. */
export interface SlotMapping {
  filamentIdx: number;
  material: string | null;
  color: string | null;
  usedG: number | null;
  /** exact: material and colour match; colour: same material, different colour; missing: no tray has it. */
  match: "exact" | "colour" | "missing";
  tray: {
    /** AMS unit id, or null for the external spool holder. */
    amsId: number | null;
    slotId: number;
    /** Slot name as the printer and Bambu Connect show it: A1–A4, B1–B4…, or Ext. */
    label: string;
    material: string | null;
    color: string | null;
    remainPct: number | null;
  } | null;
}

export type MatchVerdict = "ready" | "action" | "wait" | "unsuitable";
export type PrinterReadiness = "ready" | "clear-bed" | "busy" | "offline" | "unknown";

export interface PrinterSuggestion {
  serial: string;
  name: string;
  model: string | null;
  verdict: MatchVerdict;
  /** 0–100, higher is a better fit; only used for ordering. */
  score: number;
  modelCheck: "match" | "mismatch" | "unknown";
  readiness: PrinterReadiness;
  gcodeState: GcodeState | null;
  remainingMin: number | null;
  slots: SlotMapping[];
  issues: Array<{ level: "block" | "warn"; text: string }>;
}

export interface QueueItem {
  id: string;
  title: string;
  plateIndex: number;
  quantity: number;
  completed: number;
  priority: number;
  status: QueueStatus;
  file: Omit<QueueFile, "plates" | "uploadedBy" | "uploadedAt">;
  plate: QueuePlate | null;
  assignedPrinter: { serial: string; name: string } | null;
  jobId: string | null;
  dispatchedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Ranked printers for items that still wait for one; empty otherwise. */
  suggestions: PrinterSuggestion[];
}

/** Messages on the `/api/live` WebSocket. */
/**
 * Bambu's HMS (16 hex digits) and print_error (8 hex digits) texts. Each code maps a printer serial
 * prefix to its text; "" is the default, and a prefix appears only where that model's text differs.
 */
export interface ErrorTextTable {
  /** Bambu's version of the tables, e.g. 202611121903; 0 before the first download. */
  ver: number;
  fetchedAt: number;
  prefixes: string[];
  hms: Record<string, Record<string, string>>;
  error: Record<string, Record<string, string>>;
}

/** Pushed over `/api/live`. `serverNow` lets the browser correct for its own clock being off. */
export type LiveMessage =
  | { type: "snapshot"; states: PrinterLiveState[]; serverNow: number }
  | { type: "states"; states: PrinterLiveState[]; serverNow: number };

export interface UtilizationResponse {
  range: { from: number; to: number };
  printers: Array<{ serial: string; name: string; model: string | null; createdAt: number }>;
  /** Busy time per job, clipped to the range; a job still printing runs until now. */
  intervals: Array<{ serial: string; start: number; end: number }>;
}

/** A printer of the PrintNode account. */
export interface PrintPrinter {
  id: number;
  name: string;
  /** Name given in the dashboard, else null. */
  alias: string | null;
  description: string | null;
  state: string | null;
  computerName: string;
  computerState: string | null;
  /** Paper sizes the driver reports, in millimetres. */
  papers: Array<{ name: string; widthMm: number | null; heightMm: number | null }>;
  /** Paper chosen for labels, or null to pick the one matching the label size. */
  paper: string | null;
  /** The paper labels will print on: the chosen one, else the one matching the label size, else null. */
  labelPaper: string | null;
  /** Label format chosen in the dashboard, or null to pick by the driver name. */
  format: PrintFormat | null;
  /** What labels are actually sent as: ZPL for Zebra drivers unless set otherwise, else PDF. */
  sendsAs: PrintFormat;
  /** Resolution the driver reports, in dots per inch. */
  dpi: number | null;
  /** Millimetres to move labels down and to the right on this printer. */
  offsetMm: { x: number; y: number };
  rotate: 0 | 90 | 180 | 270;
  syncedAt: number;
}

/** pdf goes through the printer's driver; zpl is sent straight to a Zebra label printer. */
export type PrintFormat = "pdf" | "zpl";

export interface PrintPrintersResponse {
  /** Whether a PrintNode API key is set. */
  configured: boolean;
  labelPrinterId: number | null;
  /** Size of the part label, width × height. */
  labelSizeMm: { width: number; height: number };
  printers: PrintPrinter[];
}

/** submitting and failed are the dashboard's own; the others are PrintNode's job states. */
export type PrintJobState = "submitting" | "failed" | "new" | "sent_to_client" | "done" | "error" | "expired";

export interface PrintJobRow {
  id: string;
  printNodeId: number | null;
  printerId: number;
  printerName: string | null;
  template: string;
  entity: string | null;
  entityId: string | null;
  title: string;
  copies: number;
  state: PrintJobState;
  message: string | null;
  requestedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface PrintAdminStatus {
  configured: boolean;
  account: {
    email: string;
    credits: number | null;
    computers: number | null;
    totalPrints: number | null;
  } | null;
  accountError: string | null;
  webhook: {
    /** URL and secret to enter in PrintNode, once created. */
    url: string | null;
    secret: string | null;
    /** PrintNode's id when the dashboard registered it. */
    id: number | null;
    counts: { received: number; successful: number; failed: number; dropped: number } | null;
  };
}

/** A label template: one made in the editor, or a built-in one (which can be copied, not changed). */
export interface LabelTemplateRow {
  id: string;
  name: string;
  source: LabelSource;
  builtIn: boolean;
  /** Printed when a print doesn't name a template. */
  isDefault: boolean;
  template: LabelTemplate;
  /** Sent back when saving; a save over a newer version is refused. */
  version: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface LabelTemplatesResponse {
  templates: LabelTemplateRow[];
}

/** A label's placeholder values for one part or job, for the editor's canvas. */
export interface LabelValuesResponse {
  title: string;
  values: LabelValues;
}

export interface PrintBatchResponse {
  jobs: PrintJobRow[];
}

/** A part's automatic job label: printed each time `threshold` good pieces have been printed. */
export interface AutoLabelSettings {
  enabled: boolean;
  threshold: number;
  /** Good pieces counted since the last label. */
  tally: number;
  /** Automatic labels printed so far. */
  labels: number;
  /** A job label template, or null for the default job label. */
  templateId: string | null;
  /** A PrintNode printer, or null for the default label printer. */
  printerId: number | null;
  updatedBy: string;
  updatedAt: number;
}

/** One automatic label: the job in which the part reached its threshold. */
export interface AutoLabelRun {
  id: string;
  seq: number;
  qty: number;
  jobId: string;
  jobName: string | null;
  createdAt: number;
  /** The print job, or null with an error when none could be sent. */
  printJobId: string | null;
  printState: PrintJobState | null;
  error: string | null;
}

export interface AutoLabelResponse {
  settings: AutoLabelSettings | null;
  runs: AutoLabelRun[];
}
