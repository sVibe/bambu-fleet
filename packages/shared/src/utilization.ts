const HOUR_MS = 3_600_000;

export interface UtilizationPrinter {
  serial: string;
  /** When the printer was first seen; it counts as available from then (or its first job, if earlier). */
  createdAt: number;
}

/** A period a printer was busy with a job (any outcome): [start, end) in epoch ms. */
export interface BusyInterval {
  serial: string;
  start: number;
  end: number;
}

export interface HourCell {
  busyS: number;
  availableS: number;
}

export interface PrinterUtilization {
  serial: string;
  jobs: number;
  busyH: number;
  availableH: number;
  /** busy / available, 0..1; null when the printer had no time in range. */
  utilization: number | null;
  /** Average busy hours per available day. */
  hoursPerDay: number | null;
  /** Index 0..23 = local hour of day. */
  byHour: HourCell[];
}

export interface UtilizationSummary {
  printers: PrinterUtilization[];
  fleet: Omit<PrinterUtilization, "serial">;
  /** Fleet busy vs available time per local calendar day (YYYY-MM-DD). */
  byDay: Array<{ day: string; busyH: number; availableH: number; utilization: number | null }>;
}

function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Split [start, end) at local hour boundaries and report each piece. */
function eachHour(
  start: number,
  end: number,
  fn: (hour: number, day: string, seconds: number) => void,
): void {
  let t = start;
  while (t < end) {
    const boundary = new Date(t);
    boundary.setMinutes(0, 0, 0);
    const next = Math.min(end, boundary.getTime() + HOUR_MS);
    const d = new Date(t);
    fn(d.getHours(), localDay(t), (next - t) / 1000);
    t = next;
  }
}

/** Merge overlapping intervals so a printer is never counted busy twice at once. */
function merge(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const emptyHours = (): HourCell[] => Array.from({ length: 24 }, () => ({ busyS: 0, availableS: 0 }));
const ratio = (busy: number, available: number) => (available > 0 ? Math.min(1, busy / available) : null);

/**
 * Machine utilization over [from, to): the share of each printer's available time spent on jobs,
 * overall, per local hour of day and per local day. A printer is available from when it was first
 * seen (or its first job, for imported history); offline time still counts as available capacity.
 */
export function summarizeUtilization(
  printers: UtilizationPrinter[],
  intervals: BusyInterval[],
  from: number,
  to: number,
): UtilizationSummary {
  const days = new Map<string, { busyS: number; availableS: number }>();
  const day = (key: string) => {
    let d = days.get(key);
    if (!d) {
      d = { busyS: 0, availableS: 0 };
      days.set(key, d);
    }
    return d;
  };
  const fleetHours = emptyHours();
  let fleetJobs = 0;

  const perPrinter = printers.map((p): PrinterUtilization => {
    const own = intervals.filter((i) => i.serial === p.serial);
    const firstSeen = Math.min(p.createdAt, ...own.map((i) => i.start));
    const availStart = Math.max(from, firstSeen);
    const byHour = emptyHours();
    let availableS = 0;
    let busyS = 0;
    if (availStart < to) {
      eachHour(availStart, to, (h, key, s) => {
        (byHour[h] as HourCell).availableS += s;
        (fleetHours[h] as HourCell).availableS += s;
        day(key).availableS += s;
        availableS += s;
      });
    }
    const clipped = merge(
      own
        .map((i): [number, number] => [Math.max(i.start, availStart), Math.min(i.end, to)])
        .filter(([s, e]) => e > s),
    );
    for (const [s, e] of clipped) {
      eachHour(s, e, (h, key, sec) => {
        (byHour[h] as HourCell).busyS += sec;
        (fleetHours[h] as HourCell).busyS += sec;
        day(key).busyS += sec;
        busyS += sec;
      });
    }
    fleetJobs += own.length;
    return {
      serial: p.serial,
      jobs: own.length,
      busyH: busyS / 3600,
      availableH: availableS / 3600,
      utilization: ratio(busyS, availableS),
      hoursPerDay: availableS > 0 ? (busyS / availableS) * 24 : null,
      byHour,
    };
  });

  const busyS = perPrinter.reduce((n, p) => n + p.busyH * 3600, 0);
  const availableS = perPrinter.reduce((n, p) => n + p.availableH * 3600, 0);
  return {
    printers: perPrinter,
    fleet: {
      jobs: fleetJobs,
      busyH: busyS / 3600,
      availableH: availableS / 3600,
      utilization: ratio(busyS, availableS),
      hoursPerDay: availableS > 0 ? (busyS / availableS) * 24 : null,
      byHour: fleetHours,
    },
    byDay: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, d]) => ({
        day: key,
        busyH: d.busyS / 3600,
        availableH: d.availableS / 3600,
        utilization: ratio(d.busyS, d.availableS),
      })),
  };
}
