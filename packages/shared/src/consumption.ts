const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Grams actually consumed by a job that stopped at `layer`, using the per-layer extrusion curve
 * from the 3MF analysis when available and the progress percentage otherwise.
 */
export function consumedWeight(
  estWeightG: number | null,
  layerCurve: number[] | null,
  layer: number | null,
  progressPct: number | null,
): number | null {
  if (estWeightG == null) return null;
  if (layerCurve && layerCurve.length > 0 && layer != null && layer > 0) {
    const i = Math.min(layer, layerCurve.length) - 1;
    return round2(estWeightG * (layerCurve[i] ?? 1));
  }
  if (progressPct != null) return round2((estWeightG * Math.min(100, Math.max(0, progressPct))) / 100);
  return null;
}
