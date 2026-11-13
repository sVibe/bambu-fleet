import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

/** A log file is rotated to `<file>.1` once it passes this size. */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;

let file: { path: string; size: number; maxBytes: number } | null = null;

/** Send log lines to a file instead of stdout/stderr, for running without a console. */
export function logToFile(path: string, maxBytes = MAX_LOG_BYTES): void {
  mkdirSync(dirname(path), { recursive: true });
  file = { path, size: existsSync(path) ? statSync(path).size : 0, maxBytes };
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = `${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`;
  if (file) {
    try {
      const bytes = Buffer.byteLength(line);
      if (file.size + bytes > file.maxBytes && file.size > 0) {
        renameSync(file.path, `${file.path}.1`);
        file.size = 0;
      }
      appendFileSync(file.path, line);
      file.size += bytes;
      return;
    } catch {
      // Fall through to the console if the file can't be written.
    }
  }
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
export type Logger = typeof log;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
