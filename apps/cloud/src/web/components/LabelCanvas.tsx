import {
  type LabelElement,
  type LabelFonts,
  type LabelTemplate,
  type LabelValues,
  type LaidOut,
  layoutLabel,
  measuringFonts,
} from "@fleet/labels";
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";

const PT_TO_MM = 25.4 / 72;
const FONT = "Helvetica, Arial, sans-serif";
/** Smallest width or height an element can be resized to, in mm. */
const MIN_SIZE = 0.2;
/** Handles and hit areas keep a usable size on screen however small the label is drawn. */
const HANDLE_PX = 9;
const HIT_PX = 10;

export type Geometry = Pick<LabelElement, "x" | "y" | "w" | "h">;

/** Helvetica's metrics, loaded once; null for the moment before they are ready. */
export function useLabelFonts(): LabelFonts | null {
  const [fonts, setFonts] = useState<LabelFonts | null>(null);
  useEffect(() => {
    let live = true;
    measuringFonts().then((f) => live && setFonts(f));
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}

/** What the printer draws: text lines, QR modules and boxes, in black on the label. */
function Ink({ items }: { items: LaidOut[] }) {
  return (
    <>
      {items.map((item) => {
        const key = item.el.id;
        if (item.type === "text")
          return (
            <g key={key} fontFamily={FONT} fontWeight={item.el.bold ? 700 : 400} fill="#000">
              {item.lines.map((line, i) => (
                <text
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own
                  key={i}
                  x={line.x}
                  y={line.baseline}
                  fontSize={item.size * PT_TO_MM}
                  // The browser's font may be a little wider or narrower; this keeps each line to the width
                  // Helvetica gives it, as printed.
                  textLength={line.width || undefined}
                  lengthAdjust="spacingAndGlyphs"
                >
                  {line.text}
                </text>
              ))}
            </g>
          );
        if (item.type === "qr") {
          const cell = item.side / item.count;
          const d = item.runs
            .map(
              (r) =>
                `M${item.x + r.col * cell} ${item.y + r.row * cell}h${r.length * cell}v${cell}h${-r.length * cell}z`,
            )
            .join("");
          return <path key={key} d={d} fill="#000" shapeRendering="crispEdges" />;
        }
        const el = item.el;
        return el.fill ? (
          <rect key={key} x={el.x} y={el.y} width={el.w} height={el.h} fill="#000" />
        ) : (
          <rect
            key={key}
            x={el.x}
            y={el.y}
            width={el.w}
            height={el.h}
            fill="none"
            stroke="#000"
            strokeWidth={el.strokeMm ?? 0.3}
          />
        );
      })}
    </>
  );
}

/** A label drawn as it prints, e.g. for a thumbnail. */
export function LabelSvg({
  template,
  values,
  fonts,
  className,
  title,
}: {
  template: LabelTemplate;
  values: LabelValues;
  fonts: LabelFonts | null;
  className?: string;
  title: string;
}) {
  const items = useMemo(() => (fonts ? layoutLabel(template, values, fonts) : []), [template, values, fonts]);
  const { widthMm: w, heightMm: h } = template;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} role="img" aria-label={title}>
      <rect width={w} height={h} fill="#fff" />
      <Ink items={items} />
    </svg>
  );
}

type Handle = "nw" | "ne" | "sw" | "se";

interface Drag {
  id: string;
  mode: "move" | Handle;
  pointerId: number;
  start: { x: number; y: number };
  orig: Geometry;
  square: boolean;
  moved: boolean;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Where an element ends up for a drag of (dx, dy) mm: moved, or resized from one corner. */
function dragged(drag: Drag, dx: number, dy: number, snap: (v: number) => number): Geometry {
  const { orig } = drag;
  if (drag.mode === "move") return { ...orig, x: snap(orig.x + dx), y: snap(orig.y + dy) };
  let left = orig.x;
  let right = orig.x + orig.w;
  let top = orig.y;
  let bottom = orig.y + orig.h;
  const west = drag.mode.includes("w");
  const north = drag.mode.includes("n");
  if (west) left = Math.min(snap(left + dx), right - MIN_SIZE);
  else right = Math.max(snap(right + dx), left + MIN_SIZE);
  if (north) top = Math.min(snap(top + dy), bottom - MIN_SIZE);
  else bottom = Math.max(snap(bottom + dy), top + MIN_SIZE);
  if (drag.square) {
    // QR codes are square; keep the corner opposite the handle where it was.
    const side = Math.max(right - left, bottom - top);
    if (west) left = right - side;
    else right = left + side;
    if (north) top = bottom - side;
    else bottom = top + side;
  }
  return { x: round2(left), y: round2(top), w: round2(right - left), h: round2(bottom - top) };
}

/** A placeholder's name in angle quotes, for showing elements whose value is empty. */
const rawText = (text: string) => text.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, "‹$1›");

/**
 * The label editor's canvas: the label as it prints, with elements to select, drag and resize from
 * their corners. Sizes are in millimetres throughout; the SVG's own units are millimetres.
 */
export function LabelCanvas({
  template,
  values,
  fonts,
  selectedId,
  onSelect,
  onMove,
  readOnly,
  snapMm,
  outlines,
}: {
  template: LabelTemplate;
  values: LabelValues;
  fonts: LabelFonts | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Called as an element is dragged; `first` is true for the first change of each drag. */
  onMove: (id: string, geometry: Geometry, first: boolean) => void;
  readOnly: boolean;
  snapMm: number;
  outlines: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [pxPerMm, setPxPerMm] = useState(8);
  const { widthMm: w, heightMm: h } = template;
  const margin = Math.max(2, 0.06 * Math.max(w, h));
  const viewW = w + 2 * margin;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setPxPerMm(entry.contentRect.width / viewW);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [viewW]);

  const items = useMemo(() => (fonts ? layoutLabel(template, values, fonts) : []), [template, values, fonts]);
  const inked = useMemo(() => new Set(items.map((i) => i.el.id)), [items]);
  // Elements with nothing to print (an empty value) still show, faintly, so they can be found.
  const ghosts = useMemo(() => {
    if (!fonts) return [];
    const empty = template.elements.filter((el) => el.type !== "box" && !inked.has(el.id));
    return layoutLabel(
      {
        ...template,
        elements: empty.map((el) => (el.type === "text" ? { ...el, text: rawText(el.text) } : el)),
      },
      {},
      fonts,
    );
  }, [template, fonts, inked]);
  const cut = new Set(items.filter((i) => i.type === "text" && i.cut).map((i) => i.el.id));

  const snap = (v: number) => round2(Math.round(v / snapMm) * snapMm);
  const mmPerPx = 1 / pxPerMm;

  const toMm = (e: ReactPointerEvent) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM()?.inverse();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix);
    return { x: p.x, y: p.y };
  };

  const startDrag = (e: ReactPointerEvent, el: LabelElement, mode: Drag["mode"]) => {
    e.stopPropagation();
    onSelect(el.id);
    if (readOnly || e.button !== 0) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = {
      id: el.id,
      mode,
      pointerId: e.pointerId,
      start: toMm(e),
      orig: { x: el.x, y: el.y, w: el.w, h: el.h },
      square: el.type === "qr",
      moved: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = toMm(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    // A click shouldn't nudge an element by a snap step.
    if (!d.moved && Math.hypot(dx, dy) * pxPerMm < 3) return;
    const next = dragged(d, dx, dy, snap);
    const o = d.orig;
    if (!d.moved && next.x === o.x && next.y === o.y && next.w === o.w && next.h === o.h) return;
    onMove(d.id, next, !d.moved);
    d.moved = true;
  };

  const endDrag = (e: ReactPointerEvent) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };

  const selected = template.elements.find((el) => el.id === selectedId) ?? null;
  const handle = HANDLE_PX * mmPerPx;

  return (
    <svg
      ref={svgRef}
      viewBox={`${-margin} ${-margin} ${viewW} ${h + 2 * margin}`}
      className="block w-full select-none"
      style={{ maxWidth: viewW * 16, touchAction: readOnly ? "auto" : "none" }}
      onPointerDown={() => onSelect(null)}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role="img"
      aria-label={`Label, ${w} by ${h} mm`}
    >
      <defs>
        <pattern id="label-grid-1" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M1 0V1H0" fill="none" stroke="#000" strokeOpacity="0.06" strokeWidth={mmPerPx} />
        </pattern>
        <pattern id="label-grid-5" width="5" height="5" patternUnits="userSpaceOnUse">
          <rect width="5" height="5" fill="url(#label-grid-1)" />
          <path d="M5 0V5H0" fill="none" stroke="#000" strokeOpacity="0.12" strokeWidth={mmPerPx} />
        </pattern>
        <clipPath id="label-paper">
          <rect width={w} height={h} />
        </clipPath>
        <filter id="label-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy={0.3} stdDeviation={0.5} floodOpacity="0.25" />
        </filter>
      </defs>
      <rect width={w} height={h} fill="#fff" filter="url(#label-shadow)" />
      {!readOnly && <rect width={w} height={h} fill="url(#label-grid-5)" />}
      <g clipPath="url(#label-paper)">
        <g opacity="0.3">
          <Ink items={ghosts} />
        </g>
        <Ink items={items} />
      </g>

      {template.elements.map((el) => {
        // Thin lines get a taller hit area so they can still be grabbed.
        const padX = Math.max(0, (HIT_PX * mmPerPx - el.w) / 2);
        const padY = Math.max(0, (HIT_PX * mmPerPx - el.h) / 2);
        const isCut = cut.has(el.id);
        const empty = !inked.has(el.id);
        return (
          <g key={el.id}>
            {(outlines || isCut || (empty && el.type !== "box")) && el.id !== selectedId && (
              <rect
                x={el.x}
                y={el.y}
                width={el.w}
                height={el.h}
                fill="none"
                stroke={isCut ? "var(--color-critical)" : "var(--color-accent)"}
                strokeOpacity={isCut ? 0.9 : 0.45}
                strokeDasharray="3 2"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}
            <rect
              x={el.x - padX}
              y={el.y - padY}
              width={el.w + 2 * padX}
              height={el.h + 2 * padY}
              fill="transparent"
              style={{ cursor: readOnly ? "pointer" : "move" }}
              onPointerDown={(e) => startDrag(e, el, "move")}
            />
          </g>
        );
      })}

      {selected && (
        <g>
          <rect
            x={selected.x}
            y={selected.y}
            width={selected.w}
            height={selected.h}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          {!readOnly &&
            (["nw", "ne", "sw", "se"] as const).map((corner) => (
              <rect
                key={corner}
                x={(corner.includes("w") ? selected.x : selected.x + selected.w) - handle / 2}
                y={(corner.includes("n") ? selected.y : selected.y + selected.h) - handle / 2}
                width={handle}
                height={handle}
                fill="#fff"
                stroke="var(--color-accent)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize" }}
                onPointerDown={(e) => startDrag(e, selected, corner)}
              />
            ))}
        </g>
      )}
    </svg>
  );
}
