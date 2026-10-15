/** Key for extrusion outside any object label: purge, prime tower, skirt, wipe. */
export const NON_OBJECT = "";

/** Filament index used before the G-code selects one with `T<n>`; resolved later. */
export const INITIAL_FILAMENT = -1;

export interface RawAttribution {
  /** Net filament length (mm) per object label, then per 0-based filament index. */
  byObject: Map<string, Map<number, number>>;
  /** Object labels in first-seen order. Klipper-style labels are stored as `name:<NAME>`. */
  labels: string[];
  /** Net filament length (mm) at the end of each layer, all filaments; index 0 = layer 1. */
  layerEnds: number[];
  totalMm: number;
}

const START_OBJECT = "; start printing object, unique label id:";
const STOP_OBJECT = "; stop printing object, unique label id:";
const E_PARAM = /\bE(-?\d*\.?\d+)/;

/**
 * Streaming G-code scanner that sums net extrusion per object label and per filament.
 *
 * Bambu Studio wraps each object's moves (including its supports) in
 * `; start printing object, unique label id: N` / `; stop printing object` comments,
 * selects filaments with `T<n>` and marks layers with `M73 L<n>`.
 */
export class GcodeAttributor {
  private relative = true;
  private lastAbsE = 0;
  private object: string = NON_OBJECT;
  private filament = INITIAL_FILAMENT;
  private carry = "";
  private readonly decoder = new TextDecoder();
  private readonly byObject = new Map<string, Map<number, number>>();
  private readonly labels: string[] = [];
  private readonly layerEnds: number[] = [];
  private layer = 0;
  private sawM73Layer = false;
  private total = 0;

  push(bytes: Uint8Array): void {
    this.pushText(this.decoder.decode(bytes, { stream: true }));
  }

  pushText(text: string): void {
    const data = this.carry + text;
    let start = 0;
    while (true) {
      const nl = data.indexOf("\n", start);
      if (nl === -1) break;
      this.line(data.slice(start, nl));
      start = nl + 1;
    }
    this.carry = data.slice(start);
  }

  finish(): RawAttribution {
    const rest = this.carry + this.decoder.decode();
    this.carry = "";
    if (rest) this.line(rest);
    if (this.layer > 0 || this.total > 0) this.markLayer(Math.max(this.layer, this.layerEnds.length) + 1);
    return { byObject: this.byObject, labels: this.labels, layerEnds: this.layerEnds, totalMm: this.total };
  }

  private line(raw: string): void {
    const line = raw.trimStart();
    const first = line.charCodeAt(0);
    if (first === 59 /* ; */) {
      this.comment(line);
      return;
    }
    const code = stripComment(line);
    if (first === 71 /* G */) this.gCommand(code);
    else if (first === 77 /* M */) this.mCommand(code);
    else if (first === 84 /* T */) {
      const n = Number.parseInt(code.slice(1), 10);
      if (Number.isInteger(n) && n >= 0 && n < 64) this.filament = n;
    } else if (first === 69 /* E */) this.klipperLabel(code);
  }

  private comment(line: string): void {
    if (line.startsWith(START_OBJECT)) {
      this.setObject(line.slice(START_OBJECT.length).trim());
    } else if (line.startsWith(STOP_OBJECT)) {
      this.object = NON_OBJECT;
    } else if (!this.sawM73Layer && line.startsWith("; CHANGE_LAYER")) {
      this.markLayer(this.layer + 1);
    }
  }

  private klipperLabel(code: string): void {
    if (code.startsWith("EXCLUDE_OBJECT_START")) {
      const name = /NAME=("?)([^"\s]+)\1/.exec(code)?.[2];
      if (name) this.setObject(`name:${name}`);
    } else if (code.startsWith("EXCLUDE_OBJECT_END")) {
      this.object = NON_OBJECT;
    }
  }

  private setObject(label: string): void {
    this.object = label;
    if (!this.byObject.has(label)) this.labels.push(label);
  }

  private gCommand(code: string): void {
    const c1 = code.charCodeAt(1);
    const c2 = code.charCodeAt(2);
    // G0-G3 followed by a space or end of line.
    if (c1 >= 48 && c1 <= 51 && (Number.isNaN(c2) || c2 === 32)) {
      const m = E_PARAM.exec(code);
      if (!m) return;
      const e = Number.parseFloat(m[1] as string);
      if (!Number.isFinite(e)) return;
      let delta = e;
      if (!this.relative) {
        delta = e - this.lastAbsE;
        this.lastAbsE = e;
      }
      this.add(delta);
    } else if (code.startsWith("G92")) {
      const m = E_PARAM.exec(code);
      if (m) this.lastAbsE = Number.parseFloat(m[1] as string);
    }
  }

  private mCommand(code: string): void {
    if (code.startsWith("M83")) this.relative = true;
    else if (code.startsWith("M82")) this.relative = false;
    else if (code.startsWith("M73")) {
      const m = /\bL(\d+)/.exec(code);
      if (m) {
        this.sawM73Layer = true;
        this.markLayer(Number.parseInt(m[1] as string, 10));
      }
    }
  }

  private add(mm: number): void {
    if (mm === 0) return;
    let perFilament = this.byObject.get(this.object);
    if (!perFilament) {
      perFilament = new Map();
      this.byObject.set(this.object, perFilament);
    }
    perFilament.set(this.filament, (perFilament.get(this.filament) ?? 0) + mm);
    this.total += mm;
  }

  /** Entering layer `n`: everything extruded so far belongs to layers before it. */
  private markLayer(n: number): void {
    if (n <= this.layer && this.layerEnds.length >= n - 1) return;
    while (this.layerEnds.length < n - 1) this.layerEnds.push(this.total);
    this.layer = Math.max(this.layer, n);
  }
}

function stripComment(line: string): string {
  const i = line.indexOf(";");
  return (i === -1 ? line : line.slice(0, i)).trimEnd();
}
