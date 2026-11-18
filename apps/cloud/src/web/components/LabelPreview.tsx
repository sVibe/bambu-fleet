import type { LabelTemplate } from "@fleet/labels";
import { useMemo } from "react";
import { useLabelValues } from "../api.ts";
import { LabelSvg, useLabelFonts } from "./LabelCanvas.tsx";

/**
 * A part's or job's label drawn as it prints, with the quantity typed in. Loaded on demand: it brings
 * pdf-lib for Helvetica's metrics.
 */
export default function LabelPreview({
  template,
  source,
  id,
  qty,
}: {
  template: LabelTemplate;
  source: "part" | "job";
  id: string;
  qty: number | null;
}) {
  const fonts = useLabelFonts();
  const data = useLabelValues(source, id);
  const values = useMemo(
    () => (data.data ? { ...data.data.values, ...(qty ? { "label.qty": `${qty} pcs` } : {}) } : null),
    [data.data, qty],
  );
  if (data.error) return <p className="text-sm text-critical">{data.error.message}</p>;
  return (
    <div className="grid place-items-center rounded-md border border-hairline bg-wash p-3">
      {values && fonts ? (
        <LabelSvg
          template={template}
          values={values}
          fonts={fonts}
          title="Label preview"
          className="w-full shadow-sm"
        />
      ) : (
        <div style={{ aspectRatio: `${template.widthMm} / ${template.heightMm}` }} className="w-full" />
      )}
    </div>
  );
}
