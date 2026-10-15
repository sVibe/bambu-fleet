import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { fetchJobs, type JobFilters, usePrinters } from "../api.ts";
import {
  Button,
  Card,
  Empty,
  ErrorState,
  FilamentChips,
  inputClass,
  JobStatusBadge,
  Loading,
  PageHeader,
  Select,
  Td,
  Th,
  Thumb,
} from "../components/ui.tsx";
import { dateTime, duration, grams } from "../format.ts";

const RANGES: Array<{ label: string; days: number | null }> = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "All time", days: null },
];

export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const printers = usePrinters();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const range = params.get("range") ?? "30";
  const days = range === "all" ? null : Number(range);
  // Round to the minute so the query key stays stable while the page is open.
  const from = days ? Math.floor((Date.now() - days * 86_400_000) / 60_000) * 60_000 : null;

  const filters: JobFilters = {
    printer: params.get("printer") ?? undefined,
    status: params.get("status") ?? undefined,
    q: params.get("q") ?? undefined,
    material: params.get("material") ?? undefined,
    from,
  };

  const jobs = useInfiniteQuery({
    queryKey: ["jobs", filters],
    queryFn: ({ pageParam }) => fetchJobs(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const items = jobs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Print history" subtitle="Every job the agents have seen, newest first." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            set("q", search.trim());
          }}
        >
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => set("q", search.trim())}
            placeholder="Search job or file name"
            aria-label="Search jobs"
            className={`${inputClass} w-full min-w-48`}
          />
        </form>
        <Select
          aria-label="Time range"
          value={range}
          onChange={(e) => set("range", e.target.value === "30" ? "" : e.target.value)}
        >
          {RANGES.map((r) => (
            <option key={r.label} value={r.days === null ? "all" : String(r.days)}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Printer"
          value={filters.printer ?? ""}
          onChange={(e) => set("printer", e.target.value)}
        >
          <option value="">All printers</option>
          {printers.data?.map((p) => (
            <option key={p.serial} value={p.serial}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status"
          value={filters.status ?? ""}
          onChange={(e) => set("status", e.target.value)}
        >
          <option value="">Any status</option>
          <option value="printing">Printing</option>
          <option value="finished">Finished</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        {filters.material && (
          <Button variant="ghost" onClick={() => set("material", "")}>
            Material: {filters.material} ✕
          </Button>
        )}
      </div>

      {jobs.isLoading && <Loading />}
      {jobs.error && <ErrorState error={jobs.error} />}
      {jobs.data && items.length === 0 && (
        <Empty title="No jobs match">Jobs appear here once an agent sees a printer start a print.</Empty>
      )}
      {items.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-hairline">
              <tr>
                <Th>Job</Th>
                <Th>Printer</Th>
                <Th>Status</Th>
                <Th>Started</Th>
                <Th className="text-right">Duration</Th>
                <Th className="text-right">Filament</Th>
                <Th>Materials</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {items.map((j) => (
                <tr key={j.id} className="hover:bg-wash/60">
                  <Td>
                    <Link
                      to={`/jobs/${j.id}`}
                      className="flex items-center gap-3 font-medium hover:underline"
                    >
                      <Thumb src={j.thumbUrl} alt="" size={36} />
                      <span className="min-w-0">
                        <span className="block truncate">{j.name}</span>
                        <span className="text-xs font-normal text-muted">
                          {j.partCount > 0
                            ? `${j.partCount} ${j.partCount === 1 ? "part" : "parts"}`
                            : "no part data"}
                        </span>
                      </span>
                    </Link>
                  </Td>
                  <Td className="text-ink-2">{j.printerName}</Td>
                  <Td>
                    <JobStatusBadge status={j.status} />
                  </Td>
                  <Td className="tabular whitespace-nowrap text-ink-2">{dateTime(j.startedAt)}</Td>
                  <Td className="tabular text-right text-ink-2">{duration(j.durationS)}</Td>
                  <Td className="tabular text-right">
                    {grams(j.actualWeightG ?? (j.status === "printing" ? j.estWeightG : null))}
                  </Td>
                  <Td>
                    <FilamentChips filaments={j.filaments} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {jobs.hasNextPage && (
        <div className="mt-4 text-center">
          <Button onClick={() => jobs.fetchNextPage()} disabled={jobs.isFetchingNextPage}>
            {jobs.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
}
