/**
 * A label template: a page size in millimetres and elements placed on it. Positions are measured
 * from the top-left corner, like the editor shows them; the renderer converts to PDF points.
 * Text and QR values may contain `{{variable}}` placeholders, filled from a flat map of values.
 */
export interface LabelTemplate {
  widthMm: number;
  heightMm: number;
  elements: LabelElement[];
}

interface Box {
  id: string;
  /** Millimetres from the left edge. */
  x: number;
  /** Millimetres from the top edge. */
  y: number;
  w: number;
  h: number;
}

export interface TextElement extends Box {
  type: "text";
  text: string;
  /** Size in points; the text shrinks towards minFontSize when it doesn't fit the box. */
  fontSize: number;
  minFontSize?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
  /** Lines before the text is cut with an ellipsis; by default as many as fit the box height. */
  maxLines?: number;
}

/** A square QR code, as large as the smaller side of its box, centred in it. */
export interface QrElement extends Box {
  type: "qr";
  value: string;
}

/** A filled rectangle (fill) or an outline of the given stroke width; a thin filled box is a line. */
export interface BoxElement extends Box {
  type: "box";
  fill?: boolean;
  strokeMm?: number;
}

export type LabelElement = TextElement | QrElement | BoxElement;

/** Values for placeholders, keyed by variable name such as `part.number`. */
export type LabelValues = Record<string, string>;

const PLACEHOLDER = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

/** Replace `{{name}}` with its value; unknown names become empty. */
export function fillPlaceholders(text: string, values: LabelValues): string {
  return text.replace(PLACEHOLDER, (_, name: string) => values[name.toLowerCase()] ?? "");
}

/** The template with every element moved by the given millimetres (right and down). */
export function shiftTemplate(template: LabelTemplate, xMm: number, yMm: number): LabelTemplate {
  if (!xMm && !yMm) return template;
  return {
    ...template,
    elements: template.elements.map((el) => ({ ...el, x: el.x + xMm, y: el.y + yMm })),
  };
}

/**
 * The built-in 57×32 mm part label (width × height, as it comes out of the printer): QR code of the
 * part number beside the number, name, quantity and material, and a footer with the date.
 */
export const PART_LABEL: LabelTemplate = {
  widthMm: 57,
  heightMm: 32,
  elements: [
    { id: "qr", type: "qr", x: 2, y: 2, w: 22, h: 22, value: "{{part.number}}" },
    {
      id: "number",
      type: "text",
      x: 26,
      y: 2.2,
      w: 29,
      h: 5.5,
      text: "{{part.number}}",
      fontSize: 12,
      minFontSize: 7,
      bold: true,
      maxLines: 1,
    },
    {
      id: "name",
      type: "text",
      x: 26,
      y: 8,
      w: 29,
      h: 6.4,
      text: "{{part.name}}",
      fontSize: 7,
      minFontSize: 5.5,
      maxLines: 2,
    },
    {
      id: "qty",
      type: "text",
      x: 26,
      y: 14.8,
      w: 29,
      h: 5.4,
      text: "{{label.qty}}",
      fontSize: 12,
      minFontSize: 8,
      bold: true,
      maxLines: 1,
    },
    {
      id: "material",
      type: "text",
      x: 26,
      y: 20.6,
      w: 29,
      h: 3.4,
      text: "{{part.material}} · {{part.avg_g}} g/pc",
      fontSize: 7,
      minFontSize: 5.5,
      maxLines: 1,
    },
    { id: "rule", type: "box", x: 2, y: 25.4, w: 53, h: 0.3, fill: true },
    {
      id: "footer",
      type: "text",
      x: 2,
      y: 26.4,
      w: 53,
      h: 3.4,
      text: "{{label.date}} · {{part.printed}} printed in total",
      fontSize: 6.5,
      minFontSize: 5.5,
      maxLines: 1,
    },
  ],
};

/** What a template is filled from: a part, or a job (with the part it printed most of). */
export type LabelSource = "part" | "job";

export const LABEL_SOURCES: LabelSource[] = ["part", "job"];

/** Bounds the editor and the API keep templates within. */
export const LABEL_LIMITS = {
  minSizeMm: 10,
  maxWidthMm: 200,
  maxHeightMm: 300,
  maxElements: 60,
  maxTextLength: 500,
  minFontPt: 3,
  maxFontPt: 72,
} as const;

/**
 * The built-in 57×32 mm job label: like the part label, for the part the job printed most of, with the
 * pieces in this job and where and when it was printed.
 */
export const JOB_LABEL: LabelTemplate = {
  widthMm: 57,
  heightMm: 32,
  elements: PART_LABEL.elements.map((el) =>
    el.id === "material"
      ? { ...el, text: "{{job.material}} · {{job.grams}} g" }
      : el.id === "footer"
        ? { ...el, text: "{{job.printer}} · {{job.ended}}" }
        : el,
  ),
};

/** Templates that always exist; they can be copied but not changed. */
export const BUILTIN_TEMPLATES: Record<LabelSource, { id: string; name: string; template: LabelTemplate }> = {
  part: { id: "builtin:part", name: "Part label", template: PART_LABEL },
  job: { id: "builtin:job", name: "Job label", template: JOB_LABEL },
};
