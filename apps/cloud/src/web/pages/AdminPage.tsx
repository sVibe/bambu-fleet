import { ROLES, type Role } from "@fleet/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, invalidate, useAgents, useAudit, useErrorText, useMe, useUsers } from "../api.ts";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorState,
  inputClass,
  Loading,
  PageHeader,
  Select,
  Td,
  Th,
} from "../components/ui.tsx";
import { ago, dateTime } from "../format.ts";

export function AdminPage() {
  const me = useMe();
  if (me.isLoading) return <Loading />;
  if (me.data?.role !== "admin") return <Empty title="Admins only" />;
  return (
    <>
      <PageHeader title="Admin" subtitle="People, LAN agents, error codes and the audit log." />
      <div className="space-y-6">
        <Agents />
        <Users self={me.data.email} />
        <ErrorCodes />
        <Audit />
      </div>
    </>
  );
}

function Users({ self }: { self: string }) {
  const client = useQueryClient();
  const users = useUsers();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const upsert = useMutation({
    mutationFn: (body: { email: string; role: Role }) =>
      api("/api/admin/users", { method: "POST", json: body }),
    onSuccess: () => {
      setEmail("");
      return invalidate(client, "users", "audit");
    },
  });
  const remove = useMutation({
    mutationFn: (target: string) =>
      api(`/api/admin/users/${encodeURIComponent(target)}`, { method: "DELETE" }),
    onSuccess: () => invalidate(client, "users", "audit"),
  });

  return (
    <Card className="overflow-x-auto">
      <div className="px-4 pt-4">
        <h2 className="font-semibold">People</h2>
        <p className="text-xs text-ink-2">
          Viewers see everything; operators can also rename and merge parts and run the job queue; admins
          manage people and agents. Sign-in itself is controlled by the Cloudflare Access policy.
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2 px-4 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) upsert.mutate({ email: email.trim(), role });
        }}
      >
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@company.com"
          aria-label="Email"
          className={`${inputClass} min-w-56 flex-1`}
        />
        <Select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" disabled={upsert.isPending}>
          Add or update
        </Button>
      </form>
      {upsert.error && <p className="px-4 pt-2 text-sm text-critical">{upsert.error.message}</p>}
      {users.isLoading && <Loading />}
      {users.error && <ErrorState error={users.error} />}
      {users.data && (
        <table className="mt-3 w-full text-sm sm:min-w-[560px]">
          <thead className="border-b border-hairline">
            <tr>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th className="hidden sm:table-cell">Last seen</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {users.data.map((u) => (
              <tr key={u.email}>
                <Td className="break-all">
                  {u.email}
                  <div className="text-xs text-muted sm:hidden">seen {ago(u.lastSeenAt)}</div>
                </Td>
                <Td>
                  {u.email === self ? (
                    <span className="capitalize">{u.role} (you)</span>
                  ) : (
                    <Select
                      value={u.role}
                      onChange={(e) => upsert.mutate({ email: u.email, role: e.target.value as Role })}
                      aria-label={`Role of ${u.email}`}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                  )}
                </Td>
                <Td className="hidden text-ink-2 sm:table-cell">{ago(u.lastSeenAt)}</Td>
                <Td className="text-right">
                  {u.email !== self && (
                    <Button
                      variant="ghost"
                      onClick={() => confirm(`Remove ${u.email}?`) && remove.mutate(u.email)}
                    >
                      Remove
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Agents() {
  const client = useQueryClient();
  const agents = useAgents();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const create = useMutation({
    mutationFn: (agentName: string) =>
      api<{ id: string; key: string }>("/api/admin/agents", { method: "POST", json: { name: agentName } }),
    onSuccess: (res, agentName) => {
      setCreated({ name: agentName, key: res.key });
      setName("");
      return invalidate(client, "agents", "audit");
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/admin/agents/${id}/revoke`, { method: "POST" }),
    onSuccess: () => invalidate(client, "agents", "audit"),
  });

  return (
    <Card className="overflow-x-auto">
      <div className="px-4 pt-4">
        <h2 className="font-semibold">LAN agents</h2>
        <p className="text-xs text-ink-2">
          An agent runs on a machine next to the printers and forwards their status and jobs here. Create one,
          then put its key in that machine's <code>agent.yaml</code>.
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2 px-4 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate(name.trim());
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Workshop Mac mini"
          aria-label="Agent name"
          className={`${inputClass} min-w-56 flex-1`}
        />
        <Button type="submit" variant="primary" disabled={create.isPending || !name.trim()}>
          Create agent
        </Button>
      </form>
      {created && (
        <div className="mx-4 mt-3 rounded-lg border border-hairline bg-wash p-3 text-sm">
          <div className="font-medium">Key for “{created.name}”. It's shown only once:</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-raised px-2 py-1 font-mono text-xs">
              {created.key}
            </code>
            <Button onClick={() => navigator.clipboard.writeText(created.key)}>Copy</Button>
            <Button variant="ghost" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      {agents.data && agents.data.length > 0 && (
        <table className="mt-3 w-full text-sm sm:min-w-[640px]">
          <thead className="border-b border-hairline">
            <tr>
              <Th>Agent</Th>
              <Th>Status</Th>
              <Th className="hidden text-right sm:table-cell">Printers</Th>
              <Th className="hidden sm:table-cell">Version</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {agents.data.map((a) => {
              const recent = a.lastSeenAt !== null && Date.now() - a.lastSeenAt < 5 * 60_000;
              return (
                <tr key={a.id} className={a.revokedAt ? "text-muted" : undefined}>
                  <Td>
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-muted">
                      created {dateTime(a.createdAt)}
                      {a.createdBy ? ` by ${a.createdBy}` : ""}
                    </div>
                    <div className="text-xs text-muted sm:hidden">
                      {a.printers} {a.printers === 1 ? "printer" : "printers"}
                      {a.version ? ` · v${a.version}` : ""}
                    </div>
                  </Td>
                  <Td>
                    {a.revokedAt ? (
                      <Badge tone="neutral">Revoked</Badge>
                    ) : recent ? (
                      <Badge tone="good">Seen {ago(a.lastSeenAt)}</Badge>
                    ) : (
                      <Badge tone="warning">
                        {a.lastSeenAt ? `Last seen ${ago(a.lastSeenAt)}` : "Never connected"}
                      </Badge>
                    )}
                  </Td>
                  <Td className="tabular hidden text-right sm:table-cell">{a.printers}</Td>
                  <Td className="hidden text-ink-2 sm:table-cell">{a.version ?? "–"}</Td>
                  <Td className="text-right">
                    {!a.revokedAt && (
                      <Button
                        variant="danger"
                        onClick={() =>
                          confirm(`Revoke "${a.name}"? It will stop reporting immediately.`) &&
                          revoke.mutate(a.id)
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {agents.data?.length === 0 && <p className="px-4 py-4 text-sm text-ink-2">No agents yet.</p>}
      <div className="h-3" />
    </Card>
  );
}

/** Bambu's HMS and print-error texts, refreshed weekly by the cron. */
function ErrorCodes() {
  const client = useQueryClient();
  const table = useErrorText();
  const refresh = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; hms?: number; error?: number }>("/api/admin/error-text/refresh", { method: "POST" }),
    onSuccess: () => invalidate(client, "error-text", "audit"),
  });
  const t = table.data;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Error codes</h2>
          <p className="text-xs text-ink-2">
            Descriptions for HMS alerts and print errors come from Bambu's own tables (the ones Bambu Studio
            uses), downloaded every Monday for each printer model in the fleet.
          </p>
          <p className="mt-2 text-sm">
            {t && t.ver > 0
              ? `${Object.keys(t.hms).length} HMS codes and ${Object.keys(t.error).length} print errors, Bambu version ${t.ver}, downloaded ${ago(t.fetchedAt)}.`
              : "Not downloaded yet. Codes show without descriptions until they are."}
          </p>
          {refresh.isError && (
            <p className="mt-1 text-sm text-critical">Bambu's server didn't answer; try again later.</p>
          )}
        </div>
        <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? "Downloading…" : "Refresh now"}
        </Button>
      </div>
    </Card>
  );
}

function Audit() {
  const audit = useAudit();
  return (
    <Card className="overflow-x-auto">
      <h2 className="px-4 pt-4 font-semibold">Audit log</h2>
      {audit.data && audit.data.length === 0 && <p className="px-4 py-4 text-sm text-ink-2">Nothing yet.</p>}
      {audit.data && audit.data.length > 0 && (
        <table className="mt-2 w-full text-sm sm:min-w-[640px]">
          <thead className="border-b border-hairline">
            <tr>
              <Th>When</Th>
              <Th className="hidden sm:table-cell">Who</Th>
              <Th>What</Th>
              <Th className="hidden sm:table-cell">Details</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {audit.data.map((a) => (
              <tr key={a.id}>
                <Td className="tabular whitespace-nowrap text-ink-2">{dateTime(a.at)}</Td>
                <Td className="hidden sm:table-cell">{a.actor}</Td>
                <Td className="break-all">
                  {a.action} <span className="text-muted">{a.entityId}</span>
                  <div className="text-xs text-muted sm:hidden">{a.actor}</div>
                  {a.details && <div className="font-mono text-xs text-ink-2 sm:hidden">{a.details}</div>}
                </Td>
                <Td className="hidden font-mono text-xs text-ink-2 sm:table-cell">{a.details ?? ""}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="h-3" />
    </Card>
  );
}
