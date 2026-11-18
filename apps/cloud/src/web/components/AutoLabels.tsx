import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import type { AutoLabelRun, AutoLabelSettings } from "../../api-types.ts";
import { api, invalidate, useAutoLabel, useLabelTemplates, usePrintPrinters } from "../api.ts";
import { ago } from "../format.ts";
import { PrintStateBadge, printerLabel } from "./Print.tsx";
import { Badge, Button, Card, inputClass, ProgressBar, Select } from "./ui.tsx";

/**
 * A part's automatic job label: on/off, the threshold, and the labels it printed. Everyone sees it;
 * operators change it.
 */
export function AutoLabelCard({ partId, canEdit }: { partId: string; canEdit: boolean }) {
  const auto = useAutoLabel(partId);
  const settings = auto.data?.settings ?? null;
  const on = Boolean(settings?.enabled);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Automatic labels</h2>
        {auto.data && <Badge tone={on ? "good" : "neutral"}>{on ? "On" : "Off"}</Badge>}
      </div>
      {auto.error && <p className="text-sm text-critical">{auto.error.message}</p>}
      {settings && <Progress settings={settings} />}
      {auto.data && !settings && !canEdit && (
        <p className="text-sm text-ink-2">No automatic label is set up for this part.</p>
      )}
      {auto.data && canEdit && (
        <AutoLabelForm key={settings?.updatedAt ?? "new"} partId={partId} settings={settings} />
      )}
      {auto.data && auto.data.runs.length > 0 && <Runs runs={auto.data.runs} canEdit={canEdit} />}
    </Card>
  );
}

function Progress({ settings }: { settings: AutoLabelSettings }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-ink-2">Label #{settings.labels + 1}</span>
        <span className="tabular">
          <span className="font-semibold">{settings.tally}</span> / {settings.threshold} pcs
        </span>
      </div>
      <ProgressBar value={(settings.tally / settings.threshold) * 100} />
    </div>
  );
}

const digits = (v: string) => v.replace(/\D/g, "");

function AutoLabelForm({ partId, settings }: { partId: string; settings: AutoLabelSettings | null }) {
  const client = useQueryClient();
  const templates = useLabelTemplates();
  const printers = usePrintPrinters();
  const ids = useId();
  const [enabled, setEnabled] = useState(settings?.enabled ?? true);
  const [threshold, setThreshold] = useState(settings ? String(settings.threshold) : "");
  const [templateId, setTemplateId] = useState(settings?.templateId ?? "");
  const [printerId, setPrinterId] = useState(settings?.printerId ? String(settings.printerId) : "");
  const [tally, setTally] = useState(settings ? String(settings.tally) : "0");

  const jobTemplates = templates.data?.templates.filter((t) => t.source === "job") ?? [];
  const defaultTemplate = jobTemplates.find((t) => t.isDefault);
  const defaultPrinter = printers.data?.printers.find((p) => p.id === printers.data?.labelPrinterId);
  const thresholdNumber = Number(threshold);
  const validThreshold = /^\d+$/.test(threshold) && thresholdNumber >= 1;
  const tallyChanged = settings ? tally !== String(settings.tally) : tally !== "0";
  const tallyNumber = Number(tally || "0");
  const tallyError =
    validThreshold && tallyNumber >= thresholdNumber ? `Must be below ${thresholdNumber}` : null;

  const save = useMutation({
    mutationFn: () =>
      api(`/api/print/auto/parts/${encodeURIComponent(partId)}`, {
        method: "PUT",
        json: {
          enabled,
          threshold: thresholdNumber,
          templateId: templateId || null,
          printerId: printerId ? Number(printerId) : null,
          ...(tallyChanged ? { tally: tallyNumber } : {}),
        },
      }),
    onSuccess: () => invalidate(client, "auto-label"),
  });

  return (
    <form
      className="space-y-3 border-t border-hairline pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (validThreshold && !tallyError) save.mutate();
      }}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-0.5 size-4 accent-[var(--color-accent)]"
        />
        <span>
          Print a job label automatically
          <span className="block text-xs text-muted">
            Each time this many good pieces have been printed. Extra pieces count towards the next label.
          </span>
        </span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm" htmlFor={`${ids}-threshold`}>
          <span className="text-ink-2">Pieces per label</span>
          <input
            id={`${ids}-threshold`}
            inputMode="numeric"
            value={threshold}
            onChange={(e) => setThreshold(digits(e.target.value))}
            placeholder="e.g. 50"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="block text-sm" htmlFor={`${ids}-tally`}>
          <span className="text-ink-2">Counted so far</span>
          <input
            id={`${ids}-tally`}
            inputMode="numeric"
            value={tally}
            onChange={(e) => setTally(digits(e.target.value))}
            aria-invalid={Boolean(tallyError)}
            className={`${inputClass} mt-1 w-full`}
          />
          {tallyError && <span className="mt-1 block text-xs text-critical">{tallyError}</span>}
        </label>
      </div>
      <label className="block text-sm">
        <span className="text-ink-2">Template</span>
        <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="mt-1 w-full">
          <option value="">Default job label{defaultTemplate ? ` (${defaultTemplate.name})` : ""}</option>
          {jobTemplates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.template.widthMm}×{t.template.heightMm} mm)
            </option>
          ))}
        </Select>
      </label>
      <label className="block text-sm">
        <span className="text-ink-2">Printer</span>
        <Select value={printerId} onChange={(e) => setPrinterId(e.target.value)} className="mt-1 w-full">
          <option value="">
            Default label printer{defaultPrinter ? ` (${printerLabel(defaultPrinter)})` : ""}
          </option>
          {printers.data?.printers.map((p) => (
            <option key={p.id} value={p.id}>
              {printerLabel(p)}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-xs text-muted">
        The label shows the pieces per label as its quantity. Only finished jobs count, once their part data
        has arrived; skipped objects don't count.
      </p>
      <Button
        type="submit"
        variant="primary"
        disabled={save.isPending || !validThreshold || Boolean(tallyError)}
      >
        {save.isPending ? "Saving…" : "Save"}
      </Button>
      {save.error && <p className="text-sm text-critical">{save.error.message}</p>}
    </form>
  );
}

function Runs({ runs, canEdit }: { runs: AutoLabelRun[]; canEdit: boolean }) {
  const client = useQueryClient();
  const reprint = useMutation({
    mutationFn: (id: string) =>
      api(`/api/print/auto/runs/${encodeURIComponent(id)}/print`, { method: "POST" }),
    onSettled: () => invalidate(client, "auto-label", "print-jobs"),
  });
  return (
    <div className="border-t border-hairline pt-2">
      <h3 className="text-xs font-medium tracking-wide text-ink-2 uppercase">Printed automatically</h3>
      <ul className="divide-y divide-hairline">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2 text-sm">
            <div className="min-w-0">
              <div>
                <span className="font-medium">#{r.seq}</span> · {r.qty} pcs ·{" "}
                <Link to={`/jobs/${r.jobId}`} className="text-ink-2 hover:underline">
                  {r.jobName ?? "job"}
                </Link>
              </div>
              <div className="text-xs text-muted">{ago(r.createdAt)}</div>
              {r.error && <div className="text-xs text-critical">{r.error}</div>}
            </div>
            <div className="flex items-center gap-2">
              {r.printState ? (
                <PrintStateBadge state={r.printState} />
              ) : (
                <Badge tone="critical">Not sent</Badge>
              )}
              {canEdit && (
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => reprint.mutate(r.id)}
                  disabled={reprint.isPending}
                >
                  Print again
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {reprint.error && <p className="text-sm text-critical">{reprint.error.message}</p>}
    </div>
  );
}
