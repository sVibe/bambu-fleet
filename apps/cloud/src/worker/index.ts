import { Hono } from "hono";
import type { Me } from "../api-types.ts";
import { requireUser } from "./auth.ts";
import type { AppEnv, Env } from "./env.ts";
import { refreshErrorText } from "./errorText.ts";
import { ingest } from "./ingest.ts";
import { pollPrinting } from "./printing.ts";
import { admin } from "./routes/admin.ts";
import { jobs } from "./routes/jobs.ts";
import { parts } from "./routes/parts.ts";
import { print } from "./routes/print.ts";
import { queue } from "./routes/queue.ts";
import { stats } from "./routes/stats.ts";
import { webhooks } from "./webhooks.ts";

export { FleetLive } from "./live.ts";

export const PRINT_POLL_CRON = "*/5 * * * *";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

/** Agent API: bearer agent key, no user session. */
app.route("/ingest", ingest);

/** Callbacks from PrintNode: each checks its own secret, no user session. */
app.route("/webhooks", webhooks);

/** Dashboard API: Cloudflare Access identity + role. */
const api = new Hono<AppEnv>();
api.use("*", requireUser);
api.get("/me", (c) => c.json(c.get("user") satisfies Me));
api.route("/", jobs);
api.route("/", parts);
api.route("/", stats);
api.route("/queue", queue);
api.route("/print", print);
api.route("/admin", admin);
api.all("*", (c) => c.json({ error: "Not found" }, 404));
app.route("/api", api);

export default {
  fetch: app.fetch,
  /**
   * Crons (wrangler.jsonc): every five minutes, catch up on PrintNode printers and job states that
   * webhooks missed; weekly, refresh Bambu's HMS and print-error texts.
   */
  scheduled(event, env, ctx) {
    if (event.cron === PRINT_POLL_CRON) {
      ctx.waitUntil(pollPrinting(env).catch((err) => console.error("print poll failed", err)));
      return;
    }
    ctx.waitUntil(
      refreshErrorText(env).then(
        (result) => console.log("error text refresh", result),
        (err) => console.error("error text refresh failed", err),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
