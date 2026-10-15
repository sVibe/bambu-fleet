import { ROLES } from "@fleet/shared";
import { Hono } from "hono";
import { ulid } from "ulidx";
import { z } from "zod";
import type { AgentRow, AuditRow, UserRow } from "../../api-types.ts";
import { audit, requireRole, sha256Hex } from "../auth.ts";
import type { AppEnv } from "../env.ts";
import { intParam } from "../util.ts";

export const admin = new Hono<AppEnv>();
admin.use("*", requireRole("admin"));

admin.get("/users", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT email, name, role, created_at, last_seen_at FROM users ORDER BY role DESC, email",
  ).all<Record<string, unknown>>();
  const body: UserRow[] = rows.results.map((r) => ({
    email: r.email as string,
    name: r.name as string | null,
    role: r.role as UserRow["role"],
    createdAt: r.created_at as number,
    lastSeenAt: r.last_seen_at as number | null,
  }));
  return c.json(body);
});

const userSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  role: z.enum(ROLES),
  name: z.string().max(200).optional(),
});

admin.post("/users", async (c) => {
  const parsed = userSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Valid email and role required" }, 400);
  const { email, role, name } = parsed.data;
  if (email === c.get("user").email) return c.json({ error: "You can't change your own role" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO users (email, name, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role, name = COALESCE(excluded.name, users.name)`,
  )
    .bind(email, name ?? null, role, Date.now())
    .run();
  await audit(c, "user.upsert", "user", email, { role });
  return c.json({ ok: true });
});

admin.delete("/users/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  if (email === c.get("user").email) return c.json({ error: "You can't remove yourself" }, 400);
  await c.env.DB.prepare("DELETE FROM users WHERE email = ?").bind(email).run();
  await audit(c, "user.delete", "user", email);
  return c.json({ ok: true });
});

admin.get("/agents", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.name, a.created_at, a.created_by, a.last_seen_at, a.version, a.revoked_at,
       (SELECT COUNT(*) FROM printers p WHERE p.agent_id = a.id AND p.archived = 0) AS printers
     FROM agents a ORDER BY a.revoked_at IS NOT NULL, a.created_at DESC`,
  ).all<Record<string, unknown>>();
  const body: AgentRow[] = rows.results.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    createdAt: r.created_at as number,
    createdBy: r.created_by as string | null,
    lastSeenAt: r.last_seen_at as number | null,
    version: r.version as string | null,
    revokedAt: r.revoked_at as number | null,
    printers: r.printers as number,
  }));
  return c.json(body);
});

function newAgentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `fa_${btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

admin.post("/agents", async (c) => {
  const parsed = z
    .object({ name: z.string().trim().min(1).max(100) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Agent name required" }, 400);
  const id = ulid();
  const key = newAgentKey();
  await c.env.DB.prepare(
    "INSERT INTO agents (id, name, key_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, parsed.data.name, await sha256Hex(key), Date.now(), c.get("user").email)
    .run();
  await audit(c, "agent.create", "agent", id, { name: parsed.data.name });
  // The key is only ever shown here; the database keeps its hash.
  return c.json({ id, key }, 201);
});

admin.post("/agents/:id/revoke", async (c) => {
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(Date.now(), id)
    .run();
  if (res.meta.changes === 0) return c.json({ error: "Agent not found or already revoked" }, 404);
  await audit(c, "agent.revoke", "agent", id);
  return c.json({ ok: true });
});

admin.get("/audit", async (c) => {
  const limit = intParam(c.req.query("limit"), 100, 1, 500);
  const rows = await c.env.DB.prepare(
    "SELECT id, at, actor, action, entity, entity_id, details FROM audit_log ORDER BY at DESC, id DESC LIMIT ?",
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  const body: AuditRow[] = rows.results.map((r) => ({
    id: r.id as number,
    at: r.at as number,
    actor: r.actor as string,
    action: r.action as string,
    entity: r.entity as string | null,
    entityId: r.entity_id as string | null,
    details: r.details as string | null,
  }));
  return c.json(body);
});
