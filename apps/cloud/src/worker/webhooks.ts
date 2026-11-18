import { Hono } from "hono";
import { sha256Hex } from "./auth.ts";
import type { AppEnv } from "./env.ts";
import { applyState, getSetting, syncPrinters, WEBHOOK_TOKEN_KEY } from "./printing.ts";
import { printNodeFor } from "./printnode.ts";

/**
 * Callbacks from outside services. These paths bypass Cloudflare Access, so each one checks its own
 * secret: PrintNode's URL ends in a random token only the dashboard and PrintNode know.
 */
export const webhooks = new Hono<AppEnv>();

interface PrintNodeEvent {
  type?: unknown;
  createdAt?: unknown;
  data?: { printJobId?: unknown; state?: unknown; message?: unknown } | null;
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return crypto.subtle.timingSafeEqual(enc.encode(x), enc.encode(y));
}

webhooks.post("/printnode/:token", async (c) => {
  const expected = await getSetting(c.env.DB, WEBHOOK_TOKEN_KEY);
  if (!expected || !(await sameSecret(c.req.param("token"), expected)))
    return c.json({ error: "Not found" }, 404);

  // PrintNode's docs don't say how it sends the webhook secret; note which headers carry it.
  const secretHeaders = [...c.req.raw.headers].filter(([, v]) => v.includes(expected)).map(([k]) => k);
  if (secretHeaders.length) console.log("printnode webhook secret header", secretHeaders);

  const events = (await c.req.json().catch(() => null)) as PrintNodeEvent[] | null;
  if (!Array.isArray(events)) return c.json({ error: "Expected an array of events" }, 400);

  const db = c.env.DB;
  const statements: D1PreparedStatement[] = [];
  let computers = false;
  for (const e of events) {
    if (e?.type === "print job state" && e.data) {
      const { printJobId, state, message } = e.data;
      if (typeof printJobId !== "number" || typeof state !== "string") continue;
      const at = typeof e.createdAt === "string" ? Date.parse(e.createdAt) : Date.now();
      const statement = applyState(db, printJobId, state, typeof message === "string" ? message : null, at);
      if (statement) statements.push(statement);
    } else if (e?.type === "computer state") {
      computers = true;
    }
  }
  if (statements.length) await db.batch(statements);

  // A computer came or went: its printers' states changed too, so refresh them all.
  const client = computers ? printNodeFor(c.env) : null;
  if (client)
    c.executionCtx.waitUntil(
      syncPrinters(c.env, client).catch((err) => console.error("printer sync after webhook failed", err)),
    );

  c.header("X-PrintNode-Webhook-Status", "OK");
  return c.json({ ok: true });
});
