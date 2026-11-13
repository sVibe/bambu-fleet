import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeThreeMf } from "@fleet/threemf";
import { ulid } from "ulidx";
import { Agent } from "./agent.ts";
import { HttpCloudSender } from "./cloud.ts";
import { AGENT_VERSION, type AgentConfig, loadConfig } from "./config.ts";
import { FtpsFetcher } from "./fetchers/ftps.ts";
import { LocalDirFetcher } from "./fetchers/localDir.ts";
import { errorMessage, log, logToFile } from "./log.ts";
import { normalizeReport } from "./report.ts";
import { LocalMqttSource } from "./sources/localMqtt.ts";
import { ReplaySource } from "./sources/replay.ts";
import { AgentStore } from "./store.ts";

const USAGE = `bambu-fleet-agent ${AGENT_VERSION}

Usage:
  agent run     [--config agent.yaml] [--log-file <path>]
                                                      Follow printers and forward to the dashboard
  agent probe   [--config agent.yaml]                 Check MQTT and FTPS access for each printer
  agent record  --serial <sn> --out <file.jsonl> [--minutes 60] [--config agent.yaml]
                                                      Record raw MQTT reports for replay/fixtures
  agent replay  <session.jsonl> [--files <dir>] [--speed 1] (--config agent.yaml | --cloud <url> --key <key>)
                                                      Replay a recorded session into the dashboard
  agent analyze <file.gcode.3mf>                      Print filament and per-part usage of a 3MF
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: process.env.AGENT_CONFIG ?? "agent.yaml" },
    serial: { type: "string" },
    out: { type: "string" },
    minutes: { type: "string", default: "60" },
    files: { type: "string" },
    speed: { type: "string", default: "1" },
    cloud: { type: "string" },
    key: { type: "string" },
    "log-file": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const command = positionals[0] ?? "run";

const logFile = values["log-file"] ?? process.env.AGENT_LOG_FILE;
if (logFile) {
  logToFile(resolve(logFile));
  // Without a console, crashes would vanish: record them before exiting as Node would.
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: errorMessage(err), stack: err.stack });
    process.exit(1);
  });
}

function config(): AgentConfig {
  const path = resolve(values.config as string);
  if (!existsSync(path)) {
    throw new Error(`Config not found: ${path}. Copy agent.example.yaml to agent.yaml and fill it in.`);
  }
  return loadConfig(path);
}

function onShutdown(fn: () => Promise<void>): void {
  const handler = () => {
    log.info("shutting down");
    fn().finally(() => process.exit(0));
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}

async function run(): Promise<void> {
  const cfg = config();
  if (cfg.printers.length === 0) throw new Error("No printers configured");
  const store = new AgentStore(cfg.dataDir);
  const agent = new Agent({
    printers: cfg.printers.map((p) => ({ serial: p.serial, name: p.name, model: p.model ?? null })),
    source: new LocalMqttSource(cfg.printers, cfg.mqtt.pushallIntervalSec * 1000, log),
    fetcher: cfg.ftps.enabled ? new FtpsFetcher(cfg.printers, cfg.ftps.searchDirs, cfg.dataDir, log) : null,
    store,
    sender: new HttpCloudSender(cfg.cloud),
    log,
    newId: ulid,
    liveIntervalMs: cfg.liveIntervalSec * 1000,
  });
  agent.start();
  log.info("agent started", { version: AGENT_VERSION, printers: cfg.printers.length, cloud: cfg.cloud.url });
  onShutdown(async () => {
    await agent.stop();
    store.close();
  });
}

async function replay(): Promise<void> {
  const file = positionals[1];
  if (!file) throw new Error("replay needs a session file");
  const cloud =
    values.cloud && values.key
      ? { url: values.cloud as string, agentKey: values.key as string }
      : config().cloud;
  const source = ReplaySource.fromFile(resolve(file), Number(values.speed));
  const store = new AgentStore(":memory:");
  const agent = new Agent({
    printers: source.printers,
    source,
    fetcher: values.files ? new LocalDirFetcher(resolve(values.files as string)) : null,
    store,
    sender: new HttpCloudSender(cloud),
    log,
    newId: ulid,
    liveIntervalMs: 1000,
    analysisDelayMs: 0,
  });
  agent.start();
  log.info("replaying", { file, printers: source.printers.length, speed: values.speed, cloud: cloud.url });
  await source.done;
  // Let the loops deliver the tail of the session.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await agent.runAnalyses();
    await agent.flushOutbox();
    await agent.flushLive();
    if (store.pendingCount() === 0 && store.dueAnalyses(Date.now(), 1).length === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await agent.stop();
  log.info("replay finished", { undelivered: store.pendingCount() });
  process.exit(store.pendingCount() === 0 ? 0 : 1);
}

async function record(): Promise<void> {
  const cfg = config();
  const printer = cfg.printers.find((p) => p.serial === values.serial);
  if (!printer || !values.out) throw new Error("record needs --serial <configured serial> and --out <file>");
  const out = createWriteStream(resolve(values.out as string), { flags: "a" });
  const started = Date.now();
  out.write(
    `${JSON.stringify({ printer: { serial: printer.serial, name: printer.name, model: printer.model ?? null } })}\n`,
  );
  const source = new LocalMqttSource([printer], 60_000, log);
  let count = 0;
  source.start({
    onReport: (serial, payload, at) => {
      out.write(`${JSON.stringify({ t: at - started, serial, payload })}\n`);
      if (++count % 50 === 0) log.info("recorded", { messages: count });
    },
    onConnection: (serial, connected, at) =>
      out.write(`${JSON.stringify({ t: at - started, serial, connected })}\n`),
  });
  const stop = async () => {
    await source.stop();
    out.end();
    log.info("recording saved", { file: values.out, messages: count });
  };
  onShutdown(stop);
  setTimeout(() => void stop().then(() => process.exit(0)), Number(values.minutes) * 60_000);
}

async function probe(): Promise<void> {
  const cfg = config();
  const ftps = new FtpsFetcher(cfg.printers, cfg.ftps.searchDirs, cfg.dataDir, log);
  for (const printer of cfg.printers) {
    console.log(`\n== ${printer.name} (${printer.serial}) at ${printer.host}`);
    const source = new LocalMqttSource([printer], 60_000, log);
    const first = await new Promise<Record<string, unknown> | null>((done) => {
      const timeout = setTimeout(() => done(null), 15_000);
      source.start({
        onReport: (_s, payload) => {
          const print = payload.print as Record<string, unknown> | undefined;
          if (print?.gcode_state !== undefined) {
            clearTimeout(timeout);
            done(print);
          }
        },
        onConnection: () => {},
      });
    });
    await source.stop();
    if (first) {
      const s = normalizeReport(printer.serial, first, true, Date.now());
      console.log(`MQTT  ok: state=${s.gcodeState} job=${s.jobName ?? "-"} ams_units=${s.ams.length}`);
    } else {
      console.log("MQTT  FAILED: no status report within 15 s (check IP, access code, port 8883)");
    }
    try {
      for (const entry of await ftps.probe(printer.serial)) {
        if ("error" in entry) console.log(`FTPS  ${entry.dir}: ${entry.error}`);
        else {
          const threeMf = entry.files.filter((f) => /\.3mf$/i.test(f));
          console.log(
            `FTPS  ${entry.dir}: ${entry.files.length} files, ${threeMf.length} .3mf ${threeMf.slice(0, 5).join(", ")}`,
          );
        }
      }
    } catch (err) {
      console.log(`FTPS  FAILED: ${errorMessage(err)} (needs SD card/USB storage, port 990)`);
    }
  }
}

async function analyze(): Promise<void> {
  const file = positionals[1];
  if (!file) throw new Error("analyze needs a .3mf file");
  const plates = await analyzeThreeMf(createReadStream(resolve(file)) as AsyncIterable<Uint8Array>, {
    fileName: file,
    thumbnails: false,
  });
  console.log(JSON.stringify(plates, null, 2));
}

const commands: Record<string, () => Promise<void>> = { run, replay, record, probe, analyze };

if (values.help || !commands[command]) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

commands[command]?.().catch((err) => {
  log.error("fatal", { error: errorMessage(err) });
  process.exit(1);
});
