import { describe, expect, it } from "vitest";
import {
  formatPrintError,
  materialFor,
  normalizeColor,
  normalizePartName,
  roleAtLeast,
  toGcodeState,
} from "../src/index.ts";

describe("normalizePartName", () => {
  it("groups copies and file extensions", () => {
    expect(normalizePartName("Bracket.stl")).toBe("bracket");
    expect(normalizePartName("bracket (2)")).toBe("bracket");
    expect(normalizePartName("  Bracket  ")).toBe("bracket");
    expect(normalizePartName("Bambu   box (3)")).toBe("bambu box");
    expect(normalizePartName("M3-10")).toBe("m3-10");
  });
});

describe("colors and materials", () => {
  it("normalizes ARGB and hash colours", () => {
    expect(normalizeColor("F98C36FF")).toBe("F98C36");
    expect(normalizeColor("#ecc3b2")).toBe("ECC3B2");
    expect(normalizeColor("nope")).toBeNull();
  });
  it("prefers the reported type and falls back to the id table", () => {
    expect(materialFor("GFA00", "pla")).toBe("PLA");
    expect(materialFor("GFG50", "")).toBe("PETG-CF");
    expect(materialFor("XYZ", null)).toBeNull();
  });
});

describe("misc", () => {
  it("formats print errors like the Bambu wiki", () => {
    expect(formatPrintError(83935248)).toBe("0500-C010");
  });
  it("parses gcode states defensively", () => {
    expect(toGcodeState("RUNNING")).toBe("RUNNING");
    expect(toGcodeState("weird")).toBe("UNKNOWN");
  });
  it("orders roles", () => {
    expect(roleAtLeast("admin", "operator")).toBe(true);
    expect(roleAtLeast("viewer", "operator")).toBe(false);
  });
});
