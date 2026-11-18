import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { IngestEvent } from "@fleet/shared";
import { analyzeThreeMf } from "@fleet/threemf";
import { buildSample3mf, type SampleObject } from "@fleet/threemf/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoLabelResponse, AutoLabelSettings } from "../src/api-types.ts";
import { sha256Hex } from "../src/worker/auth.ts";
import worker from "../src/worker/index.ts";

const ADMIN = "admin@example.com";
const OPERATOR = "operator@example.com";
const VIEWER = "viewer@example.com";
const AGENT_KEY = "test-agent-key-0123456789";
const SERIAL = "01P00A000000001";
const PART_NAME = "2600067 Bracket";

async function call(
  path: string,
  init: RequestInit & { as?: string; agentKey?: string; json?: unknown; printNode?: boolean } = {},
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
  const res = await worker.fetch(
    request,
    {
      ...env,
      DEV_AUTH_EMAIL: init.as ?? "",
      PRINTNODE_API_KEY: init.printNode === false ? undefined : "test-printnode-key",
    },
    ctx,
  );
  // Automatic labels print after the agent's request is answered.
  await waitOnExecutionContext(ctx);
  return res;
}

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

/** ZPL documents sent to the fake PrintNode. */
let printed: string[] = [];

function mockPrintNode() {
  printed = [];
  let nextId = 9001;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.printnode.com") throw new Error(`unexpected fetch ${url}`);
    const reply = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/printers")
      return reply([
        {
          id: 101,
          name: "ZDesigner GK420d",
          state: "online",
          computer: { id: 7, name: "WORKSHOP-PC", state: "connected" },
          capabilities: { papers: {}, dpis: ["203x203"] },
        },
      ]);
    if (url.pathname === "/printjobs" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { content: string };
      printed.push(atob(body.content));
      return reply(nextId++, 201);
    }
    return reply({ message: "not mocked" }, 404);
  });
}

const TABLES = [
  "part_label_runs",
  "part_auto_labels",
  "print_jobs",
  "print_printers",
  "settings",
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
  const db = env.DB;
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.batch([
    db
      .prepare("INSERT INTO agents (id, name, key_hash, created_at) VALUES ('agent1', 'Test', ?, 0)")
      .bind(await sha256Hex(AGENT_KEY)),
    ...[
      [ADMIN, "admin"],
      [OPERATOR, "operator"],
      [VIEWER, "viewer"],
    ].map(([email, role]) =>
      db.prepare("INSERT INTO users (email, role, created_at) VALUES (?, ?, 0)").bind(email, role),
    ),
  ]);
  mockPrintNode();
  expect((await call("/api/print/printers/sync", { method: "POST", as: ADMIN })).status).toBe(200);
  await call("/api/print/label-printer", { method: "PUT", as: ADMIN, json: { printerId: 101 } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

let jobCount = 0;

/**
 * Run a job printing `pieces` brackets and a lid. Returns the job id. `order` says whether the part
 * data arrives before or after the job ends.
 */
async function runJob(
  pieces: number,
  opts: {
    status?: "finished" | "failed";
    skip?: number;
    order?: "analysis-first" | "end-first";
  } = {},
): Promise<string> {
  jobCount++;
  const jobId = `01JOB${String(jobCount).padStart(21, "0")}`;
  const objects: SampleObject[] = [
    ...Array.from({ length: pieces }, (_, i) => ({
      identifyId: String(100 + i),
      name: PART_NAME,
      filament: 0,
      mmPerLayer: 10,
    })),
    { identifyId: "99", name: "Lid", filament: 0, mmPerLayer: 5 },
  ];
  const [analysis] = await analyzeThreeMf(buildSample3mf({ objects, renders: false }), {
    fileName: "Brackets.gcode.3mf",
    fileMd5: `md5-${jobId}`,
  });
  if (!analysis) throw new Error("no plate");
  const status = opts.status ?? "finished";
  const e = (n: number) => `${jobId}-${n}`;
  const started: IngestEvent = {
    type: "job.started",
    id: e(1),
    at: 1,
    serial: SERIAL,
    jobId,
    taskId: null,
    subtaskId: null,
    name: "Brackets",
    gcodeFile: "/data/Metadata/plate_1.gcode",
    startedAt: 1_763_366_400_000,
    totalLayers: 4,
    amsSnapshot: [],
  };
  const analysed: IngestEvent = { type: "job.analysis", id: e(2), at: 2, serial: SERIAL, jobId, analysis };
  const ended: IngestEvent = {
    type: "job.ended",
    id: e(3),
    at: 3,
    serial: SERIAL,
    jobId,
    endedAt: 1_763_370_000_000,
    status,
    progressPct: status === "finished" ? 100 : 40,
    layer: status === "finished" ? 4 : 2,
    totalLayers: 4,
    printError: null,
    skippedObjects: Array.from({ length: opts.skip ?? 0 }, (_, i) => String(100 + i)),
  };
  const hello: IngestEvent = {
    type: "printer.hello",
    id: "hello",
    at: 0,
    serial: SERIAL,
    name: "X1C-1",
    model: "X1C",
  };
  // Separate requests, as the agent sends them.
  await ingest([hello, started]);
  if (opts.order === "end-first") {
    await ingest([ended]);
    await ingest([analysed]);
  } else {
    await ingest([analysed]);
    await ingest([ended]);
  }
  return jobId;
}

async function ingest(events: IngestEvent[]) {
  const res = await call("/ingest/events", {
    method: "POST",
    agentKey: AGENT_KEY,
    json: { agentVersion: "test", events },
  });
  expect(res.status).toBe(200);
}

async function partId(): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM parts WHERE name = ?")
    .bind(PART_NAME)
    .first<{ id: string }>();
  if (!row) throw new Error("part missing");
  return row.id;
}

const save = (id: string, body: Partial<AutoLabelSettings> & { tally?: number }, as = OPERATOR) =>
  call(`/api/print/auto/parts/${id}`, {
    method: "PUT",
    as,
    json: { enabled: true, threshold: 5, templateId: null, printerId: null, ...body },
  });

const status = (id: string) => json<AutoLabelResponse>(call(`/api/print/auto/parts/${id}`, { as: VIEWER }));

describe("automatic labels", () => {
  it("print a job label each time the threshold is reached, carrying the rest over", async () => {
    await runJob(3); // Before the threshold is set: never counts.
    const id = await partId();
    expect((await save(id, {})).status).toBe(200);

    await runJob(4);
    expect(printed).toHaveLength(0);
    expect((await status(id)).settings).toMatchObject({ tally: 4, labels: 0 });

    // 4 + 13 = 17: three labels of 5, and 2 carried over.
    const job = await runJob(13);
    expect(printed).toHaveLength(3);
    for (const zpl of printed) {
      expect(zpl).toContain("5 pcs");
      expect(zpl).toContain("^FDMA,2600067^FS");
    }
    const after = await status(id);
    expect(after.settings).toMatchObject({ tally: 2, labels: 3 });
    expect(after.runs.map((r) => [r.seq, r.qty, r.jobId, r.printState, r.error])).toEqual([
      [3, 5, job, "new", null],
      [2, 5, job, "new", null],
      [1, 5, job, "new", null],
    ]);
    const jobs = await env.DB.prepare(
      "SELECT title, entity, entity_id, requested_by FROM print_jobs ORDER BY title",
    ).all();
    expect(jobs.results).toEqual(
      [1, 2, 3].map((n) => ({
        title: `Auto label 2600067 #${n}`,
        entity: "job",
        entity_id: job,
        requested_by: "automatic",
      })),
    );
  });

  it("count good pieces of finished jobs once, whichever event comes last", async () => {
    await runJob(1);
    const id = await partId();
    await save(id, {});

    await runJob(6, { skip: 2 }); // 4 good pieces
    await runJob(9, { status: "failed" }); // nothing
    expect((await status(id)).settings?.tally).toBe(4);

    const job = await runJob(1, { order: "end-first" });
    expect((await status(id)).settings).toMatchObject({ tally: 0, labels: 1 });
    expect(printed).toHaveLength(1);

    // The part data sent again (a re-analysis) doesn't count the job a second time.
    const [analysis] = await analyzeThreeMf(
      buildSample3mf({ objects: [{ identifyId: "1", name: PART_NAME, filament: 0, mmPerLayer: 10 }] }),
      { fileName: "Brackets.gcode.3mf", fileMd5: "again" },
    );
    if (!analysis) throw new Error("no plate");
    await ingest([{ type: "job.analysis", id: "again", at: 9, serial: SERIAL, jobId: job, analysis }]);
    expect((await status(id)).settings).toMatchObject({ tally: 0, labels: 1 });
    expect(printed).toHaveLength(1);
  });

  it("don't count while disabled, and keep the count for when they're enabled again", async () => {
    await runJob(1);
    const id = await partId();
    await save(id, { tally: 3 });
    await save(id, { enabled: false });
    await runJob(4);
    expect((await status(id)).settings).toMatchObject({ enabled: false, tally: 3, labels: 0 });
    await save(id, { enabled: true });
    await runJob(2);
    expect((await status(id)).settings).toMatchObject({ tally: 0, labels: 1 });
    expect(printed).toHaveLength(1);
  });

  it("record a label that couldn't print, and print it again on request", async () => {
    await runJob(1);
    const id = await partId();
    await save(id, {});
    await call("/api/print/label-printer", { method: "PUT", as: ADMIN, json: { printerId: null } });
    await runJob(5);
    const [run] = (await status(id)).runs;
    expect(run).toMatchObject({ seq: 1, printJobId: null });
    expect(run?.error).toMatch(/No label printer/);
    expect(printed).toHaveLength(0);

    await save(id, { printerId: 101 });
    expect((await call(`/api/print/auto/runs/${run?.id}/print`, { method: "POST", as: VIEWER })).status).toBe(
      403,
    );
    const res = await call(`/api/print/auto/runs/${run?.id}/print`, { method: "POST", as: OPERATOR });
    expect(res.status).toBe(201);
    expect(printed).toHaveLength(1);
    expect((await status(id)).runs[0]).toMatchObject({ printState: "new", error: null });
  });

  it("are set by operators, with a job label and a count below the threshold", async () => {
    await runJob(1);
    const id = await partId();
    expect((await save(id, {}, VIEWER)).status).toBe(403);
    expect((await save(id, { threshold: 0 })).status).toBe(400);
    expect((await save(id, { tally: 5 })).status).toBe(400);
    expect((await save(id, { templateId: "builtin:part" })).status).toBe(400);
    expect((await save(id, { printerId: 555 })).status).toBe(404);
    expect((await call("/api/print/auto/parts/nope", { as: VIEWER })).status).toBe(404);
    expect((await status(id)).settings).toBeNull();

    const res = await save(id, { threshold: 50, templateId: "builtin:job", tally: 12 });
    expect(await res.json()).toMatchObject({ enabled: true, threshold: 50, tally: 12, labels: 0 });
    // Leaving the count out keeps it.
    expect(await json(save(id, { threshold: 40 }))).toMatchObject({ threshold: 40, tally: 12 });
  });

  it("follow a part when it is merged into another", async () => {
    await runJob(1);
    const id = await partId();
    const other = await env.DB.prepare("SELECT id FROM parts WHERE name = 'Lid'").first<{ id: string }>();
    await save(id, { tally: 3 });
    const res = await call(`/api/parts/${id}/merge`, {
      method: "POST",
      as: OPERATOR,
      json: { intoId: other?.id },
    });
    expect(res.status).toBe(200);
    expect((await status(other?.id ?? "")).settings).toMatchObject({ tally: 3, threshold: 5 });
  });
});
