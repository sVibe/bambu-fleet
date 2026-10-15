import { describe, expect, it } from "vitest";
import { Md5, md5Hex, modelForPrinterModelId, normalizeJobName, normalizeModel } from "../src/index.ts";

const utf8 = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

describe("md5", () => {
  it("matches the RFC 1321 test vectors", () => {
    expect(md5Hex(utf8(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(utf8("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex(utf8("message digest"))).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(
      md5Hex(utf8("12345678901234567890123456789012345678901234567890123456789012345678901234567890")),
    ).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("gives the same digest however the input is chunked", () => {
    const data = new Uint8Array(100_003).map((_, i) => (i * 31 + (i >> 7)) & 0xff);
    const expected = "a6e1f0b7f4697c8c2aa1ad195856275b"; // node:crypto createHash("md5")
    for (const size of [1, 63, 64, 65, 1000, 65_536]) {
      const md5 = new Md5();
      for (let i = 0; i < data.length; i += size) md5.update(data.subarray(i, i + size));
      expect(md5.hex()).toBe(expected);
    }
  });
});

describe("queue helpers", () => {
  it("maps printer_model_id and normalizes model names", () => {
    expect(modelForPrinterModelId("C12")).toBe("P1S");
    expect(modelForPrinterModelId("BL-P001")).toBe("X1C");
    expect(modelForPrinterModelId("Z99")).toBeNull();
    expect(normalizeModel("Bambu Lab X1 Carbon")).toBe("X1C");
    expect(normalizeModel("A1 mini")).toBe(normalizeModel("a1-mini"));
    expect(normalizeModel("A1")).not.toBe(normalizeModel("A1 mini"));
  });

  it("normalizes job names", () => {
    expect(normalizeJobName("Bracket Set.gcode.3mf")).toBe("bracket set");
    expect(normalizeJobName(" bracket set ")).toBe("bracket set");
    expect(normalizeJobName("lid.3mf")).toBe("lid");
  });
});
