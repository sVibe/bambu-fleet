import {
  ACTIVE_STATES,
  type AmsUnit,
  type IngestEventOf,
  type JobStatus,
  PRINT_ERROR_CANCELLED,
  toGcodeState,
} from "@fleet/shared";
import { type RawPrint, reportFields } from "./report.ts";

const { int, num, str } = reportFields;

/** A print job the agent is following on one printer; persisted so restarts mid-print keep the same id. */
export interface TrackedJob {
  jobId: string;
  serial: string;
  taskId: string | null;
  subtaskId: string | null;
  name: string | null;
  gcodeFile: string | null;
  startedAt: number;
  totalLayers: number | null;
  /** Whether `job.started` has been emitted (we wait until the job has a name). */
  announced: boolean;
}

export interface TrackerStore {
  loadJob(serial: string): TrackedJob | null;
  saveJob(serial: string, job: TrackedJob | null): void;
}

export type TrackerOutput =
  | { kind: "started"; job: TrackedJob; event: IngestEventOf<"job.started"> }
  | { kind: "ended"; job: TrackedJob; event: IngestEventOf<"job.ended"> };

/** `task_id`/`subtask_id` of "0" or "" mean "no cloud task" (e.g. SD-card prints). */
function realId(v: unknown): string | null {
  const s = str(v);
  return s && s !== "0" ? s : null;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

function startTime(print: RawPrint, at: number): number {
  const seconds = num(print.gcode_start_time);
  if (seconds && seconds > 0) {
    const ms = seconds * 1000;
    if (ms > at - WEEK_MS && ms < at + 60_000) return ms;
  }
  return at;
}

/**
 * Turns the printer's `gcode_state` stream into job start/end events.
 *
 * - Entering PREPARE/RUNNING/PAUSE with no tracked job starts one.
 * - A different cloud `task_id` while active ends the old job and starts a new one.
 * - FINISH → finished; FAILED → failed, or cancelled when `print_error` is the cancel code;
 *   IDLE after an active job → cancelled.
 */
export class JobTracker {
  private job: TrackedJob | null;
  private readonly serial: string;
  private readonly store: TrackerStore;
  private readonly newId: () => string;

  constructor(serial: string, store: TrackerStore, newId: () => string) {
    this.serial = serial;
    this.store = store;
    this.newId = newId;
    this.job = store.loadJob(serial);
  }

  get current(): TrackedJob | null {
    return this.job;
  }

  update(print: RawPrint, ams: AmsUnit[], at: number): TrackerOutput[] {
    const state = toGcodeState(print.gcode_state);
    const out: TrackerOutput[] = [];
    const taskId = realId(print.task_id);

    if (ACTIVE_STATES.has(state)) {
      if (this.job?.taskId && taskId && taskId !== this.job.taskId) {
        out.push(...this.end(print, "cancelled", ams, at));
      }
      if (!this.job) {
        this.job = {
          jobId: this.newId(),
          serial: this.serial,
          taskId,
          subtaskId: realId(print.subtask_id),
          name: null,
          gcodeFile: null,
          startedAt: startTime(print, at),
          totalLayers: null,
          announced: false,
        };
      }
      const job = this.job;
      job.taskId ??= taskId;
      job.subtaskId ??= realId(print.subtask_id);
      job.name = str(print.subtask_name) ?? job.name;
      job.gcodeFile = str(print.gcode_file) ?? job.gcodeFile;
      const total = int(print.total_layer_num);
      if (total && total > 0) job.totalLayers = total;
      if (!job.announced && (job.name || state === "RUNNING")) out.push(this.announce(ams, at));
      this.store.saveJob(this.serial, job);
    } else if (this.job && (state === "FINISH" || state === "FAILED" || state === "IDLE")) {
      const status: Exclude<JobStatus, "printing"> =
        state === "FINISH"
          ? "finished"
          : state === "FAILED" && int(print.print_error) !== PRINT_ERROR_CANCELLED
            ? "failed"
            : "cancelled";
      out.push(...this.end(print, status, ams, at));
    }
    return out;
  }

  private announce(ams: AmsUnit[], at: number): TrackerOutput {
    const job = this.job as TrackedJob;
    job.announced = true;
    return {
      kind: "started",
      job: { ...job },
      event: {
        type: "job.started",
        id: this.newId(),
        at,
        serial: this.serial,
        jobId: job.jobId,
        taskId: job.taskId,
        subtaskId: job.subtaskId,
        name: job.name ?? fileBaseName(job.gcodeFile) ?? "Untitled print",
        gcodeFile: job.gcodeFile,
        startedAt: job.startedAt,
        totalLayers: job.totalLayers,
        amsSnapshot: ams,
      },
    };
  }

  private end(
    print: RawPrint,
    status: Exclude<JobStatus, "printing">,
    ams: AmsUnit[],
    at: number,
  ): TrackerOutput[] {
    const out: TrackerOutput[] = [];
    if (!this.job) return out;
    if (!this.job.announced) out.push(this.announce(ams, at));
    const job = this.job;
    const printError = int(print.print_error);
    out.push({
      kind: "ended",
      job: { ...job },
      event: {
        type: "job.ended",
        id: this.newId(),
        at,
        serial: this.serial,
        jobId: job.jobId,
        endedAt: at,
        status,
        progressPct: num(print.mc_percent),
        layer: int(print.layer_num),
        totalLayers: int(print.total_layer_num) || job.totalLayers,
        printError: printError || null,
        skippedObjects: Array.isArray(print.s_obj) ? print.s_obj.map(String) : [],
      },
    });
    this.job = null;
    this.store.saveJob(this.serial, null);
    return out;
  }
}

export function fileBaseName(path: string | null): string | null {
  if (!path) return null;
  const base = path.split("/").pop() ?? "";
  if (/^plate_\d+\.gcode$/i.test(base)) return null;
  return base.replace(/\.gcode\.3mf$|\.3mf$|\.gcode$/i, "") || null;
}
