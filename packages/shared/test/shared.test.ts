import { describe, expect, it } from "vitest";
import {
  formatPrintError,
  materialFor,
  normalizeColor,
  normalizePartName,
  partNumberFromName,
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

describe("partNumberFromName", () => {
  it("takes the first number of exactly seven digits", () => {
    expect(partNumberFromName("2600076_24_5_260626.stl")).toBe("2600076");
    expect(partNumberFromName("2600095 v4_OP_1stk.stl")).toBe("2600095");
    expect(partNumberFromName("Bracket_2600067-B.stl")).toBe("2600067");
    expect(partNumberFromName("2600086")).toBe("2600086");
    // Six or eight digits are dates and other numbers, not part numbers.
    expect(partNumberFromName("Lid_modified_161126.stl")).toBeNull();
    expect(partNumberFromName("Order 26000761.stl")).toBeNull();
    expect(partNumberFromName("Bracket.stl")).toBeNull();
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
