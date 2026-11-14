import { z } from "zod";

/** `gcode_state` values reported by Bambu printers over MQTT. */
export const GCODE_STATES = [
  "IDLE",
  "INIT",
  "SLICING",
  "PREPARE",
  "RUNNING",
  "PAUSE",
  "FINISH",
  "FAILED",
  "UNKNOWN",
] as const;
export type GcodeState = (typeof GCODE_STATES)[number];

export function toGcodeState(value: unknown): GcodeState {
  return typeof value === "string" && (GCODE_STATES as readonly string[]).includes(value)
    ? (value as GcodeState)
    : "UNKNOWN";
}

/** States in which a print job is considered in progress. */
export const ACTIVE_STATES: ReadonlySet<GcodeState> = new Set(["PREPARE", "RUNNING", "PAUSE", "SLICING"]);

export const trayStateSchema = z.object({
  /** Slot index within its AMS unit (0-3), or 0 for an external spool. */
  id: z.number().int(),
  material: z.string().nullable(),
  /** RRGGBB hex, no alpha. */
  color: z.string().nullable(),
  trayInfoIdx: z.string().nullable(),
  /** Remaining filament percentage when the printer knows it (RFID spools), else null. */
  remainPct: z.number().nullable(),
  /** True when an RFID-tagged Bambu spool is loaded. */
  rfid: z.boolean(),
});
export type TrayState = z.infer<typeof trayStateSchema>;

export const amsUnitSchema = z.object({
  id: z.number().int(),
  humidity: z.number().nullable(),
  tempC: z.number().nullable(),
  trays: z.array(trayStateSchema),
});
export type AmsUnit = z.infer<typeof amsUnitSchema>;

export const hmsEntrySchema = z.object({
  /** Full 16-hex-digit HMS code, e.g. `0300120000020001`. */
  code: z.string(),
  severity: z.number().int().nullable(),
});

/** Normalized, source-independent live state of one printer. */
export const printerLiveStateSchema = z.object({
  serial: z.string(),
  online: z.boolean(),
  gcodeState: z.enum(GCODE_STATES),
  jobName: z.string().nullable(),
  progressPct: z.number().nullable(),
  remainingMin: z.number().nullable(),
  layer: z.number().int().nullable(),
  totalLayers: z.number().int().nullable(),
  nozzleTempC: z.number().nullable(),
  nozzleTargetC: z.number().nullable(),
  bedTempC: z.number().nullable(),
  bedTargetC: z.number().nullable(),
  chamberTempC: z.number().nullable(),
  speedLevel: z.number().int().nullable(),
  printError: z.number().int().nullable(),
  wifiSignal: z.string().nullable(),
  ams: z.array(amsUnitSchema),
  externalSpools: z.array(trayStateSchema),
  hms: z.array(hmsEntrySchema),
  /** Epoch milliseconds when the agent last received data from the printer, by the agent's clock. */
  updatedAt: z.number(),
  /**
   * Epoch milliseconds when the dashboard received this state, by the server's clock. Set by the
   * Worker, so freshness doesn't depend on the agent machine's clock being right.
   */
  receivedAt: z.number().optional(),
});
export type PrinterLiveState = z.infer<typeof printerLiveStateSchema>;
export type HmsEntry = z.infer<typeof hmsEntrySchema>;

/** Live state older than this is shown as offline. */
export const LIVE_STALE_MS = 2 * 60 * 1000;

/** When the dashboard last heard about this printer: server receive time, else the agent's stamp. */
export const liveSeenAt = (s: PrinterLiveState): number => s.receivedAt ?? s.updatedAt;

/** Online means the agent says the printer is connected, and said so within LIVE_STALE_MS. */
export function isLiveOnline(s: PrinterLiveState | null | undefined, now: number): boolean {
  return !!s && s.online && now - liveSeenAt(s) < LIVE_STALE_MS;
}

/**
 * `print_error` value the printer reports when a user cancels a print (HMS 0300-400C).
 * Bambu reports cancellations as gcode_state FAILED, so this separates them from real failures.
 */
export const PRINT_ERROR_CANCELLED = 50348044;

/** Convert a numeric `print_error` to the `XXXX-XXXX` form used on the Bambu wiki. */
export function formatPrintError(code: number): string {
  const hex = code.toString(16).toUpperCase().padStart(8, "0");
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}
