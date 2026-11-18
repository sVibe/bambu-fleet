import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { PrintJobRow, PrintPrinter } from "../../api-types.ts";
import { api, invalidate, usePrintAdmin, usePrintJobs, usePrintPrinters } from "../api.ts";
import { PrintJobList } from "./Print.tsx";
import { Badge, Button, Card, ErrorState, inputClass, Select, Td, Th } from "./ui.tsx";

/** Admin → Printing: the PrintNode connection, its printers, the webhook and recent prints. */
export function PrintingAdmin() {
  const client = useQueryClient();
  const status = usePrintAdmin();
  const printers = usePrintPrinters();
  const jobs = usePrintJobs();
  const sync = useMutation({
    mutationFn: () => api<{ printers: number }>("/api/print/printers/sync", { method: "POST" }),
    onSuccess: () => invalidate(client, "print-printers"),
  });

  const s = status.data;
  return (
    <Card className="overflow-x-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h2 className="font-semibold">Printing</h2>
          <p className="text-xs text-ink-2">
            Labels print through PrintNode: its Client runs on a computer next to the printers, and the
            dashboard sends it PDFs.
          </p>
        </div>
        {s?.configured && (
          <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? "Refreshing…" : "Refresh printers"}
          </Button>
        )}
      </div>
      {status.error && (
        <div className="px-4 pt-3">
          <ErrorState error={status.error} />
        </div>
      )}
      {s && !s.configured && (
        <p className="px-4 pt-3 text-sm">
          Not connected. Add the PrintNode API key as a Worker secret, then reload this page:{" "}
          <code className="rounded bg-wash px-1 font-mono text-xs">
            wrangler secret put PRINTNODE_API_KEY
          </code>
        </p>
      )}
      {s?.configured && (
        <p className="px-4 pt-3 text-sm">
          {s.account ? (
            <>
              <Badge tone="good">Connected</Badge> <span className="text-ink-2">as {s.account.email}</span>
              {s.account.computers !== null && (
                <span className="text-ink-2">
                  {" "}
                  · {s.account.computers} {s.account.computers === 1 ? "computer" : "computers"}
                </span>
              )}
            </>
          ) : (
            <>
              <Badge tone="critical">Not connected</Badge>{" "}
              <span className="text-ink-2">{s.accountError ?? "Checking…"}</span>
            </>
          )}
        </p>
      )}
      {sync.error && <p className="px-4 pt-2 text-sm text-critical">{sync.error.message}</p>}

      {printers.data && printers.data.printers.length > 0 && (
        <table className="mt-3 w-full text-sm sm:min-w-[760px]">
          <thead className="border-b border-hairline">
            <tr>
              <Th>Printer</Th>
              <Th>Labels</Th>
              <Th className="hidden md:table-cell">Sends</Th>
              <Th className="hidden md:table-cell">Paper</Th>
              <Th className="hidden md:table-cell">Position</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {printers.data.printers.map((p) => (
              <PrinterRow
                key={`${p.id}-${p.syncedAt}`}
                printer={p}
                isLabel={printers.data.labelPrinterId === p.id}
                labelSize={printers.data.labelSizeMm}
              />
            ))}
          </tbody>
        </table>
      )}
      {s?.configured && printers.data?.printers.length === 0 && (
        <p className="px-4 pt-3 text-sm text-ink-2">
          No printers yet. Install the PrintNode Client on the computer the printers are connected to, then
          refresh.
        </p>
      )}

      {s?.configured && <Webhook />}

      <div className="mt-4 border-t border-hairline px-4 pt-3">
        <h3 className="text-xs font-medium tracking-wide text-ink-2 uppercase">Recent prints</h3>
        {jobs.data && <PrintJobList jobs={jobs.data} />}
      </div>
      <div className="h-3" />
    </Card>
  );
}

function PrinterRow({
  printer: p,
  isLabel,
  labelSize,
}: {
  printer: PrintPrinter;
  isLabel: boolean;
  labelSize: { width: number; height: number };
}) {
  const client = useQueryClient();
  const [alias, setAlias] = useState(p.alias ?? "");
  const update = useMutation({
    mutationFn: (patch: Partial<Pick<PrintPrinter, "alias" | "paper" | "rotate" | "format" | "offsetMm">>) =>
      api(`/api/print/printers/${p.id}`, { method: "PATCH", json: patch }),
    onSuccess: () => invalidate(client, "print-printers", "audit"),
  });
  const choose = useMutation({
    mutationFn: () => api("/api/print/label-printer", { method: "PUT", json: { printerId: p.id } }),
    onSuccess: () => invalidate(client, "print-printers", "audit"),
  });
  const test = useMutation({
    mutationFn: () =>
      api<PrintJobRow>("/api/print/jobs", { method: "POST", json: { kind: "test-label", printerId: p.id } }),
    onSettled: () => invalidate(client, "print-jobs"),
  });
  const online = p.state === "online" && p.computerState !== "disconnected";

  return (
    <tr>
      <Td>
        <input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onBlur={() => alias !== (p.alias ?? "") && update.mutate({ alias: alias || null })}
          placeholder={p.name}
          aria-label={`Name for ${p.name}`}
          className={`${inputClass} w-full min-w-40`}
        />
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <Badge tone={online ? "good" : "neutral"}>{online ? "Online" : (p.state ?? "Unknown")}</Badge>
          {p.alias ? `${p.name} · ` : ""}
          {p.computerName}
        </div>
        {isLabel && p.sendsAs === "pdf" && !p.labelPaper && (
          <div className="mt-1.5 max-w-md text-xs text-ink-2">
            <Badge tone="warning">
              No {labelSize.width}×{labelSize.height} mm paper
            </Badge>{" "}
            Labels would print on the driver's current stock. On {p.computerName}, set the stock size under
            Printer properties → Advanced → <strong>Printing Defaults</strong> (PrintNode runs as a service
            and ignores your own Printing Preferences), restart the PrintNode Client, then refresh printers.
          </div>
        )}
        {(update.error || test.error) && (
          <div className="mt-1 text-xs text-critical">{(update.error ?? test.error)?.message}</div>
        )}
      </Td>
      <Td>
        <label className="inline-flex items-center gap-2">
          <input
            type="radio"
            name="label-printer"
            checked={isLabel}
            onChange={() => choose.mutate()}
            aria-label={`Use ${p.alias ?? p.name} for labels`}
          />
          <span className="text-ink-2">{isLabel ? "Default" : ""}</span>
        </label>
      </Td>
      <Td className="hidden md:table-cell">
        <Select
          value={p.format ?? ""}
          onChange={(e) => update.mutate({ format: (e.target.value || null) as PrintPrinter["format"] })}
          aria-label={`Label format for ${p.name}`}
          title="ZPL goes straight to a Zebra printer with the label size in it; PDF goes through the driver and its paper size."
        >
          <option value="">Auto{p.format === null ? ` (${p.sendsAs.toUpperCase()})` : ""}</option>
          <option value="zpl">ZPL</option>
          <option value="pdf">PDF</option>
        </Select>
      </Td>
      <Td className="hidden md:table-cell">
        <Select
          value={p.paper ?? ""}
          disabled={p.sendsAs === "zpl"}
          title={p.sendsAs === "zpl" ? "ZPL labels carry their own size" : undefined}
          onChange={(e) => update.mutate({ paper: e.target.value || null })}
          aria-label={`Paper for ${p.name}`}
          className="max-w-56 disabled:opacity-50"
        >
          <option value="">
            Match {labelSize.width}×{labelSize.height} mm
          </option>
          {p.papers.map((paper) => (
            <option key={paper.name} value={paper.name}>
              {paper.name}
              {paper.widthMm && paper.heightMm ? ` (${paper.widthMm}×${paper.heightMm} mm)` : ""}
            </option>
          ))}
        </Select>
      </Td>
      <Td className="hidden md:table-cell">
        <Select
          value={p.rotate}
          onChange={(e) => update.mutate({ rotate: Number(e.target.value) as PrintPrinter["rotate"] })}
          aria-label={`Rotation for ${p.name}`}
        >
          {(p.sendsAs === "zpl" ? [0, 180] : [0, 90, 180, 270]).map((r) => (
            <option key={r} value={r}>
              {r}°
            </option>
          ))}
        </Select>
        <div className="mt-1.5 flex gap-1.5">
          <OffsetInput
            label="Down"
            hint="Millimetres to move the label down; negative moves it up"
            value={p.offsetMm.y}
            onSave={(y) => update.mutate({ offsetMm: { ...p.offsetMm, y } })}
          />
          <OffsetInput
            label="Right"
            hint="Millimetres to move the label right; negative moves it left"
            value={p.offsetMm.x}
            onSave={(x) => update.mutate({ offsetMm: { ...p.offsetMm, x } })}
          />
        </div>
      </Td>
      <Td className="text-right">
        <Button onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? "Sending…" : "Test label"}
        </Button>
      </Td>
    </tr>
  );
}

/** A millimetre nudge, saved when the field loses focus. */
function OffsetInput({
  label,
  hint,
  value,
  onSave,
}: {
  label: string;
  hint: string;
  value: number;
  onSave: (mm: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const save = () => {
    const mm = Math.max(-15, Math.min(15, Math.round(Number(text.replace(",", ".")) * 10) / 10));
    if (!Number.isFinite(mm)) return setText(String(value));
    setText(String(mm));
    if (mm !== value) onSave(mm);
  };
  return (
    <label className="flex items-center gap-1 text-xs text-ink-2" title={hint}>
      {label}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        inputMode="decimal"
        aria-label={`${label} (mm)`}
        className={`${inputClass} w-14 text-right`}
      />
      mm
    </label>
  );
}

function Webhook() {
  const client = useQueryClient();
  const status = usePrintAdmin();
  const create = useMutation({
    mutationFn: () =>
      api<{ url: string; secret: string; id: number | null }>("/api/print/webhook", { method: "POST" }),
    onSettled: () => invalidate(client, "print-admin", "audit"),
  });
  const hook = status.data?.webhook;
  if (!hook) return null;

  return (
    <div className="mx-4 mt-4 rounded-lg border border-hairline bg-wash p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">Status updates (webhook)</div>
          <p className="text-xs text-ink-2">
            PrintNode reports each job's progress here. Without it, states still update every five minutes.
          </p>
        </div>
        <Button
          onClick={() =>
            (!hook.url || confirm("Make a new webhook URL? The current one stops working.")) &&
            create.mutate()
          }
          disabled={create.isPending}
        >
          {create.isPending ? "Setting up…" : hook.url ? "Make new URL" : "Set up webhook"}
        </Button>
      </div>
      {hook.url && (
        <>
          <p className="mt-2">
            {hook.id !== null ? (
              <Badge tone="good">Registered in PrintNode</Badge>
            ) : (
              <Badge tone="warning">Not registered: enter the URL and secret in PrintNode</Badge>
            )}
            {hook.counts && (
              <span className="ml-2 text-xs text-ink-2">
                {hook.counts.successful} delivered, {hook.counts.failed} failed, {hook.counts.dropped} dropped
              </span>
            )}
          </p>
          <CopyField label="URL" value={hook.url} />
          {hook.secret && <CopyField label="Secret" value={hook.secret} />}
          <p className="mt-2 text-xs text-ink-2">
            Cloudflare Access must let PrintNode through: add a <strong>Bypass</strong> policy for the path{" "}
            <code className="font-mono">/webhooks/printnode/*</code>. The random part of the URL protects it.
          </p>
        </>
      )}
      {create.error && <p className="mt-2 text-sm text-critical">{create.error.message}</p>}
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="w-12 text-xs text-ink-2">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded bg-raised px-2 py-1 font-mono text-xs">{value}</code>
      <Button
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
        }
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
