import { normalizeModel } from "@fleet/shared";
import a1 from "../assets/printers/a1.webp";
import a2l from "../assets/printers/a2l.webp";
import h2c from "../assets/printers/h2c.webp";
import h2d from "../assets/printers/h2d.webp";
import h2s from "../assets/printers/h2s.webp";
import p1s from "../assets/printers/p1s.webp";
import p2s from "../assets/printers/p2s.webp";
import x1c from "../assets/printers/x1c.webp";
import x2d from "../assets/printers/x2d.webp";
import { cx } from "./ui.tsx";

/**
 * Product pictures by model, keyed by `normalizeModel` ("Bambu Lab X1 Carbon" → X1C). Models without a
 * picture of their own (A1 mini, P1P, X1E) get the placeholder rather than a look-alike.
 */
const IMAGES: Record<string, string> = {
  A1: a1,
  A2L: a2l,
  H2C: h2c,
  H2D: h2d,
  H2DPRO: h2d,
  H2S: h2s,
  P1S: p1s,
  P2S: p2s,
  X1C: x1c,
  X2D: x2d,
};

/** Model by serial prefix, for printers configured without a model name. */
const SERIAL_PREFIX_MODEL: Record<string, string> = {
  "00M": "X1C",
  "01P": "P1S",
  "039": "A1",
  "093": "H2S",
  "094": "H2D",
  "22E": "P2S",
};

export function printerImageUrl(model: string | null, serial?: string): string | null {
  const key =
    normalizeModel(model) ?? (serial ? SERIAL_PREFIX_MODEL[serial.slice(0, 3).toUpperCase()] : undefined);
  return key ? (IMAGES[key] ?? null) : null;
}

export function PrinterImage({
  model,
  serial,
  size,
  className,
}: {
  model: string | null;
  serial?: string;
  size: number;
  className?: string;
}) {
  const src = printerImageUrl(model, serial);
  return (
    <div
      className={cx("part-well grid shrink-0 place-items-center rounded-lg p-1", className)}
      style={{ width: size, height: size }}
    >
      {src ? (
        <img src={src} alt={model ? `Bambu Lab ${model}` : ""} className="h-full w-full object-contain" />
      ) : (
        <span aria-hidden className="text-muted" style={{ fontSize: size / 3 }}>
          ▢
        </span>
      )}
    </div>
  );
}
