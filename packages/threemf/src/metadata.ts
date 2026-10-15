import { XMLParser } from "fast-xml-parser";

export interface SliceFilament {
  id: number;
  trayInfoIdx: string | null;
  type: string | null;
  color: string | null;
  usedM: number | null;
  usedG: number | null;
}

export interface SliceObject {
  identifyId: string;
  name: string;
  skipped: boolean;
}

export interface SlicePlate {
  index: number;
  printerModelId: string | null;
  predictionS: number | null;
  weightG: number | null;
  objects: SliceObject[];
  filaments: SliceFilament[];
}

const ARRAY_TAGS = new Set(["plate", "metadata", "object", "filament", "warning", "nozzle", "header_item"]);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Attrs = Record<string, string | undefined>;

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse `Metadata/slice_info.config`, which lists each plate's objects and filament usage. */
export function parseSliceInfo(text: string): SlicePlate[] {
  const doc = xml.parse(text) as { config?: { plate?: Array<Record<string, unknown>> } };
  const plates = doc.config?.plate ?? [];
  return plates.map((plate, i) => {
    const meta = new Map<string, string>();
    for (const m of (plate.metadata as Attrs[] | undefined) ?? []) {
      if (m.key !== undefined) meta.set(m.key, m.value ?? "");
    }
    const objects = ((plate.object as Attrs[] | undefined) ?? []).map((o) => ({
      identifyId: String(o.identify_id ?? ""),
      name: String(o.name ?? `Object ${o.identify_id ?? "?"}`),
      skipped: o.skipped === "true",
    }));
    const filaments = ((plate.filament as Attrs[] | undefined) ?? [])
      .map((f) => ({
        id: num(f.id) ?? 0,
        trayInfoIdx: f.tray_info_idx || null,
        type: f.type || null,
        color: f.color || null,
        usedM: num(f.used_m),
        usedG: num(f.used_g),
      }))
      .filter((f) => f.id > 0 && f.id !== 255);
    return {
      index: num(meta.get("index")) ?? i + 1,
      printerModelId: meta.get("printer_model_id") || null,
      predictionS: num(meta.get("prediction")),
      weightG: num(meta.get("weight")),
      objects,
      filaments,
    };
  });
}

export interface ProjectFilamentSettings {
  density: number[];
  diameter: number[];
  type: string[];
  colour: string[];
}

/** Read per-filament settings from `Metadata/project_settings.config` (JSON). */
export function parseProjectSettings(text: string): ProjectFilamentSettings {
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Older files may not be JSON; densities then fall back to material defaults.
  }
  const list = (key: string): string[] => {
    const v = json[key];
    return Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(";") : [];
  };
  return {
    density: list("filament_density").map(Number),
    diameter: list("filament_diameter").map(Number),
    type: list("filament_type"),
    colour: list("filament_colour"),
  };
}

/** `Metadata/plate_2.gcode` or `/data/Metadata/plate_2.gcode` → 2. */
export function plateIndexFromPath(path: string | null | undefined): number | null {
  const m = path ? /plate_(\d+)\.gcode/i.exec(path) : null;
  return m ? Number.parseInt(m[1] as string, 10) : null;
}
