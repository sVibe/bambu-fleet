import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LabelTemplateRow,
  LabelTemplatesResponse,
  LabelValuesResponse,
  PrintBatchResponse,
  PrintJobRow,
  PrintPrintersResponse,
} from "../src/api-types.ts";
import worker from "../src/worker/index.ts";
import { pollPrinting, WEBHOOK_TOKEN_KEY } from "../src/worker/printing.ts";

const ADMIN = "admin@example.com";
const OPERATOR = "operator@example.com";
const VIEWER = "viewer@example.com";
const API_KEY = "test-printnode-key";
const TOKEN = "test-webhook-token";
const PART = "01PART0000000000000000000A";

async function call(
  path: string,
  init: RequestInit & { as?: string; json?: unknown; printNode?: boolean } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
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
      PRINTNODE_API_KEY: init.printNode === false ? undefined : API_KEY,
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

const PRINTERS = [
  {
    id: 101,
    name: "ZDesigner GK420d",
    description: "Label printer",
    state: "online",
    computer: { id: 7, name: "WORKSHOP-PC", state: "connected" },
    capabilities: { papers: { "4.00x6.00in": [1016, 1524], "57x32mm": [570, 320] }, dpis: ["203x203"] },
  },
  {
    id: 102,
    name: "Office A4",
    state: "online",
    computer: { id: 7, name: "WORKSHOP-PC", state: "connected" },
    capabilities: { papers: { A4: [2100, 2970] } },
  },
];

/** Requests the Worker sent to PrintNode, and a fake PrintNode answering them. */
let sent: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
let nextJobId = 9001;
let failPrint = false;
let states: unknown = [];

function mockPrintNode() {
  sent = [];
  nextJobId = 9001;
  failPrint = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.printnode.com") throw new Error(`unexpected fetch ${url}`);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    sent.push({ method, path: url.pathname, headers: new Headers(init?.headers), body });
    const reply = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/printers") return reply(PRINTERS);
    if (method === "POST" && url.pathname === "/printjobs")
      return failPrint ? reply({ message: "Printer is offline" }, 400) : reply(nextJobId++, 201);
    if (method === "GET" && url.pathname.endsWith("/states")) return reply(states);
    if (method === "GET" && url.pathname === "/whoami")
      return reply({ id: 1, email: "print@example.com", credits: 10 });
    if (method === "GET" && url.pathname === "/webhooks") return reply([]);
    return reply({ message: "not mocked" }, 404);
  });
}

const TABLES = [
  "print_jobs",
  "print_printers",
  "settings",
  "label_templates",
  "job_filaments",
  "job_parts",
  "jobs",
  "printers",
  "parts",
  "users",
  "audit_log",
];

beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    ...[
      [ADMIN, "admin"],
      [OPERATOR, "operator"],
      [VIEWER, "viewer"],
    ].map(([email, role]) =>
      env.DB.prepare("INSERT INTO users (email, role, created_at) VALUES (?, ?, 0)").bind(email, role),
    ),
    env.DB.prepare(
      "INSERT INTO parts (id, name, normalized_name, part_number, created_at) VALUES (?, 'Bracket v3', 'bracket v3', '2600067', 0)",
    ).bind(PART),
  ]);
  mockPrintNode();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function syncAndChooseLabelPrinter() {
  expect((await call("/api/print/printers/sync", { method: "POST", as: ADMIN })).status).toBe(200);
  const res = await call("/api/print/label-printer", { method: "PUT", as: ADMIN, json: { printerId: 101 } });
  expect(res.status).toBe(200);
}

const printLabel = (body: Record<string, unknown> = {}, as = OPERATOR) =>
  call("/api/print/jobs", { method: "POST", as, json: { kind: "part-label", partId: PART, ...body } });

describe("printers", () => {
  it("syncs the account's printers with their paper sizes", async () => {
    await syncAndChooseLabelPrinter();
    const body = await json<PrintPrintersResponse>(call("/api/print/printers", { as: VIEWER }));
    expect(body.configured).toBe(true);
    expect(body.labelPrinterId).toBe(101);
    expect(body.printers.map((p) => p.name)).toEqual(["Office A4", "ZDesigner GK420d"]);
    expect(body.printers.find((p) => p.id === 101)?.papers).toContainEqual({
      name: "57x32mm",
      widthMm: 57,
      heightMm: 32,
    });
    expect(body.labelSizeMm).toEqual({ width: 57, height: 32 });
    expect(body.printers.map((p) => [p.id, p.labelPaper])).toEqual([
      [102, null],
      [101, "57x32mm"],
    ]);
    expect(sent[0]?.headers.get("authorization")).toBe(`Basic ${btoa(`${API_KEY}:`)}`);
  });

  it("keeps aliases across syncs and hides printers that left the account", async () => {
    await syncAndChooseLabelPrinter();
    await call("/api/print/printers/101", { method: "PATCH", as: ADMIN, json: { alias: "Workshop labels" } });
    PRINTERS.push({ ...PRINTERS[0], id: 103, name: "Spare" } as (typeof PRINTERS)[number]);
    await call("/api/print/printers/sync", { method: "POST", as: ADMIN });
    PRINTERS.pop();
    await call("/api/print/printers/sync", { method: "POST", as: ADMIN });
    const body = await json<PrintPrintersResponse>(call("/api/print/printers", { as: VIEWER }));
    expect(body.printers.map((p) => [p.id, p.alias])).toEqual([
      [102, null],
      [101, "Workshop labels"],
    ]);
  });

  it("is admin only to change", async () => {
    expect((await call("/api/print/printers/sync", { method: "POST", as: OPERATOR })).status).toBe(403);
    expect(
      (await call("/api/print/label-printer", { method: "PUT", as: OPERATOR, json: { printerId: 101 } }))
        .status,
    ).toBe(403);
  });
});

describe("printing a part label", () => {
  it("sends ZPL with the label's size to a Zebra printer, once per request", async () => {
    await syncAndChooseLabelPrinter();
    const res = await printLabel({ qty: 50, copies: 2 });
    expect(res.status).toBe(201);
    const job = (await res.json()) as PrintJobRow;
    expect(job).toMatchObject({
      printNodeId: 9001,
      printerId: 101,
      printerName: "ZDesigner GK420d",
      state: "new",
      title: "Label 2600067",
      copies: 2,
      entity: "part",
      entityId: PART,
    });

    const submit = sent.find((s) => s.path === "/printjobs");
    expect(submit?.headers.get("x-idempotency-key")).toBe(job.id);
    expect(submit?.body).toMatchObject({
      printerId: 101,
      contentType: "raw_base64",
      qty: 2,
      expireAfter: 3600,
    });
    expect(submit?.body).not.toHaveProperty("options");
    const zpl = atob((submit?.body as { content: string } | undefined)?.content ?? "");
    expect(zpl).toMatch(/^\^XA/);
    // 57×32 mm at the 203 dpi the driver reports.
    expect(zpl).toContain("^PW456");
    expect(zpl).toContain("^LL256");
    expect(zpl).toContain("^FDMA,2600067^FS");
    expect(zpl).toContain("^LT0");

    const history = await json<PrintJobRow[]>(
      call(`/api/print/jobs?entity=part&entityId=${PART}`, { as: VIEWER }),
    );
    expect(history.map((j) => j.id)).toEqual([job.id]);
  });

  it("sends a PDF on the matching paper when the printer is set to PDF", async () => {
    await syncAndChooseLabelPrinter();
    const patch = await call("/api/print/printers/101", {
      method: "PATCH",
      as: ADMIN,
      json: { format: "pdf" },
    });
    expect(patch.status).toBe(200);
    const printers = await json<PrintPrintersResponse>(call("/api/print/printers", { as: VIEWER }));
    expect(printers.printers.find((p) => p.id === 101)).toMatchObject({
      format: "pdf",
      sendsAs: "pdf",
      dpi: 203,
    });

    expect((await printLabel({ qty: 50 })).status).toBe(201);
    const submit = sent.find((s) => s.path === "/printjobs");
    expect(submit?.body).toMatchObject({
      contentType: "pdf_base64",
      options: { paper: "57x32mm", fit_to_page: false },
    });
    const pdf = atob((submit?.body as { content: string } | undefined)?.content ?? "");
    expect(pdf.startsWith("%PDF-")).toBe(true);
  });

  it("moves labels by the printer's offset", async () => {
    await syncAndChooseLabelPrinter();
    const patch = await call("/api/print/printers/101", {
      method: "PATCH",
      as: ADMIN,
      json: { offsetMm: { x: -1, y: 2.5 } },
    });
    expect(patch.status).toBe(200);
    expect((await printLabel()).status).toBe(201);
    const zpl = atob(
      (sent.find((s) => s.path === "/printjobs")?.body as { content: string } | undefined)?.content ?? "",
    );
    // 2.5 mm down and 1 mm left at 8 dots per mm.
    expect(zpl).toContain("^LT20");
    expect(zpl).toContain("^LS8");
  });

  it("records jobs PrintNode refuses", async () => {
    await syncAndChooseLabelPrinter();
    failPrint = true;
    const res = await printLabel();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; job: PrintJobRow };
    expect(body.error).toBe("Printer is offline");
    expect(body.job.state).toBe("failed");
  });

  it("needs the operator role, a printer and an API key", async () => {
    expect((await printLabel({}, VIEWER)).status).toBe(403);
    expect((await printLabel()).status).toBe(400);
    expect(
      (
        await call("/api/print/jobs", {
          method: "POST",
          as: OPERATOR,
          printNode: false,
          json: { kind: "part-label", partId: PART },
        })
      ).status,
    ).toBe(409);
    await syncAndChooseLabelPrinter();
    expect((await printLabel({ partId: "missing" })).status).toBe(404);
  });

  it("previews the label as a PDF", async () => {
    const res = await call(`/api/print/preview?kind=part-label&partId=${PART}&qty=50`, { as: VIEWER });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
  });
});

describe("PrintNode webhook", () => {
  async function printedJob(): Promise<PrintJobRow> {
    await syncAndChooseLabelPrinter();
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .bind(WEBHOOK_TOKEN_KEY, TOKEN)
      .run();
    return json<PrintJobRow>(printLabel());
  }

  const deliver = (events: unknown, token = TOKEN) =>
    call(`/webhooks/printnode/${token}`, { method: "POST", json: events });

  const event = (state: string, createdAt: string) => ({
    type: "print job state",
    accountId: 1,
    createdAt,
    data: { uid: crypto.randomUUID(), state, message: `${state} message`, printJobId: 9001 },
  });

  const stateOf = async (id: string) =>
    (await env.DB.prepare("SELECT state, message FROM print_jobs WHERE id = ?").bind(id).first()) as {
      state: string;
      message: string;
    };

  it("rejects unknown tokens", async () => {
    await printedJob();
    const res = await deliver([], "wrong");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-printnode-webhook-status")).toBeNull();
  });

  it("updates job states and answers OK", async () => {
    const job = await printedJob();
    const res = await deliver([
      event("sent_to_client", "2030-01-01T10:00:01Z"),
      event("done", "2030-01-01T10:00:03Z"),
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-printnode-webhook-status")).toBe("OK");
    expect(await stateOf(job.id)).toEqual({ state: "done", message: "done message" });
  });

  it("ignores late deliveries of older states", async () => {
    const job = await printedJob();
    await deliver([event("done", "2030-01-01T10:00:03Z")]);
    await deliver([event("sent_to_client", "2030-01-01T10:00:01Z")]);
    expect((await stateOf(job.id)).state).toBe("done");
  });

  it("refreshes printers when a computer connects or disconnects", async () => {
    await printedJob();
    const before = sent.filter((s) => s.path === "/printers").length;
    await deliver([{ type: "computer state", createdAt: "2030-01-01T10:00:00Z", data: { connections: [] } }]);
    expect(sent.filter((s) => s.path === "/printers").length).toBe(before + 1);
  });
});

describe("polling", () => {
  it("catches up on states webhooks missed", async () => {
    await syncAndChooseLabelPrinter();
    const job = await json<PrintJobRow>(printLabel());
    states = [
      [
        { printJobId: 9001, state: "new", message: null, createTimestamp: "2030-01-01T10:00:00Z" },
        { printJobId: 9001, state: "sent_to_client", message: null, createTimestamp: "2030-01-01T10:00:01Z" },
        { printJobId: 9001, state: "error", message: "Paper jam", createTimestamp: "2030-01-01T10:00:02Z" },
      ],
    ];
    expect(await pollPrinting({ ...env, PRINTNODE_API_KEY: API_KEY })).toEqual({ printers: 2, jobs: 1 });
    const row = await env.DB.prepare("SELECT state, message FROM print_jobs WHERE id = ?")
      .bind(job.id)
      .first();
    expect(row).toEqual({ state: "error", message: "Paper jam" });
    expect(sent.at(-1)?.path).toBe("/printjobs/9001/states");
  });

  it("also reads states as one flat list, as the docs show them", async () => {
    await syncAndChooseLabelPrinter();
    const job = await json<PrintJobRow>(printLabel());
    states = [
      { printJobId: 9001, state: "done", message: null, createTimestamp: "2030-01-01T10:00:02Z" },
      { printJobId: 9001, state: "new", message: null, createTimestamp: "2030-01-01T10:00:00Z" },
      { printJobId: 9001, state: "printing_tmp", message: null, createTimestamp: "2030-01-01T10:00:03Z" },
    ];
    await pollPrinting({ ...env, PRINTNODE_API_KEY: API_KEY });
    const row = await env.DB.prepare("SELECT state FROM print_jobs WHERE id = ?").bind(job.id).first();
    expect(row).toEqual({ state: "done" });
  });

  it("does nothing without an API key", async () => {
    expect(await pollPrinting({ ...env, PRINTNODE_API_KEY: undefined })).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe("part number", () => {
  it("is saved with the part and printed in place of the name", async () => {
    await call(`/api/parts/${PART}`, { method: "PATCH", as: OPERATOR, json: { partNumber: "2600068" } });
    await syncAndChooseLabelPrinter();
    expect((await json<PrintJobRow>(printLabel())).title).toBe("Label 2600068");
    await call(`/api/parts/${PART}`, { method: "PATCH", as: OPERATOR, json: { partNumber: "" } });
    expect((await json<PrintJobRow>(printLabel())).title).toBe("Label Bracket v3");
  });
});

const SMALL = {
  widthMm: 40,
  heightMm: 30,
  elements: [
    { id: "qr", type: "qr", x: 1, y: 1, w: 18, h: 18, value: "{{part.number}}" },
    { id: "t", type: "text", x: 20, y: 1, w: 19, h: 6, text: "{{label.qty}}", fontSize: 10, bold: true },
  ],
};

const createTemplate = (body: Record<string, unknown> = {}, as = ADMIN) =>
  call("/api/print/templates", {
    method: "POST",
    as,
    json: { name: "Small", source: "part", template: SMALL, ...body },
  });

const sentZpl = (i = 0) =>
  atob(
    (sent.filter((s) => s.path === "/printjobs")[i]?.body as { content: string } | undefined)?.content ?? "",
  );

describe("label templates", () => {
  it("lists the built-in labels, which print by default", async () => {
    const { templates } = await json<LabelTemplatesResponse>(call("/api/print/templates", { as: VIEWER }));
    expect(templates.map((t) => [t.id, t.source, t.builtIn, t.isDefault])).toEqual([
      ["builtin:part", "part", true, true],
      ["builtin:job", "job", true, true],
    ]);
  });

  it("are saved by admins, refuse stale saves and can become the default", async () => {
    expect((await createTemplate({}, OPERATOR)).status).toBe(403);
    const created = await createTemplate();
    expect(created.status).toBe(201);
    const t = (await created.json()) as LabelTemplateRow;
    expect(t).toMatchObject({ name: "Small", source: "part", builtIn: false, isDefault: false, version: 1 });

    const save = (version: number, name: string) =>
      call(`/api/print/templates/${t.id}`, {
        method: "PUT",
        as: ADMIN,
        json: { name, template: SMALL, version },
      });
    const saved = await save(1, "Small batch");
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ name: "Small batch", version: 2, updatedBy: ADMIN });
    const stale = await save(1, "Someone else");
    expect(stale.status).toBe(409);

    expect((await call(`/api/print/templates/${t.id}/default`, { method: "PUT", as: ADMIN })).status).toBe(
      200,
    );
    const { templates } = await json<LabelTemplatesResponse>(call("/api/print/templates", { as: VIEWER }));
    expect(templates.filter((x) => x.isDefault).map((x) => x.id)).toEqual(["builtin:job", t.id]);

    // Prints without a template now use it, at its own size.
    await syncAndChooseLabelPrinter();
    expect((await printLabel({ qty: 5 })).status).toBe(201);
    expect(sentZpl()).toContain("^PW320");
    expect(sentZpl()).toContain("^LL240");
    const printers = await json<PrintPrintersResponse>(call("/api/print/printers", { as: VIEWER }));
    expect(printers.labelSizeMm).toEqual({ width: 40, height: 30 });
    const row = await env.DB.prepare("SELECT template FROM print_jobs").first();
    expect(row).toEqual({ template: t.id });

    // Deleting it brings back the built-in label.
    expect((await call(`/api/print/templates/${t.id}`, { method: "DELETE", as: ADMIN })).status).toBe(200);
    expect((await call(`/api/print/templates/${t.id}`, { as: VIEWER })).status).toBe(404);
    await printLabel();
    expect(sentZpl(1)).toContain("^PW456");
  });

  it("rejects labels out of bounds and changes to built-in ones", async () => {
    expect((await createTemplate({ template: { ...SMALL, widthMm: 5 } })).status).toBe(400);
    expect((await createTemplate({ name: "" })).status).toBe(400);
    const res = await call("/api/print/templates/builtin:part", {
      method: "PUT",
      as: ADMIN,
      json: { name: "Mine", template: SMALL, version: 0 },
    });
    expect(res.status).toBe(400);
  });

  it("previews and test-prints an unsaved template", async () => {
    const preview = await call("/api/print/preview", {
      method: "POST",
      as: VIEWER,
      json: { kind: "part-label", partId: PART, template: SMALL },
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("application/pdf");

    await syncAndChooseLabelPrinter();
    const res = await printLabel({ kind: "test-label", template: SMALL });
    expect(res.status).toBe(201);
    expect(sentZpl()).toContain("^PW320");
    expect(sentZpl()).toContain("50 pcs");
  });
});

describe("job labels", () => {
  const JOB = "01JOB00000000000000000000A";
  const JOB2 = "01JOB00000000000000000000B";
  const OTHER = "01PART0000000000000000000B";

  beforeEach(async () => {
    const db = env.DB;
    await db.batch([
      db.prepare("INSERT INTO printers (serial, name, created_at) VALUES ('P1', 'X1C-1', 0)"),
      db
        .prepare("INSERT INTO parts (id, name, normalized_name, created_at) VALUES (?, 'Clip', 'clip', 0)")
        .bind(OTHER),
      ...[JOB, JOB2].map((id, i) =>
        db
          .prepare(
            `INSERT INTO jobs (id, printer_serial, name, status, started_at, ended_at, duration_s, actual_weight_g,
               created_at, updated_at)
             VALUES (?, 'P1', ?, 'finished', 1763366400000, 1763386800000, 20400, 61.5, 0, 0)`,
          )
          .bind(id, `2600067_plate_${i + 1}`),
      ),
      db.prepare("INSERT INTO job_filaments (job_id, idx, material) VALUES (?, 0, 'PETG')").bind(JOB),
      ...[
        ["1", PART, 0, 12],
        ["2", PART, 0, 13],
        ["3", PART, 1, null],
        ["4", OTHER, 0, 5],
      ].map(([identify, part, skipped, weight]) =>
        db
          .prepare(
            "INSERT INTO job_parts (job_id, identify_id, part_id, object_name, skipped, weight_g) VALUES (?, ?, ?, 'obj', ?, ?)",
          )
          .bind(JOB, identify, part, skipped, weight),
      ),
    ]);
  });

  it("fill from the part the job printed most of", async () => {
    const { values } = await json<LabelValuesResponse>(
      call(`/api/print/values?source=job&id=${JOB}`, { as: VIEWER }),
    );
    expect(values).toMatchObject({
      "part.number": "2600067",
      "part.name": "Bracket v3",
      "part.qty": "2",
      "part.g": "12.5",
      "job.name": "2600067_plate_1",
      "job.printer": "X1C-1",
      "job.material": "PETG",
      "job.grams": "62",
      "job.duration": "5 h 40 min",
      "job.pieces": "3",
      "job.parts": "2600067 ×2, Clip ×1",
      "label.qty": "2 pcs",
    });

    await syncAndChooseLabelPrinter();
    const res = await call("/api/print/jobs", {
      method: "POST",
      as: OPERATOR,
      json: { kind: "job-label", jobId: JOB },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ entity: "job", entityId: JOB, template: "builtin:job" });
    expect(sentZpl()).toContain("^FDMA,2600067^FS");
    expect(sentZpl()).toContain("2 pcs");
  });

  it("won't use a part template", async () => {
    const t = await json<LabelTemplateRow>(createTemplate());
    await syncAndChooseLabelPrinter();
    const res = await call("/api/print/jobs", {
      method: "POST",
      as: OPERATOR,
      json: { kind: "job-label", jobId: JOB, templateId: t.id },
    });
    expect(res.status).toBe(400);
  });

  it("print in batches, and not at all when a job is missing", async () => {
    await syncAndChooseLabelPrinter();
    const batch = (jobIds: string[]) =>
      call("/api/print/batch", { method: "POST", as: OPERATOR, json: { jobIds, copies: 2 } });
    expect((await batch([JOB, "missing"])).status).toBe(404);
    expect(sent.filter((s) => s.path === "/printjobs")).toHaveLength(0);

    const res = await batch([JOB, JOB2, JOB]);
    expect(res.status).toBe(201);
    const { jobs } = (await res.json()) as PrintBatchResponse;
    expect(jobs.map((j) => [j.entityId, j.copies, j.state])).toEqual([
      [JOB, 2, "new"],
      [JOB2, 2, "new"],
    ]);
    // A job without part data is labelled with its name.
    expect(sentZpl(1)).toContain("^FDMA,2600067_5Fplate_5F2^FS");
    expect(
      (await call("/api/print/batch", { method: "POST", as: VIEWER, json: { jobIds: [JOB] } })).status,
    ).toBe(403);
  });
});
