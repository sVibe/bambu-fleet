import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type IngestEvent, md5Hex, type PrinterLiveState, type QueuePlateInput } from "@fleet/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { QueueFile, QueueItem } from "../src/api-types.ts";
import { sha256Hex } from "../src/worker/auth.ts";
import worker from "../src/worker/index.ts";
import { rankPrinters, suggestSlots } from "../src/worker/matcher.ts";

const AGENT_KEY = "test-agent-key-0123456789";
const ADMIN = "admin@example.com";
const OPERATOR = "operator@example.com";
const VIEWER = "viewer@example.com";
const P1S = "01P00A000000001";
const X1C = "00M00A000000002";
const HOUR = 3_600_000;

async function call(
  path: string,
  init: RequestInit & { as?: string; agentKey?: string; json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.agentKey) headers.set("authorization", `Bearer ${init.agentKey}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  // Browsers send Content-Length for file bodies; a Request built here doesn't.
  if (init.body instanceof Uint8Array) headers.set("content-length", String(init.body.byteLength));
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

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

const ingest = (events: IngestEvent[]) =>
  call("/ingest/events", { method: "POST", agentKey: AGENT_KEY, json: { agentVersion: "test", events } });

function liveState(serial: string, patch: Partial<PrinterLiveState> = {}): PrinterLiveState {
  return {
    serial,
    online: true,
    gcodeState: "IDLE",
    jobName: null,
    progressPct: null,
    remainingMin: null,
    layer: null,
    totalLayers: null,
    nozzleTempC: 25,
    nozzleTargetC: 0,
    bedTempC: 25,
    bedTargetC: 0,
    chamberTempC: null,
    speedLevel: 2,
    printError: 0,
    wifiSignal: null,
    ams: [
      {
        id: 0,
        humidity: 4,
        tempC: 24,
        trays: [
          { id: 0, material: "PLA", color: "F98C36", trayInfoIdx: "GFA00", remainPct: 72, rfid: true },
          { id: 1, material: "PETG", color: "161616", trayInfoIdx: "GFG00", remainPct: 45, rfid: true },
          { id: 2, material: "PLA", color: "FFFFFF", trayInfoIdx: "GFA00", remainPct: null, rfid: false },
        ],
      },
    ],
    externalSpools: [],
    hms: [],
    updatedAt: Date.now(),
    ...patch,
  };
}

const PLATE: QueuePlateInput = {
  index: 1,
  printerModelId: "C12",
  estTimeS: 3600,
  estWeightG: 30,
  wasteG: 2,
  filaments: [
    {
      idx: 1,
      trayInfoIdx: "GFA00",
      material: "PLA",
      color: "F98C36",
      usedG: 20,
      usedM: 6.6,
      wasteG: 1,
    },
    {
      idx: 2,
      trayInfoIdx: "GFG00",
      material: "PETG",
      color: "161616",
      usedG: 10,
      usedM: 3.2,
      wasteG: 1,
    },
  ],
  parts: [
    { name: "Bracket", count: 2, weightG: 18 },
    { name: "Clip", count: 1, weightG: 10 },
  ],
  thumbnailPngBase64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
};

const FILE_BYTES = new TextEncoder().encode("PK fake 3mf bytes for the queue tests");
const FILE_MD5 = md5Hex(FILE_BYTES);

async function upload(as = OPERATOR, filename = "Bracket set.gcode.3mf"): Promise<QueueFile> {
  const put = await call(`/api/queue/files/${FILE_MD5}`, { method: "PUT", as, body: FILE_BYTES });
  expect(put.status).toBe(201);
  const res = await call("/api/queue/files", {
    method: "POST",
    as,
    json: { md5: FILE_MD5, filename, plates: [PLATE] },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as QueueFile;
}

async function enqueue(patch: Record<string, unknown> = {}): Promise<QueueItem> {
  const res = await call("/api/queue", {
    method: "POST",
    as: OPERATOR,
    json: { fileMd5: FILE_MD5, plateIndex: 1, ...patch },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as QueueItem;
}

const act = (id: string, action: string, body: unknown = {}, as = OPERATOR) =>
  call(`/api/queue/${id}/${action}`, { method: "POST", as, json: body });

async function addPrinters(states: PrinterLiveState[] = [liveState(P1S), liveState(X1C)]) {
  await ingest([
    { type: "printer.hello", id: "h1", at: 1, serial: P1S, name: "P1S-01", model: "P1S" },
    { type: "printer.hello", id: "h2", at: 1, serial: X1C, name: "X1C-02", model: "X1C" },
  ]);
  const res = await call("/ingest/state", { method: "POST", agentKey: AGENT_KEY, json: { states } });
  expect(res.status).toBe(200);
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
  // Storage persists across tests in this file, so start each one from empty tables and objects.
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const objects = await env.FILES.list({ prefix: "queue/" });
  if (objects.objects.length) await env.FILES.delete(objects.objects.map((o) => o.key));
  await env.DB.prepare("INSERT INTO agents (id, name, key_hash, created_at) VALUES ('agent1', 'Test', ?, 0)")
    .bind(await sha256Hex(AGENT_KEY))
    .run();
  await env.DB.batch(
    [
      [ADMIN, "admin"],
      [OPERATOR, "operator"],
      [VIEWER, "viewer"],
    ].map(([email, role]) =>
      env.DB.prepare("INSERT INTO users (email, role, created_at) VALUES (?, ?, 0)").bind(email, role),
    ),
  );
});

describe("queue roles", () => {
  it("lets viewers read the queue but not change it", async () => {
    await upload();
    const item = await enqueue();
    expect((await call("/api/queue", { as: VIEWER })).status).toBe(200);
    expect(
      (await call(`/api/queue/files/${FILE_MD5}`, { method: "PUT", as: VIEWER, body: FILE_BYTES })).status,
    ).toBe(403);
    expect(
      (
        await call("/api/queue", {
          method: "POST",
          as: VIEWER,
          json: { fileMd5: FILE_MD5, plateIndex: 1 },
        })
      ).status,
    ).toBe(403);
    expect((await act(item.id, "cancel", {}, VIEWER)).status).toBe(403);
    expect((await call(`/api/queue/${item.id}`, { method: "PATCH", as: VIEWER, json: {} })).status).toBe(403);
    expect((await call(`/api/queue/files/${FILE_MD5}/download`, { as: VIEWER })).status).toBe(403);
    expect((await call("/api/queue")).status).toBe(401);
  });
});

describe("queue files", () => {
  it("stores the file under its MD5 and rejects a body that doesn't match", async () => {
    const bad = await call(`/api/queue/files/${md5Hex(new TextEncoder().encode("something else"))}`, {
      method: "PUT",
      as: OPERATOR,
      body: FILE_BYTES,
    });
    expect(bad.status).toBe(400);
    expect(
      (await call("/api/queue/files/not-a-hash", { method: "PUT", as: OPERATOR, body: "x" })).status,
    ).toBe(400);

    const file = await upload();
    expect(file).toMatchObject({
      md5: FILE_MD5,
      filename: "Bracket set.gcode.3mf",
      size: FILE_BYTES.length,
      printerModelId: "C12",
      model: "P1S",
      uploadedBy: OPERATOR,
    });
    expect(file.plates[0]).toMatchObject({ index: 1, estWeightG: 30, thumbUrl: expect.any(String) });
    expect(file.plates[0]).not.toHaveProperty("thumbnailPngBase64");

    // Uploading the same bytes again is a no-op.
    const again = await call(`/api/queue/files/${FILE_MD5}`, {
      method: "PUT",
      as: OPERATOR,
      body: FILE_BYTES,
    });
    expect(await again.json()).toMatchObject({ stored: false });

    const download = await call(file.downloadUrl, { as: OPERATOR });
    expect(download.headers.get("content-disposition")).toContain('filename="Bracket set.gcode.3mf"');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(FILE_BYTES);
    const thumb = await call(file.plates[0]?.thumbUrl as string, { as: VIEWER });
    expect(thumb.headers.get("content-type")).toBe("image/png");
  });

  it("refuses to register metadata for a file that was never uploaded", async () => {
    const res = await call("/api/queue/files", {
      method: "POST",
      as: OPERATOR,
      json: { md5: md5Hex(new TextEncoder().encode("missing")), filename: "x.gcode.3mf", plates: [PLATE] },
    });
    expect(res.status).toBe(409);
  });
});

describe("queue items", () => {
  it("creates, updates and moves items through operator actions, with an audit trail", async () => {
    await upload();
    await addPrinters();
    const item = await enqueue({ quantity: 2, priority: 5 });
    expect(item).toMatchObject({
      title: "Bracket set",
      status: "queued",
      quantity: 2,
      priority: 5,
      plate: { index: 1, estWeightG: 30 },
    });
    expect(item.suggestions.map((s) => s.name)).toEqual(["P1S-01", "X1C-02"]);

    const patched = await json<QueueItem>(
      call(`/api/queue/${item.id}`, { method: "PATCH", as: OPERATOR, json: { title: "Brackets" } }),
    );
    expect(patched.title).toBe("Brackets");

    expect((await act(item.id, "dispatch")).status).toBe(400); // no printer chosen yet
    expect((await act(item.id, "dispatch", { printer: "nope" })).status).toBe(404);
    const assigned = await json<QueueItem>(act(item.id, "assign", { printer: P1S }));
    expect(assigned).toMatchObject({ status: "assigned", assignedPrinter: { serial: P1S, name: "P1S-01" } });
    const dispatched = await json<QueueItem>(act(item.id, "dispatch"));
    expect(dispatched.status).toBe("dispatched");
    expect(dispatched.dispatchedAt).toBeGreaterThan(0);

    const requeued = await json<QueueItem>(act(item.id, "requeue"));
    expect(requeued).toMatchObject({ status: "queued", assignedPrinter: null, dispatchedAt: null });
    const cancelled = await json<QueueItem>(act(item.id, "cancel"));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.suggestions).toEqual([]);
    const refused = await act(item.id, "dispatch", { printer: P1S });
    expect(refused.status).toBe(409);

    expect(await json<QueueItem[]>(call("/api/queue", { as: VIEWER }))).toEqual([]);
    const history = await json<QueueItem[]>(call("/api/queue?view=history", { as: VIEWER }));
    expect(history.map((i) => i.id)).toEqual([item.id]);

    const audit = await json<Array<{ action: string; actor: string }>>(
      call("/api/admin/audit", { as: ADMIN }),
    );
    expect(audit.map((a) => a.action).reverse()).toEqual([
      "file.upload",
      "queue.create",
      "queue.update",
      "queue.assign",
      "queue.dispatch",
      "queue.requeue",
      "queue.cancel",
    ]);
    expect(new Set(audit.map((a) => a.actor))).toEqual(new Set([OPERATOR]));
  });

  it("orders open items by priority, then age", async () => {
    await upload();
    const low = await enqueue({ title: "low" });
    const high = await enqueue({ title: "high", priority: 10 });
    const list = await json<QueueItem[]>(call("/api/queue", { as: VIEWER }));
    expect(list.map((i) => i.id)).toEqual([high.id, low.id]);
  });

  it("warns when another item is already dispatched to a printer", async () => {
    await upload();
    await addPrinters();
    const first = await enqueue();
    const second = await enqueue();
    await act(first.id, "dispatch", { printer: P1S });
    const list = await json<QueueItem[]>(call("/api/queue", { as: VIEWER }));
    const p1s = list.find((i) => i.id === second.id)?.suggestions.find((s) => s.serial === P1S);
    expect(p1s?.verdict).toBe("wait");
    expect(p1s?.issues.map((i) => i.text)).toContain('Already has "Bracket set"');
    const own = list.find((i) => i.id === first.id)?.suggestions.find((s) => s.serial === P1S);
    expect(own?.verdict).toBe("ready");
  });
});

describe("matcher", () => {
  const now = Date.now();
  const plate = { printerModelId: "C12", filaments: PLATE.filaments };

  it("ranks an idle printer of the sliced model with the right filaments first", () => {
    const ranked = rankPrinters(
      plate,
      [
        { serial: "x", name: "X1C", model: "X1C", live: liveState("x") },
        { serial: "p", name: "P1S", model: "P1S", live: liveState("p") },
      ],
      now,
    );
    expect(ranked.map((s) => [s.name, s.verdict, s.modelCheck])).toEqual([
      ["P1S", "ready", "match"],
      ["X1C", "unsuitable", "mismatch"],
    ]);
    expect(ranked[0]?.issues).toEqual([]);
    expect(ranked[0]?.slots.map((s) => [s.filamentIdx, s.tray?.label, s.match])).toEqual([
      [1, "A1", "exact"],
      [2, "A2", "exact"],
    ]);
    expect(ranked[1]?.issues[0]).toEqual({ level: "block", text: "Sliced for P1S, printer is X1C" });
  });

  it("treats unknown models as check-manually", () => {
    const [unknownFile] = rankPrinters(
      { ...plate, printerModelId: "Z99" },
      [{ serial: "p", name: "P1S", model: "P1S", live: liveState("p") }],
      now,
    );
    expect(unknownFile).toMatchObject({ modelCheck: "unknown", verdict: "action" });
    expect(unknownFile?.issues[0]?.text).toContain("check manually");
    const [unknownPrinter] = rankPrinters(
      plate,
      [{ serial: "p", name: "?", model: null, live: liveState("p") }],
      now,
    );
    expect(unknownPrinter?.modelCheck).toBe("unknown");
  });

  it("maps materials to trays and flags colour differences and missing materials", () => {
    const slots = suggestSlots(
      [
        { ...(PLATE.filaments[0] as (typeof PLATE.filaments)[0]), color: "FFFFFE" },
        { ...(PLATE.filaments[1] as (typeof PLATE.filaments)[0]), material: "ABS" },
      ],
      liveState("p"),
    );
    expect(slots.map((s) => [s.tray?.label ?? null, s.match])).toEqual([
      ["A3", "exact"],
      [null, "missing"],
    ]);

    const [green] = rankPrinters(
      { ...plate, filaments: [{ ...(PLATE.filaments[0] as (typeof PLATE.filaments)[0]), color: "2E7D32" }] },
      [{ serial: "p", name: "P1S", model: "P1S", live: liveState("p") }],
      now,
    );
    expect(green?.verdict).toBe("action");
    expect(green?.slots[0]?.match).toBe("colour");
  });

  it("uses each tray once while another matching tray is free", () => {
    const twoOrange = [
      { ...(PLATE.filaments[0] as (typeof PLATE.filaments)[0]), idx: 1, usedG: 5 },
      { ...(PLATE.filaments[0] as (typeof PLATE.filaments)[0]), idx: 2, usedG: 50 },
    ];
    const slots = suggestSlots(twoOrange, liveState("p"));
    // The heavier filament gets the exact colour; the other falls back to the other PLA tray.
    expect(slots.map((s) => [s.filamentIdx, s.tray?.label, s.match])).toEqual([
      [1, "A3", "colour"],
      [2, "A1", "exact"],
    ]);
  });

  it("accounts for bed state, busy and offline printers", () => {
    const rank = (patch: Partial<PrinterLiveState>) =>
      rankPrinters(plate, [{ serial: "p", name: "P1S", model: "P1S", live: liveState("p", patch) }], now)[0];
    expect(rank({ gcodeState: "FINISH" })).toMatchObject({ readiness: "clear-bed", verdict: "action" });
    expect(rank({ gcodeState: "FINISH" })?.issues[0]?.text).toBe("Clear the bed first");
    expect(rank({ gcodeState: "RUNNING", remainingMin: 12 })).toMatchObject({
      readiness: "busy",
      verdict: "wait",
    });
    expect(rank({ online: false })).toMatchObject({ readiness: "offline", verdict: "unsuitable" });
    expect(rank({ updatedAt: now - HOUR })).toMatchObject({ readiness: "offline" });
    const ranked = rankPrinters(
      plate,
      [
        { serial: "a", name: "A", model: "P1S", live: liveState("a", { gcodeState: "FINISH" }) },
        { serial: "b", name: "B", model: "P1S", live: liveState("b") },
        { serial: "c", name: "C", model: "P1S", live: null },
      ],
      now,
    );
    expect(ranked.map((s) => s.name)).toEqual(["B", "A", "C"]);
  });
});

describe("reconcile", () => {
  let jobSeq = 0;

  async function startJob(serial: string, name: string, startedAt: number) {
    const jobId = `01JOB${String(++jobSeq).padStart(21, "0")}`;
    const res = await ingest([
      {
        type: "job.started",
        id: `start-${jobId}`,
        at: startedAt,
        serial,
        jobId,
        taskId: "1",
        subtaskId: "2",
        name,
        gcodeFile: "/data/Metadata/plate_1.gcode",
        startedAt,
        totalLayers: 4,
        amsSnapshot: [],
      },
    ]);
    expect(res.status).toBe(200);
    return jobId;
  }

  async function endJob(serial: string, jobId: string, status: "finished" | "failed" | "cancelled") {
    await ingest([
      {
        type: "job.ended",
        id: `end-${jobId}`,
        at: Date.now(),
        serial,
        jobId,
        endedAt: Date.now(),
        status,
        progressPct: status === "finished" ? 100 : 40,
        layer: 2,
        totalLayers: 4,
        printError: null,
        skippedObjects: [],
      },
    ]);
  }

  const getItem = (id: string) => json<QueueItem>(call(`/api/queue/${id}`, { as: VIEWER }));

  async function dispatched(patch: Record<string, unknown> = {}, printer = P1S) {
    await upload();
    await addPrinters();
    const item = await enqueue(patch);
    expect((await act(item.id, "dispatch", { printer })).status).toBe(200);
    return item;
  }

  it("links the started job by name on the assigned printer, then marks the item done", async () => {
    const item = await dispatched();
    const jobId = await startJob(P1S, "BRACKET SET.gcode.3mf", Date.now() + 60_000);
    expect(await getItem(item.id)).toMatchObject({ status: "printing", jobId, suggestions: [] });
    const job = await env.DB.prepare("SELECT queue_item_id FROM jobs WHERE id = ?").bind(jobId).first();
    expect(job).toEqual({ queue_item_id: item.id });

    await endJob(P1S, jobId, "finished");
    expect(await getItem(item.id)).toMatchObject({ status: "done", completed: 1, jobId });
  });

  it("marks the item failed when the job fails or is cancelled", async () => {
    const item = await dispatched();
    const jobId = await startJob(P1S, "Bracket set", Date.now());
    await endJob(P1S, jobId, "cancelled");
    expect(await getItem(item.id)).toMatchObject({ status: "failed", completed: 0 });
    expect((await act(item.id, "requeue")).status).toBe(200);
  });

  it("re-queues an item until its quantity is printed", async () => {
    const item = await dispatched({ quantity: 2 });
    const first = await startJob(P1S, "Bracket set", Date.now());
    await endJob(P1S, first, "finished");
    expect(await getItem(item.id)).toMatchObject({ status: "queued", completed: 1, assignedPrinter: null });

    await act(item.id, "dispatch", { printer: X1C });
    const second = await startJob(X1C, "Bracket set", Date.now());
    await endJob(X1C, second, "finished");
    expect(await getItem(item.id)).toMatchObject({ status: "done", completed: 2, jobId: second });
  });

  it("matches the item title as well as the file name", async () => {
    const item = await dispatched({ title: "Custom run" });
    const jobId = await startJob(P1S, "custom run", Date.now());
    expect(await getItem(item.id)).toMatchObject({ status: "printing", jobId });
  });

  it("matches the H2D's job name with a trailing dot", async () => {
    const item = await dispatched();
    const jobId = await startJob(P1S, "Bracket set.", Date.now());
    expect(await getItem(item.id)).toMatchObject({ status: "printing", jobId });
  });

  it("ignores jobs on other printers, with other names, or outside the window", async () => {
    const item = await dispatched();
    await startJob(X1C, "Bracket set", Date.now());
    await startJob(P1S, "Something else", Date.now());
    await startJob(P1S, "Bracket set", Date.now() + 3 * HOUR);
    await startJob(P1S, "Bracket set", Date.now() - HOUR);
    expect(await getItem(item.id)).toMatchObject({ status: "dispatched", jobId: null });
  });

  it("links each job to one item, oldest dispatch first", async () => {
    const a = await dispatched();
    const b = await enqueue();
    await act(b.id, "dispatch", { printer: P1S });
    const first = await startJob(P1S, "Bracket set", Date.now());
    expect((await getItem(a.id)).jobId).toBe(first);
    expect((await getItem(b.id)).status).toBe("dispatched");
    const second = await startJob(P1S, "Bracket set", Date.now());
    expect((await getItem(b.id)).jobId).toBe(second);
  });
});
