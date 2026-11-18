const MODEL_EXTENSIONS = /\.(stl|3mf|step|stp|obj|amf|ply)$/i;
const COPY_SUFFIX = /\s*(\(\d+\)|\scopy(\s\d+)?)$/i;

/**
 * Key used to group object names from different jobs into one catalog part.
 * "Bracket.stl", "bracket (2)" and " Bracket " all map to "bracket".
 */
export function normalizePartName(name: string): string {
  let n = name.trim().replace(MODEL_EXTENSIONS, "").trim();
  n = n.replace(COPY_SUFFIX, "").trim();
  return n.toLowerCase().replace(/\s+/g, " ") || name.trim().toLowerCase();
}

const PART_NUMBER = /(?<!\d)\d{7}(?!\d)/;

/**
 * The part number in a file or object name: the first number of exactly seven digits.
 * "2600076_24_5_260626.stl" → "2600076"; null when the name has none.
 */
export function partNumberFromName(name: string): string | null {
  return PART_NUMBER.exec(name)?.[0] ?? null;
}
