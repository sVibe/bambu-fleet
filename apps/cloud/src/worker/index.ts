import { Hono } from "hono";
import type { Me } from "../api-types.ts";
import { requireUser } from "./auth.ts";
import type { AppEnv, Env } from "./env.ts";
import { refreshErrorText } from "./errorText.ts";
import { ingest } from "./ingest.ts";
import { admin } from "./routes/admin.ts";
import { jobs } from "./routes/jobs.ts";
import { parts } from "./routes/parts.ts";
import { queue } from "./routes/queue.ts";
import { stats } from "./routes/stats.ts";

export { FleetLive } from "./live.ts";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

/** Agent API: bearer agent key, no user session. */
app.route("/ingest", ingest);

/** Dashboard API: Cloudflare Access identity + role. */
const api = new Hono<AppEnv>();
api.use("*", requireUser);
api.get("/me", (c) => c.json(c.get("user") satisfies Me));
api.route("/", jobs);
api.route("/", parts);
api.route("/", stats);
api.route("/queue", queue);
api.route("/admin", admin);
api.all("*", (c) => c.json({ error: "Not found" }, 404));
app.route("/api", api);

export default {
  fetch: app.fetch,
  /** Weekly cron (wrangler.jsonc): refresh Bambu's HMS and print-error texts. */
  scheduled(_event, env, ctx) {
    ctx.waitUntil(
      refreshErrorText(env).then(
        (result) => console.log("error text refresh", result),
        (err) => console.error("error text refresh failed", err),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
