import { describe, expect, it } from "vitest";
import { analyzeThreeMf } from "../src/index.ts";
import { cutOutParts } from "../src/partImages.ts";
import { decodePng, encodePng, type Rgba } from "../src/png.ts";
import { buildSample3mf, buildSampleRenders, SAMPLE_FILAMENTS } from "../src/testing.ts";

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Number of pixels that are not fully transparent. */
function opaque(img: Rgba): number {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if ((img.data[i] ?? 0) > 0) n++;
  return n;
}

describe("png", () => {
  it("round-trips RGBA pixels", () => {
    const data = new Uint8Array(5 * 3 * 4).map((_, i) => (i * 37) % 256);
    const decoded = decodePng(encodePng({ width: 5, height: 3, data }));
    expect(decoded).toEqual({ width: 5, height: 3, data });
  });

  it("rejects what it cannot read", () => {
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("cutOutParts", () => {
  const objects = [
    { identifyId: "139", name: "Bracket", filament: 0, mmPerLayer: 1 },
    { identifyId: "300", name: "Lid", filament: 1, mmPerLayer: 1 },
  ];

  it("crops each object to its own pixels using the pick map", () => {
    const { top, pick } = buildSampleRenders(objects, SAMPLE_FILAMENTS);
    const cut = cutOutParts(top, pick, ["139", "300", "999"]);
    expect([...cut.keys()].sort()).toEqual(["139", "300"]);

    const bracket = decodePng(cut.get("139") as Uint8Array) as Rgba;
    const lid = decodePng(cut.get("300") as Uint8Array) as Rgba;
    // Each object sits in its own half of the 256 px render.
    expect(bracket.width).toBeLessThanOrEqual(128);
    expect(lid.width).toBeLessThanOrEqual(128);
    expect(opaque(bracket)).toBeGreaterThan(100);
    // Corners are transparent padding; the bracket is drawn in orange PLA.
    expect(bracket.data[3]).toBe(0);
    const centreRow = Math.floor(bracket.height / 2) * bracket.width * 4;
    const firstOpaque = bracket.data.subarray(centreRow).findIndex((v, i) => i % 4 === 3 && v === 255) - 3;
    const [r, g, b] = bracket.data.subarray(centreRow + firstOpaque, centreRow + firstOpaque + 3);
    expect(r).toBeGreaterThan((b ?? 0) + 100);
    expect(g).toBeLessThan(r ?? 0);
  });

  it("returns nothing when the renders don't line up", () => {
    const a = buildSampleRenders(objects, SAMPLE_FILAMENTS);
    const small = encodePng({ width: 2, height: 2, data: new Uint8Array(16) });
    expect(cutOutParts(a.top, small, ["139"]).size).toBe(0);
  });
});

describe("analyzeThreeMf part images", () => {
  it("adds one image per distinct part name", async () => {
    const [plate] = await analyzeThreeMf(
      buildSample3mf({
        objects: [
          { identifyId: "139", name: "Bracket", filament: 0, mmPerLayer: 10 },
          { identifyId: "140", name: "Bracket", filament: 0, mmPerLayer: 10 },
          { identifyId: "69", name: "Lid", filament: 1, mmPerLayer: 5 },
        ],
      }),
    );
    const images = Object.fromEntries(
      (plate?.parts ?? []).map((p) => [p.identifyId, p.imagePngBase64 ?? null]),
    );
    expect(images["139"]).toMatch(/^iVBOR/);
    expect(images["140"]).toBeNull();
    expect(images["69"]).toMatch(/^iVBOR/);
    expect(decodePng(fromBase64(images["69"] as string))?.width).toBeGreaterThan(10);
  });

  it("skips the cut-outs when asked, or when the file has no renders", async () => {
    const [off] = await analyzeThreeMf(buildSample3mf(), { partImages: false });
    expect(off?.parts.every((p) => p.imagePngBase64 === undefined)).toBe(true);
    const [none] = await analyzeThreeMf(buildSample3mf({ renders: false }));
    expect(none?.parts.every((p) => p.imagePngBase64 === undefined)).toBe(true);
  });
});
