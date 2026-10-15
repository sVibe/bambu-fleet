import { ROLES, type Role, roleAtLeast } from "@fleet/shared";
import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { AppEnv, Env, User } from "./env.ts";

const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function jwks(team: string): JWTVerifyGetKey {
  let set = jwksByTeam.get(team);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksByTeam.set(team, set);
  }
  return set;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Email of the signed-in user, from a verified Cloudflare Access JWT (or the local dev override). */
async function identify(req: Request, env: Env): Promise<string | null> {
  const url = new URL(req.url);
  if (env.DEV_AUTH_EMAIL && LOCAL_HOSTS.has(url.hostname)) return env.DEV_AUTH_EMAIL.toLowerCase();
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const token =
    req.headers.get("cf-access-jwt-assertion") ??
    /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Find or create the user row; first-time users get the bootstrap admin role or DEFAULT_ROLE. */
async function resolveUser(env: Env, email: string): Promise<User | null> {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT email, role, last_seen_at FROM users WHERE email = ?")
    .bind(email)
    .first<{ email: string; role: Role; last_seen_at: number | null }>();
  if (row) {
    if (!row.last_seen_at || now - row.last_seen_at > 5 * 60_000) {
      await env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE email = ?").bind(now, email).run();
    }
    return { email: row.email, role: row.role };
  }
  const isBootstrap = env.BOOTSTRAP_ADMIN_EMAIL && email === env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
  const role: Role | null = isBootstrap
    ? "admin"
    : (ROLES as readonly string[]).includes(env.DEFAULT_ROLE) && env.DEFAULT_ROLE !== "admin"
      ? (env.DEFAULT_ROLE as Role)
      : null;
  if (!role) return null;
  await env.DB.prepare(
    "INSERT INTO users (email, role, created_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING",
  )
    .bind(email, role, now, now)
    .run();
  return { email, role };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = await identify(c.req.raw, c.env);
  if (!email) return c.json({ error: "Not signed in" }, 401);
  const user = await resolveUser(c.env, email);
  if (!user)
    return c.json({ error: "Your account has no access to this dashboard. Ask an admin to add you." }, 403);
  c.set("user", user);
  await next();
};

export function requireRole(role: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roleAtLeast(c.get("user").role, role)) return c.json({ error: `Requires ${role} role` }, 403);
    await next();
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Agents authenticate with `Authorization: Bearer <agent key>`; only the SHA-256 is stored. */
export const requireAgent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const key = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (!key) return c.json({ error: "Missing agent key" }, 401);
  const agent = await c.env.DB.prepare("SELECT id FROM agents WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(key))
    .first<{ id: string }>();
  if (!agent) return c.json({ error: "Unknown or revoked agent key" }, 401);
  c.set("agentId", agent.id);
  await next();
};

export async function audit(
  c: Context<AppEnv>,
  action: string,
  entity: string,
  entityId: string,
  details?: unknown,
): Promise<void> {
  await c.env.DB.prepare(
    "INSERT INTO audit_log (at, actor, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      Date.now(),
      c.get("user").email,
      action,
      entity,
      entityId,
      details === undefined ? null : JSON.stringify(details),
    )
    .run();
}
