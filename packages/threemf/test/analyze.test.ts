import { consumedWeight } from "@fleet/shared";
import { describe, expect, it } from "vitest";
import { analyzeThreeMf, GcodeAttributor, plateIndexFromPath, selectPlate } from "../src/index.ts";
import { buildSample3mf, SAMPLE_OBJECTS } from "../src/testing.ts";

/*
 * The default sample has two objects over 4 layers:
 *   Bracket (id 139) on filament 1 (PLA, 0.1 g/mm), 10 mm per layer  → 40 mm
 *   Lid     (id 69)  on filament 2 (PETG, 0.2 g/mm), 5 mm per layer  → 20 mm
 * plus a 20 mm start purge on the initial filament and 8 mm flush per tool change (7 changes).
 *   filament 1: 20 + 40 + 3×8 = 84 mm → used_g 8.4
 *   filament 2: 20 + 4×8      = 52 mm → used_g 10.4
 */
describe("analyzeThreeMf", () => {
  it("attributes grams per object and per filament from G-code labels", async () => {
    const [plate] = await analyzeThreeMf(buildSample3mf(), { fileName: "sample.gcode.3mf", fileMd5: "abc" });
    expect(plate).toBeDefined();
    if (!plate) return;

    expect(plate.attribution).toBe("gcode");
    expect(plate.plateIndex).toBe(1);
    expect(plate.printerModelId).toBe("C12");
    expect(plate.estTimeS).toBe(3720);
    expect(plate.estWeightG).toBeCloseTo(18.8, 5);
    // used_m is written with two decimals: 0.08 + 0.05.
    expect(plate.estLengthM).toBeCloseTo(0.13, 5);
    expect(plate.fileName).toBe("sample.gcode.3mf");

    expect(plate.filaments).toEqual([
      expect.objectContaining({ idx: 1, material: "PLA", color: "F98C36", usedG: 8.4, wasteG: 4.4 }),
      expect.objectContaining({ idx: 2, material: "PETG", color: "161616", usedG: 10.4, wasteG: 6.4 }),
    ]);
    expect(plate.wasteG).toBeCloseTo(10.8, 5);

    const bracket = plate.parts.find((p) => p.identifyId === "139");
    const lid = plate.parts.find((p) => p.identifyId === "69");
    expect(bracket).toMatchObject({ name: "Bracket", weightG: 4, perFilament: { "1": 4 }, wasteShareG: 5.4 });
    expect(lid).toMatchObject({ name: "Lid", weightG: 4, perFilament: { "2": 4 }, wasteShareG: 5.4 });

    // Parts plus waste add back up to the slicer's total.
    const parts = plate.parts.reduce((n, p) => n + (p.weightG ?? 0), 0);
    expect(parts + (plate.wasteG ?? 0)).toBeCloseTo(plate.estWeightG ?? 0, 1);

    expect(plate.layerCurve).toEqual([0.3162, 0.5441, 0.7721, 1]);
    expect(plate.thumbnailPngBase64).toMatch(/^iVBOR/);
  });

  it("handles streaming-written archives fed in small chunks", async () => {
    const bytes = buildSample3mf({ streaming: true });
    async function* chunked() {
      for (let i = 0; i < bytes.length; i += 97) yield bytes.subarray(i, i + 97);
    }
    const [plate] = await analyzeThreeMf(chunked());
    expect(plate?.parts.map((p) => p.weightG)).toEqual([4, 4]);
  });

  it("accepts a web ReadableStream", async () => {
    const bytes = buildSample3mf();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 100));
        controller.enqueue(bytes.subarray(100));
        controller.close();
      },
    });
    const [plate] = await analyzeThreeMf(stream);
    expect(plate?.attribution).toBe("gcode");
  });

  it("falls back to an even split when objects are not labelled", async () => {
    const [plate] = await analyzeThreeMf(buildSample3mf({ noLabels: true }));
    expect(plate?.attribution).toBe("even");
    expect(plate?.wasteG).toBeNull();
    expect(plate?.parts.map((p) => p.weightG)).toEqual([9.4, 9.4]);
  });

  it("keeps slicer-skipped objects but gives them no extrusion", async () => {
    const objects = [
      ...SAMPLE_OBJECTS,
      { identifyId: "7", name: "Spare", filament: 0, mmPerLayer: 0, skipped: true },
    ];
    const [plate] = await analyzeThreeMf(buildSample3mf({ objects }));
    expect(plate?.parts.find((p) => p.identifyId === "7")).toMatchObject({ skipped: true, weightG: 0 });
  });

  it("selects the printed plate", async () => {
    const plates = await analyzeThreeMf(buildSample3mf({ plateIndex: 3 }));
    expect(selectPlate(plates, 3)?.plateIndex).toBe(3);
    expect(selectPlate(plates, null)?.plateIndex).toBe(3);
    expect(selectPlate([], 1)).toBeNull();
  });
});

describe("GcodeAttributor", () => {
  it("supports absolute extrusion and G92 resets", () => {
    const g = new GcodeAttributor();
    g.pushText(
      [
        "M82",
        "; start printing object, unique label id: 5",
        "G1 X1 E2",
        "G1 X2 E5",
        "G92 E0",
        "G1 X3 E1.5",
        "; stop printing object, unique label id: 5",
        "",
      ].join("\n"),
    );
    const raw = g.finish();
    expect(raw.byObject.get("5")?.get(-1)).toBeCloseTo(6.5);
  });

  it("recognizes Klipper-style object labels", () => {
    const g = new GcodeAttributor();
    g.pushText(
      "EXCLUDE_OBJECT_START NAME=Gear_id_0_copy_0\nG1 X1 E3\nEXCLUDE_OBJECT_END NAME=Gear_id_0_copy_0\nG1 E1\n",
    );
    const raw = g.finish();
    expect(raw.labels).toEqual(["name:Gear_id_0_copy_0"]);
    expect(raw.byObject.get("")?.get(-1)).toBe(1);
  });

  it("handles lines split across chunks", () => {
    const g = new GcodeAttributor();
    const enc = new TextEncoder();
    g.push(enc.encode("T1\nG1 X1 E"));
    g.push(enc.encode("4\nG1 X2 E1"));
    expect(g.finish().byObject.get("")?.get(1)).toBe(5);
  });
});

describe("helpers", () => {
  it("parses plate index from G-code paths", () => {
    expect(plateIndexFromPath("/data/Metadata/plate_2.gcode")).toBe(2);
    expect(plateIndexFromPath("Metadata/plate_12.gcode")).toBe(12);
    expect(plateIndexFromPath("foo.3mf")).toBeNull();
  });

  it("estimates consumption for stopped jobs", () => {
    expect(consumedWeight(100, [0.25, 0.5, 1], 2, 40)).toBe(50);
    expect(consumedWeight(100, null, 2, 40)).toBe(40);
    expect(consumedWeight(100, [0.25, 0.5, 1], 9, null)).toBe(100);
    expect(consumedWeight(null, null, null, null)).toBeNull();
  });
});
