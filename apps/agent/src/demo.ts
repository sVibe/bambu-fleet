import { buildSample3mf, type SampleFilament } from "@fleet/threemf/testing";

/**
 * A synthetic three-printer session for demos and tests: one finished job with per-part data,
 * one failed job, and one cancelled job whose file is missing (so it has job-level data only).
 */

const PLA_ORANGE: SampleFilament = { type: "PLA", trayInfoIdx: "GFA00", color: "#F98C36", gramsPerMm: 0.05 };
const PETG_BLACK: SampleFilament = { type: "PETG", trayInfoIdx: "GFG00", color: "#161616", gramsPerMm: 0.06 };

const tray = (id: number, type: string, color: string, idx: string, remain: number) => ({
  id: String(id),
  tray_type: type,
  tray_color: `${color}FF`,
  tray_info_idx: idx,
  remain,
  tag_uid: remain >= 0 ? "A1B2C3D4E5F60708" : "0000000000000000",
});

const AMS_P1S = {
  ams_exist_bits: "1",
  tray_exist_bits: "7",
  ams: [
    {
      id: "0",
      humidity: "4",
      humidity_raw: "31",
      temp: "24.5",
      tray: [
        tray(0, "PLA", "F98C36", "GFA00", 72),
        tray(1, "PETG", "161616", "GFG00", 45),
        tray(2, "PLA", "FFFFFF", "GFA00", -1),
        { id: "3" },
      ],
    },
  ],
};

const AMS_X1C = {
  ams_exist_bits: "1",
  tray_exist_bits: "f",
  ams: [
    {
      id: "0",
      humidity: "5",
      humidity_raw: "22",
      temp: "26.0",
      tray: [
        tray(0, "PETG", "161616", "GFG00", 88),
        tray(1, "PETG", "D9D9D9", "GFG00", 64),
        tray(2, "PLA", "1F5FBF", "GFA00", 15),
        tray(3, "ABS", "C8102E", "GFB00", 93),
      ],
    },
  ],
};

interface Step {
  t: number;
  serial: string;
  payload?: Record<string, unknown>;
  connected?: boolean;
}

function report(print: Record<string, unknown>): Record<string, unknown> {
  return { print: { command: "push_status", ...print } };
}

export function buildDemoSession(): { session: string; files: Record<string, Uint8Array> } {
  const p1s = "01P00A000000001";
  const x1c = "00M00A000000002";
  const a1 = "03919A000000003";
  const steps: Step[] = [];

  // P1S: sends deltas only, finishes "Bracket set" (2 brackets in PLA + 1 clip in PETG).
  steps.push({ t: 0, serial: p1s, connected: true });
  steps.push({
    t: 200,
    serial: p1s,
    payload: report({
      gcode_state: "IDLE",
      mc_percent: 0,
      mc_remaining_time: 0,
      nozzle_temper: 27.5,
      nozzle_target_temper: 0,
      bed_temper: 25,
      bed_target_temper: 0,
      wifi_signal: "-48dBm",
      spd_lvl: 2,
      print_error: 0,
      task_id: "0",
      subtask_id: "0",
      subtask_name: "",
      ams: AMS_P1S,
      vt_tray: { id: "254", tray_type: "", tray_color: "00000000" },
      hms: [],
    }),
  });
  steps.push({
    t: 3000,
    serial: p1s,
    payload: report({
      gcode_state: "PREPARE",
      task_id: "1001",
      subtask_id: "2001",
      nozzle_target_temper: 220,
    }),
  });
  steps.push({
    t: 5000,
    serial: p1s,
    payload: report({
      subtask_name: "Bracket set",
      gcode_file: "/data/Metadata/plate_1.gcode",
      total_layer_num: 4,
    }),
  });
  for (let layer = 1; layer <= 4; layer++) {
    steps.push({
      t: 6000 + layer * 7000,
      serial: p1s,
      payload: report({
        gcode_state: "RUNNING",
        layer_num: layer,
        mc_percent: layer * 25 - 5,
        mc_remaining_time: (4 - layer) * 9 + 3,
        nozzle_temper: 219.6,
        bed_temper: 55,
        bed_target_temper: 55,
      }),
    });
  }
  steps.push({
    t: 40000,
    serial: p1s,
    payload: report({
      gcode_state: "FINISH",
      mc_percent: 100,
      mc_remaining_time: 0,
      nozzle_target_temper: 0,
    }),
  });

  // X1C: full reports, "Lid batch" (3 lids, PETG) fails on layer 2.
  const x1Base = {
    nozzle_temper: 250,
    nozzle_target_temper: 250,
    bed_temper: 70,
    bed_target_temper: 70,
    chamber_temper: 34,
    wifi_signal: "-61dBm",
    spd_lvl: 2,
    ams: AMS_X1C,
    task_id: "1002",
    subtask_id: "2002",
    subtask_name: "Lid batch",
    gcode_file: "/data/Metadata/plate_1.gcode",
    total_layer_num: 4,
    hms: [],
    print_error: 0,
  };
  steps.push({ t: 0, serial: x1c, connected: true });
  steps.push({
    t: 1000,
    serial: x1c,
    payload: report({
      ...x1Base,
      gcode_state: "IDLE",
      task_id: "0",
      subtask_name: "",
      nozzle_target_temper: 0,
    }),
  });
  steps.push({
    t: 6000,
    serial: x1c,
    payload: report({
      ...x1Base,
      gcode_state: "RUNNING",
      layer_num: 1,
      mc_percent: 12,
      mc_remaining_time: 41,
    }),
  });
  steps.push({
    t: 16000,
    serial: x1c,
    payload: report({
      ...x1Base,
      gcode_state: "RUNNING",
      layer_num: 2,
      mc_percent: 38,
      mc_remaining_time: 27,
      // A real code, so the dashboard can show its text: AMS A slot 1 has run out (HMS 0700_2000_0002_0001).
      hms: [{ attr: 0x07002000, code: 0x00020001 }],
    }),
  });
  steps.push({
    t: 26000,
    serial: x1c,
    payload: report({
      ...x1Base,
      gcode_state: "FAILED",
      layer_num: 2,
      mc_percent: 41,
      print_error: 0x07008011,
      nozzle_target_temper: 0,
    }),
  });

  // A1: a spacer test the operator cancels; its file isn't on the printer, so no per-part data.
  steps.push({ t: 0, serial: a1, connected: true });
  steps.push({
    t: 1500,
    serial: a1,
    payload: report({
      gcode_state: "IDLE",
      nozzle_temper: 26,
      bed_temper: 24,
      wifi_signal: "-70dBm",
      ams: {
        ams: [
          { id: "0", tray: [tray(0, "PLA", "2E7D32", "GFA00", 51), tray(1, "PLA", "FFD100", "GFA00", 77)] },
        ],
      },
      task_id: "0",
      subtask_name: "",
    }),
  });
  steps.push({
    t: 9000,
    serial: a1,
    payload: report({
      gcode_state: "RUNNING",
      task_id: "1003",
      subtask_id: "2003",
      subtask_name: "Spacer test",
      layer_num: 1,
      total_layer_num: 30,
      mc_percent: 3,
      mc_remaining_time: 22,
    }),
  });
  steps.push({
    t: 21000,
    serial: a1,
    payload: report({ gcode_state: "FAILED", layer_num: 3, mc_percent: 9, print_error: 50348044 }),
  });
  steps.push({ t: 23000, serial: a1, payload: report({ gcode_state: "IDLE", print_error: 0 }) });

  const printers = [
    { printer: { serial: p1s, name: "P1S-01", model: "P1S" } },
    { printer: { serial: x1c, name: "X1C-02", model: "X1C" } },
    { printer: { serial: a1, name: "A1-03", model: "A1" } },
  ];
  const session = [...printers, ...steps.sort((a, b) => a.t - b.t)].map((l) => JSON.stringify(l)).join("\n");

  const files = {
    "Bracket set.gcode.3mf": buildSample3mf({
      objects: [
        { identifyId: "139", name: "Bracket", filament: 0, mmPerLayer: 120 },
        { identifyId: "140", name: "Bracket", filament: 0, mmPerLayer: 120 },
        { identifyId: "141", name: "Clip", filament: 1, mmPerLayer: 60 },
      ],
      filaments: [PLA_ORANGE, PETG_BLACK],
      startPurgeMm: 40,
      toolChangePurgeMm: 30,
      printerModelId: "C12",
    }),
    "Lid batch.gcode.3mf": buildSample3mf({
      objects: [
        { identifyId: "69", name: "Lid", filament: 0, mmPerLayer: 90 },
        { identifyId: "70", name: "Lid", filament: 0, mmPerLayer: 90 },
        { identifyId: "71", name: "Lid", filament: 0, mmPerLayer: 90 },
      ],
      filaments: [PETG_BLACK],
      startPurgeMm: 40,
      printerModelId: "BL-P001",
    }),
  };
  return { session: `${session}\n`, files };
}
