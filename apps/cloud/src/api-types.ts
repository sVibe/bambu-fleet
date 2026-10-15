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
}

export interface PartDetail {
  part: { id: string; name: string; notes: string | null; createdAt: number };
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
export type LiveMessage =
  | { type: "snapshot"; states: PrinterLiveState[] }
  | { type: "states"; states: PrinterLiveState[] };
