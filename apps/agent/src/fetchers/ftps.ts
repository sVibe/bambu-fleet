import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client, type FileInfo } from "basic-ftp";
import type { PrinterConfig } from "../config.ts";
import { errorMessage, type Logger } from "../log.ts";
import type { AnalysisRequest } from "../store.ts";
import { type FetchedFile, type JobFileFetcher, md5File, sameJobName } from "./types.ts";

interface Candidate {
  dir: string;
  info: FileInfo;
  modifiedAt: number | null;
}

/** How far around the job start a 3MF's modification time may be to count as the job's file. */
const MATCH_WINDOW_MS = 30 * 60 * 1000;

/**
 * Downloads the job's `.gcode.3mf` from the printer's storage over implicit FTPS (port 990).
 * Works while the printer stays on Bambu Cloud, provided an SD card/USB stick is inserted and
 * "store sent files on external storage" is enabled on newer firmware.
 */
export class FtpsFetcher implements JobFileFetcher {
  private readonly printers: Map<string, PrinterConfig>;
  private readonly searchDirs: string[];
  private readonly tmpDir: string;
  private readonly log: Logger;

  constructor(printers: PrinterConfig[], searchDirs: string[], dataDir: string, log: Logger) {
    this.printers = new Map(printers.map((p) => [p.serial, p]));
    this.searchDirs = searchDirs;
    this.tmpDir = join(dataDir, "tmp");
    this.log = log;
  }

  async fetch(request: AnalysisRequest): Promise<FetchedFile | null> {
    const printer = this.printers.get(request.serial);
    if (!printer) return null;
    const client = await connect(printer);
    try {
      const candidates = await listCandidates(client, this.searchDirs);
      const chosen = chooseFile(candidates, request);
      if (!chosen) {
        this.log.info("ftps: no matching 3mf yet", {
          serial: request.serial,
          job: request.name,
          seen: candidates.length,
        });
        return null;
      }
      mkdirSync(this.tmpDir, { recursive: true });
      const local = join(this.tmpDir, `${request.jobId}.3mf`);
      const remote = `${chosen.dir.replace(/\/$/, "")}/${chosen.info.name}`;
      await client.downloadTo(local, remote);
      return {
        path: local,
        fileName: chosen.info.name,
        md5: await md5File(local),
        cleanup: () => rm(local, { force: true }),
      };
    } finally {
      client.close();
    }
  }

  /** Connection check and file listing per directory, for `agent probe`. */
  async probe(
    serial: string,
  ): Promise<Array<{ dir: string; files: string[] } | { dir: string; error: string }>> {
    const printer = this.printers.get(serial);
    if (!printer) throw new Error(`unknown printer ${serial}`);
    const client = await connect(printer);
    try {
      const out: Array<{ dir: string; files: string[] } | { dir: string; error: string }> = [];
      for (const dir of this.searchDirs) {
        try {
          const list = await client.list(dir);
          out.push({ dir, files: list.filter((f) => f.isFile).map((f) => f.name) });
        } catch (err) {
          out.push({ dir, error: errorMessage(err) });
        }
      }
      return out;
    } finally {
      client.close();
    }
  }
}

async function connect(printer: PrinterConfig): Promise<Client> {
  const client = new Client(30_000);
  await client.access({
    host: printer.host,
    port: 990,
    user: "bblp",
    password: printer.accessCode,
    secure: "implicit",
    // The printer's certificate is issued by Bambu's private CA.
    secureOptions: { rejectUnauthorized: false },
  });
  return client;
}

async function listCandidates(client: Client, dirs: string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const dir of dirs) {
    let list: FileInfo[];
    try {
      list = await client.list(dir);
    } catch {
      continue; // directory doesn't exist on this model
    }
    for (const info of list) {
      if (!info.isFile || !/\.3mf$/i.test(info.name)) continue;
      out.push({ dir, info, modifiedAt: info.modifiedAt?.getTime() ?? null });
    }
  }
  return out;
}

/** Prefer an exact name match (newest first); else the newest 3MF written around the job start. */
export function chooseFile(candidates: Candidate[], request: AnalysisRequest): Candidate | null {
  const newestFirst = [...candidates].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  const gcodeBase = request.gcodeFile?.split("/").pop() ?? "";
  const byName = newestFirst.find(
    (c) =>
      sameJobName(c.info.name, request.name) || (gcodeBase.endsWith(".3mf") && c.info.name === gcodeBase),
  );
  if (byName) return byName;
  return (
    newestFirst.find(
      (c) => c.modifiedAt !== null && Math.abs(c.modifiedAt - request.startedAt) <= MATCH_WINDOW_MS,
    ) ?? null
  );
}
