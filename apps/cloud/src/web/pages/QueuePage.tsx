import {
  type JobAnalysis,
  modelForPrinterModelId,
  type QueuePlateInput,
  type QueueStatus,
  roleAtLeast,
} from "@fleet/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { PrinterSuggestion, QueueFile, QueueItem, SlotMapping } from "../../api-types.ts";
import type { AnalyzeMessage } from "../analyze.worker.ts";
import { ApiError, api, invalidate, useMe, useQueue } from "../api.ts";
import {
  Badge,
  Button,
  Card,
  cx,
  Empty,
  ErrorState,
  FilamentChips,
  inputClass,
  Loading,
  PageHeader,
  ProgressBar,
  Swatch,
  Td,
  Th,
  Thumb,
} from "../components/ui.tsx";
import { ago, dateTime, duration, grams } from "../format.ts";
import { useNow } from "../live.ts";

const STATUS: Record<QueueStatus, [Parameters<typeof Badge>[0]["tone"], string]> = {
  queued: ["neutral", "Queued"],
  assigned: ["accent", "Assigned"],
  dispatched: ["warning", "Dispatched"],
  printing: ["accent", "Printing"],
  done: ["good", "Done"],
  failed: ["critical", "Failed"],
  cancelled: ["neutral", "Cancelled"],
};

const VERDICT: Record<PrinterSuggestion["verdict"], [Parameters<typeof Badge>[0]["tone"], string]> = {
  ready: ["good", "Ready"],
  action: ["warning", "Needs a check"],
  wait: ["neutral", "Busy"],
  unsuitable: ["critical", "Unsuitable"],
};

function QueueStatusBadge({ status }: { status: QueueStatus }) {
  const [tone, label] = STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function QueuePage() {
  const me = useMe();
  const [view, setView] = useState<"active" | "history">("active");
  const [file, setFile] = useState<File | null>(null);
  const items = useQueue(view);
  const canEdit = !!me.data && roleAtLeast(me.data.role, "operator");
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <PageHeader
        title="Queue"
        subtitle="Upload sliced files, pick a printer, then start each print in Bambu Connect. Items follow the printer automatically once the job starts."
        actions={
          <>
            <div className="flex rounded-lg border border-hairline bg-raised p-0.5 text-sm">
              {(["active", "history"] as const).map((v) => (
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
                  {v === "active" ? "Active" : "History"}
                </button>
              ))}
            </div>
            {canEdit && (
              <>
                <input
                  ref={input}
                  type="file"
                  accept=".3mf"
                  className="hidden"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    e.target.value = "";
                  }}
                />
                <Button variant="primary" onClick={() => input.current?.click()}>
                  Upload 3MF
                </Button>
              </>
            )}
          </>
        }
      />
      {file && (
        <UploadPanel key={`${file.name}-${file.lastModified}`} file={file} onClose={() => setFile(null)} />
      )}
      {items.isLoading && <Loading />}
      {items.error && <ErrorState error={items.error} />}
      {items.data && items.data.length === 0 && (
        <Empty title={view === "active" ? "The queue is empty" : "Nothing finished yet"}>
          {view === "active"
            ? canEdit
              ? "Upload a sliced .gcode.3mf (File → Export → Export plate sliced file in Bambu Studio) to queue its plates."
              : "Operators upload sliced files here and dispatch them to printers."
            : "Done, failed and cancelled items show up here."}
        </Empty>
      )}
      {view === "active" && (
        <div className="space-y-4">
          {items.data?.map((item) => (
            <ItemCard key={item.id} item={item} canEdit={canEdit} />
          ))}
        </div>
      )}
      {view === "history" && items.data && items.data.length > 0 && (
        <HistoryTable items={items.data} canEdit={canEdit} />
      )}
    </>
  );
}

// --- Upload ---------------------------------------------------------------------------------------

type Analysis = { md5: string; plates: JobAnalysis[] };

function useAnalysis(file: File) {
  const [bytes, setBytes] = useState(0);
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const worker = new Worker(new URL("../analyze.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<AnalyzeMessage>) => {
      const m = event.data;
      if (m.type === "progress") setBytes(m.bytes);
      else if (m.type === "done") setResult({ md5: m.md5, plates: m.plates });
      else setError(m.message);
    };
    worker.onerror = (event) => setError(event.message || "Could not read the file");
    worker.postMessage(file);
    return () => worker.terminate();
  }, [file]);
  return { bytes, result, error };
}

/** PUT with upload progress, which fetch can't report. */
function putFile(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `${xhr.status} ${xhr.statusText}`;
      try {
        message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
      } catch {
        // not JSON
      }
      reject(new ApiError(xhr.status, message));
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload failed"));
    xhr.send(file);
  });
}

function toPlateInput(p: JobAnalysis): QueuePlateInput {
  const parts = new Map<string, { name: string; count: number; weightG: number | null }>();
  for (const part of p.parts) {
    const name = part.name.trim();
    const entry = parts.get(name) ?? { name, count: 0, weightG: null };
    entry.count++;
    if (part.weightG !== null) entry.weightG = (entry.weightG ?? 0) + part.weightG;
    parts.set(name, entry);
  }
  return {
    index: p.plateIndex,
    printerModelId: p.printerModelId,
    estTimeS: p.estTimeS,
    estWeightG: p.estWeightG,
    wasteG: p.wasteG,
    filaments: p.filaments,
    parts: [...parts.values()],
    thumbnailPngBase64: p.thumbnailPngBase64,
  };
}

function UploadPanel({ file, onClose }: { file: File; onClose: () => void }) {
  const client = useQueryClient();
  const { bytes, result, error } = useAnalysis(file);
  const plates = result?.plates.filter((p) => p.filaments.length > 0 || p.layerCurve) ?? [];
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [priority, setPriority] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const chosen = selected ?? new Set(plates.map((p) => p.plateIndex));

  const submit = useMutation({
    mutationFn: async () => {
      if (!result) return;
      const existing = await api<QueueFile>(`/api/queue/files/${result.md5}`).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      });
      if (!existing) await putFile(`/api/queue/files/${result.md5}`, file, setUploaded);
      setUploaded(1);
      await api<QueueFile>("/api/queue/files", {
        method: "POST",
        json: { md5: result.md5, filename: file.name, plates: plates.map(toPlateInput) },
      });
      for (const index of [...chosen].sort((a, b) => a - b)) {
        await api<QueueItem>("/api/queue", {
          method: "POST",
          json: { fileMd5: result.md5, plateIndex: index, quantity, priority },
        });
      }
    },
    onSuccess: () => {
      onClose();
      return invalidate(client, "queue");
    },
  });

  const model = modelForPrinterModelId(plates[0]?.printerModelId);
  return (
    <Card className="mb-6 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{file.name}</h2>
          <p className="text-xs text-muted">
            {file.size < 1024 * 1024
              ? `${Math.ceil(file.size / 1024)} KB`
              : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
            {result && (
              <>
                {" · "}
                <span className="font-mono">md5 {result.md5}</span>
                {" · sliced for "}
                {model ?? `unknown model (${plates[0]?.printerModelId ?? "no printer_model_id"})`}
              </>
            )}
          </p>
        </div>
        <Button variant="ghost" onClick={onClose} disabled={submit.isPending}>
          Close
        </Button>
      </div>

      {error && <p className="mt-4 text-sm text-critical">Could not read this file: {error}</p>}
      {!result && !error && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-ink-2">Reading plates, filaments and parts…</p>
          <ProgressBar value={(bytes / Math.max(1, file.size)) * 100} />
        </div>
      )}
      {result && plates.length === 0 && (
        <p className="mt-4 text-sm text-ink-2">
          This file has no sliced plates. Export it from Bambu Studio with File → Export → Export plate sliced
          file.
        </p>
      )}

      {plates.length > 0 && (
        <>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {plates.map((p) => (
              <label
                key={p.plateIndex}
                className={cx(
                  "flex cursor-pointer gap-3 rounded-lg border p-3",
                  chosen.has(p.plateIndex) ? "border-accent bg-wash/40" : "border-hairline",
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={chosen.has(p.plateIndex)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(p.plateIndex);
                    else next.delete(p.plateIndex);
                    setSelected(next);
                  }}
                />
                <Thumb
                  src={p.thumbnailPngBase64 ? `data:image/png;base64,${p.thumbnailPngBase64}` : null}
                  alt=""
                  size={72}
                />
                <PlateSummary plate={toPlateInput(p)} />
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <NumberField
              label="Copies of each plate"
              value={quantity}
              min={1}
              max={1000}
              onChange={setQuantity}
            />
            <NumberField label="Priority" value={priority} min={-100} max={100} onChange={setPriority} />
            <div className="flex-1" />
            {submit.isPending && (
              <div className="w-40">
                <ProgressBar value={uploaded * 100} />
              </div>
            )}
            <Button
              variant="primary"
              disabled={chosen.size === 0 || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending
                ? "Uploading…"
                : `Add ${chosen.size} ${chosen.size === 1 ? "plate" : "plates"} to queue`}
            </Button>
          </div>
          {submit.error && <p className="mt-2 text-sm text-critical">{submit.error.message}</p>}
        </>
      )}
    </Card>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="text-xs text-ink-2">
      <span className="mb-1 block">{props.label}</span>
      <input
        type="number"
        className={`${inputClass} w-24`}
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(n)) props.onChange(Math.min(props.max, Math.max(props.min, n)));
        }}
      />
    </label>
  );
}

function PlateSummary({ plate, extra }: { plate: QueuePlateInput; extra?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 text-sm">
      <div className="font-medium">
        Plate {plate.index}
        {extra}
      </div>
      <div className="tabular text-xs text-ink-2">
        {grams(plate.estWeightG)}
        {plate.wasteG ? ` (${grams(plate.wasteG)} waste)` : ""} · {duration(plate.estTimeS)}
      </div>
      <div className="mt-1.5">
        <FilamentChips
          filaments={plate.filaments.map((f) => ({
            idx: f.idx,
            material: f.material,
            color: f.color,
            weightG: f.usedG,
          }))}
        />
      </div>
      {plate.parts.length > 0 && (
        <div className="mt-1.5 text-xs text-ink-2">
          {plate.parts
            .map((p) => `${p.count}× ${p.name}${p.weightG !== null ? ` (${grams(p.weightG)})` : ""}`)
            .join(", ")}
        </div>
      )}
    </div>
  );
}

// --- Items ----------------------------------------------------------------------------------------

function useItemAction(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ action, printer }: { action: string; printer?: string }) =>
      api<QueueItem>(`/api/queue/${id}/${action}`, { method: "POST", json: printer ? { printer } : {} }),
    onSuccess: () => invalidate(client, "queue"),
  });
}

/** Start the browser download of the item's file. */
function download(item: QueueItem) {
  const a = document.createElement("a");
  a.href = item.file.downloadUrl;
  a.download = item.file.filename;
  document.body.append(a);
  a.click();
  a.remove();
}

function ItemCard({ item, canEdit }: { item: QueueItem; canEdit: boolean }) {
  const action = useItemAction(item.id);
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const dispatch = (printer: string) =>
    action.mutate({ action: "dispatch", printer }, { onSuccess: () => download(item) });
  const assignedSuggestion = item.suggestions.find((s) => s.serial === item.assignedPrinter?.serial);
  const choosing = item.status === "queued" || item.status === "assigned";
  const shown = showAll ? item.suggestions : item.suggestions.slice(0, 3);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-4">
        <Thumb src={item.plate?.thumbUrl ?? null} alt="" size={72} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{item.title}</h2>
            <QueueStatusBadge status={item.status} />
            {item.priority !== 0 && <Badge tone="neutral">Priority {item.priority}</Badge>}
            <span className="tabular text-xs text-muted">
              {item.completed} of {item.quantity} printed
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {item.file.filename} · plate {item.plateIndex} · sliced for{" "}
            {item.file.model ?? `unknown model (${item.file.printerModelId ?? "none"}) – check manually`} ·
            added {ago(item.createdAt)} by {item.createdBy}
          </p>
          {item.plate && (
            <div className="mt-2">
              <PlateSummary plate={item.plate} />
            </div>
          )}
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setEditing((e) => !e)}>
              Edit
            </Button>
            {item.status !== "queued" && item.status !== "printing" && (
              <Button onClick={() => action.mutate({ action: "requeue" })} disabled={action.isPending}>
                Requeue
              </Button>
            )}
            {item.status !== "printing" && (
              <Button
                variant="danger"
                onClick={() => action.mutate({ action: "cancel" })}
                disabled={action.isPending}
              >
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>
      {editing && <EditItem item={item} onDone={() => setEditing(false)} />}
      {action.error && <p className="mt-2 text-sm text-critical">{action.error.message}</p>}

      {item.status === "dispatched" && (
        <DispatchPanel item={item} suggestion={assignedSuggestion} canEdit={canEdit} />
      )}
      {item.status === "printing" && (
        <p className="mt-4 border-t border-hairline pt-3 text-sm text-ink-2">
          Printing on{" "}
          <span className="font-medium text-ink">{item.assignedPrinter?.name ?? "a printer"}</span>
          {item.jobId && (
            <>
              {" · "}
              <Link to={`/jobs/${item.jobId}`} className="text-accent-ink hover:underline">
                Open job
              </Link>
            </>
          )}
        </p>
      )}

      {choosing && (
        <div className="mt-4 border-t border-hairline pt-3">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-2 uppercase">Suggested printers</h3>
          {item.suggestions.length === 0 ? (
            <p className="text-sm text-muted">No printers yet. They appear once the LAN agent connects.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {shown.map((s, i) => (
                <SuggestionRow
                  key={s.serial}
                  s={s}
                  assigned={s.serial === item.assignedPrinter?.serial}
                  primary={i === 0 || s.serial === item.assignedPrinter?.serial}
                  canEdit={canEdit}
                  pending={action.isPending}
                  onDispatch={() => dispatch(s.serial)}
                  onAssign={() => action.mutate({ action: "assign", printer: s.serial })}
                />
              ))}
            </ul>
          )}
          {item.suggestions.length > 3 && (
            <Button variant="ghost" className="mt-2" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${item.suggestions.length} printers`}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function SuggestionRow(props: {
  s: PrinterSuggestion;
  assigned: boolean;
  primary: boolean;
  canEdit: boolean;
  pending: boolean;
  onDispatch: () => void;
  onAssign: () => void;
}) {
  const { s } = props;
  const [tone, label] = VERDICT[s.verdict];
  return (
    <li className="flex flex-wrap items-start gap-3 py-2.5">
      <div className="w-40 shrink-0">
        <div className="font-medium">
          {s.name}
          {props.assigned && <span className="ml-1.5 text-xs font-normal text-accent-ink">assigned</span>}
        </div>
        <div className="text-xs text-muted">
          {s.model ?? "Unknown model"} · {readinessLabel(s)}
        </div>
      </div>
      <div className="w-32 shrink-0 whitespace-nowrap">
        <Badge tone={tone}>{label}</Badge>
      </div>
      <div className="min-w-0 flex-1">
        <SlotMap slots={s.slots} />
        {s.issues.length > 0 && (
          <ul className="mt-1 text-xs">
            {s.issues.map((i) => (
              <li key={i.text} className={i.level === "block" ? "text-critical" : "text-ink-2"}>
                {i.level === "block" ? "✕ " : "! "}
                {i.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      {props.canEdit && (
        <div className="flex gap-2">
          {!props.assigned && (
            <Button variant="ghost" onClick={props.onAssign} disabled={props.pending}>
              Assign
            </Button>
          )}
          <Button
            variant={props.primary && s.verdict !== "unsuitable" ? "primary" : "secondary"}
            onClick={props.onDispatch}
            disabled={props.pending}
            title="Mark as dispatched and download the file for Bambu Connect"
          >
            Dispatch
          </Button>
        </div>
      )}
    </li>
  );
}

function readinessLabel(s: PrinterSuggestion): string {
  switch (s.readiness) {
    case "ready":
      return "idle";
    case "clear-bed":
      return s.gcodeState === "FAILED" ? "stopped, clear bed" : "finished, clear bed";
    case "busy":
      return s.remainingMin ? `printing, ${s.remainingMin} min left` : "busy";
    case "offline":
      return "offline";
    default:
      return "state unknown";
  }
}

const MATCH_LABEL: Record<SlotMapping["match"], string> = {
  exact: "matches",
  colour: "colour differs",
  missing: "not loaded",
};

/** Which AMS slot each slicer filament would come from. */
function SlotMap({ slots }: { slots: SlotMapping[] }) {
  if (slots.length === 0) return <span className="text-xs text-muted">No AMS data</span>;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {slots.map((m) => (
        <li
          key={m.filamentIdx}
          className="flex items-center gap-1.5 text-ink-2"
          title={`Filament ${m.filamentIdx}: ${MATCH_LABEL[m.match]}`}
        >
          <Swatch color={m.color} size={11} />
          <span>
            {m.material ?? "?"} #{m.filamentIdx}
          </span>
          <span aria-hidden className="text-muted">
            →
          </span>
          {m.tray ? (
            <>
              <Swatch color={m.tray.color} size={11} />
              <span className={cx("font-medium", m.match === "exact" ? "text-ink" : "text-serious")}>
                {m.tray.label}
              </span>
              {m.match === "colour" && <span className="text-muted">(colour differs)</span>}
            </>
          ) : (
            <span className="font-medium text-critical">not loaded</span>
          )}
        </li>
      ))}
    </ul>
  );
}

const DIR_KEY = "fleet.downloadDir";

function readDir(): string {
  try {
    return localStorage.getItem(DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Bambu Connect imports a file from a local path, which a web page can't know, so the link is built from
 * the operator's downloads folder. Without it: open the downloaded file in Bambu Connect or Studio.
 */
function bambuConnectUrl(dir: string, filename: string, name: string): string | null {
  const folder = dir.trim().replace(/[\\/]+$/, "");
  if (!folder) return null;
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const params = `path=${encodeURIComponent(`${folder}${sep}${filename}`)}&name=${encodeURIComponent(name)}&version=1.0.0`;
  return `bambu-connect://import-file?${params}`;
}

function DispatchPanel({
  item,
  suggestion,
  canEdit,
}: {
  item: QueueItem;
  suggestion: PrinterSuggestion | undefined;
  canEdit: boolean;
}) {
  const now = useNow();
  const [dir, setDir] = useState(readDir);
  const connect = bambuConnectUrl(dir, item.file.filename, item.title);
  const waitingFor = item.dispatchedAt ? now - item.dispatchedAt : 0;
  const names = [...new Set([item.title, item.file.filename.replace(/(\.gcode)?\.3mf$/i, "")])];

  return (
    <div className="mt-4 space-y-3 border-t border-hairline pt-3 text-sm">
      <p className="text-ink-2">
        Dispatched to <span className="font-medium text-ink">{item.assignedPrinter?.name}</span>{" "}
        {ago(item.dispatchedAt, now)}. Start it in Bambu Connect; the item moves to printing when{" "}
        {item.assignedPrinter?.name} starts a job named {names.map((n) => `“${n}”`).join(" or ")} within 2
        hours.
        {waitingFor > 2 * 3_600_000 && (
          <span className="text-serious"> The 2-hour window has passed; requeue to try again.</span>
        )}
      </p>
      {suggestion && (
        <div>
          <div className="mb-1 text-xs text-muted">AMS mapping to select in Bambu Connect</div>
          <SlotMap slots={suggestion.slots} />
          {suggestion.issues.length > 0 && (
            <p className="mt-1 text-xs text-ink-2">{suggestion.issues.map((i) => i.text).join(" · ")}</p>
          )}
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-end gap-3">
          <Button onClick={() => download(item)}>1. Download file</Button>
          <label className="text-xs text-ink-2">
            <span className="mb-1 block">Your downloads folder (for the Bambu Connect link)</span>
            <input
              className={`${inputClass} w-72`}
              value={dir}
              placeholder="/Users/you/Downloads or C:\Users\you\Downloads"
              onChange={(e) => {
                setDir(e.target.value);
                try {
                  localStorage.setItem(DIR_KEY, e.target.value);
                } catch {
                  // storage unavailable; the field still works for this page
                }
              }}
            />
          </label>
          {connect ? (
            <a
              href={connect}
              className="inline-flex items-center rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
            >
              2. Open in Bambu Connect
            </a>
          ) : (
            <span className="text-xs text-muted">
              Or open the downloaded file in Bambu Connect or Bambu Studio yourself.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function EditItem({ item, onDone }: { item: QueueItem; onDone: () => void }) {
  const client = useQueryClient();
  const [title, setTitle] = useState(item.title);
  const [quantity, setQuantity] = useState(item.quantity);
  const [priority, setPriority] = useState(item.priority);
  const save = useMutation({
    mutationFn: () =>
      api<QueueItem>(`/api/queue/${item.id}`, { method: "PATCH", json: { title, quantity, priority } }),
    onSuccess: async () => {
      await invalidate(client, "queue");
      onDone();
    },
  });
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="text-xs text-ink-2">
        <span className="mb-1 block">Title (matched against the printer's job name)</span>
        <input className={`${inputClass} w-72`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <NumberField
        label="Copies"
        value={quantity}
        min={Math.max(1, item.completed)}
        max={1000}
        onChange={setQuantity}
      />
      <NumberField label="Priority" value={priority} min={-100} max={100} onChange={setPriority} />
      <Button type="submit" variant="primary" disabled={save.isPending || !title.trim()}>
        Save
      </Button>
      {save.error && <span className="text-sm text-critical">{save.error.message}</span>}
    </form>
  );
}

function HistoryTable({ items, canEdit }: { items: QueueItem[]; canEdit: boolean }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="border-b border-hairline">
          <tr>
            <Th>Item</Th>
            <Th>Status</Th>
            <Th>Printer</Th>
            <Th className="text-right">Printed</Th>
            <Th>Updated</Th>
            <Th />
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {items.map((item) => (
            <HistoryRow key={item.id} item={item} canEdit={canEdit} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function HistoryRow({ item, canEdit }: { item: QueueItem; canEdit: boolean }) {
  const action = useItemAction(item.id);
  return (
    <tr className="hover:bg-wash/60">
      <Td>
        <div className="font-medium">{item.title}</div>
        <div className="text-xs text-muted">
          {item.file.filename} · plate {item.plateIndex}
        </div>
      </Td>
      <Td>
        <QueueStatusBadge status={item.status} />
      </Td>
      <Td className="text-ink-2">
        {item.jobId ? (
          <Link to={`/jobs/${item.jobId}`} className="hover:underline">
            {item.assignedPrinter?.name ?? "Job"}
          </Link>
        ) : (
          (item.assignedPrinter?.name ?? "–")
        )}
      </Td>
      <Td className="tabular text-right">
        {item.completed}/{item.quantity}
      </Td>
      <Td className="tabular whitespace-nowrap text-ink-2">{dateTime(item.updatedAt)}</Td>
      <Td className="text-right">
        {canEdit && item.status !== "done" && (
          <Button onClick={() => action.mutate({ action: "requeue" })} disabled={action.isPending}>
            Requeue
          </Button>
        )}
      </Td>
    </tr>
  );
}
