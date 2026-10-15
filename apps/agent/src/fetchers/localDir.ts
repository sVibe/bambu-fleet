import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AnalysisRequest } from "../store.ts";
import { type FetchedFile, type JobFileFetcher, md5File, sameJobName } from "./types.ts";

/** Finds job files in a local directory by job name. Used by replay demos and tests. */
export class LocalDirFetcher implements JobFileFetcher {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async fetch(request: AnalysisRequest): Promise<FetchedFile | null> {
    if (!existsSync(this.dir)) return null;
    const match = readdirSync(this.dir).find((f) => /\.3mf$/i.test(f) && sameJobName(f, request.name));
    if (!match) return null;
    const path = join(this.dir, match);
    return { path, fileName: match, md5: await md5File(path), cleanup: async () => {} };
  }
}
