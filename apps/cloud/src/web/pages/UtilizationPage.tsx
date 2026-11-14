import { type HourCell, summarizeUtilization, type UtilizationSummary } from "@fleet/shared";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import type { UtilizationResponse } from "../../api-types.ts";
import { useUtilization } from "../api.ts";
import { Card, Empty, ErrorState, Loading, PageHeader, Select, StatTile, Td, Th } from "../components/ui.tsx";
import { percent } from "../format.ts";

const RANGES = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
] as const;

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
const hours = (h: number) => `${h >= 100 ? Math.round(h) : h.toFixed(1)} h`;
const cellRatio = (c: HourCell) => (c.availableS > 0 ? c.busyS / c.availableS : null);

export function UtilizationPage() {
  const [rangeIndex, setRangeIndex] = useState(1);
  const range = RANGES[rangeIndex] ?? RANGES[1];
  const [now] = useState(() => Date.now());
  const from = Math.floor((now - range.days * 86_400_000) / 60_000) * 60_000;
  const data = useUtilization(from);

  return (
    <>
      <PageHeader
        title="Machine utilization"
        subtitle="Share of each printer's time spent on jobs (any outcome), from when the printer was first seen. Hours are in your time zone."
        actions={
          <Select
            aria-label="Time range"
            value={rangeIndex}
            onChange={(e) => setRangeIndex(Number(e.target.value))}
          >
            {RANGES.map((r, i) => (
              <option key={r.label} value={i}>
                {r.label}
              </option>
            ))}
          </Select>
        }
      />
      {data.isLoading && <Loading />}
      {data.error && <ErrorState error={data.error} />}
      {data.data && <Dashboard data={data.data} />}
    </>
  );
}

function Dashboard({ data }: { data: UtilizationResponse }) {
  const summary = useMemo(
    () => summarizeUtilization(data.printers, data.intervals, data.range.from, data.range.to),
    [data],
  );
  const names = new Map(data.printers.map((p) => [p.serial, p]));
  if (data.printers.length === 0) return <Empty title="No printers yet" />;

  const f = summary.fleet;
  const ranked = f.byHour
    .map((c, h) => ({ h, r: cellRatio(c) }))
    .filter((x): x is { h: number; r: number } => x.r !== null)
    .sort((a, b) => b.r - a.r);
  const busiest = ranked[0];
  const quietest = ranked.at(-1);

  return (
    <div className="space-y-4">
      {/* An odd last tile spans the row on two-column screens instead of sitting alone. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 max-lg:[&>*:last-child:nth-child(odd)]:col-span-2">
        <StatTile label="Fleet utilization" value={percent(f.utilization)} note="of available printer time" />
        <StatTile
          label="Busy per printer"
          value={f.hoursPerDay !== null ? `${f.hoursPerDay.toFixed(1)} h/day` : "–"}
          note="average over the period"
        />
        <StatTile label="Printing time" value={hours(f.busyH)} note={`${f.jobs} jobs, all printers`} />
        <StatTile
          label="Idle capacity"
          value={hours(Math.max(0, f.availableH - f.busyH))}
          note="printer-hours not printing"
        />
        <StatTile
          label="Busiest hour"
          value={busiest ? hourLabel(busiest.h) : "–"}
          note={
            busiest && quietest
              ? `${percent(busiest.r)} busy · quietest ${hourLabel(quietest.h)} (${percent(quietest.r)})`
              : undefined
          }
        />
      </div>
      <HourHeatmap summary={summary} names={names} />
      <DailyChart summary={summary} />
      <PrinterTable summary={summary} names={names} />
    </div>
  );
}

/** Quantized steps keep neighbouring cells comparable at a glance; exact values are in the readout and table. */
const STEPS = [0.2, 0.4, 0.6, 0.8, 1];

function cellColor(r: number | null): string {
  if (r === null) return "transparent";
  if (r === 0) return "var(--color-wash)";
  const step = STEPS.findIndex((s) => r <= s) + 1;
  return `color-mix(in oklab, var(--series-1) ${step * 18}%, var(--color-wash))`;
}

function HourHeatmap({
  summary,
  names,
}: {
  summary: UtilizationSummary;
  names: Map<string, { name: string }>;
}) {
  const [hover, setHover] = useState<{ row: string; h: number; r: number | null } | null>(null);
  const [showTable, setShowTable] = useState(false);
  const rows = [
    { key: "Fleet", label: "All printers", cells: summary.fleet.byHour, strong: true },
    ...summary.printers.map((p) => ({
      key: p.serial,
      label: names.get(p.serial)?.name ?? p.serial,
      cells: p.byHour,
      strong: false,
    })),
  ];

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Busy by hour of day</h2>
          <p className="text-xs text-ink-2">
            Share of each hour, across the period, that the printer was on a job.
          </p>
        </div>
        <button
          type="button"
          className="text-xs text-accent-ink hover:underline"
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? "Show heatmap" : "Show table"}
        </button>
      </div>

      {showTable ? (
        <div className="mt-3 overflow-x-auto">
          <table className="tabular w-full text-xs">
            <thead className="border-b border-hairline">
              <tr>
                <Th>Hour</Th>
                {rows.map((r) => (
                  <Th key={r.key} className="text-right">
                    {r.label}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {Array.from({ length: 24 }, (_, h) => (
                <tr key={hourLabel(h)}>
                  <Td>{hourLabel(h)}</Td>
                  {rows.map((r) => (
                    <Td key={r.key} className="text-right">
                      {percent(cellRatio(r.cells[h] as HourCell))}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {/* All 24 hours fit the width, so phones see the whole day without scrolling sideways. */}
          <div className="mt-4">
            <div
              className="grid items-center gap-px sm:gap-[2px]"
              style={{ gridTemplateColumns: "fit-content(140px) repeat(24, minmax(0, 1fr))" }}
            >
              <div />
              {Array.from({ length: 24 }, (_, h) => (
                <div key={hourLabel(h)} className="text-center text-[10px] text-muted">
                  {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                </div>
              ))}
              {rows.map((row) => (
                <HeatRow key={row.key} row={row} onHover={(h, r) => setHover({ row: row.label, h, r })} />
              ))}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-2">
            <div className="tabular min-h-4" aria-live="polite">
              {hover ? (
                <>
                  <span className="font-semibold text-ink">{percent(hover.r)}</span> busy · {hover.row} ·{" "}
                  {hourLabel(hover.h)}–{hourLabel((hover.h + 1) % 24)}
                </>
              ) : (
                "Hover or tap a cell for its value."
              )}
            </div>
            <div className="flex items-center gap-1.5" role="img" aria-label="Colour scale from 0% to 100%">
              <span>0%</span>
              <span className="size-3 rounded-[3px]" style={{ background: cellColor(0) }} />
              {STEPS.map((s) => (
                <span key={s} className="size-3 rounded-[3px]" style={{ background: cellColor(s) }} />
              ))}
              <span>100%</span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function HeatRow({
  row,
  onHover,
}: {
  row: { label: string; cells: HourCell[]; strong: boolean };
  onHover: (h: number, r: number | null) => void;
}) {
  return (
    <>
      <div className={`truncate pr-2 text-xs ${row.strong ? "font-semibold text-ink" : "text-ink-2"}`}>
        {row.label}
      </div>
      {row.cells.map((c, h) => {
        const r = cellRatio(c);
        return (
          <div
            key={hourLabel(h)}
            role="img"
            aria-label={`${row.label} ${hourLabel(h)}: ${percent(r)} busy`}
            title={`${row.label} ${hourLabel(h)}: ${percent(r)}`}
            onMouseEnter={() => onHover(h, r)}
            // Touch screens have no hover: a tap shows the value. The table view serves keyboards.
            onPointerDown={() => onHover(h, r)}
            className="h-5 rounded-[2px] ring-inset hover:ring-2 hover:ring-ink sm:h-6 sm:rounded-[3px]"
            style={{ background: cellColor(r) }}
          />
        );
      })}
    </>
  );
}

function DailyChart({ summary }: { summary: UtilizationSummary }) {
  const rows = summary.byDay.map((d) => ({
    day: d.day,
    pct: d.utilization === null ? 0 : d.utilization * 100,
    busyH: d.busyH,
  }));
  return (
    <Card className="p-4">
      <h2 className="font-semibold">Fleet utilization per day</h2>
      <p className="text-xs text-ink-2">Busy printer-hours as a share of available printer-hours.</p>
      <div className="mt-3 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="25%">
            <CartesianGrid vertical={false} stroke="var(--color-grid)" />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={{ stroke: "var(--color-line)" }}
              tick={{ fill: "var(--color-muted)", fontSize: 12 }}
              tickFormatter={(d: string) => d.slice(5)}
              minTickGap={16}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickLine={false}
              axisLine={false}
              width={44}
              tick={{ fill: "var(--color-muted)", fontSize: 12 }}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip content={DayTooltip} cursor={{ fill: "var(--color-wash)" }} />
            <Bar
              dataKey="pct"
              fill="var(--series-1)"
              maxBarSize={24}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function DayTooltip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
  const row = payload?.[0]?.payload as { pct: number; busyH: number } | undefined;
  if (!active || !row) return null;
  return (
    <div className="rounded-lg border border-hairline bg-raised px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 text-ink-2">{label}</div>
      <div className="tabular">
        <span className="font-semibold text-ink">{Math.round(row.pct)}%</span>{" "}
        <span className="text-ink-2">· {hours(row.busyH)} printing</span>
      </div>
    </div>
  );
}

function PrinterTable({
  summary,
  names,
}: {
  summary: UtilizationSummary;
  names: Map<string, { name: string; model: string | null }>;
}) {
  const rows = [...summary.printers].sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));
  return (
    <Card className="overflow-x-auto">
      <h2 className="px-4 pt-4 font-semibold">By printer</h2>
      <table className="mt-2 w-full text-sm sm:min-w-[620px]">
        <thead className="border-b border-hairline">
          <tr>
            <Th>Printer</Th>
            <Th className="hidden text-right sm:table-cell">Jobs</Th>
            <Th className="hidden text-right sm:table-cell">Printing</Th>
            <Th className="text-right">Per day</Th>
            <Th className="w-2/5">Utilization</Th>
          </tr>
        </thead>
        <tbody className="tabular divide-y divide-hairline">
          {rows.map((p) => {
            const info = names.get(p.serial);
            return (
              <tr key={p.serial}>
                <Td>
                  <Link to={`/history?printer=${p.serial}`} className="hover:underline">
                    {info?.name ?? p.serial}
                  </Link>
                  {info?.model && <span className="ml-2 text-xs text-muted">{info.model}</span>}
                  <div className="text-xs text-muted sm:hidden">
                    {p.jobs} jobs · {hours(p.busyH)}
                  </div>
                </Td>
                <Td className="hidden text-right sm:table-cell">{p.jobs}</Td>
                <Td className="hidden text-right text-ink-2 sm:table-cell">{hours(p.busyH)}</Td>
                <Td className="text-right text-ink-2">
                  {p.hoursPerDay !== null ? `${p.hoursPerDay.toFixed(1)} h` : "–"}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-sm bg-wash">
                      <div
                        className="h-full rounded-r-[4px] bg-[var(--series-1)]"
                        style={{ width: `${(p.utilization ?? 0) * 100}%` }}
                      />
                    </div>
                    <span className="w-10 text-right text-xs text-ink-2">{percent(p.utilization)}</span>
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
