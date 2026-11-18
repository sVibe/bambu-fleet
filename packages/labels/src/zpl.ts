import qrcode from "qrcode-generator";
import { type LaidOutText, layoutLabel, measuringFonts } from "./layout.ts";
import {
  type BoxElement,
  fillPlaceholders,
  type LabelTemplate,
  type LabelValues,
  type QrElement,
} from "./template.ts";

export interface ZplOptions {
  /** Printer resolution in dots per inch; 203 for a Zebra GK420. */
  dpi?: number;
  /** Print the label upside down (ZPL ^POI), for printers fed the other way round. */
  upsideDown?: boolean;
  /**
   * Move everything on the label, in millimetres down and to the right, for a printer that places
   * labels off. Sent as ^LT and ^LS, which the printer applies after finding the label's top edge.
   */
  offsetMm?: { x: number; y: number };
}

/**
 * Render a template as ZPL, the language Zebra label printers speak. Unlike a PDF, ZPL carries the
 * label's own width and length, so the printer needs no paper size set up in its driver: it finds each
 * label with its gap sensor and prints the layout on it dot for dot.
 *
 * Text is laid out with Helvetica's metrics (as in the PDF) and printed in the printer's scalable font
 * 0, which is narrower, so lines that fit the PDF fit the label too.
 */
export async function renderLabelZpl(
  template: LabelTemplate,
  values: LabelValues,
  options: ZplOptions = {},
): Promise<string> {
  const dpmm = (options.dpi ?? 203) / 25.4;
  const dots = (mm: number) => Math.max(0, Math.round(mm * dpmm));
  const fonts = await measuringFonts();

  const out = [
    "^XA",
    // UTF-8 field data, so æ, ø and å print as themselves.
    "^CI28",
    `^PW${dots(template.widthMm)}`,
    `^LL${dots(template.heightMm)}`,
    "^LH0,0",
    // Every job sets both, so an adjustment from an earlier job never lingers. ^LT is limited to ±120.
    `^LT${Math.max(-120, Math.min(120, Math.round((options.offsetMm?.y ?? 0) * dpmm)))}`,
    `^LS${-Math.round((options.offsetMm?.x ?? 0) * dpmm)}`,
    options.upsideDown ? "^POI" : "^PON",
  ];
  for (const item of layoutLabel(template, values, fonts)) {
    if (item.type === "text") out.push(...zplText(item, dots));
    // The printer encodes QR codes itself, so they're sized from the value rather than the layout.
    else if (item.type === "qr") out.push(...zplQr(item.el, fillPlaceholders(item.el.value, values), dots));
    else out.push(zplBox(item.el, dots));
  }
  out.push("^PQ1", "^XZ");
  return `${out.join("\n")}\n`;
}

/** Field data with ^FH: the control characters ^ and ~, and the escape _ itself, go as hex. */
function fieldData(text: string): string {
  return `^FH_^FD${text.replace(/[_^~]/g, (ch) => `_${ch.charCodeAt(0).toString(16).toUpperCase()}`)}^FS`;
}

function zplText(item: LaidOutText, dots: (mm: number) => number): string[] {
  const { el, size, lines } = item;
  const height = Math.max(10, dots((size * 25.4) / 72));
  const justify = el.align === "center" ? "C" : el.align === "right" ? "R" : "L";
  // ^FB keeps each line to the box width and aligns it; font 0 may lack "…", so use three dots.
  return lines.map(
    (line) =>
      `^FO${dots(el.x)},${dots(line.top)}^A0N,${height},0^FB${dots(el.w)},1,0,${justify},0${fieldData(line.text.replace(/…/g, "..."))}`,
  );
}

function qrMode(value: string): "Numeric" | "Alphanumeric" | "Byte" {
  if (/^\d+$/.test(value)) return "Numeric";
  if (/^[0-9A-Z $%*+\-./:]+$/.test(value)) return "Alphanumeric";
  return "Byte";
}

function zplQr(el: QrElement, value: string, dots: (mm: number) => number): string[] {
  if (!value) return [];
  // The printer picks the encoding itself (automatic mode); size the code the same way to place it.
  const qr = qrcode(0, "M");
  const mode = qrMode(value);
  qr.addData(mode === "Byte" ? String.fromCharCode(...new TextEncoder().encode(value)) : value, mode);
  qr.make();
  const count = qr.getModuleCount();
  const box = Math.min(dots(el.w), dots(el.h));
  const magnification = Math.max(1, Math.min(10, Math.floor(box / count)));
  const side = count * magnification;
  const x = dots(el.x) + Math.floor((dots(el.w) - side) / 2);
  const y = dots(el.y) + Math.floor((dots(el.h) - side) / 2);
  // ^BQN,2,m: model 2 QR with m dots per module; "MA," is error correction M, automatic encoding.
  return [`^FO${x},${y}^BQN,2,${magnification}${fieldData(`MA,${value}`)}`];
}

function zplBox(el: BoxElement, dots: (mm: number) => number): string {
  const w = Math.max(1, dots(el.w));
  const h = Math.max(1, dots(el.h));
  const thickness = el.fill ? Math.min(w, h) : Math.max(1, dots(el.strokeMm ?? 0.3));
  return `^FO${dots(el.x)},${dots(el.y)}^GB${w},${h},${thickness},B,0^FS`;
}
