import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import type { PrintBatchResponse, PrintJobRow, PrintJobState, PrintPrinter } from "../../api-types.ts";
import { api, invalidate, useLabelTemplates, usePrintJobs, usePrintPrinters } from "../api.ts";
import { ago } from "../format.ts";
import { Badge, Button, Card, inputClass, Select } from "./ui.tsx";

const LabelPreview = lazy(() => import("./LabelPreview.tsx"));

const PRINT_STATE: Record<PrintJobState, [Parameters<typeof Badge>[0]["tone"], string]> = {
  submitting: ["accent", "Sending"],
  new: ["neutral", "Waiting at PrintNode"],
  sent_to_client: ["accent", "Sent to computer"],
  // PrintNode's "done" means the OS print queue has it, not that the label came out.
  done: ["good", "Sent to printer"],
  error: ["critical", "Error"],
  expired: ["warning", "Expired"],
  failed: ["critical", "Not sent"],
};

export function PrintStateBadge({ state }: { state: PrintJobState }) {
  const [tone, label] = PRINT_STATE[state];
  return <Badge tone={tone}>{label}</Badge>;
}

export const printerLabel = (p: Pick<PrintPrinter, "alias" | "name">) => p.alias ?? p.name;

export function PrintJobList({ jobs, showTitle = true }: { jobs: PrintJobRow[]; showTitle?: boolean }) {
  if (jobs.length === 0) return <p className="text-sm text-ink-2">Nothing printed yet.</p>;
  return (
    <ul className="divide-y divide-hairline">
      {jobs.map((j) => (
        <li key={j.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2 text-sm">
          <div className="min-w-0">
            {showTitle && <div className="font-medium">{j.title}</div>}
            <div className="text-xs text-muted">
              {ago(j.createdAt)} · {j.printerName ?? `printer ${j.printerId}`}
              {j.copies > 1 ? ` · ${j.copies} copies` : ""} · {j.requestedBy}
            </div>
            {j.message && (j.state === "error" || j.state === "failed" || j.state === "expired") && (
              <div className="text-xs text-critical">{j.message}</div>
            )}
          </div>
          <PrintStateBadge state={j.state} />
        </li>
      ))}
    </ul>
  );
}

type Source = "part" | "job";

/** Printers to choose from, with the default label printer chosen until another is picked. */
function usePrinterChoice() {
  const printers = usePrintPrinters();
  const [printerId, setPrinterId] = useState<number | null>(null);
  const chosen = printerId ?? printers.data?.labelPrinterId ?? printers.data?.printers[0]?.id ?? null;
  const ready = Boolean(printers.data?.configured && printers.data.printers.length > 0);
  const select = (
    <label className="block text-sm">
      <span className="text-ink-2">Printer</span>
      <Select
        value={chosen ?? ""}
        onChange={(e) => setPrinterId(Number(e.target.value))}
        className="mt-1 w-full"
      >
        {printers.data?.printers.map((p) => (
          <option key={p.id} value={p.id}>
            {printerLabel(p)}
            {p.state && p.state !== "online" ? ` (${p.state})` : ""}
          </option>
        ))}
      </Select>
    </label>
  );
  return { printers, chosen, ready, select };
}

/** Templates of one kind, with its default chosen until another is picked. */
function useTemplateChoice(source: Source) {
  const templates = useLabelTemplates();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const options = templates.data?.templates.filter((t) => t.source === source) ?? [];
  const chosen = options.find((t) => t.id === templateId) ?? options.find((t) => t.isDefault) ?? options[0];
  const select =
    options.length > 1 ? (
      <label className="block text-sm">
        <span className="text-ink-2">Template</span>
        <Select
          value={chosen?.id ?? ""}
          onChange={(e) => setTemplateId(e.target.value)}
          className="mt-1 w-full"
        >
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.template.widthMm}×{t.template.heightMm} mm)
            </option>
          ))}
        </Select>
      </label>
    ) : null;
  return { chosen, select };
}

function QtyAndCopies({
  qty,
  setQty,
  copies,
  setCopies,
  qtyPlaceholder,
}: {
  qty: string;
  setQty: (v: string) => void;
  copies: string;
  setCopies: (v: string) => void;
  qtyPlaceholder: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block text-sm">
        <span className="text-ink-2">Quantity on label</span>
        <input
          inputMode="numeric"
          value={qty}
          onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
          placeholder={qtyPlaceholder}
          className={`${inputClass} mt-1 w-full`}
        />
      </label>
      <label className="block text-sm">
        <span className="text-ink-2">Copies</span>
        <input
          type="number"
          min={1}
          max={50}
          value={copies}
          onChange={(e) => setCopies(e.target.value)}
          className={`${inputClass} mt-1 w-full`}
        />
      </label>
    </div>
  );
}

const toQty = (qty: string) => (/^\d+$/.test(qty) && Number(qty) > 0 ? Number(qty) : null);
const toCopies = (copies: string) => Math.max(1, Math.min(50, Number(copies) || 1));

/** Print a part's or job's label on a PrintNode printer, with a preview and its recent prints. */
export function LabelCard({ source, id }: { source: Source; id: string }) {
  const client = useQueryClient();
  const printer = usePrinterChoice();
  const template = useTemplateChoice(source);
  const jobs = usePrintJobs({ type: source, id });
  const [qty, setQty] = useState("");
  const [copies, setCopies] = useState("1");
  const [preview, setPreview] = useState(false);

  const qtyNumber = toQty(qty);
  const kind = source === "part" ? "part-label" : "job-label";
  const target = source === "part" ? { partId: id } : { jobId: id };
  const print = useMutation({
    mutationFn: () =>
      api<PrintJobRow>("/api/print/jobs", {
        method: "POST",
        json: {
          kind,
          ...target,
          templateId: template.chosen?.id,
          qty: qtyNumber,
          copies: toCopies(copies),
          printerId: printer.chosen ?? undefined,
        },
      }),
    onSettled: () => invalidate(client, "print-jobs"),
  });

  const params = new URLSearchParams({ kind, [source === "part" ? "partId" : "jobId"]: id });
  if (template.chosen) params.set("templateId", template.chosen.id);
  if (qtyNumber) params.set("qty", String(qtyNumber));
  const previewUrl = `/api/print/preview?${params}`;
  const layout = template.chosen?.template;
  const previewButton = (
    <Button onClick={() => setPreview((v) => !v)} aria-expanded={preview}>
      {preview ? "Hide preview" : "Preview"}
    </Button>
  );

  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">Label</h2>
      {printer.printers.data && !printer.ready && (
        <>
          <p className="text-sm text-ink-2">
            Printing isn't set up yet. An admin connects PrintNode under Admin → Printing.
          </p>
          {previewButton}
        </>
      )}
      {printer.ready && (
        <>
          {template.select}
          {printer.select}
          <QtyAndCopies
            qty={qty}
            setQty={setQty}
            copies={copies}
            setCopies={setCopies}
            qtyPlaceholder={source === "job" ? "pieces in job" : "e.g. 50"}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => print.mutate()}
              disabled={print.isPending || !printer.chosen}
            >
              {print.isPending ? "Sending…" : "Print label"}
            </Button>
            {previewButton}
          </div>
          {print.error && <p className="text-sm text-critical">{print.error.message}</p>}
        </>
      )}
      {preview && layout && (
        <div className="space-y-1">
          <Suspense fallback={<div className="h-24 rounded-md bg-wash" />}>
            <LabelPreview template={layout} source={source} id={id} qty={qtyNumber} />
          </Suspense>
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ink-2 hover:underline"
          >
            Open the PDF
          </a>
        </div>
      )}
      {jobs.data && jobs.data.length > 0 && (
        <div className="border-t border-hairline pt-2">
          <h3 className="text-xs font-medium tracking-wide text-ink-2 uppercase">Recent prints</h3>
          <PrintJobList jobs={jobs.data.slice(0, 5)} showTitle={false} />
        </div>
      )}
    </Card>
  );
}

/** Print one job label for each selected job. */
export function BatchLabelPanel({ jobIds, onClose }: { jobIds: string[]; onClose: () => void }) {
  const client = useQueryClient();
  const printer = usePrinterChoice();
  const template = useTemplateChoice("job");
  const [qty, setQty] = useState("");
  const [copies, setCopies] = useState("1");
  const print = useMutation({
    mutationFn: () =>
      api<PrintBatchResponse>("/api/print/batch", {
        method: "POST",
        json: {
          jobIds,
          templateId: template.chosen?.id,
          qty: toQty(qty),
          copies: toCopies(copies),
          printerId: printer.chosen ?? undefined,
        },
      }),
    onSettled: () => invalidate(client, "print-jobs"),
  });
  const failed = print.data?.jobs.filter((j) => j.state === "failed") ?? [];

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">
          Print {jobIds.length} job {jobIds.length === 1 ? "label" : "labels"}
        </h2>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {printer.printers.data && !printer.ready ? (
        <p className="text-sm text-ink-2">
          Printing isn't set up yet. An admin connects PrintNode under Admin → Printing.
        </p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {template.select}
            {printer.select}
          </div>
          <QtyAndCopies
            qty={qty}
            setQty={setQty}
            copies={copies}
            setCopies={setCopies}
            qtyPlaceholder="pieces in each job"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onClick={() => print.mutate()}
              disabled={print.isPending || !printer.chosen || jobIds.length === 0}
            >
              {print.isPending ? "Sending…" : "Print labels"}
            </Button>
            {print.data && (
              <span className={failed.length ? "text-sm text-critical" : "text-sm text-ink-2"}>
                {failed.length
                  ? `${failed.length} of ${print.data.jobs.length} weren't sent: ${failed[0]?.message ?? ""}`
                  : `Sent ${print.data.jobs.length} to PrintNode.`}
              </span>
            )}
          </div>
          {print.error && <p className="text-sm text-critical">{print.error.message}</p>}
        </>
      )}
    </Card>
  );
}
