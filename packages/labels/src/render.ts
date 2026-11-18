import { PDFDocument, type PDFPage, rgb } from "pdf-lib";
import { embedLabelFonts, type LaidOutQr, type LaidOutText, layoutLabel, PT_PER_MM } from "./layout.ts";
import type { BoxElement, LabelTemplate, LabelValues } from "./template.ts";

const BLACK = rgb(0, 0, 0);

/** Render a template filled with values as a one-page PDF at the label's exact size. */
export async function renderLabelPdf(template: LabelTemplate, values: LabelValues): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Label");
  doc.setProducer("Bambu Fleet");
  const fonts = await embedLabelFonts(doc);
  const page = doc.addPage([template.widthMm * PT_PER_MM, template.heightMm * PT_PER_MM]);
  for (const item of layoutLabel(template, values, fonts)) {
    if (item.type === "text") drawText(page, item);
    else if (item.type === "qr") drawQr(page, item);
    else drawBox(page, item.el);
  }
  return doc.save();
}

/** PDF y (from the bottom) of a distance in mm from the top of the page. */
const fromTop = (page: PDFPage, mm: number) => page.getHeight() - mm * PT_PER_MM;

function drawText(page: PDFPage, item: LaidOutText): void {
  for (const line of item.lines)
    page.drawText(line.text, {
      x: line.x * PT_PER_MM,
      y: fromTop(page, line.baseline),
      size: item.size,
      font: item.font,
      color: BLACK,
    });
}

function drawQr(page: PDFPage, item: LaidOutQr): void {
  const cell = (item.side / item.count) * PT_PER_MM;
  const left = item.x * PT_PER_MM;
  const top = fromTop(page, item.y);
  for (const run of item.runs)
    page.drawRectangle({
      x: left + run.col * cell,
      y: top - (run.row + 1) * cell,
      width: run.length * cell,
      height: cell,
      color: BLACK,
    });
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
