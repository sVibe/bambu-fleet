import { type QueryClient, useQuery } from "@tanstack/react-query";
import type {
  AgentRow,
  AuditRow,
  JobDetail,
  JobListResponse,
  Me,
  PartDetail,
  PartListItem,
  PrinterSummary,
  QueueItem,
  StatsResponse,
  UserRow,
} from "../api-types.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(path, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== null && v !== undefined && v !== "") search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : "";
}

export const useMe = () =>
  useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me"), staleTime: 60_000 });

export const usePrinters = () =>
  useQuery({
    queryKey: ["printers"],
    queryFn: () => api<PrinterSummary[]>("/api/printers"),
    refetchInterval: 30_000,
  });

export interface JobFilters {
  printer?: string;
  status?: string;
  from?: number | null;
  q?: string;
  material?: string;
  part?: string;
}

export const fetchJobs = (filters: JobFilters, cursor: string | null) =>
  api<JobListResponse>(`/api/jobs${qs({ ...filters, cursor, limit: 50 })}`);

export const useJob = (id: string) =>
  useQuery({ queryKey: ["job", id], queryFn: () => api<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`) });

export const useParts = (q: string) =>
  useQuery({ queryKey: ["parts", q], queryFn: () => api<PartListItem[]>(`/api/parts${qs({ q })}`) });

export const usePart = (id: string) =>
  useQuery({
    queryKey: ["part", id],
    queryFn: () => api<PartDetail>(`/api/parts/${encodeURIComponent(id)}`),
  });

export const useStats = (from: number, bucket: string) =>
  useQuery({
    queryKey: ["stats", from, bucket],
    queryFn: () => api<StatsResponse>(`/api/stats${qs({ from, bucket })}`),
  });

export const useQueue = (view: "active" | "history") =>
  useQuery({
    queryKey: ["queue", view],
    queryFn: () => api<QueueItem[]>(`/api/queue${qs({ view })}`),
    // Suggestions follow live printer state, and items move on when printers report jobs.
    refetchInterval: 10_000,
  });

export const useUsers = () =>
  useQuery({ queryKey: ["users"], queryFn: () => api<UserRow[]>("/api/admin/users") });
export const useAgents = () =>
  useQuery({ queryKey: ["agents"], queryFn: () => api<AgentRow[]>("/api/admin/agents") });
export const useAudit = () =>
  useQuery({ queryKey: ["audit"], queryFn: () => api<AuditRow[]>("/api/admin/audit") });

export function invalidate(client: QueryClient, ...keys: string[]): Promise<void> {
  return Promise.all(keys.map((k) => client.invalidateQueries({ queryKey: [k] }))).then(() => undefined);
}
