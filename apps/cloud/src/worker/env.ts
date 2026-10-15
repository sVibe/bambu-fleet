import type { Role } from "@fleet/shared";
import type { FleetLive } from "./live.ts";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  FLEET_LIVE: DurableObjectNamespace<FleetLive>;
  ASSETS: Fetcher;
  /** Cloudflare Access team domain, e.g. `acme.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application protecting this Worker. */
  ACCESS_AUD: string;
  /** Becomes admin on first sign-in. */
  BOOTSTRAP_ADMIN_EMAIL: string;
  /** Role given to other Access-authenticated users on first sign-in: viewer, operator or "none". */
  DEFAULT_ROLE: string;
  /**
   * Local development only (set in .dev.vars, never in production): requests from localhost are
   * signed in as this email instead of verifying a Cloudflare Access token.
   */
  DEV_AUTH_EMAIL?: string;
}

export interface User {
  email: string;
  role: Role;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: User; agentId: string };
};
