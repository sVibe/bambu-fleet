import {
  type FilamentUsage,
  LIVE_STALE_MS,
  modelForPrinterModelId,
  normalizeModel,
  type PrinterLiveState,
  type TrayState,
} from "@fleet/shared";
import type { MatchVerdict, PrinterReadiness, PrinterSuggestion, SlotMapping } from "../api-types.ts";

export interface MatchPrinter {
  serial: string;
  name: string;
  model: string | null;
  live: PrinterLiveState | null;
  /** Titles of other queue items already assigned or dispatched to this printer. */
  reservedFor?: string[];
}

export interface MatchPlate {
  printerModelId: string | null;
  filaments: FilamentUsage[];
}

/** RGB distance (0–441) below which two filament colours count as the same. */
const SAME_COLOUR = 40;
/** Spool size assumed when converting a tray's remaining percentage to grams. */
const ASSUMED_SPOOL_G = 1000;

type Tray = NonNullable<SlotMapping["tray"]>;

function loadedTrays(live: PrinterLiveState): Tray[] {
  const label = (amsId: number, slot: number) =>
    amsId < 26 ? `${String.fromCharCode(65 + amsId)}${slot + 1}` : `AMS ${amsId} slot ${slot + 1}`;
  return [
    ...live.ams.flatMap((unit) => unit.trays.map((t) => tray(t, unit.id, label(unit.id, t.id)))),
    ...live.externalSpools.map((t) => tray(t, null, "Ext")),
  ].filter((t) => t.material !== null);
}

function tray(t: TrayState, amsId: number | null, label: string): Tray {
  return { amsId, slotId: t.id, label, material: t.material, color: t.color, remainPct: t.remainPct };
}

function colourDistance(a: string | null, b: string | null): number {
  if (!a || !b) return 441;
  const rgb = (hex: string) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(...x.map((v, i) => v - (y[i] as number)));
}

function sameMaterial(filament: string | null, trayMaterial: string | null): boolean {
  if (!filament) return true;
  return filament.toUpperCase() === trayMaterial?.toUpperCase();
}

/**
 * Map each filament of a plate to a loaded tray: same material required, closest colour preferred, heaviest
 * filament first, and each tray used once while unused matching trays remain.
 */
export function suggestSlots(filaments: FilamentUsage[], live: PrinterLiveState | null): SlotMapping[] {
  const trays = live ? loadedTrays(live) : [];
  const used = new Set<Tray>();
  const order = [...filaments].sort((a, b) => (b.usedG ?? 0) - (a.usedG ?? 0));
  const result = new Map<number, SlotMapping>();
  for (const f of order) {
    const candidates = trays
      .filter((t) => sameMaterial(f.material, t.material))
      .map((t) => ({ t, d: colourDistance(f.color, t.color) + (used.has(t) ? 1000 : 0) }))
      .sort((a, b) => a.d - b.d);
    const best = candidates[0]?.t ?? null;
    if (best) used.add(best);
    result.set(f.idx, {
      filamentIdx: f.idx,
      material: f.material,
      color: f.color,
      usedG: f.usedG,
      match: !best ? "missing" : colourDistance(f.color, best.color) <= SAME_COLOUR ? "exact" : "colour",
      tray: best,
    });
  }
  return filaments.map((f) => result.get(f.idx) as SlotMapping);
}

function readinessOf(live: PrinterLiveState | null, now: number): PrinterReadiness {
  if (!live?.online || now - live.updatedAt > LIVE_STALE_MS) return "offline";
  switch (live.gcodeState) {
    case "IDLE":
      return "ready";
    case "FINISH":
    case "FAILED":
      return "clear-bed";
    case "UNKNOWN":
      return "unknown";
    default:
      return "busy";
  }
}

const VERDICT_ORDER: Record<MatchVerdict, number> = { ready: 0, action: 1, wait: 2, unsuitable: 3 };

/** Rank printers for one plate by model compatibility, loaded materials and whether they're free. */
export function rankPrinters(plate: MatchPlate, printers: MatchPrinter[], now: number): PrinterSuggestion[] {
  const wanted = modelForPrinterModelId(plate.printerModelId);
  const suggestions = printers.map((p): PrinterSuggestion => {
    const issues: PrinterSuggestion["issues"] = [];
    let wait = false;

    const have = normalizeModel(p.model);
    const modelCheck: PrinterSuggestion["modelCheck"] =
      !wanted || !have ? "unknown" : normalizeModel(wanted) === have ? "match" : "mismatch";
    if (modelCheck === "mismatch")
      issues.push({ level: "block", text: `Sliced for ${wanted}, printer is ${p.model}` });
    if (modelCheck === "unknown") {
      issues.push({
        level: "warn",
        text: wanted
          ? "Printer model unknown – check manually"
          : `Unknown printer_model_id ${plate.printerModelId ?? "(none)"} – check manually`,
      });
    }

    const readiness = readinessOf(p.live, now);
    if (readiness === "offline") issues.push({ level: "block", text: "Offline" });
    if (readiness === "clear-bed") issues.push({ level: "warn", text: "Clear the bed first" });
    if (readiness === "unknown") issues.push({ level: "warn", text: "Printer state unknown" });
    if (readiness === "busy") {
      wait = true;
      const left = p.live?.remainingMin;
      issues.push({ level: "warn", text: left ? `Busy, about ${left} min left` : "Busy" });
    }
    if (p.reservedFor?.length) {
      wait = true;
      issues.push({ level: "warn", text: `Already has ${p.reservedFor.map((t) => `"${t}"`).join(", ")}` });
    }

    const slots = readiness === "offline" && !p.live ? [] : suggestSlots(plate.filaments, p.live);
    for (const s of slots) {
      const what = `${s.material ?? "Filament"} #${s.filamentIdx}`;
      if (s.match === "missing")
        issues.push({ level: "block", text: `No ${s.material ?? "matching"} loaded` });
      else if (s.match === "colour")
        issues.push({ level: "warn", text: `${what}: colour differs in ${s.tray?.label}` });
      const remain = s.tray?.remainPct;
      if (s.tray && remain != null && s.usedG && (remain / 100) * ASSUMED_SPOOL_G < s.usedG) {
        issues.push({ level: "warn", text: `${s.tray.label} may run out (${remain}% left)` });
      }
    }

    const materialScore =
      slots.length > 0
        ? slots.reduce((n, s) => n + (s.match === "exact" ? 1 : s.match === "colour" ? 0.5 : 0), 0) /
          slots.length
        : plate.filaments.length === 0
          ? 1
          : 0;
    const score = Math.round(
      (modelCheck === "match" ? 40 : modelCheck === "unknown" ? 20 : 0) +
        materialScore * 40 +
        { ready: 20, "clear-bed": 12, busy: 5, unknown: 5, offline: 0 }[readiness] -
        (p.reservedFor?.length ? 5 : 0),
    );

    const verdict: MatchVerdict = issues.some((i) => i.level === "block")
      ? "unsuitable"
      : wait
        ? "wait"
        : issues.length > 0
          ? "action"
          : "ready";
    issues.sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));

    return {
      serial: p.serial,
      name: p.name,
      model: p.model,
      verdict,
      score: Math.max(0, score),
      modelCheck,
      readiness,
      gcodeState: p.live?.gcodeState ?? null,
      remainingMin: p.live?.remainingMin ?? null,
      slots,
      issues,
    };
  });
  return suggestions.sort(
    (a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
      b.score - a.score ||
      a.name.localeCompare(b.name),
  );
}
