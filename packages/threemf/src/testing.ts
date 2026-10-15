import { strToU8, Zip, ZipDeflate, zipSync } from "fflate";

/** Builders for synthetic Bambu-style `.gcode.3mf` files, used by tests and agent replay demos. */

export interface SampleObject {
  identifyId: string;
  name: string;
  /** 0-based filament index (`T<n>`). */
  filament: number;
  mmPerLayer: number;
  skipped?: boolean;
}

export interface SampleFilament {
  type: string;
  trayInfoIdx: string;
  color: string;
  /** Grams per mm, used to compute `used_g` so expected results are easy to reason about. */
  gramsPerMm: number;
}

export interface Sample3mfOptions {
  plateIndex?: number;
  layers?: number;
  /** Purge line in the start G-code, before any `T` command (initial filament). */
  startPurgeMm?: number;
  /** Flush after each tool change, outside object labels. */
  toolChangePurgeMm?: number;
  objects?: SampleObject[];
  filaments?: SampleFilament[];
  printerModelId?: string;
  /** Write the archive with data descriptors, like a streaming ZIP writer would. */
  streaming?: boolean;
  /** Omit object labels from the G-code (label objects disabled in the slicer). */
  noLabels?: boolean;
}

export const SAMPLE_OBJECTS: SampleObject[] = [
  { identifyId: "139", name: "Bracket", filament: 0, mmPerLayer: 10 },
  { identifyId: "69", name: "Lid", filament: 1, mmPerLayer: 5 },
];

export const SAMPLE_FILAMENTS: SampleFilament[] = [
  { type: "PLA", trayInfoIdx: "GFA00", color: "#F98C36", gramsPerMm: 0.1 },
  { type: "PETG", trayInfoIdx: "GFG00", color: "#161616", gramsPerMm: 0.2 },
];

/** A 1×1 transparent PNG. */
const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

export function buildSampleGcode(options: Sample3mfOptions = {}): { gcode: string; mmByFilament: number[] } {
  const layers = options.layers ?? 4;
  const objects = options.objects ?? SAMPLE_OBJECTS;
  const purge = options.toolChangePurgeMm ?? 8;
  const filamentCount = Math.max(...objects.map((o) => o.filament)) + 1;
  const mm = new Array<number>(filamentCount).fill(0);
  const lines: string[] = [
    "; HEADER_BLOCK_START",
    "; BambuStudio synthetic sample",
    "; HEADER_BLOCK_END",
    "M83",
  ];
  let current = objects[0]?.filament ?? 0;

  const startPurge = options.startPurgeMm ?? 20;
  lines.push(`G1 X18 Y1 E${startPurge / 2}`, `G1 X60 Y1 E${startPurge / 2}`);
  mm[current] = (mm[current] ?? 0) + startPurge;

  for (let layer = 1; layer <= layers; layer++) {
    lines.push("; CHANGE_LAYER", `; Z_HEIGHT: ${(layer * 0.2).toFixed(1)}`, `M73 L${layer}`);
    for (const o of objects) {
      if (o.filament !== current) {
        lines.push(`M620 S${o.filament}A`, `T${o.filament}`, `G1 E${purge} F300`, `M621 S${o.filament}A`);
        mm[o.filament] = (mm[o.filament] ?? 0) + purge;
        current = o.filament;
      }
      if (!options.noLabels) lines.push(`; start printing object, unique label id: ${o.identifyId}`);
      // Split into moves with a retract/unretract pair, which must cancel out.
      lines.push(
        `G1 X10 Y10 E${o.mmPerLayer / 2} ; perimeter`,
        "G1 E-.8 F2100",
        "G0 X20 Y20",
        "G1 E.8 F2100",
        `G1 X30 Y30 E${o.mmPerLayer / 2}`,
      );
      mm[o.filament] = (mm[o.filament] ?? 0) + o.mmPerLayer;
      if (!options.noLabels) lines.push(`; stop printing object, unique label id: ${o.identifyId}`);
    }
  }
  lines.push("M73 P100 R0", "; EXECUTABLE_BLOCK_END", "");
  return { gcode: lines.join("\n"), mmByFilament: mm };
}

export function buildSliceInfo(options: Sample3mfOptions, mmByFilament: number[]): string {
  const plate = options.plateIndex ?? 1;
  const objects = options.objects ?? SAMPLE_OBJECTS;
  const filaments = options.filaments ?? SAMPLE_FILAMENTS;
  const filamentXml = mmByFilament.map((mm, i) => {
    const f = filaments[i] ?? filaments[0];
    if (!f) throw new Error("no filament definition");
    return `    <filament id="${i + 1}" tray_info_idx="${f.trayInfoIdx}" type="${f.type}" color="${f.color}" used_m="${(mm / 1000).toFixed(2)}" used_g="${(mm * f.gramsPerMm).toFixed(2)}" group_id="0" nozzle_diameter="0.40" used_for_object="true" used_for_support="false"/>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<config>",
    "  <header>",
    '    <header_item key="X-BBL-Client-Type" value="slicer"/>',
    '    <header_item key="X-BBL-Client-Version" value="02.05.03.61"/>',
    "  </header>",
    "  <plate>",
    `    <metadata key="index" value="${plate}"/>`,
    `    <metadata key="printer_model_id" value="${options.printerModelId ?? "C12"}"/>`,
    '    <metadata key="prediction" value="3720"/>',
    ...objects.map(
      (o) =>
        `    <object identify_id="${o.identifyId}" name="${o.name}" skipped="${o.skipped ? "true" : "false"}" />`,
    ),
    ...filamentXml,
    "  </plate>",
    "</config>",
    "",
  ].join("\n");
}

export function buildSample3mf(options: Sample3mfOptions = {}): Uint8Array {
  const plate = options.plateIndex ?? 1;
  const filaments = options.filaments ?? SAMPLE_FILAMENTS;
  const { gcode, mmByFilament } = buildSampleGcode(options);
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types/>'),
    [`Metadata/plate_${plate}.gcode`]: strToU8(gcode),
    "Metadata/slice_info.config": strToU8(buildSliceInfo(options, mmByFilament)),
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({
        filament_density: filaments.map(() => "1.24"),
        filament_diameter: filaments.map(() => "1.75"),
        filament_type: filaments.map((f) => f.type),
        filament_colour: filaments.map((f) => f.color),
      }),
    ),
    [`Metadata/plate_${plate}.png`]: TINY_PNG,
  };
  return options.streaming ? streamingZip(files) : zipSync(files, { level: 6 });
}

function streamingZip(files: Record<string, Uint8Array>): Uint8Array {
  const out: Uint8Array[] = [];
  const zip = new Zip((err, data) => {
    if (err) throw err;
    out.push(data);
  });
  for (const [name, bytes] of Object.entries(files)) {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();
  const result = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of out) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}
