import { readFileSync } from "node:fs";
import type { PrinterSource, SourceHandlers } from "./types.ts";

/**
 * Replays a recorded session (JSON Lines) through the normal pipeline, for demos and tests.
 *
 *   {"printer": {"serial": "...", "name": "...", "model": "P1S"}}   declares a printer
 *   {"t": 0, "serial": "...", "connected": true}                     connection change
 *   {"t": 1500, "serial": "...", "payload": {"print": {...}}}        MQTT report, t in ms
 */
export interface ReplayPrinter {
  serial: string;
  name: string;
  model: string | null;
}

type Line =
  | { printer: ReplayPrinter }
  | { t: number; serial: string; connected: boolean }
  | { t: number; serial: string; payload: Record<string, unknown> };

export function parseReplay(text: string): {
  printers: ReplayPrinter[];
  steps: Exclude<Line, { printer: unknown }>[];
} {
  const printers: ReplayPrinter[] = [];
  const steps: Exclude<Line, { printer: unknown }>[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const line = JSON.parse(raw) as Line;
    if ("printer" in line) printers.push({ ...line.printer, model: line.printer.model ?? null });
    else steps.push(line);
  }
  steps.sort((a, b) => a.t - b.t);
  return { printers, steps };
}

export class ReplaySource implements PrinterSource {
  readonly printers: ReplayPrinter[];
  private readonly steps: ReturnType<typeof parseReplay>["steps"];
  private stopped = false;
  private resolveDone!: () => void;
  /** Resolves once every step has been delivered. */
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  /** Playback speed multiplier; Infinity delivers everything immediately. */
  private readonly speed: number;
  /** Wall-clock time of t=0 (lets tests use a fixed clock). */
  private readonly startAt: number;

  constructor(text: string, speed: number, startAt: number = Date.now()) {
    this.speed = speed;
    this.startAt = startAt;
    const parsed = parseReplay(text);
    this.printers = parsed.printers;
    this.steps = parsed.steps;
  }

  static fromFile(path: string, speed: number): ReplaySource {
    return new ReplaySource(readFileSync(path, "utf8"), speed);
  }

  start(handlers: SourceHandlers): void {
    void this.run(handlers);
  }

  private async run(handlers: SourceHandlers): Promise<void> {
    let previous = 0;
    for (const step of this.steps) {
      if (this.stopped) break;
      const wait = (step.t - previous) / this.speed;
      previous = step.t;
      if (wait > 0 && Number.isFinite(wait)) await new Promise((r) => setTimeout(r, wait));
      const at = this.startAt + step.t;
      if ("payload" in step) handlers.onReport(step.serial, step.payload, at);
      else handlers.onConnection(step.serial, step.connected, at);
    }
    this.resolveDone();
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
