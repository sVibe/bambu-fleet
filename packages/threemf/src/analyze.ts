import {
  defaultDensity,
  type FilamentUsage,
  type JobAnalysis,
  materialFor,
  normalizeColor,
  type PartUsage,
} from "@fleet/shared";
import { GcodeAttributor, INITIAL_FILAMENT, NON_OBJECT, type RawAttribution } from "./gcode.ts";
import {
  type ProjectFilamentSettings,
  parseProjectSettings,
  parseSliceInfo,
  type SlicePlate,
} from "./metadata.ts";
import { type ByteSource, collect, walkZip } from "./zip.ts";

export interface AnalyzeOptions {
  fileName?: string | null;
  fileMd5?: string | null;
  /** Include each plate's PNG preview as base64 (default true). */
  thumbnails?: boolean;
}

const decoder = new TextDecoder();

/**
 * Analyze a sliced Bambu `.gcode.3mf`: filament usage per plate and grams per object.
 * Streams the archive, so large G-code entries are never held in memory.
 */
export async function analyzeThreeMf(
  source: ByteSource,
  options: AnalyzeOptions = {},
): Promise<JobAnalysis[]> {
  let sliceInfo: string | null = null;
  let projectSettings: string | null = null;
  const gcode = new Map<number, RawAttribution>();
  const thumbs = new Map<number, Uint8Array>();

  await walkZip(source, (name) => {
    if (name === "Metadata/slice_info.config") return collect((b) => (sliceInfo = decoder.decode(b)));
    if (name === "Metadata/project_settings.config") {
      return collect((b) => (projectSettings = decoder.decode(b)));
    }
    const g = /^Metadata\/plate_(\d+)\.gcode$/.exec(name);
    if (g) {
      const index = Number(g[1]);
      const scanner = new GcodeAttributor();
      return { data: (c) => scanner.push(c), end: () => gcode.set(index, scanner.finish()) };
    }
    const t = /^Metadata\/plate_(\d+)\.png$/.exec(name);
    if (t && options.thumbnails !== false) return collect((b) => thumbs.set(Number(t[1]), b));
    return null;
  });

  const plates = sliceInfo ? parseSliceInfo(sliceInfo) : [];
  const settings = projectSettings ? parseProjectSettings(projectSettings) : null;
  const indices = [...new Set([...plates.map((p) => p.index), ...gcode.keys()])].sort((a, b) => a - b);

  return indices.map((index) =>
    buildAnalysis(
      plates.find((p) => p.index === index) ?? emptyPlate(index),
      gcode.get(index) ?? null,
      settings,
      thumbs.get(index) ?? null,
      options,
    ),
  );
}

/** Pick the plate that was printed: by index when known, else the one with G-code. */
export function selectPlate(plates: JobAnalysis[], plateIndex?: number | null): JobAnalysis | null {
  if (plateIndex != null) {
    const match = plates.find((p) => p.plateIndex === plateIndex);
    if (match) return match;
  }
  return plates.find((p) => p.layerCurve !== null) ?? plates[0] ?? null;
}

function emptyPlate(index: number): SlicePlate {
  return { index, printerModelId: null, predictionS: null, weightG: null, objects: [], filaments: [] };
}

const round = (n: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

function mmToGrams(mm: number, densityGcm3: number, diameterMm: number): number {
  const areaMm2 = Math.PI * (diameterMm / 2) ** 2;
  return ((areaMm2 * mm) / 1000) * densityGcm3;
}

export function buildAnalysis(
  plate: SlicePlate,
  raw: RawAttribution | null,
  settings: ProjectFilamentSettings | null,
  thumbnail: Uint8Array | null,
  options: AnalyzeOptions = {},
): JobAnalysis {
  const sliceFilaments = new Map(plate.filaments.map((f) => [f.id, f]));
  const firstUsed = plate.filaments.find((f) => (f.usedG ?? 0) > 0)?.id ?? plate.filaments[0]?.id ?? 1;

  const materialOf = (id: number) => {
    const f = sliceFilaments.get(id);
    return materialFor(f?.trayInfoIdx, f?.type ?? settings?.type[id - 1]);
  };

  // Net mm per label per 1-based filament id.
  const mmByLabel = new Map<string, Map<number, number>>();
  const mmByFilament = new Map<number, number>();
  for (const [label, perFilament] of raw?.byObject ?? []) {
    const target = mmByLabel.get(label) ?? new Map<number, number>();
    mmByLabel.set(label, target);
    for (const [index, mm] of perFilament) {
      const id = index === INITIAL_FILAMENT ? firstUsed : index + 1;
      target.set(id, (target.get(id) ?? 0) + mm);
      mmByFilament.set(id, (mmByFilament.get(id) ?? 0) + mm);
    }
  }

  // Grams per mm per filament: scale to the slicer's own used_g when present.
  const gramsPerMm = (id: number): number => {
    const used = sliceFilaments.get(id)?.usedG;
    const mm = mmByFilament.get(id) ?? 0;
    if (used != null && mm > 0) return used / mm;
    const density = settings?.density[id - 1];
    const diameter = settings?.diameter[id - 1];
    return mmToGrams(
      1,
      density && density > 0 ? density : defaultDensity(materialOf(id)),
      diameter && diameter > 0 ? diameter : 1.75,
    );
  };

  const objectLabels = (raw?.labels ?? []).filter((l) => l !== NON_OBJECT);
  const hasLabels = objectLabels.length > 0;
  const nonObject = mmByLabel.get(NON_OBJECT);

  const filamentIds = [...new Set([...sliceFilaments.keys(), ...mmByFilament.keys()])].sort((a, b) => a - b);
  const filaments: FilamentUsage[] = filamentIds
    .map((id) => {
      const f = sliceFilaments.get(id);
      const mm = mmByFilament.get(id) ?? 0;
      return {
        idx: id,
        trayInfoIdx: f?.trayInfoIdx ?? null,
        material: materialOf(id),
        color: normalizeColor(f?.color ?? settings?.colour[id - 1]),
        usedG: f?.usedG ?? (mm > 0 ? round(mm * gramsPerMm(id)) : null),
        usedM: f?.usedM ?? (mm > 0 ? round(mm / 1000) : null),
        wasteG: hasLabels ? round((nonObject?.get(id) ?? 0) * gramsPerMm(id)) : null,
      };
    })
    .filter((f) => (f.usedG ?? 0) > 0 || (f.usedM ?? 0) > 0);

  const totalUsedG = filaments.reduce((n, f) => n + (f.usedG ?? 0), 0);
  const estWeightG = totalUsedG > 0 ? round(totalUsedG) : plate.weightG;
  const wasteG = hasLabels ? round(filaments.reduce((n, f) => n + (f.wasteG ?? 0), 0)) : null;

  let parts: PartUsage[] = [];
  let attribution: JobAnalysis["attribution"] = "none";

  if (hasLabels) {
    attribution = "gcode";
    const known = new Set(plate.objects.map((o) => o.identifyId));
    const objects = [
      ...plate.objects,
      ...objectLabels
        .filter((l) => !known.has(l))
        .map((l) => ({
          identifyId: l,
          name: l.startsWith("name:") ? l.slice(5) : `Object ${l}`,
          skipped: false,
        })),
    ];
    parts = objects.map((o) => {
      const perFilament: Record<string, number> = {};
      let weight = 0;
      for (const [id, mm] of mmByLabel.get(o.identifyId) ?? []) {
        const g = mm * gramsPerMm(id);
        if (g <= 0) continue;
        perFilament[String(id)] = round(g);
        weight += g;
      }
      return {
        identifyId: o.identifyId,
        name: o.name,
        skipped: o.skipped,
        weightG: round(weight),
        wasteShareG: 0,
        perFilament,
      };
    });
    const partTotal = parts.reduce((n, p) => n + (p.weightG ?? 0), 0);
    for (const p of parts) {
      p.wasteShareG = partTotal > 0 && wasteG ? round((wasteG * (p.weightG ?? 0)) / partTotal) : 0;
    }
  } else if (plate.objects.length > 0) {
    attribution = "even";
    const printed = plate.objects.filter((o) => !o.skipped);
    const share = printed.length > 0 ? 1 / printed.length : 0;
    parts = plate.objects.map((o) => {
      const perFilament: Record<string, number> = {};
      if (!o.skipped) {
        for (const f of filaments) {
          if (f.usedG) perFilament[String(f.idx)] = round(f.usedG * share);
        }
      }
      return {
        identifyId: o.identifyId,
        name: o.name,
        skipped: o.skipped,
        weightG: o.skipped || estWeightG == null ? 0 : round(estWeightG * share),
        wasteShareG: null,
        perFilament,
      };
    });
  }

  const layerCurve =
    raw && raw.totalMm > 0 && raw.layerEnds.length > 0
      ? raw.layerEnds.map((mm) => round(Math.min(1, Math.max(0, mm / raw.totalMm)), 4))
      : null;

  return {
    fileName: options.fileName ?? null,
    fileMd5: options.fileMd5 ?? null,
    plateIndex: plate.index,
    printerModelId: plate.printerModelId,
    estWeightG,
    estLengthM: filaments.some((f) => f.usedM != null)
      ? round(filaments.reduce((n, f) => n + (f.usedM ?? 0), 0))
      : null,
    estTimeS: plate.predictionS,
    wasteG,
    attribution,
    filaments,
    parts,
    layerCurve,
    thumbnailPngBase64: thumbnail ? toBase64(thumbnail) : null,
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
