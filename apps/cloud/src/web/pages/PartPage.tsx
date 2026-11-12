import { roleAtLeast } from "@fleet/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, invalidate, useMe, usePart, useParts } from "../api.ts";
import {
  Button,
  Card,
  ErrorState,
  inputClass,
  JobStatusBadge,
  Loading,
  PageHeader,
  Select,
  StatTile,
  Swatch,
  Td,
  Th,
} from "../components/ui.tsx";
import { dateTime, grams, percent } from "../format.ts";

export function PartPage() {
  const { id = "" } = useParams();
  const part = usePart(id);
  const me = useMe();
  const canEdit = me.data ? roleAtLeast(me.data.role, "operator") : false;

  if (part.isLoading) return <Loading />;
  if (part.error || !part.data) return <ErrorState error={part.error} />;
  const { stats, materials, history } = part.data;
  const attempts = stats.printedQty + stats.failedQty;
  const total = materials.reduce((n, m) => n + m.grams, 0);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/parts" className="text-ink-2 hover:text-ink">
          ← Parts
        </Link>
      </p>
      <PageHeader title={part.data.part.name} subtitle={part.data.part.notes ?? undefined} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Printed" value={stats.printedQty} note={`${stats.jobs} jobs`} />
        <StatTile
          label="Success"
          value={attempts ? percent(stats.printedQty / attempts) : "–"}
          note={`${stats.failedQty} in failed or cancelled jobs`}
        />
        <StatTile
          label="Avg per part"
          value={grams(stats.avgG)}
          note={
            stats.wasteG ? `+ ${grams(stats.wasteG / Math.max(1, stats.printedQty))} waste share` : undefined
          }
        />
        <StatTile
          label="Most used filament"
          value={
            stats.topFilament ? (
              <span className="inline-flex items-center gap-2">
                <Swatch color={stats.topFilament.color} size={16} />
                {stats.topFilament.material}
              </span>
            ) : (
              "–"
            )
          }
          note={
            stats.topFilament
              ? `${stats.topFilament.count} of ${stats.printedQty} parts (${percent(stats.topFilament.share)})`
              : undefined
          }
        />
        <StatTile
          label="Total filament"
          value={grams(stats.totalG)}
          note={`last printed ${dateTime(stats.lastPrintedAt)}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="overflow-x-auto">
          <h2 className="px-4 pt-4 font-semibold">Jobs</h2>
          <table className="mt-2 w-full min-w-[560px] text-sm">
            <thead className="border-b border-hairline">
              <tr>
                <Th>Job</Th>
                <Th>Printer</Th>
                <Th>Status</Th>
                <Th className="text-right">Qty</Th>
                <Th className="text-right">Grams</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {history.map((h) => (
                <tr key={h.jobId}>
                  <Td>
                    <Link to={`/jobs/${h.jobId}`} className="font-medium hover:underline">
                      {h.jobName}
                    </Link>
                    <div className="tabular text-xs text-muted">{dateTime(h.startedAt)}</div>
                  </Td>
                  <Td className="text-ink-2">{h.printerName}</Td>
                  <Td>
                    <JobStatusBadge status={h.status} />
                  </Td>
                  <Td className="tabular text-right">
                    {h.qty - h.skipped}
                    {h.skipped > 0 && <span className="text-xs text-muted"> (+{h.skipped} skipped)</span>}
                  </Td>
                  <Td className="tabular text-right">{grams(h.grams)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="font-semibold">Material</h2>
            {materials.length === 0 ? (
              <p className="mt-2 text-sm text-ink-2">No finished prints yet.</p>
            ) : (
              <ul className="mt-3 space-y-2.5">
                {materials.map((m) => (
                  <li key={`${m.material}-${m.color}`} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2">
                        <Swatch color={m.color} size={12} />
                        {m.material ?? "Unknown"}
                      </span>
                      <span className="tabular text-ink-2">{grams(m.grams)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-wash">
                      <div
                        className="h-full rounded-full bg-ink-2"
                        style={{ width: `${(m.grams / total) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {canEdit && <EditPart id={id} name={part.data.part.name} notes={part.data.part.notes} />}
        </div>
      </div>
    </>
  );
}

function EditPart({ id, name, notes }: { id: string; name: string; notes: string | null }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [newName, setNewName] = useState(name);
  const [newNotes, setNewNotes] = useState(notes ?? "");
  const [mergeInto, setMergeInto] = useState("");
  const others = useParts("");

  const save = useMutation({
    mutationFn: () =>
      api(`/api/parts/${id}`, { method: "PATCH", json: { name: newName, notes: newNotes || null } }),
    onSuccess: () => invalidate(client, "part", "parts"),
  });
  const merge = useMutation({
    mutationFn: () => api(`/api/parts/${id}/merge`, { method: "POST", json: { intoId: mergeInto } }),
    onSuccess: async () => {
      await invalidate(client, "parts", "part", "jobs", "job");
      navigate(`/parts/${mergeInto}`);
    },
  });

  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">Edit</h2>
      <label className="block text-sm">
        <span className="text-ink-2">Name</span>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className={`${inputClass} mt-1 w-full`}
        />
      </label>
      <label className="block text-sm">
        <span className="text-ink-2">Notes</span>
        <textarea
          value={newNotes}
          onChange={(e) => setNewNotes(e.target.value)}
          rows={2}
          className={`${inputClass} mt-1 w-full`}
        />
      </label>
      <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending || !newName.trim()}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
      {save.error && <p className="text-sm text-critical">{save.error.message}</p>}

      <div className="border-t border-hairline pt-3">
        <span className="text-sm text-ink-2">Merge into another part (same object, different name)</span>
        <div className="mt-1 flex gap-2">
          <Select
            value={mergeInto}
            onChange={(e) => setMergeInto(e.target.value)}
            className="min-w-0 flex-1"
            aria-label="Merge target"
          >
            <option value="">Choose part…</option>
            {others.data
              ?.filter((p) => p.id !== id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
          <Button
            variant="danger"
            disabled={!mergeInto || merge.isPending}
            onClick={() => {
              if (
                confirm(
                  "Merge this part's history into the selected part? This can't be undone from the dashboard.",
                )
              )
                merge.mutate();
            }}
          >
            Merge
          </Button>
        </div>
        {merge.error && <p className="mt-1 text-sm text-critical">{merge.error.message}</p>}
      </div>
    </Card>
  );
}
