/**
 * Bambu filament ids (`tray_info_idx`) to material type, as listed in the Fleet Hub API v1.0.0.
 * Only a fallback: reports and 3MF files normally carry the material type themselves.
 */
const KNOWN_FILAMENT_IDS: Record<string, string> = {
  GFA00: "PLA",
  GFG00: "PETG",
  GFG50: "PETG-CF",
  GFU00: "TPU",
  GFB00: "ABS",
  GFB50: "ABS-GF",
  GFB01: "ASA",
  GFB02: "ASA-AERO",
};

export function materialFor(
  trayInfoIdx: string | null | undefined,
  type: string | null | undefined,
): string | null {
  const cleaned = type?.trim();
  if (cleaned) return cleaned.toUpperCase();
  return (trayInfoIdx && KNOWN_FILAMENT_IDS[trayInfoIdx]) || null;
}

/**
 * Typical densities (g/cm³) used only when a 3MF carries no `filament_density`.
 * Per-part grams are scaled to the slicer's own `used_g`, so these rarely affect results.
 */
const DEFAULT_DENSITY: Record<string, number> = {
  PLA: 1.24,
  PETG: 1.27,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.21,
  PC: 1.2,
  PA: 1.08,
  PVA: 1.23,
};

export function defaultDensity(material: string | null | undefined): number {
  if (!material) return 1.24;
  const base = material.toUpperCase().split(/[-\s+]/)[0] ?? "";
  return DEFAULT_DENSITY[base] ?? 1.24;
}

/** Normalize Bambu colours (`F98C36FF`, `#ECC3B2`) to `RRGGBB`. */
export function normalizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.replace(/^#/, "").trim().toUpperCase();
  if (/^[0-9A-F]{8}$/.test(hex)) return hex.slice(0, 6);
  if (/^[0-9A-F]{6}$/.test(hex)) return hex;
  return null;
}
