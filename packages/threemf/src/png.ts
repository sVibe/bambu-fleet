// biome-ignore-all lint/style/noNonNullAssertion: pixel and byte indices stay inside the typed arrays by construction.
import { unzlibSync, zlibSync } from "fflate";

/** 8-bit RGBA pixels, row-major. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

const u32 = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode the PNGs Bambu Studio writes into a 3MF: 8-bit greyscale, RGB or RGBA, non-interlaced.
 * Returns null for anything else rather than guessing.
 */
export function decodePng(png: Uint8Array): Rgba | null {
  if (png.length < 33 || SIGNATURE.some((v, i) => png[i] !== v)) return null;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const len = u32(png, at);
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    const body = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = u32(body, 0);
      height = u32(body, 4);
      channels = CHANNELS[body[9]!] ?? 0;
      if (body[8] !== 8 || body[12] !== 0 || !channels) return null;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (!width || !height || idat.length === 0) return null;

  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of idat) {
    joined.set(c, offset);
    offset += c.length;
  }
  const raw = unzlibSync(joined);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;

  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[dst + x - channels]! : 0;
      const b = y > 0 ? rows[dst - stride + x]! : 0;
      const c = x >= channels && y > 0 ? rows[dst - stride + x - channels]! : 0;
      const v = raw[src + x]!;
      rows[dst + x] =
        filter === 1
          ? v + a
          : filter === 2
            ? v + b
            : filter === 3
              ? v + ((a + b) >> 1)
              : filter === 4
                ? v + paeth(a, b, c)
                : v;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const grey = channels <= 2;
    data[i * 4] = rows[j]!;
    data[i * 4 + 1] = grey ? rows[j]! : rows[j + 1]!;
    data[i * 4 + 2] = grey ? rows[j]! : rows[j + 2]!;
    data[i * 4 + 3] = channels === 4 ? rows[j + 3]! : channels === 2 ? rows[j + 1]! : 255;
  }
  return { width, height, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encode RGBA pixels as a PNG (up filter, which suits flat renders). */
export function encodePng({ width, height, data }: Rgba): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 2;
    for (let x = 0; x < stride; x++) {
      const v = data[y * stride + x]!;
      const up = y > 0 ? data[(y - 1) * stride + x]! : 0;
      raw[y * (stride + 1) + 1 + x] = (v - up) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
