import {
  type AmsUnit,
  materialFor,
  normalizeColor,
  type PrinterLiveState,
  type TrayState,
  toGcodeState,
} from "@fleet/shared";

/** The `print` object of a Bambu MQTT report, merged across delta messages. */
export type RawPrint = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge a report delta into the accumulated state. P1/A1 printers send only changed fields,
 * X1/H2 send full reports; objects merge recursively, arrays and scalars replace.
 */
export function mergeReport(target: RawPrint, delta: RawPrint): RawPrint {
  for (const [key, value] of Object.entries(delta)) {
    const current = target[key];
    target[key] = isObject(current) && isObject(value) ? mergeReport({ ...current }, value) : value;
  }
  return target;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : null;
}

function tray(raw: Record<string, unknown>, fallbackId: number): TrayState {
  const remain = num(raw.remain);
  const tagUid = str(raw.tag_uid);
  const trayInfoIdx = str(raw.tray_info_idx);
  return {
    id: int(raw.id) ?? fallbackId,
    material: materialFor(trayInfoIdx, str(raw.tray_type)),
    color: normalizeColor(str(raw.tray_color)),
    trayInfoIdx,
    remainPct: remain !== null && remain >= 0 ? remain : null,
    rfid: tagUid !== null && /[1-9A-F]/i.test(tagUid),
  };
}

function amsUnits(print: RawPrint): AmsUnit[] {
  const ams = print.ams;
  if (!isObject(ams) || !Array.isArray(ams.ams)) return [];
  return ams.ams.filter(isObject).map((unit, i) => ({
    id: int(unit.id) ?? i,
    // `humidity` is a 1-5 index on most firmware; newer firmware adds `humidity_raw` in %.
    humidity: num(unit.humidity_raw),
    tempC: num(unit.temp),
    trays: (Array.isArray(unit.tray) ? unit.tray : []).filter(isObject).map((t, j) => tray(t, j)),
  }));
}

function externalSpools(print: RawPrint): TrayState[] {
  if (Array.isArray(print.vir_slot)) return print.vir_slot.filter(isObject).map((t, i) => tray(t, i));
  if (isObject(print.vt_tray)) return [tray(print.vt_tray, 0)];
  return [];
}

function hms(print: RawPrint): PrinterLiveState["hms"] {
  if (!Array.isArray(print.hms)) return [];
  return print.hms.filter(isObject).flatMap((h) => {
    const attr = int(h.attr);
    const code = int(h.code);
    if (attr === null || code === null) return [];
    const hex = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
    return [{ code: `${hex(attr)}${hex(code)}`, severity: code >>> 16 }];
  });
}

/** Convert accumulated raw report fields into the dashboard's normalized live state. */
export function normalizeReport(
  serial: string,
  print: RawPrint,
  online: boolean,
  at: number,
): PrinterLiveState {
  return {
    serial,
    online,
    gcodeState: toGcodeState(print.gcode_state),
    jobName: str(print.subtask_name),
    progressPct: num(print.mc_percent),
    // Printers report mc_remaining_time in minutes.
    remainingMin: num(print.mc_remaining_time),
    layer: int(print.layer_num),
    totalLayers: int(print.total_layer_num),
    nozzleTempC: num(print.nozzle_temper),
    nozzleTargetC: num(print.nozzle_target_temper),
    bedTempC: num(print.bed_temper),
    bedTargetC: num(print.bed_target_temper),
    chamberTempC: num(print.chamber_temper),
    speedLevel: int(print.spd_lvl),
    printError: int(print.print_error),
    wifiSignal: str(print.wifi_signal),
    ams: amsUnits(print),
    externalSpools: externalSpools(print),
    hms: hms(print),
    updatedAt: at,
  };
}

export const reportFields = { num, int, str };
