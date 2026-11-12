import { describe, expect, it } from "vitest";
import { summarizeUtilization } from "../src/utilization.ts";

// Local-time dates keep the assertions independent of the machine's time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

describe("summarizeUtilization", () => {
  const from = at(10, 0);
  const to = at(12, 0); // two full days

  it("computes overall, per-hour and per-day utilization", () => {
    const s = summarizeUtilization(
      [{ serial: "A", createdAt: 0 }],
      [
        { serial: "A", start: at(10, 9), end: at(10, 15) }, // 6 h on day 1
        { serial: "A", start: at(11, 9, 30), end: at(11, 10, 30) }, // 1 h on day 2, split over 9:00 and 10:00
      ],
      from,
      to,
    );
    const a = s.printers[0];
    expect(a?.busyH).toBeCloseTo(7);
    expect(a?.availableH).toBeCloseTo(48);
    expect(a?.utilization).toBeCloseTo(7 / 48);
    expect(a?.hoursPerDay).toBeCloseTo(3.5);
    expect(a?.jobs).toBe(2);
    // Hour 9: busy all of day 1 plus 30 min of day 2, out of two days.
    expect(a?.byHour[9]).toEqual({ busyS: 3600 + 1800, availableS: 7200 });
    expect(a?.byHour[10]).toEqual({ busyS: 3600 + 1800, availableS: 7200 });
    expect(a?.byHour[20]).toEqual({ busyS: 0, availableS: 7200 });
    expect(s.byDay.map((d) => [d.day, d.busyH])).toEqual([
      ["2026-11-10", 6],
      ["2026-11-11", 1],
    ]);
  });

  it("clips jobs to the range, merges overlaps and starts a printer at its first sighting", () => {
    const s = summarizeUtilization(
      [
        { serial: "A", createdAt: 0 },
        { serial: "B", createdAt: at(11, 0) },
      ],
      [
        { serial: "A", start: at(9, 20), end: at(10, 2) }, // 2 h inside the range
        { serial: "A", start: at(10, 1), end: at(10, 3) }, // overlaps: adds 1 h
        { serial: "B", start: at(10, 22), end: at(11, 4) }, // job predates registration: B counts from 22:00
      ],
      from,
      to,
    );
    expect(s.printers[0]?.busyH).toBeCloseTo(3);
    expect(s.printers[1]).toMatchObject({ availableH: 26, busyH: 6 });
    expect(s.fleet.availableH).toBeCloseTo(74);
    expect(s.fleet.busyH).toBeCloseTo(9);
    expect(s.fleet.utilization).toBeCloseTo(9 / 74);
    // A printer registered later with no earlier jobs only counts from registration.
    const late = summarizeUtilization([{ serial: "C", createdAt: at(11, 0) }], [], from, to);
    expect(late.printers[0]?.availableH).toBeCloseTo(24);
  });

  it("handles printers with no time in range", () => {
    const s = summarizeUtilization([{ serial: "A", createdAt: to + 1 }], [], from, to);
    expect(s.printers[0]).toMatchObject({ utilization: null, hoursPerDay: null, availableH: 0 });
    expect(s.fleet.utilization).toBeNull();
  });
});
