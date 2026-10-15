import { describe, expect, it } from "vitest";
import { chooseFile } from "../src/fetchers/ftps.ts";
import { sameJobName } from "../src/fetchers/types.ts";
import { fileBaseName } from "../src/jobTracker.ts";
import { mergeReport, normalizeReport } from "../src/report.ts";

describe("mergeReport", () => {
  it("merges nested deltas and replaces arrays", () => {
    const state = mergeReport(
      {},
      { gcode_state: "IDLE", ams: { ams: [{ id: "0" }], tray_now: "1" }, hms: [1] },
    );
    mergeReport(state, { mc_percent: 5, ams: { tray_now: "2" }, hms: [] });
    expect(state).toEqual({
      gcode_state: "IDLE",
      mc_percent: 5,
      ams: { ams: [{ id: "0" }], tray_now: "2" },
      hms: [],
    });
  });
});

describe("normalizeReport", () => {
  it("normalizes temperatures, AMS trays, external spool and HMS", () => {
    const s = normalizeReport(
      "SN",
      {
        gcode_state: "RUNNING",
        subtask_name: "Gears",
        mc_percent: 42,
        mc_remaining_time: 33,
        layer_num: "10",
        total_layer_num: 100,
        nozzle_temper: 219.6,
        bed_temper: "55",
        print_error: 0,
        ams: {
          ams: [
            {
              id: "0",
              humidity: "4",
              humidity_raw: "31",
              temp: "24.5",
              tray: [
                {
                  id: "0",
                  tray_type: "PLA",
                  tray_color: "F98C36FF",
                  tray_info_idx: "GFA00",
                  remain: 72,
                  tag_uid: "A1B2",
                },
                { id: "1", tray_type: "", tray_info_idx: "GFG50", remain: -1, tag_uid: "0000000000000000" },
                { id: "2" },
              ],
            },
          ],
        },
        vt_tray: { id: "254", tray_type: "TPU", tray_color: "000000FF" },
        hms: [{ attr: 50336256, code: 131073 }],
      },
      true,
      123,
    );
    expect(s).toMatchObject({
      gcodeState: "RUNNING",
      jobName: "Gears",
      progressPct: 42,
      remainingMin: 33,
      layer: 10,
      bedTempC: 55,
      updatedAt: 123,
      hms: [{ code: "0300120000020001", severity: 2 }],
      externalSpools: [{ material: "TPU", color: "000000" }],
    });
    expect(s.ams[0]).toMatchObject({ id: 0, humidity: 31, tempC: 24.5 });
    expect(s.ams[0]?.trays).toEqual([
      { id: 0, material: "PLA", color: "F98C36", trayInfoIdx: "GFA00", remainPct: 72, rfid: true },
      { id: 1, material: "PETG-CF", color: null, trayInfoIdx: "GFG50", remainPct: null, rfid: false },
      { id: 2, material: null, color: null, trayInfoIdx: null, remainPct: null, rfid: false },
    ]);
  });
});

describe("file matching", () => {
  it("matches job names to 3MF file names", () => {
    expect(sameJobName("Bracket set.gcode.3mf", "Bracket set")).toBe(true);
    expect(sameJobName("bracket SET.3mf", "Bracket set")).toBe(true);
    expect(sameJobName("Other.gcode.3mf", "Bracket set")).toBe(false);
    expect(fileBaseName("/data/Metadata/plate_1.gcode")).toBeNull();
    expect(fileBaseName("/sdcard/Widget.gcode.3mf")).toBe("Widget");
  });

  it("prefers a name match, then a file written near the job start", () => {
    const file = (name: string, modifiedAt: number | null) => ({
      dir: "/cache",
      info: { name, isFile: true } as never,
      modifiedAt,
    });
    const request = { jobId: "j", serial: "s", name: "Gears", gcodeFile: null, startedAt: 10_000_000 };
    const named = file("Gears.gcode.3mf", 1);
    const recent = file("x.gcode.3mf", 10_000_000 - 60_000);
    expect(chooseFile([recent, named], request)).toBe(named);
    expect(chooseFile([recent, file("old.3mf", 1)], { ...request, name: "Nope" })).toBe(recent);
    expect(chooseFile([file("old.3mf", 1)], { ...request, name: "Nope" })).toBeNull();
  });
});
