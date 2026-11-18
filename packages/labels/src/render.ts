import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import qrcode from "qrcode-generator";
import {
  type BoxElement,
  fillPlaceholders,
  type LabelTemplate,
  type LabelValues,
  type QrElement,
  type TextElement,
} from "./template.ts";

const PT_PER_MM = 72 / 25.4;
export const LINE_HEIGHT = 1.15;
const BLACK = rgb(0, 0, 0);

/** Render a template filled with values as a one-page PDF at the label's exact size. */
export async function renderLabelPdf(template: LabelTemplate, values: LabelValues): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Label");
  doc.setProducer("Bambu Fleet");
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const page = doc.addPage([template.widthMm * PT_PER_MM, template.heightMm * PT_PER_MM]);
  for (const el of template.elements) {
    if (el.type === "text")
      drawText(page, el, fillPlaceholders(el.text, values), el.bold ? fonts.bold : fonts.regular);
    else if (el.type === "qr") drawQr(page, el, fillPlaceholders(el.value, values));
    else drawBox(page, el);
  }
  return doc.save();
}

/** PDF y (from the bottom) of a distance in mm from the top of the page. */
const fromTop = (page: PDFPage, mm: number) => page.getHeight() - mm * PT_PER_MM;

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
): { size: number; lines: string[] } {
  const width = el.w * PT_PER_MM;
  const height = el.h * PT_PER_MM;
  const min = Math.min(el.minFontSize ?? el.fontSize, el.fontSize);
  for (let size = el.fontSize; ; size = Math.max(min, size - 0.5)) {
    const maxLines = Math.max(1, Math.min(el.maxLines ?? 99, Math.floor(height / (size * LINE_HEIGHT)) || 1));
    const lines = wrap(text, font, size, width);
    if (lines.length <= maxLines) return { size, lines };
    if (size <= min) {
      const kept = lines.slice(0, maxLines);
      const last = kept.length - 1;
      kept[last] = ellipsize(`${kept[last]} ${lines[maxLines]}`, font, size, width);
      return { size, lines: kept };
    }
  }
}

function drawText(page: PDFPage, el: TextElement, raw: string, font: PDFFont): void {
  const text = encodable(font, raw);
  if (!text) return;
  const { size, lines } = layoutText(text, font, el);
  const ascent = font.heightAtSize(size, { descender: false });
  const left = el.x * PT_PER_MM;
  const width = el.w * PT_PER_MM;
  lines.forEach((line, i) => {
    const lineWidth = font.widthOfTextAtSize(line, size);
    const x =
      el.align === "center"
        ? left + (width - lineWidth) / 2
        : el.align === "right"
          ? left + width - lineWidth
          : left;
    const y = fromTop(page, el.y) - ascent - i * size * LINE_HEIGHT;
    page.drawText(line, { x, y, size, font, color: BLACK });
  });
}

/** QR byte mode takes one byte per character, so non-ASCII text is passed as its UTF-8 bytes. */
function utf8Binary(text: string): string {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

function drawQr(page: PDFPage, el: QrElement, value: string): void {
  if (!value) return;
  const qr = qrcode(0, "M");
  qr.addData(utf8Binary(value), "Byte");
  qr.make();
  const count = qr.getModuleCount();
  const side = Math.min(el.w, el.h) * PT_PER_MM;
  const cell = side / count;
  const left = el.x * PT_PER_MM + (el.w * PT_PER_MM - side) / 2;
  const top = fromTop(page, el.y) - (el.h * PT_PER_MM - side) / 2;
  // One rectangle per horizontal run of dark modules keeps the PDF small and the edges clean.
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      let end = col;
      while (end + 1 < count && qr.isDark(row, end + 1)) end++;
      page.drawRectangle({
        x: left + col * cell,
        y: top - (row + 1) * cell,
        width: (end - col + 1) * cell,
        height: cell,
        color: BLACK,
      });
      col = end;
    }
  }
}

function drawBox(page: PDFPage, el: BoxElement): void {
  const rect = {
    x: el.x * PT_PER_MM,
    y: fromTop(page, el.y + el.h),
    width: el.w * PT_PER_MM,
    height: el.h * PT_PER_MM,
  };
  if (el.fill) page.drawRectangle({ ...rect, color: BLACK });
  else page.drawRectangle({ ...rect, borderColor: BLACK, borderWidth: (el.strokeMm ?? 0.3) * PT_PER_MM });
}
