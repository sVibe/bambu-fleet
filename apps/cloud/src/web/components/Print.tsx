import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { PrintJobRow, PrintJobState, PrintPrinter } from "../../api-types.ts";
import { api, invalidate, usePrintJobs, usePrintPrinters } from "../api.ts";
import { ago } from "../format.ts";
import { Badge, Button, Card, inputClass, Select } from "./ui.tsx";

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

/** Print a part's label on a PrintNode printer, with a preview and its recent prints. */
export function PartLabelCard({ partId }: { partId: string }) {
  const client = useQueryClient();
  const printers = usePrintPrinters();
  const jobs = usePrintJobs({ type: "part", id: partId });
  const [printerId, setPrinterId] = useState<number | null>(null);
  const [qty, setQty] = useState("");
  const [copies, setCopies] = useState("1");
  const [preview, setPreview] = useState(false);

  const qtyNumber = /^\d+$/.test(qty) && Number(qty) > 0 ? Number(qty) : null;
  const chosen = printerId ?? printers.data?.labelPrinterId ?? printers.data?.printers[0]?.id ?? null;
  const print = useMutation({
    mutationFn: () =>
      api<PrintJobRow>("/api/print/jobs", {
        method: "POST",
        json: {
          kind: "part-label",
          partId,
          qty: qtyNumber,
          copies: Math.max(1, Math.min(50, Number(copies) || 1)),
          printerId: chosen ?? undefined,
        },
      }),
    onSettled: () => invalidate(client, "print-jobs"),
  });

  const previewUrl = `/api/print/preview?kind=part-label&partId=${encodeURIComponent(partId)}${qtyNumber ? `&qty=${qtyNumber}` : ""}`;
  const ready = printers.data?.configured && printers.data.printers.length > 0;

  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">Label</h2>
      {printers.data && !ready && (
        <>
          <p className="text-sm text-ink-2">
            Printing isn't set up yet. An admin connects PrintNode under Admin → Printing.
          </p>
          <Button onClick={() => setPreview((v) => !v)} aria-expanded={preview}>
            {preview ? "Hide preview" : "Preview"}
          </Button>
        </>
      )}
      {ready && (
        <>
          <div className="text-sm">
            <span className="text-ink-2">Printer</span>
            <Select
              value={chosen ?? ""}
              onChange={(e) => setPrinterId(Number(e.target.value))}
              aria-label="Printer"
              className="mt-1 w-full"
            >
              {printers.data?.printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {printerLabel(p)}
                  {p.state && p.state !== "online" ? ` (${p.state})` : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              <span className="text-ink-2">Quantity on label</span>
              <input
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
                placeholder="e.g. 50"
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
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => print.mutate()} disabled={print.isPending || !chosen}>
              {print.isPending ? "Sending…" : "Print label"}
            </Button>
            <Button onClick={() => setPreview((v) => !v)} aria-expanded={preview}>
              {preview ? "Hide preview" : "Preview"}
            </Button>
          </div>
          {print.error && <p className="text-sm text-critical">{print.error.message}</p>}
        </>
      )}
      {preview && (
        <div className="space-y-1">
          <iframe
            key={previewUrl}
            title="Label preview"
            src={`${previewUrl}#toolbar=0&navpanes=0&view=Fit`}
            className="aspect-[4/3] w-full rounded-md border border-hairline bg-white"
          />
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
