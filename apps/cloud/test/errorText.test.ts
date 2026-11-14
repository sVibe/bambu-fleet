import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ErrorTextTable } from "../src/api-types.ts";
import {
  ERROR_TEXT_KEY,
  mergeErrorText,
  refreshErrorText,
  refreshErrorTextIfNeeded,
} from "../src/worker/errorText.ts";
import worker from "../src/worker/index.ts";

/** A query.php response in Bambu's shape. */
const response = (ver: number, hms: Record<string, string>, error: Record<string, string>) => ({
  result: 0,
  t: 1,
  ver,
  data: {
    device_hms: { ver, en: Object.entries(hms).map(([ecode, intro]) => ({ ecode, intro })) },
    device_error: { ver, en: Object.entries(error).map(([ecode, intro]) => ({ ecode, intro })) },
  },
});

const X1 = response(
  202611121903,
  {
    "0300020000010001": "The nozzle temperature is abnormal; the heater may have a short circuit.",
    "0300010000010007": "The heatbed temperature is abnormal;\n  the sensor may have an open circuit.",
    "0700010000020002": "",
  },
  { "0300400C": "The task was canceled." },
);
const H2D = response(
  202611121904,
  {
    "0300020000010001": "The right nozzle temperature is abnormal; the heater may have a short circuit.",
    "0300010000010007": "The heatbed temperature is abnormal; the sensor may have an open circuit.",
    "1800000000010001": "Only on H2D.",
  },
  { "0300400C": "The task was canceled." },
);

describe("mergeErrorText", () => {
  it("keeps model texts only where they differ from the default", () => {
    const table = mergeErrorText(
      [
        { prefix: "094", body: H2D },
        { prefix: "", body: X1 },
        { prefix: "ZZZ", body: { result: 201 } },
      ],
      5,
    );
    expect(table.ver).toBe(202611121904);
    expect(table.prefixes).toEqual(["", "094"]);
    expect(table.hms["0300020000010001"]).toEqual({
      "": "The nozzle temperature is abnormal; the heater may have a short circuit.",
      "094": "The right nozzle temperature is abnormal; the heater may have a short circuit.",
    });
    // Whitespace is collapsed, so the identical H2D text adds nothing.
    expect(table.hms["0300010000010007"]).toEqual({
      "": "The heatbed temperature is abnormal; the sensor may have an open circuit.",
    });
    expect(table.hms["1800000000010001"]).toEqual({ "094": "Only on H2D." });
    // Entries without text are skipped, as Bambu Studio does.
    expect(table.hms["0700010000020002"]).toBeUndefined();
    expect(table.error).toEqual({ "0300400C": { "": "The task was canceled." } });
  });
});

describe("refreshErrorText", () => {
  beforeEach(async () => {
    await env.DB.batch(["printers", "agents"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.FILES.delete([ERROR_TEXT_KEY, "error-text/en.attempt"]);
    await env.DB.prepare(
      `INSERT INTO printers (serial, name, created_at, archived) VALUES
         ('0940000000001', 'H2D', 0, 0), ('0940000000002', 'H2D 2', 0, 0), ('00M0000000003', 'X1C', 0, 0),
         ('01P0000000004', 'Old P1S', 0, 1)`,
    ).run();
  });

  it("fetches the default set plus one per model family in the fleet, and stores the merge", async () => {
    const urls: string[] = [];
    const result = await refreshErrorText(env, async (url) => {
      urls.push(url);
      const d = new URL(url).searchParams.get("d");
      return Response.json(d === "094" ? H2D : X1);
    });
    expect(urls.sort()).toEqual([
      "https://e.bambulab.com/query.php?lang=en",
      "https://e.bambulab.com/query.php?lang=en&d=00M",
      "https://e.bambulab.com/query.php?lang=en&d=094",
    ]);
    expect(result).toMatchObject({ ok: true, hms: 3, error: 1 });
    const stored = (await (await env.FILES.get(ERROR_TEXT_KEY))?.json()) as ErrorTextTable;
    expect(stored.hms["1800000000010001"]).toEqual({ "094": "Only on H2D." });
  });

  it("keeps the last good copy when Bambu's endpoint fails", async () => {
    await refreshErrorText(env, async () => Response.json(X1));
    const result = await refreshErrorText(env, async () => new Response("down", { status: 503 }));
    expect(result.ok).toBe(false);
    const stored = (await (await env.FILES.get(ERROR_TEXT_KEY))?.json()) as ErrorTextTable;
    expect(stored.error["0300400C"]).toBeDefined();
  });

  it("keeps a model's previous texts when only that model's download fails", async () => {
    await refreshErrorText(env, async (url) => Response.json(url.includes("d=094") ? H2D : X1));
    const result = await refreshErrorText(env, async (url) =>
      url.includes("d=094") ? new Response("timeout", { status: 504 }) : Response.json(X1),
    );
    expect(result).toMatchObject({ ok: true, failed: ["094"] });
    const stored = (await (await env.FILES.get(ERROR_TEXT_KEY))?.json()) as ErrorTextTable;
    expect(stored.hms["1800000000010001"]).toEqual({ "094": "Only on H2D." });
    expect(stored.hms["0300020000010001"]?.["094"]).toMatch(/^The right nozzle/);
    expect(stored.prefixes.sort()).toEqual(["", "00M", "094"]);
  });

  it("doesn't replace the table when the default set fails", async () => {
    await refreshErrorText(env, async (url) => Response.json(url.includes("d=094") ? H2D : X1));
    const result = await refreshErrorText(env, async (url) =>
      url.includes("d=") ? Response.json(H2D) : new Response("down", { status: 503 }),
    );
    expect(result.ok).toBe(false);
    const stored = (await (await env.FILES.get(ERROR_TEXT_KEY))?.json()) as ErrorTextTable;
    expect(stored.error["0300400C"]).toEqual({ "": "The task was canceled." });
  });

  it("refreshes in the background for a new model family, at most every ten minutes", async () => {
    await refreshErrorText(env, async () => Response.json(X1));
    const started: Promise<unknown>[] = [];
    const check = async () =>
      refreshErrorTextIfNeeded(env, await env.FILES.head(ERROR_TEXT_KEY), (p) => started.push(p));
    await check();
    expect(started).toHaveLength(0);

    await env.DB.prepare(
      "INSERT INTO printers (serial, name, created_at) VALUES ('22E0000000005', 'P2S', 0)",
    ).run();
    await check();
    await check();
    expect(started).toHaveLength(1);
    await Promise.allSettled(started);
  });

  it("serves the stored table to signed-in users", async () => {
    await refreshErrorText(env, async () => Response.json(X1));
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/api/error-text"),
      { ...env, DEV_AUTH_EMAIL: "viewer@example.com" },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const table = (await res.json()) as ErrorTextTable;
    expect(table.error["0300400C"]).toEqual({ "": "The task was canceled." });
    expect(res.headers.get("etag")).toBeTruthy();
  });
});
