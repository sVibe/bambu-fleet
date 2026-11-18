import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import qrcode from "qrcode-generator";
import {
  type BoxElement,
  fillPlaceholders,
  type LabelTemplate,
  type LabelValues,
  type QrElement,
  type TextElement,
} from "./template.ts";

export const PT_PER_MM = 72 / 25.4;
const MM_PER_PT = 25.4 / 72;
export const LINE_HEIGHT = 1.15;

export interface LabelFonts {
  regular: PDFFont;
  bold: PDFFont;
}

export async function embedLabelFonts(doc: PDFDocument): Promise<LabelFonts> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
}

let measuring: Promise<LabelFonts> | null = null;

/** Helvetica's metrics for laying labels out without drawing them, e.g. in the editor or for ZPL. */
export function measuringFonts(): Promise<LabelFonts> {
  measuring ??= PDFDocument.create().then(embedLabelFonts);
  return measuring;
}

/** A text element as it prints: font size in points, and lines placed in millimetres. */
export interface LaidOutText {
  type: "text";
  el: TextElement;
  /** Points. */
  size: number;
  font: PDFFont;
  lines: Array<{ text: string; x: number; top: number; baseline: number; width: number }>;
  /** The text didn't fit at the smallest size and was shortened with an ellipsis. */
  cut: boolean;
}

/** A QR code as square modules; dark modules come as horizontal runs, so drawings stay small. */
export interface LaidOutQr {
  type: "qr";
  el: QrElement;
  x: number;
  y: number;
  side: number;
  count: number;
  runs: Array<{ row: number; col: number; length: number }>;
}

export interface LaidOutBox {
  type: "box";
  el: BoxElement;
}

export type LaidOut = LaidOutText | LaidOutQr | LaidOutBox;

/** Fill a template's placeholders and place every element as it will print. Empty values draw nothing. */
export function layoutLabel(template: LabelTemplate, values: LabelValues, fonts: LabelFonts): LaidOut[] {
  const out: LaidOut[] = [];
  for (const el of template.elements) {
    if (el.type === "text") {
      const text = layoutTextElement(
        el,
        fillPlaceholders(el.text, values),
        el.bold ? fonts.bold : fonts.regular,
      );
      if (text) out.push(text);
    } else if (el.type === "qr") {
      const qr = layoutQr(el, fillPlaceholders(el.value, values));
      if (qr) out.push(qr);
    } else out.push({ type: "box", el });
  }
  return out;
}

const charsets = new WeakMap<PDFFont, Set<number>>();

/** The standard PDF fonts only cover WinAnsi (Latin-1 plus a few signs); anything else becomes "?". */
export function encodable(font: PDFFont, text: string): string {
  let set = charsets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charsets.set(font, set);
  }
  const known = set;
  return [...text.normalize("NFC").replace(/\s+/g, " ").trim()]
    .map((ch) => (known.has(ch.codePointAt(0) ?? 0) ? ch : "?"))
    .join("");
}

/** Break text into lines no wider than `width`; words longer than a line are split by character. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    let rest = word;
    while (rest && !fits(rest)) {
      let n = rest.length - 1;
      while (n > 1 && !fits(rest.slice(0, n))) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

function ellipsize(line: string, font: PDFFont, size: number, width: number): string {
  let s = line;
  while (s && font.widthOfTextAtSize(`${s}…`, size) > width) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Lines and font size for a text box: the largest size from fontSize down to minFontSize that fits. */
export function layoutText(
  text: string,
  font: PDFFont,
  el: Pick<TextElement, "w" | "h" | "fontSize" | "minFontSize" | "maxLines">,
): { size: number; lines: string[]; cut: boolean } {
  const width = Math.max(0.1, el.w) * PT_PER_MM;
  const height = el.h * PT_PER_MM;
  const min = Math.min(el.minFontSize ?? el.fontSize, el.fontSize);
  for (let size = el.fontSize; ; size = Math.max(min, size - 0.5)) {
    const maxLines = Math.max(1, Math.min(el.maxLines ?? 99, Math.floor(height / (size * LINE_HEIGHT)) || 1));
    const lines = wrap(text, font, size, width);
    if (lines.length <= maxLines) return { size, lines, cut: false };
    if (size <= min) {
      const kept = lines.slice(0, maxLines);
      const last = kept.length - 1;
      kept[last] = ellipsize(`${kept[last]} ${lines[maxLines]}`, font, size, width);
      return { size, lines: kept, cut: true };
    }
  }
}

function layoutTextElement(el: TextElement, raw: string, font: PDFFont): LaidOutText | null {
  const text = encodable(font, raw);
  if (!text) return null;
  const { size, lines, cut } = layoutText(text, font, el);
  const ascent = font.heightAtSize(size, { descender: false }) * MM_PER_PT;
  const lineHeight = size * LINE_HEIGHT * MM_PER_PT;
  return {
    type: "text",
    el,
    size,
    font,
    cut,
    lines: lines.map((line, i) => {
      const width = font.widthOfTextAtSize(line, size) * MM_PER_PT;
      const x =
        el.align === "center" ? el.x + (el.w - width) / 2 : el.align === "right" ? el.x + el.w - width : el.x;
      const top = el.y + i * lineHeight;
      return { text: line, x, top, baseline: top + ascent, width };
    }),
  };
}

/** QR byte mode takes one byte per character, so non-ASCII text is passed as its UTF-8 bytes. */
function utf8Binary(text: string): string {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

function layoutQr(el: QrElement, value: string): LaidOutQr | null {
  if (!value) return null;
  const qr = qrcode(0, "M");
  qr.addData(utf8Binary(value), "Byte");
  qr.make();
  const count = qr.getModuleCount();
  const side = Math.max(0, Math.min(el.w, el.h));
  const runs: LaidOutQr["runs"] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      let end = col;
      while (end + 1 < count && qr.isDark(row, end + 1)) end++;
      runs.push({ row, col, length: end - col + 1 });
      col = end;
    }
  }
  return { type: "qr", el, x: el.x + (el.w - side) / 2, y: el.y + (el.h - side) / 2, side, count, runs };
}
