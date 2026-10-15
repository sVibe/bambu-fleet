import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestEvent, IngestEventOf, PrinterLiveState } from "@fleet/shared";
import { ingestBatchSchema } from "@fleet/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { CloudSender, SendResult } from "../src/cloud.ts";
import { buildDemoSession } from "../src/demo.ts";
import { LocalDirFetcher } from "../src/fetchers/localDir.ts";
import type { Logger } from "../src/log.ts";
import { ReplaySource } from "../src/sources/replay.ts";
import { AgentStore } from "../src/store.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

class FakeSender implements CloudSender {
  events: IngestEvent[] = [];
  states: PrinterLiveState[] = [];
  failNext = 0;
  async sendEvents(events: IngestEvent[]): Promise<SendResult> {
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, status: 503, error: "down" };
    }
    // Whatever the agent sends must pass the cloud's schema.
    ingestBatchSchema.parse({ agentVersion: "test", events });
    this.events.push(...events);
    return { ok: true };
  }
  async sendStates(states: PrinterLiveState[]): Promise<SendResult> {
    this.states.push(...states);
    return { ok: true };
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function replayDemo(sender = new FakeSender()) {
  const { session, files } = buildDemoSession();
  const dir = mkdtempSync(join(tmpdir(), "fleet-agent-"));
  dirs.push(dir);
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);

  const start = 1_760_000_000_000;
  let clock = start;
  const source = new ReplaySource(session, Number.POSITIVE_INFINITY, start);
  const store = new AgentStore(":memory:");
  let n = 0;
  const agent = new Agent({
    printers: source.printers,
    source,
    fetcher: new LocalDirFetcher(dir),
    store,
    sender,
    log: quiet,
    now: () => clock,
    newId: () => `id${String(++n).padStart(4, "0")}`,
    analysisDelayMs: 0,
    timers: false,
  });
  agent.start();
  await source.done;
  clock = start + 60_000;
  return { agent, store, sender, start };
}

describe("Agent replay of the demo session", () => {
  it("emits hello, start, analysis and end events for each printer", async () => {
    const { agent, sender, store } = await replayDemo();
    await agent.runAnalyses();
    await agent.flushOutbox();
    await agent.flushLive();

    expect(store.pendingCount()).toBe(0);
    const byType = (t: IngestEvent["type"]) => sender.events.filter((e) => e.type === t);
    expect(byType("printer.hello").map((e) => e.serial)).toHaveLength(3);

    const started = byType("job.started") as IngestEventOf<"job.started">[];
    expect(started.map((e) => e.name).sort()).toEqual(["Bracket set", "Lid batch", "Spacer test"]);

    const ended = byType("job.ended") as IngestEventOf<"job.ended">[];
    const statusByJob = Object.fromEntries(
      ended.map((e) => [started.find((s) => s.jobId === e.jobId)?.name, e.status]),
    );
    expect(statusByJob).toEqual({
      "Bracket set": "finished",
      "Lid batch": "failed",
      "Spacer test": "cancelled",
    });

    const analyses = byType("job.analysis") as IngestEventOf<"job.analysis">[];
    expect(analyses).toHaveLength(2);
    const bracket = analyses.find((a) => a.analysis.fileName === "Bracket set.gcode.3mf")?.analysis;
    expect(bracket?.attribution).toBe("gcode");
    expect(bracket?.parts.map((p) => [p.name, p.weightG])).toEqual([
      ["Bracket", 24],
      ["Bracket", 24],
      ["Clip", 14.4],
    ]);
    expect(bracket?.fileMd5).toMatch(/^[0-9a-f]{32}$/);

    // Live state reflects the end of the session.
    const last = new Map(sender.states.map((s) => [s.serial, s]));
    expect(last.get("01P00A000000001")?.gcodeState).toBe("FINISH");
    expect(last.get("00M00A000000002")).toMatchObject({ gcodeState: "FAILED", printError: 0x07008011 });
    expect(last.get("03919A000000003")?.gcodeState).toBe("IDLE");
  });

  it("keeps events in the outbox until the cloud accepts them", async () => {
    const sender = new FakeSender();
    sender.failNext = 1;
    const { agent, store, start } = await replayDemo(sender);
    await agent.flushOutbox();
    expect(sender.events).toHaveLength(0);
    const queued = store.pendingCount();
    expect(queued).toBeGreaterThan(0);
    // Retries are scheduled with backoff; once due they go through.
    expect(store.dueEvents(start + 60_000, 100)).toHaveLength(0);
    expect(store.dueEvents(start + 70_000, 100).length).toBe(Math.min(queued, 100));
  });
});
