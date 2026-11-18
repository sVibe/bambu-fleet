import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TEMPLATES,
  EXAMPLE_PART_VALUES,
  exampleValues,
  fillPlaceholders,
  LABEL_VARIABLES,
  layoutLabel,
  layoutText,
  measuringFonts,
  PART_LABEL,
  renderLabelPdf,
  renderLabelZpl,
} from "../src/index.ts";

const MM = 72 / 25.4;

describe("fillPlaceholders", () => {
  it("replaces known names and blanks unknown ones", () => {
    expect(
      fillPlaceholders("{{part.number}} · {{ part.name }} {{nope}}", {
        "part.number": "2600067",
        "part.name": "Bracket",
      }),
    ).toBe("2600067 · Bracket ");
  });
});

describe("layoutText", () => {
  it("shrinks text until it fits, then cuts it with an ellipsis", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const box = { w: 18, h: 5, fontSize: 10, minFontSize: 6, maxLines: 1 };
    expect(layoutText("Short", font, box)).toEqual({ size: 10, lines: ["Short"], cut: false });

    const medium = layoutText("A somewhat longer name", font, box);
    expect(medium.size).toBeLessThan(10);
    expect(medium.lines).toHaveLength(1);

    const long = layoutText("A very long part name that can never fit on one small label line", font, box);
    expect(long.size).toBe(6);
    expect(long.lines).toHaveLength(1);
    expect(long.lines[0]?.endsWith("…")).toBe(true);
    expect(font.widthOfTextAtSize(long.lines[0] ?? "", 6)).toBeLessThanOrEqual(18 * MM);
  });

  it("wraps onto as many lines as the box allows", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const { lines } = layoutText("Bracket for the left side panel", font, {
      w: 18,
      h: 6.4,
      fontSize: 6.5,
      maxLines: 2,
    });
    expect(lines.length).toBe(2);
  });
});

describe("renderLabelPdf", () => {
  it("renders the part label at 57×32 mm", async () => {
    const bytes = await renderLabelPdf(PART_LABEL, EXAMPLE_PART_VALUES);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(57 * MM, 3);
    expect(height).toBeCloseTo(32 * MM, 3);
  });

  it("doesn't fail on characters the standard fonts can't show", async () => {
    const bytes = await renderLabelPdf(PART_LABEL, {
      ...EXAMPLE_PART_VALUES,
      "part.name": "Bøjle ✓ 支架",
      "part.number": "Ø-2600067",
    });
    expect(bytes.byteLength).toBeGreaterThan(500);
  });
});

describe("renderLabelZpl", () => {
  it("draws the label in printer dots, with its size in the job", async () => {
    const zpl = await renderLabelZpl(PART_LABEL, { ...EXAMPLE_PART_VALUES, "label.qty": "50 pcs" });
    expect(zpl.startsWith("^XA\n^CI28\n^PW456\n^LL256\n")).toBe(true);
    expect(zpl.trimEnd().endsWith("^XZ")).toBe(true);
    // QR of the part number: 21 modules of 8 dots fill the 22 mm (176 dot) box.
    expect(zpl).toContain("^FO20,20^BQN,2,8^FH_^FDMA,2600067^FS");
    expect(zpl).toContain("^FD50 pcs^FS");
    // The rule under the QR code: 53 × 0.3 mm, filled.
    expect(zpl).toContain("^FO16,203^GB424,2,2,B,0^FS");
  });

  it("escapes ZPL control characters and scales to other resolutions", async () => {
    const zpl = await renderLabelZpl(
      PART_LABEL,
      { ...EXAMPLE_PART_VALUES, "part.name": "A^B~C_D" },
      { dpi: 300, upsideDown: true },
    );
    expect(zpl).toContain("^FDA_5EB_7EC_5FD^FS");
    expect(zpl).toContain("^PW673");
    expect(zpl).toContain("^POI");
  });
});

describe("layoutLabel", () => {
  it("places text lines in mm and flags text cut short", async () => {
    const fonts = await measuringFonts();
    const box = { id: "t", type: "text" as const, x: 5, y: 2, w: 20, h: 4, fontSize: 10, maxLines: 1 };
    const [fits] = layoutLabel(
      { widthMm: 30, heightMm: 10, elements: [{ ...box, text: "Short", align: "right" }] },
      {},
      fonts,
    );
    expect(fits?.type).toBe("text");
    if (fits?.type !== "text") return;
    const line = fits.lines[0];
    expect(fits.cut).toBe(false);
    expect(line?.top).toBe(2);
    expect((line?.x ?? 0) + (line?.width ?? 0)).toBeCloseTo(25, 5);
    expect(line?.baseline).toBeGreaterThan(2);

    const [cut] = layoutLabel(
      { widthMm: 30, heightMm: 10, elements: [{ ...box, text: "A very long part name that cannot fit" }] },
      {},
      fonts,
    );
    expect(cut?.type === "text" && cut.cut).toBe(true);
  });

  it("leaves out elements whose value is empty", async () => {
    const items = layoutLabel(
      PART_LABEL,
      { ...EXAMPLE_PART_VALUES, "label.qty": "" },
      await measuringFonts(),
    );
    expect(items.map((i) => i.el.id)).not.toContain("qty");
    expect(items.map((i) => i.el.id)).toContain("qr");
  });
});

describe("templates and variables", () => {
  it("has example values for every variable the built-in labels use", () => {
    for (const source of ["part", "job"] as const) {
      const values = exampleValues(source);
      const used = BUILTIN_TEMPLATES[source].template.elements.flatMap((el) =>
        [
          ...(el.type === "text" ? el.text : el.type === "qr" ? el.value : "").matchAll(
            /\{\{([a-z0-9_.]+)\}\}/g,
          ),
        ].map((m) => m[1]),
      );
      expect(used.length).toBeGreaterThan(0);
      for (const name of used) expect(values, `${source}: ${name}`).toHaveProperty([name as string]);
    }
  });

  it("names each variable once per kind", () => {
    for (const groups of Object.values(LABEL_VARIABLES)) {
      const names = groups.flatMap((g) => g.variables.map((v) => v.name));
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
