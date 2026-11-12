import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { normalizeJobName } from "@fleet/shared";
import type { AnalysisRequest } from "../store.ts";

export interface FetchedFile {
  path: string;
  fileName: string;
  md5: string;
  /** Remove temporary copies; a no-op for files that were already local. */
  cleanup(): Promise<void>;
}

/** Locates and retrieves the `.gcode.3mf` a job printed. Returns null when it can't be found (yet). */
export interface JobFileFetcher {
  fetch(request: AnalysisRequest): Promise<FetchedFile | null>;
}

export async function md5File(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Same job name, as {@link normalizeJobName} compares them (case, `.gcode.3mf`, trailing dots). */
export function sameJobName(fileName: string, jobName: string | null): boolean {
  if (!jobName) return false;
  return normalizeJobName(fileName) === normalizeJobName(jobName);
}
