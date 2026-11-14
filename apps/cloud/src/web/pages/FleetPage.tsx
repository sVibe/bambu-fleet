import {
  isLiveOnline,
  LIVE_STALE_MS,
  liveSeenAt,
  type PrinterLiveState,
  type TrayState,
} from "@fleet/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PrinterSummary } from "../../api-types.ts";
import { usePrinters } from "../api.ts";
import { HmsAlerts, HmsCount, PrintError } from "../components/Hms.tsx";
import { PrinterImage } from "../components/PrinterImage.tsx";
import {
  Badge,
  Card,
  cx,
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

type View = "grid" | "list";
const VIEW_KEY = "fleet.view";

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

const ACTIVE_STATES = ["PREPARE", "RUNNING", "PAUSE", "SLICING"];

type FleetPrinter = PrinterSummary & { online: boolean };

export function FleetPage() {
  const printers = usePrinters();
  const live = useLiveStates();
  // Judge freshness on the server's clock, so a skewed browser or agent clock can't hide printers.
  const now = useNow() + live.clockOffset;
  const client = useQueryClient();
  const [view, setViewState] = useState<View>(readView);

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Remembering the view is a convenience; private windows may refuse storage.
    }
  };

  // A printer the agent just registered shows up in the live feed before the printer list.
  useEffect(() => {
    if (!printers.data) return;
    const known = new Set(printers.data.map((p) => p.serial));
    if ([...live.states.keys()].some((serial) => !known.has(serial))) {
      void client.invalidateQueries({ queryKey: ["printers"] });
    }
  }, [live.states, printers.data, client]);

  const list: FleetPrinter[] = (printers.data ?? []).map((p) => {
    const state = live.states.get(p.serial) ?? p.live;
    return { ...p, live: state, online: isLiveOnline(state, now) };
  });
  // "Live" only means this page's connection is up; say so when no agent has reported recently.
  const lastAgentData = Math.max(0, ...list.flatMap((p) => (p.live ? [liveSeenAt(p.live)] : [])));
  const agentQuiet = list.length > 0 && now - lastAgentData > LIVE_STALE_MS;
  const printing = list.filter(
    (p) => p.online && ["PREPARE", "RUNNING", "PAUSE"].includes(p.live?.gcodeState ?? ""),
  );
  const attention = list.filter(
    (p) =>
      p.online &&
      (p.live?.gcodeState === "FAILED" || p.live?.gcodeState === "PAUSE" || (p.live?.hms.length ?? 0) > 0),
  );

  return (
    <>
      <PageHeader
        title="Fleet"
        subtitle={
          printers.data
            ? `${list.filter((p) => p.online).length} of ${list.length} online · ${printing.length} printing · ${attention.length} need attention`
            : undefined
        }
        actions={
          <>
            {live.status === "live" && agentQuiet ? (
              <span
                title={
                  lastAgentData
                    ? `The page is connected, but no agent has sent printer data since ${ago(lastAgentData, now)}. Check that the LAN agent is running.`
                    : "The page is connected, but no agent has sent printer data yet. Check that the LAN agent is running."
                }
              >
                <Badge tone="warning">No agent data</Badge>
              </span>
            ) : (
              <Badge tone={live.status === "live" ? "good" : "neutral"}>{LIVE_LABEL[live.status]}</Badge>
            )}
            <div className="flex rounded-lg border border-hairline bg-raised p-0.5 text-sm">
              {(["grid", "list"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={cx(
                    "rounded-md px-3 py-1",
                    view === v ? "bg-wash font-medium text-ink" : "text-ink-2 hover:text-ink",
                  )}
                >
                  {v === "grid" ? "Grid" : "List"}
                </button>
              ))}
            </div>
          </>
        }
      />
      {printers.isLoading && <Loading />}
      {printers.error && <ErrorState error={printers.error} />}
      {printers.data && list.length === 0 && (
        <Empty title="No printers yet">
          Create an agent under Admin → Agents, add your printers to its <code>agent.yaml</code> and start it
          on a machine on the printers' network. Printers appear here as soon as it connects.
        </Empty>
      )}
      {list.length > 0 &&
        (view === "grid" ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((p) => (
              <PrinterCard key={p.serial} printer={p} now={now} />
            ))}
          </div>
        ) : (
          <Card>
            <ul className="divide-y divide-hairline">
              {list.map((p) => (
                <PrinterRow key={p.serial} printer={p} now={now} />
              ))}
            </ul>
          </Card>
        ))}
    </>
  );
}

function trayList(s: PrinterLiveState | null): Array<TrayState & { unit: string }> {
  return [
    ...(s?.ams ?? []).flatMap((u) => u.trays.map((t) => ({ ...t, unit: `AMS ${u.id + 1}` }))),
    ...(s?.externalSpools ?? []).filter((t) => t.material).map((t) => ({ ...t, unit: "Ext" })),
  ];
}

const isActive = (p: FleetPrinter) => p.online && !!p.live && ACTIVE_STATES.includes(p.live.gcodeState);

/** One line on what the printer is doing when it isn't printing. */
function idleText(p: FleetPrinter, now: number): ReactNode {
  const s = p.live;
  if (!p.online) return `Last seen ${ago(s ? liveSeenAt(s) : p.lastSeenAt, now)}`;
  if (s?.gcodeState === "FINISH") return `Finished ${s.jobName ?? "job"} – bed needs clearing`;
  if (s?.gcodeState === "FAILED") {
    return s.printError ? (
      <>
        {s.jobName ?? "Job"} stopped: <PrintError code={s.printError} serial={p.serial} />
      </>
    ) : (
      `${s.jobName ?? "Job"} stopped`
    );
  }
  return "Ready";
}

/** Job name, progress bar and ETA of a printing printer. */
function JobProgress({ printer, now }: { printer: FleetPrinter; now: number }) {
  const s = printer.live as PrinterLiveState;
  const finishAt = s.remainingMin ? now + s.remainingMin * 60_000 : null;
  return (
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
        <ProgressBar value={s.progressPct ?? 0} tone={s.gcodeState === "PAUSE" ? "warning" : "accent"} />
      </div>
      <div className="tabular mt-1.5 flex justify-between gap-2 text-xs text-ink-2">
        <span>
          {s.progressPct ?? 0}% · layer {s.layer ?? "–"}/{s.totalLayers ?? "–"}
        </span>
        <span>{finishAt ? `done ~${clock(finishAt)}` : ""}</span>
      </div>
    </div>
  );
}

function PrinterCard({ printer, now }: { printer: FleetPrinter; now: number }) {
  const s = printer.live;
  const trays = trayList(s);

  return (
    <Card className={printer.online ? "p-4" : "p-4 opacity-75"}>
      <div className="flex items-start gap-3">
        <PrinterImage model={printer.model} serial={printer.serial} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h2 className="truncate font-semibold">{printer.name}</h2>
            <PrinterStateBadge state={s?.gcodeState ?? "UNKNOWN"} online={printer.online} />
          </div>
          <p className="truncate text-xs text-muted">
            {printer.model ?? "Printer"} · {printer.serial}
          </p>
        </div>
      </div>

      {isActive(printer) ? (
        <div className="mt-4 flex gap-3">
          <Thumb src={printer.currentJob?.thumbUrl ?? null} alt="" size={56} />
          <JobProgress printer={printer} now={now} />
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-2">{idleText(printer, now)}</p>
      )}

      {printer.online && s && (
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

      {printer.online && s && s.hms.length > 0 && (
        <HmsAlerts hms={s.hms} serial={printer.serial} className="mt-3" />
      )}
    </Card>
  );
}

/** A compact row: on phones the activity wraps under the name instead of scrolling sideways. */
function PrinterRow({ printer, now }: { printer: FleetPrinter; now: number }) {
  const s = printer.live;
  const trays = trayList(s);
  return (
    <li
      className={cx("flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3", !printer.online && "opacity-75")}
    >
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-3 md:w-56 md:flex-none">
        <PrinterImage model={printer.model} serial={printer.serial} size={44} />
        <div className="min-w-0">
          <div className="truncate font-medium">{printer.name}</div>
          <div className="truncate text-xs text-muted">
            {printer.model ?? "Printer"} · {printer.serial}
          </div>
        </div>
      </div>
      <div className="order-last flex w-full min-w-0 items-center md:order-none md:w-auto md:flex-1">
        {isActive(printer) ? (
          <JobProgress printer={printer} now={now} />
        ) : (
          <p className="truncate text-sm text-ink-2">{idleText(printer, now)}</p>
        )}
      </div>
      {printer.online && s && (
        <div className="tabular hidden w-36 shrink-0 text-right text-xs text-ink-2 lg:block">
          {s.nozzleTempC === null ? "–" : `${Math.round(s.nozzleTempC)}°`} nozzle ·{" "}
          {s.bedTempC === null ? "–" : `${Math.round(s.bedTempC)}°`} bed
        </div>
      )}
      {trays.length > 0 && (
        <ul className="hidden shrink-0 items-center gap-1 xl:flex" aria-label="Loaded filament">
          {trays.map((t) => (
            <li key={`${t.unit}-${t.id}`}>
              <Swatch
                color={t.color}
                size={12}
                title={`${t.unit} slot ${t.id + 1}: ${t.material ?? "Empty"}${t.remainPct !== null ? ` ${t.remainPct}%` : ""}`}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="flex shrink-0 items-center justify-end gap-2 md:w-44">
        {printer.online && s && s.hms.length > 0 && <HmsCount hms={s.hms} serial={printer.serial} />}
        <PrinterStateBadge state={s?.gcodeState ?? "UNKNOWN"} online={printer.online} />
      </div>
    </li>
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
