const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function grams(g: number | null | undefined): string {
  if (g === null || g === undefined) return "–";
  if (Math.abs(g) >= 1000) return `${numberFmt.format(g / 1000)} kg`;
  return `${numberFmt.format(g)} g`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "–";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${m.toString().padStart(2, "0")} min`;
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

export function dateTime(ms: number | null | undefined): string {
  return ms ? dateTimeFmt.format(ms) : "–";
}

export function clock(ms: number): string {
  return timeFmt.format(ms);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export function percent(fraction: number | null | undefined): string {
  return fraction === null || fraction === undefined ? "–" : `${Math.round(fraction * 100)}%`;
}

/** `#RRGGBB` for a filament colour, or null. */
export function hex(color: string | null | undefined): string | null {
  return color && /^[0-9A-F]{6}$/i.test(color) ? `#${color}` : null;
}
