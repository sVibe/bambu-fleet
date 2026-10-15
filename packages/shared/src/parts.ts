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
