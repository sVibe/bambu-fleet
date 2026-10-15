import { formatPrintError, LIVE_STALE_MS, type PrinterLiveState, type TrayState } from "@fleet/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link } from "react-router";
import type { PrinterSummary } from "../../api-types.ts";
import { usePrinters } from "../api.ts";
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  PrinterStateBadge,
  ProgressBar,
  Swatch,
  Thumb,
} from "../components/ui.tsx";
import { ago, clock } from "../format.ts";
import { type LiveStatus, useLiveStates, useNow } from "../live.ts";

const LIVE_LABEL: Record<LiveStatus, string> = {
  live: "Live",
  connecting: "Connecting…",
  offline: "Reconnecting…",
};

export function FleetPage() {
  const printers = usePrinters();
  const live = useLiveStates();
  const now = useNow();
  const client = useQueryClient();

  // A printer the agent just registered shows up in the live feed before the printer list.
  useEffect(() => {
    if (!printers.data) return;
    const known = new Set(printers.data.map((p) => p.serial));
    if ([...live.states.keys()].some((serial) => !known.has(serial))) {
      void client.invalidateQueries({ queryKey: ["printers"] });
    }
  }, [live.states, printers.data, client]);

  const list = (printers.data ?? []).map((p) => ({ ...p, live: live.states.get(p.serial) ?? p.live }));
  const isOnline = (s: PrinterLiveState | null) => !!s && s.online && now - s.updatedAt < LIVE_STALE_MS;
  const printing = list.filter(
    (p) => isOnline(p.live) && ["PREPARE", "RUNNING", "PAUSE"].includes(p.live?.gcodeState ?? ""),
  );
  const attention = list.filter(
    (p) =>
      isOnline(p.live) &&
      (p.live?.gcodeState === "FAILED" || p.live?.gcodeState === "PAUSE" || (p.live?.hms.length ?? 0) > 0),
  );

  return (
    <>
      <PageHeader
        title="Fleet"
        subtitle={
          printers.data
            ? `${list.filter((p) => isOnline(p.live)).length} of ${list.length} online · ${printing.length} printing · ${attention.length} need attention`
            : undefined
        }
        actions={<Badge tone={live.status === "live" ? "good" : "neutral"}>{LIVE_LABEL[live.status]}</Badge>}
      />
      {printers.isLoading && <Loading />}
      {printers.error && <ErrorState error={printers.error} />}
      {printers.data && list.length === 0 && (
        <Empty title="No printers yet">
          Create an agent under Admin → Agents, add your printers to its <code>agent.yaml</code> and start it
          on a machine on the printers' network. Printers appear here as soon as it connects.
        </Empty>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((p) => (
          <PrinterCard key={p.serial} printer={p} online={isOnline(p.live)} now={now} />
        ))}
      </div>
    </>
  );
}

function PrinterCard({ printer, online, now }: { printer: PrinterSummary; online: boolean; now: number }) {
  const s = printer.live;
  const active = online && s && ["PREPARE", "RUNNING", "PAUSE", "SLICING"].includes(s.gcodeState);
  const trays: Array<TrayState & { unit: string }> = [
    ...(s?.ams ?? []).flatMap((u) => u.trays.map((t) => ({ ...t, unit: `AMS ${u.id + 1}` }))),
    ...(s?.externalSpools ?? []).filter((t) => t.material).map((t) => ({ ...t, unit: "Ext" })),
  ];
  const finishAt = s?.remainingMin ? now + s.remainingMin * 60_000 : null;

  return (
    <Card className={online ? "p-4" : "p-4 opacity-75"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{printer.name}</h2>
          <p className="text-xs text-muted">
            {printer.model ?? "Printer"} · {printer.serial}
          </p>
        </div>
        <PrinterStateBadge state={s?.gcodeState ?? "UNKNOWN"} online={online} />
      </div>

      {active && s ? (
        <div className="mt-4 flex gap-3">
          <Thumb src={printer.currentJob?.thumbUrl ?? null} alt="" size={56} />
          <div className="min-w-0 flex-1">
            {printer.currentJob ? (
              <Link
                to={`/jobs/${printer.currentJob.id}`}
                className="block truncate text-sm font-medium hover:underline"
              >
                {s.jobName ?? printer.currentJob.name}
              </Link>
            ) : (
              <div className="truncate text-sm font-medium">{s.jobName ?? "Preparing…"}</div>
            )}
            <div className="mt-2">
              <ProgressBar
                value={s.progressPct ?? 0}
                tone={s.gcodeState === "PAUSE" ? "warning" : "accent"}
              />
            </div>
            <div className="tabular mt-1.5 flex justify-between text-xs text-ink-2">
              <span>
                {s.progressPct ?? 0}% · layer {s.layer ?? "–"}/{s.totalLayers ?? "–"}
              </span>
              <span>{finishAt ? `done ~${clock(finishAt)}` : ""}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-2">
          {!online
            ? `Last seen ${ago(s?.updatedAt ?? printer.lastSeenAt, now)}`
            : s?.gcodeState === "FINISH"
              ? `Finished ${s.jobName ?? "job"} – bed needs clearing`
              : s?.gcodeState === "FAILED"
                ? `${s.jobName ?? "Job"} stopped${s.printError ? ` (error ${formatPrintError(s.printError)})` : ""}`
                : "Ready"}
        </p>
      )}

      {online && s && (
        <dl className="tabular mt-4 grid grid-cols-3 gap-2 text-xs">
          <Temp label="Nozzle" value={s.nozzleTempC} target={s.nozzleTargetC} />
          <Temp label="Bed" value={s.bedTempC} target={s.bedTargetC} />
          <Temp label="Chamber" value={s.chamberTempC} target={null} />
        </dl>
      )}

      {trays.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-x-3 gap-y-2 border-t border-hairline pt-3">
          {trays.map((t) => (
            <li
              key={`${t.unit}-${t.id}`}
              className="flex items-center gap-1.5 text-xs text-ink-2"
              title={`${t.unit} slot ${t.id + 1}`}
            >
              <Swatch color={t.color} size={14} />
              <span>{t.material ?? "Empty"}</span>
              {t.remainPct !== null && <span className="tabular text-muted">{t.remainPct}%</span>}
            </li>
          ))}
        </ul>
      )}

      {online && s && s.hms.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <Badge tone="warning">
            {s.hms.length} HMS {s.hms.length === 1 ? "alert" : "alerts"}
          </Badge>
          <span className="font-mono text-muted">
            {s.hms.map((h) => h.code.replace(/(.{4})(?!$)/g, "$1-")).join(", ")}
          </span>
        </div>
      )}
    </Card>
  );
}

function Temp({ label, value, target }: { label: string; value: number | null; target: number | null }) {
  return (
    <div className="rounded-lg bg-wash px-2 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink">
        {value === null ? "–" : `${Math.round(value)}°`}
        {target ? <span className="text-muted"> / {Math.round(target)}°</span> : null}
      </dd>
    </div>
  );
}
