import {
  fillPlaceholders,
  LABEL_LIMITS,
  LABEL_VARIABLES,
  type LabelElement,
  type LabelSource,
  type LabelTemplate,
  type LabelValues,
} from "@fleet/labels";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button, cx, inputClass, Select } from "./ui.tsx";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** A number input that lets you type freely ("1.", "") and reports only valid numbers. */
export function NumberField({
  label,
  value,
  onChange,
  step = 0.1,
  min,
  max,
  unit,
  placeholder,
  allowEmpty = false,
  disabled,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
  allowEmpty?: boolean;
  disabled?: boolean;
}) {
  const shown = value === undefined ? "" : String(round2(value));
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  return (
    <label className="block text-sm">
      <span className="text-ink-2">{label}</span>
      <span className="relative mt-1 block">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            setText(shown);
          }}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim() === "") {
              if (allowEmpty) onChange(undefined);
              return;
            }
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onChange(Math.min(max ?? n, Math.max(min ?? n, n)));
          }}
          className={cx(inputClass, "tabular w-full", unit && "pr-9")}
        />
        {unit && (
          <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted">
            {unit}
          </span>
        )}
      </span>
    </label>
  );
}

/** Insert a `{{variable}}`; lists the variables this kind of label can use. */
function VariablePicker({ source, onPick }: { source: LabelSource; onPick: (name: string) => void }) {
  return (
    <Select
      value=""
      aria-label="Insert a variable"
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
      className="w-full"
    >
      <option value="">Insert variable…</option>
      {LABEL_VARIABLES[source].map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.variables.map((v) => (
            <option key={v.name} value={v.name} title={v.description}>
              {v.name} · {v.description}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/** Text with placeholders, a picker that inserts at the cursor, and what it prints with the data shown. */
function TemplateText({
  label,
  value,
  onChange,
  source,
  values,
  multiline,
  disabled,
  warning,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  source: LabelSource;
  values: LabelValues;
  multiline: boolean;
  disabled: boolean;
  warning?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const fieldId = useId();
  const placed = useRef(false);
  const insert = (name: string) => {
    const field = ref.current;
    const token = `{{${name}}}`;
    // Where the cursor was last; at the end when the field hasn't been used yet.
    const start = field && placed.current ? field.selectionStart : value.length;
    const end = field && placed.current ? field.selectionEnd : value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const printed = fillPlaceholders(value, values).trim();
  const props = {
    ref,
    id: fieldId,
    value,
    onSelect: () => {
      placed.current = true;
    },
    disabled,
    maxLength: LABEL_LIMITS.maxTextLength,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    className: `${inputClass} mt-1 w-full font-mono text-xs`,
  };
  return (
    <div className="space-y-1.5">
      <div className="text-sm">
        <label htmlFor={fieldId} className="text-ink-2">
          {label}
        </label>
        {multiline ? <textarea rows={3} {...props} /> : <input {...props} />}
      </div>
      {!disabled && <VariablePicker source={source} onPick={insert} />}
      <p className="text-xs text-muted">
        Prints: <span className="text-ink-2">{printed || "nothing (empty)"}</span>
      </p>
      {warning}
    </div>
  );
}

export const elementName = (el: LabelElement): string => {
  if (el.type === "text") return el.text.trim() || "Empty text";
  if (el.type === "qr") return `QR · ${el.value || "empty"}`;
  return el.fill && Math.min(el.w, el.h) <= 1 ? "Line" : el.fill ? "Filled box" : "Box";
};

/** Settings of the selected element. */
export function ElementProps({
  el,
  label,
  source,
  values,
  cut,
  readOnly,
  onChange,
  onDelete,
  onDuplicate,
}: {
  el: LabelElement;
  label: LabelTemplate;
  source: LabelSource;
  values: LabelValues;
  /** The text is shortened with "…" for the data shown. */
  cut: boolean;
  readOnly: boolean;
  onChange: (patch: Partial<LabelElement>, key: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const field = (name: keyof LabelElement) => (v: number | undefined) =>
    onChange({ [name]: v } as Partial<LabelElement>, `${el.id}.${name}`);
  const geometry = (
    <div className="grid grid-cols-2 gap-2">
      <NumberField label="Left" unit="mm" value={el.x} onChange={field("x")} disabled={readOnly} />
      <NumberField label="Top" unit="mm" value={el.y} onChange={field("y")} disabled={readOnly} />
      <NumberField
        label="Width"
        unit="mm"
        min={0.1}
        value={el.w}
        onChange={(v) => onChange(el.type === "qr" ? { w: v, h: v } : { w: v }, `${el.id}.w`)}
        disabled={readOnly}
      />
      <NumberField
        label="Height"
        unit="mm"
        min={0.1}
        value={el.h}
        onChange={(v) => onChange(el.type === "qr" ? { w: v, h: v } : { h: v }, `${el.id}.h`)}
        disabled={readOnly}
      />
    </div>
  );
  const center = (axis: "x" | "y") =>
    onChange(
      axis === "x" ? { x: round2((label.widthMm - el.w) / 2) } : { y: round2((label.heightMm - el.h) / 2) },
      `${el.id}.${axis}`,
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">
          {el.type === "text" ? "Text" : el.type === "qr" ? "QR code" : elementName(el)}
        </h2>
        {!readOnly && (
          <div className="flex gap-1">
            <Button variant="ghost" onClick={onDuplicate} title="Duplicate (⌘D)">
              Duplicate
            </Button>
            <Button variant="danger" onClick={onDelete} title="Delete (⌫)">
              Delete
            </Button>
          </div>
        )}
      </div>

      {el.type === "text" && (
        <>
          <TemplateText
            label="Text"
            value={el.text}
            onChange={(text) => onChange({ text }, `${el.id}.text`)}
            source={source}
            values={values}
            multiline
            disabled={readOnly}
            warning={
              cut ? (
                <p className="text-xs text-critical">
                  Doesn't fit, even at the smallest size: it's shortened with “…”. Make the box larger or the
                  smallest size lower.
                </p>
              ) : null
            }
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Size"
              unit="pt"
              step={0.5}
              min={LABEL_LIMITS.minFontPt}
              max={LABEL_LIMITS.maxFontPt}
              value={el.fontSize}
              onChange={(v) => v !== undefined && onChange({ fontSize: v }, `${el.id}.fontSize`)}
              disabled={readOnly}
            />
            <NumberField
              label="Shrinks to"
              unit="pt"
              step={0.5}
              min={LABEL_LIMITS.minFontPt}
              max={LABEL_LIMITS.maxFontPt}
              value={el.minFontSize}
              placeholder={String(el.fontSize)}
              allowEmpty
              onChange={(v) => onChange({ minFontSize: v }, `${el.id}.minFontSize`)}
              disabled={readOnly}
            />
            <NumberField
              label="Lines at most"
              step={1}
              min={1}
              max={50}
              value={el.maxLines}
              placeholder="as fit"
              allowEmpty
              onChange={(v) =>
                onChange({ maxLines: v === undefined ? undefined : Math.round(v) }, `${el.id}.maxLines`)
              }
              disabled={readOnly}
            />
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(el.bold)}
                disabled={readOnly}
                onChange={(e) => onChange({ bold: e.target.checked }, `${el.id}.bold`)}
                className="size-4 accent-accent"
              />
              Bold
            </label>
          </div>
          <fieldset className="text-sm">
            <legend className="text-ink-2">Alignment</legend>
            <div className="mt-1 inline-flex rounded-lg border border-hairline bg-raised p-0.5">
              {(["left", "center", "right"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={(el.align ?? "left") === a}
                  onClick={() => onChange({ align: a }, `${el.id}.align`)}
                  className={cx(
                    "rounded-md px-3 py-1 capitalize",
                    (el.align ?? "left") === a ? "bg-wash font-medium text-ink" : "text-ink-2 hover:text-ink",
                  )}
                >
                  {a}
                </button>
              ))}
            </div>
          </fieldset>
        </>
      )}

      {el.type === "qr" && (
        <TemplateText
          label="Encodes"
          value={el.value}
          onChange={(value) => onChange({ value }, `${el.id}.value`)}
          source={source}
          values={values}
          multiline={false}
          disabled={readOnly}
        />
      )}

      {el.type === "box" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(el.fill)}
              disabled={readOnly}
              onChange={(e) => onChange({ fill: e.target.checked }, `${el.id}.fill`)}
              className="size-4 accent-accent"
            />
            Filled
          </label>
          {!el.fill && (
            <NumberField
              label="Line width"
              unit="mm"
              step={0.1}
              min={0.1}
              max={5}
              value={el.strokeMm ?? 0.3}
              onChange={(v) => v !== undefined && onChange({ strokeMm: v }, `${el.id}.strokeMm`)}
              disabled={readOnly}
            />
          )}
        </div>
      )}

      <div className="space-y-2 border-t border-hairline pt-3">
        {geometry}
        {!readOnly && (
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" onClick={() => center("x")}>
              Centre across
            </Button>
            <Button variant="ghost" onClick={() => center("y")}>
              Centre down
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const SIZE_PRESETS: Array<[number, number]> = [
  [57, 32],
  [40, 30],
  [50, 25],
  [62, 29],
  [76, 51],
  [100, 50],
  [102, 76],
  [100, 150],
];

/** Scale every element to a new label size, fonts by the smaller factor so text keeps its shape. */
export function scaleTemplate(t: LabelTemplate, widthMm: number, heightMm: number): LabelTemplate {
  const sx = widthMm / t.widthMm;
  const sy = heightMm / t.heightMm;
  const sf = Math.min(sx, sy);
  const font = (pt: number) =>
    Math.min(LABEL_LIMITS.maxFontPt, Math.max(LABEL_LIMITS.minFontPt, Math.round(pt * sf * 2) / 2));
  return {
    widthMm,
    heightMm,
    elements: t.elements.map((el) => {
      const g = { x: round2(el.x * sx), y: round2(el.y * sy), w: round2(el.w * sx), h: round2(el.h * sy) };
      if (el.type === "qr") {
        const side = round2(Math.min(el.w * sx, el.h * sy));
        return { ...el, ...g, w: side, h: side };
      }
      if (el.type === "text")
        return {
          ...el,
          ...g,
          fontSize: font(el.fontSize),
          ...(el.minFontSize !== undefined ? { minFontSize: font(el.minFontSize) } : {}),
        };
      return { ...el, ...g };
    }),
  };
}

/** The label's size, with common sizes to pick from. */
export function LabelSizeProps({
  template,
  readOnly,
  onChange,
}: {
  template: LabelTemplate;
  readOnly: boolean;
  onChange: (template: LabelTemplate, key: string) => void;
}) {
  const [scale, setScale] = useState(false);
  const resize = (w: number, h: number, key: string) =>
    onChange(
      scale ? scaleTemplate(template, w, h) : { ...template, widthMm: w, heightMm: h },
      scale ? `size-scaled-${Date.now()}` : key,
    );
  const preset = SIZE_PRESETS.find(([w, h]) => w === template.widthMm && h === template.heightMm);
  const L = LABEL_LIMITS;
  return (
    <div className="space-y-2">
      <h2 className="font-semibold">Label size</h2>
      <Select
        aria-label="Common label sizes"
        value={preset ? `${preset[0]}x${preset[1]}` : ""}
        disabled={readOnly}
        onChange={(e) => {
          const [w, h] = e.target.value.split("x").map(Number);
          if (w && h) resize(w, h, `size-preset-${Date.now()}`);
        }}
        className="w-full"
      >
        <option value="">Custom size</option>
        {SIZE_PRESETS.map(([w, h]) => (
          <option key={`${w}x${h}`} value={`${w}x${h}`}>
            {w} × {h} mm
          </option>
        ))}
      </Select>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Width"
          unit="mm"
          step={1}
          min={L.minSizeMm}
          max={L.maxWidthMm}
          value={template.widthMm}
          onChange={(v) => v !== undefined && resize(v, template.heightMm, "size.w")}
          disabled={readOnly}
        />
        <NumberField
          label="Height"
          unit="mm"
          step={1}
          min={L.minSizeMm}
          max={L.maxHeightMm}
          value={template.heightMm}
          onChange={(v) => v !== undefined && resize(template.widthMm, v, "size.h")}
          disabled={readOnly}
        />
      </div>
      {!readOnly && (
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            checked={scale}
            onChange={(e) => setScale(e.target.checked)}
            className="size-4 accent-accent"
          />
          Scale the content with the label
        </label>
      )}
      <p className="text-xs text-muted">
        Width is across the printer, as the label comes out. Zebra printers get the size with each label;
        other printers need a matching paper size in their driver.
      </p>
    </div>
  );
}

/** Every element, top-most last as they print; select and reorder them here as well as on the canvas. */
export function ElementList({
  elements,
  selectedId,
  readOnly,
  onSelect,
  onMove,
}: {
  elements: LabelElement[];
  selectedId: string | null;
  readOnly: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, by: -1 | 1) => void;
}) {
  if (elements.length === 0)
    return <p className="text-sm text-ink-2">No elements yet. Add text or a QR code.</p>;
  return (
    <ul className="divide-y divide-hairline text-sm">
      {elements.map((el, i) => (
        <li key={el.id} className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onSelect(el.id)}
            aria-current={el.id === selectedId}
            className={cx(
              "min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left",
              el.id === selectedId ? "bg-wash font-medium text-ink" : "text-ink-2 hover:text-ink",
            )}
          >
            <span className="mr-2 text-xs text-muted uppercase">{el.type === "qr" ? "QR" : el.type}</span>
            {el.type === "qr" ? el.value : elementName(el)}
          </button>
          {!readOnly && (
            <>
              <Button
                variant="ghost"
                className="px-2"
                disabled={i === 0}
                onClick={() => onMove(el.id, -1)}
                aria-label="Move back"
                title="Move back (drawn earlier)"
              >
                ↑
              </Button>
              <Button
                variant="ghost"
                className="px-2"
                disabled={i === elements.length - 1}
                onClick={() => onMove(el.id, 1)}
                aria-label="Move forward"
                title="Move forward (drawn on top)"
              >
                ↓
              </Button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
