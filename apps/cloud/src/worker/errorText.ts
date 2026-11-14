import type { ErrorTextTable } from "../api-types.ts";
import type { Env } from "./env.ts";

/**
 * Bambu's own HMS and print-error texts, the same tables Bambu Studio downloads. `d` is the first three
 * characters of a printer serial (the model family): texts differ by model, e.g. an H2D says "right
 * nozzle" where an X1C says "nozzle". Without `d` it returns the X1 set, used as the default.
 */
const SOURCE = "https://e.bambulab.com/query.php";
const LANG = "en";
export const ERROR_TEXT_KEY = `error-text/${LANG}.json`;

type Fetcher = (url: string) => Promise<Response>;

interface SourceEntry {
  ecode?: unknown;
  intro?: unknown;
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

function entries(body: unknown, table: "device_hms" | "device_error"): Array<[string, string]> {
  const data = (body as { data?: Record<string, Record<string, unknown>> } | null)?.data;
  const list = data?.[table]?.[LANG];
  if (!Array.isArray(list)) return [];
  return (list as SourceEntry[]).flatMap((e) =>
    typeof e.ecode === "string" && typeof e.intro === "string" && clean(e.intro)
      ? [[e.ecode.toUpperCase(), clean(e.intro)] as [string, string]]
      : [],
  );
}

/**
 * Merge the per-model responses into one table. Each code keeps its default text under "" and a
 * model's text under its serial prefix only where it differs, so the table stays small.
 */
export function mergeErrorText(
  responses: Array<{ prefix: string; body: unknown }>,
  fetchedAt: number,
): ErrorTextTable {
  const table: ErrorTextTable = { ver: 0, fetchedAt, prefixes: [], hms: {}, error: {} };
  // The default set first, so model texts can be compared against it.
  const ordered = [...responses].sort((a, b) => (a.prefix === "" ? -1 : b.prefix === "" ? 1 : 0));
  for (const { prefix, body } of ordered) {
    const b = body as { result?: unknown; ver?: unknown } | null;
    if (b?.result !== 0) continue;
    table.prefixes.push(prefix);
    if (typeof b.ver === "number") table.ver = Math.max(table.ver, b.ver);
    for (const kind of ["hms", "error"] as const) {
      for (const [code, text] of entries(body, kind === "hms" ? "device_hms" : "device_error")) {
        const texts = table[kind][code] ?? {};
        table[kind][code] = texts;
        // A model's text is kept only where it differs from the default (or there is no default).
        if (prefix === "" || texts[""] !== text) texts[prefix] = text;
      }
    }
  }
  return table;
}

/** Marker for background refreshes, so open pages can't set off a download on every request. */
const ATTEMPT_KEY = `error-text/${LANG}.attempt`;
const RETRY_AFTER_MS = 10 * 60_000;

/** Model families (serial prefixes) of the active fleet. */
async function fleetPrefixes(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT upper(substr(serial, 1, 3)) AS prefix FROM printers WHERE archived = 0",
  ).all<{ prefix: string }>();
  return rows.results.map((r) => r.prefix).filter((p) => /^[0-9A-Z]{3}$/.test(p));
}

/** Fetch the texts for every model family in the fleet and store the merged table in R2. */
export async function refreshErrorText(
  env: Env,
  fetcher: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(20_000) }),
) {
  const prefixes = ["", ...(await fleetPrefixes(env))];
  const responses = await Promise.all(
    prefixes.map(async (prefix) => {
      try {
        const res = await fetcher(`${SOURCE}?lang=${LANG}${prefix ? `&d=${prefix}` : ""}`);
        return { prefix, body: res.ok ? await res.json() : null };
      } catch {
        return { prefix, body: null };
      }
    }),
  );
  const table = mergeErrorText(responses, Date.now());
  // Without the default set the table would be unusable for most codes: keep the last good copy.
  if (!table.prefixes.includes("")) return { ok: false as const, tried: prefixes, failed: ["" as string] };

  // A model whose download failed keeps its texts from the previous table rather than losing them.
  const failed = prefixes.filter((p) => !table.prefixes.includes(p));
  if (failed.length > 0) {
    const previous = (await (await env.FILES.get(ERROR_TEXT_KEY))?.json()) as ErrorTextTable | undefined;
    for (const prefix of failed.filter((p) => previous?.prefixes.includes(p))) {
      for (const kind of ["hms", "error"] as const) {
        for (const [code, texts] of Object.entries(previous?.[kind] ?? {})) {
          const text = texts[prefix];
          if (text !== undefined && table[kind][code]?.[""] !== text) {
            table[kind][code] = { ...table[kind][code], [prefix]: text };
          }
        }
      }
      table.prefixes.push(prefix);
    }
  }

  await env.FILES.put(ERROR_TEXT_KEY, JSON.stringify(table), {
    httpMetadata: { contentType: "application/json" },
    // Read by GET /api/error-text to spot model families added since, without parsing the table.
    customMetadata: { tried: prefixes.join(",") },
  });
  return {
    ok: true as const,
    ver: table.ver,
    prefixes: table.prefixes,
    failed,
    hms: Object.keys(table.hms).length,
    error: Object.keys(table.error).length,
  };
}

/**
 * Refresh in the background when the table is missing or the fleet gained a model family since the last
 * download, at most once every ten minutes.
 */
export async function refreshErrorTextIfNeeded(
  env: Env,
  stored: R2Object | null,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<void> {
  if (stored) {
    const tried = new Set((stored.customMetadata?.tried ?? "").split(","));
    if ((await fleetPrefixes(env)).every((p) => tried.has(p))) return;
  }
  const attempt = await env.FILES.head(ATTEMPT_KEY);
  if (attempt && Date.now() - attempt.uploaded.getTime() < RETRY_AFTER_MS) return;
  await env.FILES.put(ATTEMPT_KEY, String(Date.now()));
  waitUntil(
    refreshErrorText(env).then(
      (result) => console.log("error text refresh", result),
      (err) => console.error("error text refresh failed", err),
    ),
  );
}
