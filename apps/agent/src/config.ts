import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const AGENT_VERSION = "0.1.0";

const printerSchema = z.object({
  serial: z.string().min(5),
  name: z.string().min(1),
  /** Printer IP or hostname on the LAN. */
  host: z.string().min(1),
  /** LAN access code shown on the printer screen. Never leaves this machine. */
  accessCode: z.string().min(4),
  model: z.string().optional(),
});
export type PrinterConfig = z.infer<typeof printerSchema>;

const configSchema = z.object({
  cloud: z.object({
    /** Dashboard base URL, e.g. https://fleet.example.com */
    url: z.url(),
    /** Agent key created in the dashboard's Admin → Agents page. */
    agentKey: z.string().min(16),
    /** Optional Cloudflare Access service token, when /ingest is behind Access. */
    accessClientId: z.string().optional(),
    accessClientSecret: z.string().optional(),
  }),
  dataDir: z.string().default("./data"),
  printers: z.array(printerSchema).default([]),
  mqtt: z
    .object({
      /** Minimum interval between full-state requests (`pushall`). P1/A1 printers dislike frequent ones. */
      pushallIntervalSec: z.number().int().min(60).default(300),
    })
    .default({ pushallIntervalSec: 300 }),
  ftps: z
    .object({
      /** Fetch each job's .gcode.3mf from the printer's SD card/USB stick for per-part analysis. */
      enabled: z.boolean().default(true),
      /** Directories searched on the printer's storage. */
      searchDirs: z.array(z.string()).default(["/", "/cache", "/model"]),
    })
    .default({ enabled: true, searchDirs: ["/", "/cache", "/model"] }),
  /** How often live printer state is pushed to the cloud. */
  liveIntervalSec: z.number().min(1).default(3),
});
export type AgentConfig = z.infer<typeof configSchema>;

export function loadConfig(path: string): AgentConfig {
  const text = readFileSync(path, "utf8");
  const parsed = configSchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new Error(`Invalid config ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  config.dataDir = process.env.AGENT_DATA_DIR ?? resolve(path, "..", config.dataDir);
  return config;
}

export function parseConfig(value: unknown): AgentConfig {
  return configSchema.parse(value);
}
