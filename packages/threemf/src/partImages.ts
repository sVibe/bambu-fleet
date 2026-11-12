// biome-ignore-all lint/style/noNonNullAssertion: pixel and byte indices stay inside the typed arrays by construction.
import { decodePng, encodePng } from "./png.ts";

/** Transparent margin around each cut-out, in pixels. */
const PAD = 2;

/**
 * Cut single objects out of a plate's top-down render. Bambu Studio writes `top_N.png` (the plate
 * seen from above) and `pick_N.png` (the same view with each object filled in a flat colour that
 * encodes its `identify_id` as r + g·256 + b·65536). Each requested object is cropped to its own
 * pixels, with everything else made transparent.
 */
export function cutOutParts(topPng: Uint8Array, pickPng: Uint8Array, ids: string[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const top = decodePng(topPng);
  const pick = decodePng(pickPng);
  if (!top || !pick || top.width !== pick.width || top.height !== pick.height) return out;
  const { width, height } = pick;

  const wanted = new Set(ids.map(Number).filter(Number.isInteger));
  const owner = new Int32Array(width * height).fill(-1);
  const boxes = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < width * height; i++) {
    if (pick.data[i * 4 + 3] !== 255) continue;
    const id = pick.data[i * 4]! | (pick.data[i * 4 + 1]! << 8) | (pick.data[i * 4 + 2]! << 16);
    owner[i] = id;
    if (!wanted.has(id)) continue;
    const x = i % width;
    const y = (i - x) / width;
    const b = boxes.get(id);
    if (!b) boxes.set(id, [x, y, x, y]);
    else {
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], y);
    }
  }

  // Keep the object's pixels plus the anti-aliased rim just outside them, never a neighbour's.
  const keeps = (id: number, x: number, y: number) => {
    const own = owner[y * width + x];
    if (own === id) return true;
    if (own !== -1) return false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && owner[ny * width + nx] === id) return true;
      }
    }
    return false;
  };

  for (const [id, [x0, y0, x1, y1]] of boxes) {
    const left = Math.max(0, x0 - PAD);
    const topY = Math.max(0, y0 - PAD);
    const w = Math.min(width - 1, x1 + PAD) - left + 1;
    const h = Math.min(height - 1, y1 + PAD) - topY + 1;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!keeps(id, left + x, topY + y)) continue;
        const src = ((topY + y) * width + left + x) * 4;
        data.set(top.data.subarray(src, src + 4), (y * w + x) * 4);
      }
    }
    out.set(String(id), encodePng({ width: w, height: h, data }));
  }
  return out;
}
