import { z } from "zod";
import { filamentUsageSchema } from "./ingest.ts";

export const QUEUE_STATUSES = [
  "queued",
  "assigned",
  "dispatched",
  "printing",
  "done",
  "failed",
  "cancelled",
] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/** Statuses in which an item still waits for a printer. */
export const OPEN_QUEUE_STATUSES: ReadonlySet<QueueStatus> = new Set(["queued", "assigned", "dispatched"]);

/**
 * `printer_model_id` written by Bambu Studio into `slice_info.config`, mapped to the model names printers
 * report. Ids not listed here (newer models) are shown as "check manually" instead of being guessed.
 */
const PRINTER_MODEL_IDS: Record<string, string> = {
  "BL-P001": "X1C",
  "BL-P002": "X1",
  C13: "X1E",
  C11: "P1P",
  C12: "P1S",
  N1: "A1 mini",
  N2S: "A1",
  O1D: "H2D",
};

/** Model name for a 3MF `printer_model_id`, or null when the id is unknown. */
export function modelForPrinterModelId(id: string | null | undefined): string | null {
  return (id && PRINTER_MODEL_IDS[id.trim()]) || null;
}

/** Compare key for model names: "Bambu Lab X1 Carbon", "x1c" and "X1C" are the same model. */
export function normalizeModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const key = model
    .toUpperCase()
    .replace(/^BAMBU\s*LAB\s*/, "")
    .replace(/\s*CARBON$/, "C")
    .replace(/[\s_-]+/g, "");
  return key || null;
}

/**
 * Job names as the printer reports them vs. queued file names: case-insensitive, without `.gcode.3mf`, and without
 * the trailing dot the H2D adds ("Bracket set.").
 */
export function normalizeJobName(name: string | null | undefined): string {
  return (name ?? "")
    .trim()
    .replace(/\.+$/, "")
    .replace(/(\.gcode)?\.3mf$/i, "")
    .replace(/\.gcode$/i, "")
    .trim()
    .toLowerCase();
}

/** Plate summary parsed from a 3MF in the browser and stored with the file. */
export const queuePlateSchema = z.object({
  index: z.number().int().min(1),
  printerModelId: z.string().nullable(),
  estTimeS: z.number().nullable(),
  estWeightG: z.number().nullable(),
  wasteG: z.number().nullable(),
  filaments: z.array(filamentUsageSchema).max(64),
  parts: z
    .array(
      z.object({ name: z.string().max(500), count: z.number().int().min(1), weightG: z.number().nullable() }),
    )
    .max(1000),
  /** PNG preview; stored in R2, never in D1. */
  thumbnailPngBase64: z.string().max(2_000_000).nullable().optional(),
});
export type QueuePlateInput = z.infer<typeof queuePlateSchema>;
export type QueuePlate = Omit<QueuePlateInput, "thumbnailPngBase64"> & { thumbUrl: string | null };
