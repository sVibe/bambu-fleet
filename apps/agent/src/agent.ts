import { createReadStream } from "node:fs";
import { type IngestEvent, MAX_EVENTS_PER_BATCH, type PrinterLiveState } from "@fleet/shared";
import { analyzeThreeMf, plateIndexFromPath, selectPlate } from "@fleet/threemf";
import type { CloudSender } from "./cloud.ts";
import type { JobFileFetcher } from "./fetchers/types.ts";
import { JobTracker } from "./jobTracker.ts";
import { errorMessage, type Logger } from "./log.ts";
import { mergeReport, normalizeReport, type RawPrint } from "./report.ts";
import type { PrinterSource } from "./sources/types.ts";
import type { AgentStore, AnalysisRequest } from "./store.ts";

export interface PrinterInfo {
  serial: string;
  name: string;
  model: string | null;
}

export interface AgentDeps {
  printers: PrinterInfo[];
  source: PrinterSource;
  /** Null disables per-part analysis (no FTPS). */
  fetcher: JobFileFetcher | null;
  store: AgentStore;
  sender: CloudSender;
  log: Logger;
  now?: () => number;
  newId: () => string;
  liveIntervalMs?: number;
  /** Delay before fetching a job's file, so the printer has finished writing it. */
  analysisDelayMs?: number;
  /** Run the periodic loops on timers. Tests drive the tick methods directly instead. */
  timers?: boolean;
}

/** Retry schedule for a job file that isn't on the printer's storage yet. */
const ANALYSIS_BACKOFF_MS = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000];
const HEARTBEAT_MS = 30_000;

/** Wires a printer source to the job tracker, the analysis queue and the cloud uploader. */
export class Agent {
  private readonly deps: AgentDeps;
  private readonly now: () => number;
  private readonly raw = new Map<string, RawPrint>();
  private readonly live = new Map<string, PrinterLiveState>();
  private readonly connected = new Map<string, boolean>();
  private readonly trackers = new Map<string, JobTracker>();
  private readonly dirty = new Set<string>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly busy = new Set<string>();

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    const { printers, store, source, newId } = this.deps;
    for (const p of printers) {
      this.trackers.set(p.serial, new JobTracker(p.serial, store, newId));
      store.enqueue({
        type: "printer.hello",
        id: newId(),
        at: this.now(),
        serial: p.serial,
        name: p.name,
        model: p.model,
      });
    }
    source.start({
      onReport: (serial, payload, at) => this.handleReport(serial, payload, at),
      onConnection: (serial, connected, at) => this.handleConnection(serial, connected, at),
    });
    if (this.deps.timers !== false) {
      const every = (name: string, ms: number, fn: () => Promise<void>) => {
        this.timers.push(setInterval(() => void this.guard(name, fn), ms));
      };
      every("live", this.deps.liveIntervalMs ?? 3000, () => this.flushLive());
      every("outbox", 2000, () => this.flushOutbox());
      every("analysis", 5000, () => this.runAnalyses());
      every("heartbeat", HEARTBEAT_MS, async () => this.heartbeat());
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.deps.source.stop();
  }

  /** Run a loop body unless the previous run is still going. */
  private async guard(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    try {
      await fn();
    } catch (err) {
      this.deps.log.error("loop failed", { loop: name, error: errorMessage(err) });
    } finally {
      this.busy.delete(name);
    }
  }

  handleReport(serial: string, payload: Record<string, unknown>, at: number): void {
    const tracker = this.trackers.get(serial);
    const print = payload.print;
    if (!tracker || !print || typeof print !== "object") return;
    const delta = print as RawPrint;
    // Command responses share the topic; only status pushes describe printer state.
    if (delta.command !== undefined && delta.command !== "push_status") return;

    const merged = mergeReport(this.raw.get(serial) ?? {}, delta);
    this.raw.set(serial, merged);
    this.connected.set(serial, true);
    const state = normalizeReport(serial, merged, true, at);
    this.live.set(serial, state);
    this.dirty.add(serial);

    for (const output of tracker.update(merged, state.ams, at)) {
      this.deps.store.enqueue(output.event);
      if (output.kind === "started") {
        this.deps.log.info("job started", { serial, job: output.event.name, jobId: output.job.jobId });
        if (this.deps.fetcher) {
          const request: AnalysisRequest = {
            jobId: output.job.jobId,
            serial,
            name: output.event.name,
            gcodeFile: output.job.gcodeFile,
            startedAt: output.job.startedAt,
          };
          // Agent clock, not the report time: replays run sessions faster than real time.
          this.deps.store.requestAnalysis(request, this.now() + (this.deps.analysisDelayMs ?? 20_000));
        }
      } else {
        this.deps.log.info("job ended", { serial, jobId: output.job.jobId, status: output.event.status });
      }
    }
  }

  handleConnection(serial: string, connected: boolean, at: number): void {
    if (this.connected.get(serial) === connected) return;
    this.connected.set(serial, connected);
    const state = this.live.get(serial) ?? normalizeReport(serial, this.raw.get(serial) ?? {}, connected, at);
    this.live.set(serial, { ...state, online: connected, updatedAt: at });
    this.dirty.add(serial);
  }

  /** Refresh `updatedAt` so the dashboard can tell a quiet printer from a dead agent. */
  heartbeat(): void {
    const at = this.now();
    for (const [serial, state] of this.live) {
      this.live.set(serial, { ...state, online: this.connected.get(serial) ?? false, updatedAt: at });
      this.dirty.add(serial);
    }
  }

  async flushLive(): Promise<void> {
    if (this.dirty.size === 0) return;
    const serials = [...this.dirty];
    this.dirty.clear();
    const states = serials.flatMap((s) => this.live.get(s) ?? []);
    const res = await this.deps.sender.sendStates(states);
    if (!res.ok) {
      for (const s of serials) this.dirty.add(s);
      this.deps.log.warn("live state push failed", { status: res.status, error: res.error });
    }
  }

  async flushOutbox(): Promise<void> {
    const { store, sender, log } = this.deps;
    while (true) {
      const now = this.now();
      const rows = store.dueEvents(now, MAX_EVENTS_PER_BATCH);
      if (rows.length === 0) return;
      const res = await sender.sendEvents(rows.map((r) => r.event));
      if (res.ok) {
        store.ack(rows.map((r) => r.seq));
        continue;
      }
      if (res.status === 400 || res.status === 422) {
        // Isolate the rejected event(s) so one bad event can't block the queue.
        for (const row of rows) {
          const single = await sender.sendEvents([row.event]);
          if (single.ok) store.ack([row.seq]);
          else if (single.status === 400 || single.status === 422) {
            log.error("event rejected by cloud", {
              id: row.event.id,
              type: row.event.type,
              error: single.error,
            });
            store.deadLetter(row, single.error, now);
          } else store.retryLater([row.seq], now);
        }
        continue;
      }
      log.warn("event upload failed, will retry", {
        status: res.status,
        error: res.error,
        pending: rows.length,
      });
      store.retryLater(
        rows.map((r) => r.seq),
        now,
      );
      return;
    }
  }

  async runAnalyses(): Promise<void> {
    const { store, fetcher, log } = this.deps;
    if (!fetcher) return;
    for (const request of store.dueAnalyses(this.now(), 2)) {
      try {
        const file = await fetcher.fetch(request);
        if (!file) {
          this.postpone(request.jobId, request.attempts, "file not found");
          continue;
        }
        try {
          const plates = await analyzeThreeMf(createReadStream(file.path) as AsyncIterable<Uint8Array>, {
            fileName: file.fileName,
            fileMd5: file.md5,
          });
          const plate = selectPlate(plates, plateIndexFromPath(request.gcodeFile));
          if (plate) {
            const event: IngestEvent = {
              type: "job.analysis",
              id: this.deps.newId(),
              at: this.now(),
              serial: request.serial,
              jobId: request.jobId,
              analysis: plate,
            };
            store.enqueue(event);
            log.info("job analyzed", {
              jobId: request.jobId,
              file: file.fileName,
              grams: plate.estWeightG,
              parts: plate.parts.length,
              attribution: plate.attribution,
            });
          } else {
            log.warn("3mf has no plates", { jobId: request.jobId, file: file.fileName });
          }
          store.finishAnalysis(request.jobId);
        } finally {
          await file.cleanup();
        }
      } catch (err) {
        this.postpone(request.jobId, request.attempts, errorMessage(err));
      }
    }
  }

  private postpone(jobId: string, attempts: number, reason: string): void {
    const delay = ANALYSIS_BACKOFF_MS[attempts];
    if (delay === undefined) {
      this.deps.log.warn("giving up on job file", { jobId, reason });
      this.deps.store.finishAnalysis(jobId);
      return;
    }
    this.deps.log.info("job file not available yet", { jobId, reason, retryInSec: delay / 1000 });
    this.deps.store.postponeAnalysis(jobId, this.now() + delay);
  }

  /** Current normalized state per printer (for probes and tests). */
  snapshot(): PrinterLiveState[] {
    return [...this.live.values()];
  }
}
