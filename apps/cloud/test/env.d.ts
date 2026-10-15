import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as AppBindings } from "../src/worker/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends AppBindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
