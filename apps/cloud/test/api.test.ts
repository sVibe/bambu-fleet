import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { IngestEvent, PrinterLiveState } from "@fleet/shared";
import { analyzeThreeMf } from "@fleet/threemf";
import { buildSample3mf } from "@fleet/threemf/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  JobDetail,
  JobListResponse,
  PartDetail,
  PartListItem,
  PrinterSummary,
  StatsResponse,
  UtilizationResponse,
} from "../src/api-types.ts";
import { sha256Hex } from "../src/worker/auth.ts";
import worker from "../src/worker/index.ts";
import { topFilaments } from "../src/worker/routes/parts.ts";

const AGENT_KEY = "test-agent-key-0123456789";
const SERIAL = "01P00A000000001";
const JOB = "01JOB0000000000000000000A1";

/** Call the Worker as `email` (local dev sign-in), or as an agent when `agentKey` is given. */
async function call(
  path: string,
  init: RequestInit & { as?: string; agentKey?: string; json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.agentKey) headers.set("authorization", `Bearer ${init.agentKey}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`http://localhost${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, DEV_AUTH_EMAIL: init.as ?? "" }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const ADMIN = "admin@example.com";

async function ingest(events: IngestEvent[]) {
  return call("/ingest/events", {
    method: "POST",
    agentKey: AGENT_KEY,
    json: { agentVersion: "test", events },
  });
}

async function sampleAnalysis() {
  const [plate] = await analyzeThreeMf(buildSample3mf(), { fileName: "Gears.gcode.3mf", fileMd5: "abc123" });
  if (!plate) throw new Error("no plate");
  return plate;
}

const TABLES = [
  "queue_items",
  "files",
  "job_parts",
  "job_filaments",
  "jobs",
  "parts",
  "ingest_events",
  "printers",
  "agents",
  "users",
  "audit_log",
];

beforeEach(async () => {
  // Storage persists across tests in this file, so start each one from empty tables.
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("INSERT INTO agents (id, name, key_hash, created_at) VALUES ('agent1', 'Test', ?, 0)")
    .bind(await sha256Hex(AGENT_KEY))
    .run();
});

describe("ingest auth", () => {
  it("rejects missing and unknown agent keys", async () => {
    expect((await call("/ingest/events", { method: "POST", json: {} })).status).toBe(401);
    expect(
      (await call("/ingest/events", { method: "POST", agentKey: "nope-nope-nope-nope", json: {} })).status,
    ).toBe(401);
  });

  it("rejects malformed batches", async () => {
    const res = await call("/ingest/events", { method: "POST", agentKey: AGENT_KEY, json: { events: [] } });
    expect(res.status).toBe(400);
  });
});

describe("job lifecycle", () => {
  async function runJob(status: "finished" | "failed", layer: number) {
    const analysis = await sampleAnalysis();
    const events: IngestEvent[] = [
      { type: "printer.hello", id: "e1", at: 1, serial: SERIAL, name: "P1S-01", model: "P1S" },
      {
        type: "job.started",
        id: "e2",
        at: 2,
        serial: SERIAL,
        jobId: JOB,
        taskId: "1001",
        subtaskId: "2001",
        name: "Gears",
        gcodeFile: "/data/Metadata/plate_1.gcode",
        startedAt: 1_000_000,
        totalLayers: 4,
        amsSnapshot: [],
      },
      { type: "job.analysis", id: "e3", at: 3, serial: SERIAL, jobId: JOB, analysis },
      {
        type: "job.ended",
        id: "e4",
        at: 4,
        serial: SERIAL,
        jobId: JOB,
        endedAt: 4_600_000,
        status,
        progressPct: status === "finished" ? 100 : 50,
        layer,
        totalLayers: 4,
        printError: status === "failed" ? 117473297 : null,
        skippedObjects: [],
      },
    ];
    const res = await ingest(events);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 4, duplicates: 0 });
    return analysis;
  }

  it("records a finished job with filaments, parts and a thumbnail", async () => {
    await runJob("finished", 4);

    const list = (await (await call("/api/jobs", { as: ADMIN })).json()) as JobListResponse;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: JOB,
      name: "Gears",
      printerName: "P1S-01",
      status: "finished",
      durationS: 3600,
      estWeightG: 18.8,
      actualWeightG: 18.8,
      partCount: 2,
      attribution: "gcode",
    });
    expect(list.items[0]?.filaments.map((f) => f.material)).toEqual(["PLA", "PETG"]);

    const detail = (await (await call(`/api/jobs/${JOB}`, { as: ADMIN })).json()) as JobDetail;
    expect(detail.plateIndex).toBe(1);
    expect(detail.parts.map((p) => [p.partName, p.weightG])).toEqual([
      ["Bracket", 4],
      ["Lid", 4],
    ]);
    expect(detail.thumbUrl).toBe(`/api/thumbs/${JOB}`);
    const thumb = await call(detail.thumbUrl as string, { as: ADMIN });
    expect(thumb.headers.get("content-type")).toBe("image/png");
  });

  it("estimates consumption of a failed job from the layer curve", async () => {
    await runJob("failed", 2);
    const detail = (await (await call(`/api/jobs/${JOB}`, { as: ADMIN })).json()) as JobDetail;
    // Layer 2 of 4 ends at 54.41% of the plate's extrusion: 18.8 g × 0.5441.
    expect(detail.actualWeightG).toBeCloseTo(10.23, 2);
    expect(detail.errorCode).toBe(117473297);
  });

  it("ignores redelivered events", async () => {
    await runJob("finished", 4);
    const again = await ingest([
      { type: "printer.hello", id: "e1", at: 1, serial: SERIAL, name: "X", model: null },
    ]);
    expect(await again.json()).toEqual({ applied: 0, duplicates: 1 });
  });

  it("aggregates parts and lets operators merge them", async () => {
    await runJob("finished", 4);
    const list = (await (await call("/api/parts", { as: ADMIN })).json()) as PartListItem[];
    const bracket = list.find((p) => p.name === "Bracket");
    const lid = list.find((p) => p.name === "Lid");
    expect(bracket).toMatchObject({ printedQty: 1, failedQty: 0, totalG: 4, avgG: 4, materials: ["PLA"] });
    expect(bracket?.topFilament).toEqual({ material: "PLA", color: "F98C36", count: 1, share: 1 });

    const merge = await call(`/api/parts/${lid?.id}/merge`, {
      method: "POST",
      as: ADMIN,
      json: { intoId: bracket?.id },
    });
    expect(merge.status).toBe(200);
    const merged = (await (await call(`/api/parts/${bracket?.id}`, { as: ADMIN })).json()) as PartDetail;
    expect(merged.stats.printedQty).toBe(2);
    expect(merged.materials.map((m) => m.material).sort()).toEqual(["PETG", "PLA"]);
    // One part each: a tie resolves alphabetically, at a 50% share.
    expect(merged.stats.topFilament).toMatchObject({ material: "PETG", count: 1, share: 0.5 });
    expect((await call(`/api/parts/${lid?.id}`, { as: ADMIN })).status).toBe(409);
  });

  it("shows each part's own cut-out, falling back to the plate preview", async () => {
    await runJob("finished", 4);
    const list = (await (await call("/api/parts", { as: ADMIN })).json()) as PartListItem[];
    const bracket = list.find((p) => p.name === "Bracket");
    expect(bracket?.image).toEqual({
      url: `/api/thumbs/${JOB}/parts/139`,
      kind: "part",
      jobId: JOB,
      jobName: "Gears",
    });
    const png = await call(bracket?.image?.url as string, { as: ADMIN });
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await call(`/api/thumbs/${JOB}/parts/140`, { as: ADMIN })).status).toBe(404);

    // Re-analysis without cut-outs (an older slicer): the part page shows the plate instead.
    const analysis = await sampleAnalysis();
    for (const p of analysis.parts) delete p.imagePngBase64;
    await ingest([{ type: "job.analysis", id: "e5", at: 5, serial: SERIAL, jobId: JOB, analysis }]);
    const detail = (await (await call(`/api/parts/${bracket?.id}`, { as: ADMIN })).json()) as PartDetail;
    expect(detail.stats.image).toMatchObject({ url: `/api/thumbs/${JOB}`, kind: "plate" });
  });

  it("returns busy intervals clipped to the utilization range", async () => {
    await runJob("finished", 4);
    const res = (await (
      await call("/api/utilization?from=2000000&to=3000000", { as: ADMIN })
    ).json()) as UtilizationResponse;
    expect(res.printers.map((p) => p.serial)).toEqual([SERIAL]);
    expect(res.intervals).toEqual([{ serial: SERIAL, start: 2_000_000, end: 3_000_000 }]);
  });

  it("summarizes stats", async () => {
    await runJob("finished", 4);
    const stats = (await (
      await call("/api/stats?from=0&to=99999999", { as: ADMIN })
    ).json()) as StatsResponse;
    expect(stats.totals).toMatchObject({ jobs: 1, finished: 1, grams: 18.8, successRate: 1, printHours: 1 });
    expect(stats.byPeriod).toEqual([
      { period: "1970-01-01", material: "PETG", grams: 10.4 },
      { period: "1970-01-01", material: "PLA", grams: 8.4 },
    ]);
    expect(stats.topParts).toHaveLength(2);
  });
});

describe("live state", () => {
  it("serves the latest state of the agent's printers", async () => {
    await ingest([{ type: "printer.hello", id: "h1", at: 1, serial: SERIAL, name: "P1S-01", model: "P1S" }]);
    const state: PrinterLiveState = {
      serial: SERIAL,
      online: true,
      gcodeState: "RUNNING",
      jobName: "Gears",
      progressPct: 40,
      remainingMin: 12,
      layer: 2,
      totalLayers: 4,
      nozzleTempC: 220,
      nozzleTargetC: 220,
      bedTempC: 55,
      bedTargetC: 55,
      chamberTempC: null,
      speedLevel: 2,
      printError: 0,
      wifiSignal: "-50dBm",
      ams: [],
      externalSpools: [],
      hms: [],
      updatedAt: Date.now(),
    };
    const foreign = { ...state, serial: "NOT-MINE" };
    const res = await call("/ingest/state", {
      method: "POST",
      agentKey: AGENT_KEY,
      json: { states: [state, foreign] },
    });
    expect(await res.json()).toEqual({ accepted: 1 });

    const printers = (await (await call("/api/printers", { as: ADMIN })).json()) as PrinterSummary[];
    expect(printers).toHaveLength(1);
    expect(printers[0]?.live).toMatchObject({ gcodeState: "RUNNING", progressPct: 40 });
  });
});

describe("users and roles", () => {
  it("requires sign-in", async () => {
    expect((await call("/api/jobs")).status).toBe(401);
  });

  it("gives new users the default viewer role, which cannot edit or administer", async () => {
    const me = await (await call("/api/me", { as: "viewer@example.com" })).json();
    expect(me).toEqual({ email: "viewer@example.com", role: "viewer" });
    expect((await call("/api/admin/users", { as: "viewer@example.com" })).status).toBe(403);
    expect(
      (await call("/api/parts/x", { method: "PATCH", as: "viewer@example.com", json: { name: "y" } })).status,
    ).toBe(403);
  });

  it("bootstraps the admin, who can create agents whose keys work", async () => {
    const me = await (await call("/api/me", { as: ADMIN })).json();
    expect(me).toMatchObject({ role: "admin" });

    const created = await call("/api/admin/agents", {
      method: "POST",
      as: ADMIN,
      json: { name: "Workshop" },
    });
    expect(created.status).toBe(201);
    const { id, key } = (await created.json()) as { id: string; key: string };
    const hello = await call("/ingest/events", {
      method: "POST",
      agentKey: key,
      json: {
        agentVersion: "t",
        events: [{ type: "printer.hello", id: "x1", at: 1, serial: "S2", name: "N", model: null }],
      },
    });
    expect(hello.status).toBe(200);

    await call(`/api/admin/agents/${id}/revoke`, { method: "POST", as: ADMIN });
    const after = await call("/ingest/events", { method: "POST", agentKey: key, json: {} });
    expect(after.status).toBe(401);

    const audit = (await (await call("/api/admin/audit", { as: ADMIN })).json()) as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(["agent.revoke", "agent.create"]);
  });

  it("refuses unknown users when DEFAULT_ROLE is none", async () => {
    const request = new Request("http://localhost/api/me");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      request,
      { ...env, DEV_AUTH_EMAIL: "stranger@example.com", DEFAULT_ROLE: "none" },
      ctx,
    );
    expect(res.status).toBe(403);
  });
});

describe("topFilaments", () => {
  it("picks the material most parts were printed in, and its most common colour", () => {
    const top = topFilaments([
      { part_id: "p", material: "PLA", color: "FFFFFF", n: 10 },
      { part_id: "p", material: "PETG", color: "161616", n: 200 },
      { part_id: "p", material: "PETG", color: "D9D9D9", n: 50 },
    ]);
    expect(top.get("p")).toEqual({ material: "PETG", color: "161616", count: 250, share: 250 / 260 });
  });
});
