export function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function optionalInt(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function thumbUrl(jobId: string, thumbKey: string | null): string | null {
  return thumbKey ? `/api/thumbs/${encodeURIComponent(jobId)}` : null;
}

/** R2 key of an object's top-down cut-out within a job. */
export const partImageKey = (jobId: string, identifyId: string) => `thumbs/${jobId}/parts/${identifyId}.png`;

export const partImageUrl = (jobId: string, identifyId: string) =>
  `/api/thumbs/${encodeURIComponent(jobId)}/parts/${encodeURIComponent(identifyId)}`;

export const round = (n: number | null | undefined, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round((n ?? 0) * f) / f;
};
