/**
 * Incremental MD5 (RFC 1321). Web Crypto has no MD5, but Bambu identifies files by it and R2 can verify
 * an upload against it, so the browser hashes files with this before uploading them.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21, 6, 10, 15, 21,
];

const K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

export class Md5 {
  private readonly state = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476);
  private readonly block = new Uint8Array(64);
  private readonly words = new Int32Array(16);
  private blockLength = 0;
  private totalBytes = 0;

  update(data: Uint8Array): this {
    let offset = 0;
    this.totalBytes += data.length;
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, data.length);
      this.block.set(data.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength < 64) return this;
      this.compress(this.block, 0);
      this.blockLength = 0;
    }
    for (; offset + 64 <= data.length; offset += 64) this.compress(data, offset);
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0);
      this.blockLength = data.length - offset;
    }
    return this;
  }

  /** Lowercase hex digest. The hash cannot be updated afterwards. */
  hex(): string {
    const bits = this.totalBytes * 8;
    const padLength = this.blockLength < 56 ? 56 - this.blockLength : 120 - this.blockLength;
    const tail = new Uint8Array(padLength + 8);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(padLength, bits >>> 0, true);
    view.setUint32(padLength + 4, Math.floor(bits / 2 ** 32), true);
    this.update(tail);
    let out = "";
    for (const word of this.state) {
      for (let i = 0; i < 4; i++) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return out;
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const o = offset + i * 4;
      w[i] =
        (bytes[o] as number) |
        ((bytes[o + 1] as number) << 8) |
        ((bytes[o + 2] as number) << 16) |
        ((bytes[o + 3] as number) << 24);
    }
    let [a, b, c, d] = this.state as unknown as [number, number, number, number];
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const sum = (a + f + (K[i] as number) + (w[g] as number)) | 0;
      const s = S[i] as number;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
    }
    this.state[0] = (this.state[0] as number) + a;
    this.state[1] = (this.state[1] as number) + b;
    this.state[2] = (this.state[2] as number) + c;
    this.state[3] = (this.state[3] as number) + d;
  }
}

export function md5Hex(data: Uint8Array): string {
  return new Md5().update(data).hex();
}
