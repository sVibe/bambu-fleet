import type { PartListItem } from "../../api-types.ts";
import { percent } from "../format.ts";
import { Swatch } from "./ui.tsx";

/** "PETG 96% · also PLA": the material most printed parts used, its share, and the others. */
export function TopFilament({ top, materials }: { top: PartListItem["topFilament"]; materials: string[] }) {
  if (!top) return <span className="text-muted">–</span>;
  const others = materials.filter((m) => m !== top.material);
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-1.5 text-ink-2"
      title={`${top.count} printed parts used mostly ${top.material}`}
    >
      <Swatch color={top.color} size={12} />
      <span className="text-ink">{top.material}</span>
      <span className="tabular text-xs text-muted">{percent(top.share)} of parts</span>
      {others.length > 0 && <span className="text-xs text-muted">· also {others.join(", ")}</span>}
    </span>
  );
}
