import { useState } from "react";
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
import type { StatsResponse } from "../../api-types.ts";
import { useStats } from "../api.ts";
import {
  Card,
  cx,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  Select,
  StatTile,
  Swatch,
  Td,
  Th,
} from "../components/ui.tsx";
import { grams, percent } from "../format.ts";

/**
 * Material families get fixed categorical slots (validated order from the dataviz palette), so a
 * family keeps its colour whatever the date range. Anything else folds into "Other".
 */
const FAMILIES = ["PLA", "PETG", "ABS", "ASA", "TPU", "PC", "PA"] as const;
const FAMILY_COLOR: Record<string, string> = {
  PLA: "var(--series-1)",
  PETG: "var(--series-2)",
  ABS: "var(--series-3)",
  ASA: "var(--series-4)",
  TPU: "var(--series-5)",
  PC: "var(--series-6)",
  PA: "var(--series-7)",
  Other: "var(--series-other)",
};

function family(material: string): string {
  const base = material.toUpperCase().split(/[-\s+]/)[0] ?? "";
  return (FAMILIES as readonly string[]).includes(base) ? base : "Other";
}

const RANGES = [
  { label: "Last 30 days", days: 30, bucket: "day" },
  { label: "Last 90 days", days: 90, bucket: "week" },
  { label: "Last 12 months", days: 365, bucket: "month" },
] as const;

export function AnalyticsPage() {
  const [rangeIndex, setRangeIndex] = useState(0);
  const range = RANGES[rangeIndex] ?? RANGES[0];
  const [from] = useState(() => Date.now());
  const start = Math.floor((from - range.days * 86_400_000) / 60_000) * 60_000;
  const stats = useStats(start, range.bucket);

  return (
    <>
      <PageHeader
        title="Materials & activity"
        subtitle="Filament actually consumed: full plates for finished jobs, up to the stop layer for failed or cancelled ones."
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
      {stats.isLoading && <Loading />}
      {stats.error && <ErrorState error={stats.error} />}
      {stats.data && <Dashboard data={stats.data} />}
    </>
  );
}

function Dashboard({ data }: { data: StatsResponse }) {
  const t = data.totals;
  if (t.jobs === 0) return <Empty title="No jobs in this period" />;
  const wastePct = t.grams > 0 ? t.wasteG / t.grams : null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Filament used" value={grams(t.grams)} />
        <StatTile
          label="Jobs"
          value={t.jobs}
          note={`${t.finished} finished · ${t.failed} failed · ${t.cancelled} cancelled`}
        />
        <StatTile label="Success rate" value={percent(t.successRate)} note="finished ÷ (finished + failed)" />
        <StatTile label="Print time" value={`${t.printHours} h`} />
        <StatTile
          label="Waste"
          value={grams(t.wasteG)}
          note={wastePct !== null ? `${percent(wastePct)} of filament, finished jobs` : undefined}
        />
      </div>
      <MaterialChart data={data} />
      <div className="grid gap-4 lg:grid-cols-2">
        <PrinterTable data={data} />
        <ColorList data={data} />
      </div>
      <TopParts data={data} />
    </div>
  );
}

function MaterialChart({ data }: { data: StatsResponse }) {
  const [showTable, setShowTable] = useState(false);
  const totals = new Map<string, number>();
  const rows = new Map<string, Record<string, number | string>>();
  for (const r of data.byPeriod) {
    const f = family(r.material);
    const row = rows.get(r.period) ?? { period: r.period };
    row[f] = ((row[f] as number | undefined) ?? 0) + r.grams;
    rows.set(r.period, row);
    totals.set(f, (totals.get(f) ?? 0) + r.grams);
  }
  const series = [...FAMILIES, "Other"].filter((f) => totals.has(f));
  const chartRows = [...rows.values()];
  const top = series.at(-1);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Filament by material</h2>
          <p className="text-xs text-ink-2">Grams per {data.range.bucket}</p>
        </div>
        <button
          type="button"
          className="text-xs text-accent-ink hover:underline"
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {series.length > 1 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Legend">
          {series.map((s) => (
            <li key={s} className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-sm" style={{ background: FAMILY_COLOR[s] }} />
              {s} <span className="tabular text-muted">{grams(totals.get(s))}</span>
            </li>
          ))}
        </ul>
      )}
      {showTable ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-hairline">
              <tr>
                <Th>Period</Th>
                {series.map((s) => (
                  <Th key={s} className="text-right">
                    {s}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular divide-y divide-hairline">
              {chartRows.map((r) => (
                <tr key={r.period as string}>
                  <Td>{r.period}</Td>
                  {series.map((s) => (
                    <Td key={s} className="text-right">
                      {grams((r[s] as number | undefined) ?? 0)}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="30%">
              <CartesianGrid vertical={false} stroke="var(--color-grid)" />
              <XAxis
                dataKey="period"
                tickLine={false}
                axisLine={{ stroke: "var(--color-line)" }}
                tick={{ fill: "var(--color-muted)", fontSize: 12 }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tick={{ fill: "var(--color-muted)", fontSize: 12 }}
                tickFormatter={(v: number) => grams(v)}
              />
              <Tooltip content={MaterialTooltip} cursor={{ fill: "var(--color-wash)" }} />
              {series.map((s) => (
                <Bar
                  key={s}
                  dataKey={s}
                  stackId="m"
                  fill={FAMILY_COLOR[s]}
                  stroke="var(--color-surface)"
                  strokeWidth={2}
                  maxBarSize={24}
                  radius={s === top ? [4, 4, 0, 0] : 0}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function MaterialTooltip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null;
  const items = payload.filter((p) => Number(p.value ?? 0) > 0).reverse();
  const total = items.reduce((n, p) => n + Number(p.value ?? 0), 0);
  return (
    <div className="rounded-lg border border-hairline bg-raised px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 text-ink-2">{label}</div>
      {items.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: FAMILY_COLOR[String(p.dataKey)] }}
          />
          <span className="tabular font-semibold text-ink">{grams(Number(p.value))}</span>
          <span className="text-ink-2">{String(p.dataKey)}</span>
        </div>
      ))}
      {items.length > 1 && (
        <div className="tabular mt-1 border-t border-hairline pt-1 text-ink-2">Total {grams(total)}</div>
      )}
    </div>
  );
}

function PrinterTable({ data }: { data: StatsResponse }) {
  const max = Math.max(1, ...data.byPrinter.map((p) => p.grams));
  return (
    <Card className="overflow-x-auto">
      <h2 className="px-4 pt-4 font-semibold">By printer</h2>
      <table className="mt-2 w-full text-sm">
        <thead className="border-b border-hairline">
          <tr>
            <Th>Printer</Th>
            <Th className="text-right">Jobs</Th>
            <Th className="text-right">Success</Th>
            <Th className="text-right">Hours</Th>
            <Th className="w-2/5">Filament</Th>
          </tr>
        </thead>
        <tbody className="tabular divide-y divide-hairline">
          {data.byPrinter.map((p) => (
            <tr key={p.serial}>
              <Td>
                <Link to={`/history?printer=${p.serial}`} className="hover:underline">
                  {p.name}
                </Link>
              </Td>
              <Td className="text-right">{p.jobs}</Td>
              <Td className="text-right text-ink-2">
                {p.finished + p.failed ? percent(p.finished / (p.finished + p.failed)) : "–"}
              </Td>
              <Td className="text-right text-ink-2">{p.hours}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-sm bg-wash">
                    <div
                      className="h-full rounded-r-[4px] bg-[var(--series-1)]"
                      style={{ width: `${(p.grams / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-16 text-right text-xs text-ink-2">{grams(p.grams)}</span>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ColorList({ data }: { data: StatsResponse }) {
  const max = Math.max(1, ...data.byColor.map((c) => c.grams));
  return (
    <Card className="p-4">
      <h2 className="font-semibold">Spools by colour</h2>
      <p className="text-xs text-ink-2">Swatches show the filament's own colour.</p>
      <ul className="mt-3 space-y-2">
        {data.byColor.map((c) => (
          <li key={`${c.material}-${c.color}`} className="flex items-center gap-2 text-sm">
            <Swatch color={c.color} size={14} />
            <span className="w-28 shrink-0 truncate text-ink-2">
              {c.material} {c.color ? <span className="font-mono text-xs text-muted">#{c.color}</span> : null}
            </span>
            <div className="h-2 flex-1 rounded-sm bg-wash">
              <div
                className={cx("h-full rounded-r-[4px] bg-ink-2")}
                style={{ width: `${(c.grams / max) * 100}%` }}
              />
            </div>
            <span className="tabular w-16 text-right text-xs text-ink-2">{grams(c.grams)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TopParts({ data }: { data: StatsResponse }) {
  if (data.topParts.length === 0) return null;
  return (
    <Card className="overflow-x-auto">
      <h2 className="px-4 pt-4 font-semibold">Most printed parts</h2>
      <table className="mt-2 w-full text-sm">
        <thead className="border-b border-hairline">
          <tr>
            <Th>Part</Th>
            <Th className="text-right">Printed</Th>
            <Th className="text-right">Filament</Th>
          </tr>
        </thead>
        <tbody className="tabular divide-y divide-hairline">
          {data.topParts.map((p) => (
            <tr key={p.id}>
              <Td>
                <Link to={`/parts/${p.id}`} className="hover:underline">
                  {p.name}
                </Link>
              </Td>
              <Td className="text-right">{p.qty}</Td>
              <Td className="text-right text-ink-2">{grams(p.grams)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
