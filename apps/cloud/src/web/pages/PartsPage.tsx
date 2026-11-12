import { useState } from "react";
import { Link } from "react-router";
import { useParts } from "../api.ts";
import { PartImage } from "../components/PartImage.tsx";
import { TopFilament } from "../components/TopFilament.tsx";
import { Card, Empty, ErrorState, inputClass, Loading, PageHeader, Td, Th } from "../components/ui.tsx";
import { dateTime, grams, percent } from "../format.ts";

export function PartsPage() {
  const [q, setQ] = useState("");
  const parts = useParts(q.trim());
  const rows = parts.data ?? [];

  return (
    <>
      <PageHeader
        title="Parts"
        subtitle="Every object printed, grouped by name. Counts and averages only include finished jobs; skipped objects are excluded."
      />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search parts"
        aria-label="Search parts"
        className={`${inputClass} mb-4 w-full sm:w-80`}
      />
      {parts.isLoading && <Loading />}
      {parts.error && <ErrorState error={parts.error} />}
      {parts.data && rows.length === 0 && (
        <Empty title={q ? "No parts match" : "No parts yet"}>
          Parts come from the objects in each job's 3MF, which the agent downloads from the printer.
        </Empty>
      )}
      {rows.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-hairline">
              <tr>
                <Th>Part</Th>
                <Th className="text-right">Printed</Th>
                <Th className="text-right">Success</Th>
                <Th className="text-right">Avg g / part</Th>
                <Th className="text-right">Total</Th>
                <Th>Most used filament</Th>
                <Th>Last printed</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {rows.map((p) => {
                const attempts = p.printedQty + p.failedQty;
                return (
                  <tr key={p.id} className="hover:bg-wash/60">
                    <Td>
                      <div className="flex items-center gap-3">
                        <PartImage image={p.image} alt="" className="size-10 shrink-0 p-1" />
                        <div>
                          <Link to={`/parts/${p.id}`} className="font-medium hover:underline">
                            {p.name}
                          </Link>
                          <span className="ml-2 text-xs text-muted">
                            {p.jobs} {p.jobs === 1 ? "job" : "jobs"}
                          </span>
                        </div>
                      </div>
                    </Td>
                    <Td className="tabular text-right">{p.printedQty}</Td>
                    <Td className="tabular text-right text-ink-2">
                      {attempts ? percent(p.printedQty / attempts) : "–"}
                    </Td>
                    <Td className="tabular text-right">{grams(p.avgG)}</Td>
                    <Td className="tabular text-right text-ink-2">{grams(p.totalG)}</Td>
                    <Td>
                      <TopFilament top={p.topFilament} materials={p.materials} />
                    </Td>
                    <Td className="tabular whitespace-nowrap text-ink-2">{dateTime(p.lastPrintedAt)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
