import { z } from "zod";
import { amsUnitSchema, printerLiveStateSchema } from "./printer.ts";

export const JOB_STATUSES = ["printing", "finished", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const filamentUsageSchema = z.object({
  /** Slicer filament id, starting at 1 (`<filament id>` in slice_info.config). */
  idx: z.number().int().min(1),
  trayInfoIdx: z.string().nullable(),
  material: z.string().nullable(),
  /** RRGGBB hex, no alpha. */
  color: z.string().nullable(),
  usedG: z.number().nullable(),
  usedM: z.number().nullable(),
  /** Portion of usedG that went to purge, prime tower and other non-object extrusion. */
  wasteG: z.number().nullable(),
});
export type FilamentUsage = z.infer<typeof filamentUsageSchema>;

export const partUsageSchema = z.object({
  /** Object instance id: `identify_id` in slice_info.config, `unique label id` in the G-code. */
  identifyId: z.string(),
  name: z.string(),
  skipped: z.boolean(),
  /** Grams extruded inside this object's G-code labels, including its supports. */
  weightG: z.number().nullable(),
  /** This object's proportional share of the plate's waste. */
  wasteShareG: z.number().nullable(),
  /** Grams per slicer filament id. */
  perFilament: z.record(z.string(), z.number()),
  /** Top-down cut-out of this object; sent for one object per distinct part name. */
  imagePngBase64: z.string().max(1_500_000).nullable().optional(),
});
export type PartUsage = z.infer<typeof partUsageSchema>;

export const ATTRIBUTION_METHODS = ["gcode", "even", "none"] as const;

export const jobAnalysisSchema = z.object({
  fileName: z.string().nullable(),
  fileMd5: z.string().nullable(),
  plateIndex: z.number().int(),
  printerModelId: z.string().nullable(),
  estWeightG: z.number().nullable(),
  estLengthM: z.number().nullable(),
  estTimeS: z.number().nullable(),
  wasteG: z.number().nullable(),
  /** How per-part grams were derived: G-code labels, an even split, or not at all. */
  attribution: z.enum(ATTRIBUTION_METHODS),
  filaments: z.array(filamentUsageSchema),
  parts: z.array(partUsageSchema),
  /** Cumulative fraction (0..1) of the plate's extrusion at the end of each layer; index 0 = layer 1. */
  layerCurve: z.array(z.number()).nullable(),
  thumbnailPngBase64: z.string().nullable(),
});
export type JobAnalysis = z.infer<typeof jobAnalysisSchema>;

const eventBase = {
  /** Idempotency key; the cloud ignores an event id it has already applied. */
  id: z.string().min(1).max(64),
  at: z.number(),
  serial: z.string().min(1),
};

export const printerHelloEvent = z.object({
  ...eventBase,
  type: z.literal("printer.hello"),
  name: z.string(),
  model: z.string().nullable(),
});

export const jobStartedEvent = z.object({
  ...eventBase,
  type: z.literal("job.started"),
  jobId: z.string(),
  taskId: z.string().nullable(),
  subtaskId: z.string().nullable(),
  name: z.string(),
  gcodeFile: z.string().nullable(),
  startedAt: z.number(),
  totalLayers: z.number().int().nullable(),
  amsSnapshot: z.array(amsUnitSchema),
});

export const jobEndedEvent = z.object({
  ...eventBase,
  type: z.literal("job.ended"),
  jobId: z.string(),
  endedAt: z.number(),
  status: z.enum(["finished", "failed", "cancelled"]),
  progressPct: z.number().nullable(),
  layer: z.number().int().nullable(),
  totalLayers: z.number().int().nullable(),
  printError: z.number().int().nullable(),
  skippedObjects: z.array(z.string()),
});

export const jobAnalysisEvent = z.object({
  ...eventBase,
  type: z.literal("job.analysis"),
  jobId: z.string(),
  analysis: jobAnalysisSchema,
});

export const ingestEventSchema = z.discriminatedUnion("type", [
  printerHelloEvent,
  jobStartedEvent,
  jobEndedEvent,
  jobAnalysisEvent,
]);
export type IngestEvent = z.infer<typeof ingestEventSchema>;
export type IngestEventOf<T extends IngestEvent["type"]> = Extract<IngestEvent, { type: T }>;

export const MAX_EVENTS_PER_BATCH = 50;

export const ingestBatchSchema = z.object({
  agentVersion: z.string(),
  events: z.array(ingestEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type IngestBatch = z.infer<typeof ingestBatchSchema>;

/** Response of `POST /ingest/state`. */
export interface IngestStateResponse {
  accepted: number;
  /** Serials this agent sent but doesn't own: another agent registered those printers. */
  rejected: string[];
  /** The server's clock, so the agent can warn when its own clock is off. */
  serverNow: number;
}

export const ingestStateSchema = z.object({
  states: z.array(printerLiveStateSchema).max(200),
});
export type IngestState = z.infer<typeof ingestStateSchema>;
