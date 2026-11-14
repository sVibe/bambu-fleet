import { Link, useParams } from "react-router";
import type { JobDetail } from "../../api-types.ts";
import { useJob } from "../api.ts";
import { PrintError } from "../components/Hms.tsx";
import {
  Card,
  ErrorState,
  JobStatusBadge,
  Loading,
  PageHeader,
  Swatch,
  Td,
  Th,
  Thumb,
} from "../components/ui.tsx";
import { dateTime, duration, grams } from "../format.ts";

const ATTRIBUTION_NOTE: Record<string, string> = {
  gcode:
    "Grams per part are measured from the G-code: extrusion inside each object's labels, scaled to the slicer total.",
  even: "This file has no object labels, so the plate's filament is split evenly between its objects.",
  none: "No objects were listed in the file.",
};

export function JobPage() {
  const { id = "" } = useParams();
  const job = useJob(id);
  if (job.isLoading) return <Loading />;
  if (job.error || !job.data) return <ErrorState error={job.error} />;
  const j = job.data;
  const stopped = j.status === "failed" || j.status === "cancelled";

  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/history" className="text-ink-2 hover:text-ink">
          ← History
        </Link>
      </p>
      <PageHeader
        title={j.name}
        subtitle={`${j.printerName}${j.printerModel ? ` (${j.printerModel})` : ""} · ${dateTime(j.startedAt)}`}
        actions={<JobStatusBadge status={j.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        {/* min-w-0: without it a wide table stretches the grid and the whole page scrolls sideways. */}
        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact
              label={stopped ? "Filament used (est.)" : "Filament"}
              value={grams(j.actualWeightG ?? j.estWeightG)}
              note={stopped && j.estWeightG ? `of ${grams(j.estWeightG)} planned` : undefined}
            />
            <Fact
              label="Duration"
              value={duration(j.durationS)}
              note={j.estTimeS ? `slicer est. ${duration(j.estTimeS)}` : undefined}
            />
            <Fact label="Waste" value={grams(j.wasteG)} note="purge, prime tower" />
            <Fact
              label="Layers"
              value={
                j.totalLayers
                  ? `${j.layerAtEnd ?? (j.status === "finished" ? j.totalLayers : "–")} / ${j.totalLayers}`
                  : "–"
              }
            />
          </div>

          {j.errorCode ? (
            <Card className="p-4 text-sm">
              <span className="font-medium">Printer error: </span>
              <PrintError code={j.errorCode} serial={j.printerSerial} />
            </Card>
          ) : null}

          <Filaments job={j} />
          <Parts job={j} />
        </div>

        <aside className="min-w-0 space-y-4">
          <Card className="p-3">
            <Thumb src={j.thumbUrl} alt={`Plate preview of ${j.name}`} size={254} />
          </Card>
          <Card className="p-4 text-sm">
            <dl className="space-y-2">
              <Meta label="File" value={j.fileName} />
              <Meta label="Plate" value={j.plateIndex?.toString()} />
              <Meta label="Started" value={dateTime(j.startedAt)} />
              <Meta label="Ended" value={dateTime(j.endedAt)} />
              <Meta label="Cloud task" value={j.taskId} />
              <Meta label="File MD5" value={j.fileMd5} mono />
            </dl>
          </Card>
        </aside>
      </div>
    </>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-ink-2">{label}</div>
      <div className="tabular mt-0.5 text-lg font-semibold">{value}</div>
      {note && <div className="text-xs text-muted">{note}</div>}
    </Card>
  );
}

function Meta({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-2">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right ${mono ? "font-mono text-xs" : ""}`}
        title={value ?? undefined}
      >
        {value || "–"}
      </dd>
    </div>
  );
}

function Filaments({ job }: { job: JobDetail }) {
  if (job.filaments.length === 0) {
    return (
      <Card className="p-4 text-sm text-ink-2">
        No filament data for this job. The agent couldn't download the job's 3MF from the printer. Check that
        an SD card or USB stick is inserted and "store sent files on external storage" is on.
      </Card>
    );
  }
  return (
    <Card className="overflow-x-auto">
      <h2 className="px-4 pt-4 font-semibold">Filament</h2>
      <table className="mt-2 w-full text-sm">
        <thead className="border-b border-hairline">
          <tr>
            <Th className="hidden sm:table-cell">#</Th>
            <Th>Material</Th>
            <Th className="text-right">Planned</Th>
            <Th className="hidden text-right sm:table-cell">Length</Th>
            <Th className="text-right">Of which waste</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {job.filaments.map((f) => (
            <tr key={f.idx}>
              <Td className="hidden text-muted sm:table-cell">{f.idx}</Td>
              <Td>
                <span className="inline-flex items-center gap-2">
                  <Swatch color={f.color} size={14} />
                  {f.material ?? "Unknown"}
                  {f.trayInfoIdx && <span className="text-xs text-muted">{f.trayInfoIdx}</span>}
                </span>
              </Td>
              <Td className="tabular text-right">{grams(f.weightG)}</Td>
              <Td className="tabular hidden text-right text-ink-2 sm:table-cell">
                {f.lengthM !== null ? `${f.lengthM} m` : "–"}
              </Td>
              <Td className="tabular text-right text-ink-2">{grams(f.wasteG)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Parts({ job }: { job: JobDetail }) {
  if (job.parts.length === 0) return null;
  const colorOf = new Map(job.filaments.map((f) => [String(f.idx), f]));
  const split = (perFilament: Record<string, number>) =>
    Object.entries(perFilament).map(([idx, g]) => (
      <span key={idx} className="inline-flex items-center gap-1 text-xs text-ink-2">
        <Swatch color={colorOf.get(idx)?.color ?? null} size={10} />
        {colorOf.get(idx)?.material ?? `#${idx}`} {grams(g)}
      </span>
    ));
  return (
    <Card className="overflow-x-auto">
      <div className="px-4 pt-4">
        <h2 className="font-semibold">Parts on the plate</h2>
        <p className="mt-1 text-xs text-ink-2">{ATTRIBUTION_NOTE[job.attribution ?? "none"]}</p>
      </div>
      <table className="mt-2 w-full text-sm">
        <thead className="border-b border-hairline">
          <tr>
            <Th>Part</Th>
            <Th className="hidden sm:table-cell">Filament split</Th>
            <Th className="text-right">Part grams</Th>
            <Th className="text-right">+ waste share</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {job.parts.map((p) => (
            <tr key={p.identifyId} className={p.skipped ? "text-muted" : undefined}>
              <Td>
                <Link to={`/parts/${p.partId}`} className="font-medium hover:underline">
                  {p.partName}
                </Link>
                {p.objectName !== p.partName && (
                  <span className="ml-2 text-xs text-muted">{p.objectName}</span>
                )}
                {p.skipped && <span className="ml-2 text-xs">(skipped)</span>}
                {/* On phones the split goes under the name instead of in its own column. */}
                <span className="mt-1 flex flex-wrap gap-2 sm:hidden">{split(p.perFilament)}</span>
              </Td>
              <Td className="hidden sm:table-cell">
                <span className="flex flex-wrap gap-2">{split(p.perFilament)}</span>
              </Td>
              <Td className="tabular text-right">{grams(p.weightG)}</Td>
              <Td className="tabular text-right text-ink-2">{grams(p.wasteShareG)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
