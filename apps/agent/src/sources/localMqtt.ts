import { randomBytes } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import type { PrinterConfig } from "../config.ts";
import { errorMessage, type Logger } from "../log.ts";
import type { PrinterSource, SourceHandlers } from "./types.ts";

/**
 * Subscribes to each printer's local MQTT broker (port 8883, user `bblp`, LAN access code).
 * Only reads `device/<serial>/report` and sends `pushall`, which Bambu's Authorization Control
 * leaves open for printers that stay on Bambu Cloud. Never sends control commands.
 */
export class LocalMqttSource implements PrinterSource {
  private readonly clients = new Map<string, MqttClient>();
  private readonly lastPushall = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private sequence = 1;
  private readonly printers: PrinterConfig[];
  private readonly pushallIntervalMs: number;
  private readonly log: Logger;

  constructor(printers: PrinterConfig[], pushallIntervalMs: number, log: Logger) {
    this.printers = printers;
    this.pushallIntervalMs = pushallIntervalMs;
    this.log = log;
  }

  start(handlers: SourceHandlers): void {
    for (const printer of this.printers) {
      const client = mqtt.connect(`mqtts://${printer.host}:8883`, {
        username: "bblp",
        password: printer.accessCode,
        clientId: `fleet-agent-${randomBytes(4).toString("hex")}`,
        // Printers use certificates from Bambu's private CA with the serial as CN.
        rejectUnauthorized: false,
        protocolVersion: 4,
        keepalive: 30,
        reconnectPeriod: 5000,
        connectTimeout: 15_000,
      });
      this.clients.set(printer.serial, client);

      client.on("connect", () => {
        this.log.info("mqtt connected", { serial: printer.serial, host: printer.host });
        handlers.onConnection(printer.serial, true, Date.now());
        client.subscribe(`device/${printer.serial}/report`, { qos: 0 }, (err) => {
          if (err)
            this.log.warn("mqtt subscribe failed", { serial: printer.serial, error: errorMessage(err) });
        });
        this.pushall(printer.serial, client);
      });
      client.on("message", (_topic, buffer) => {
        let payload: unknown;
        try {
          payload = JSON.parse(buffer.toString("utf8"));
        } catch {
          return;
        }
        if (payload && typeof payload === "object") {
          handlers.onReport(printer.serial, payload as Record<string, unknown>, Date.now());
        }
      });
      client.on("close", () => handlers.onConnection(printer.serial, false, Date.now()));
      client.on("error", (err) => {
        this.log.warn("mqtt error", { serial: printer.serial, error: errorMessage(err) });
      });
    }

    this.timer = setInterval(() => {
      for (const [serial, client] of this.clients) {
        if (client.connected) this.pushall(serial, client);
      }
    }, 60_000);
  }

  /** Ask for a full state report, at most once per interval per printer. */
  private pushall(serial: string, client: MqttClient): void {
    const now = Date.now();
    if (now - (this.lastPushall.get(serial) ?? 0) < this.pushallIntervalMs) return;
    this.lastPushall.set(serial, now);
    const message = {
      pushing: { sequence_id: String(this.sequence++), command: "pushall", version: 1, push_target: 1 },
    };
    client.publish(`device/${serial}/request`, JSON.stringify(message), { qos: 0 });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.clients.values()].map((c) => c.endAsync()));
    this.clients.clear();
  }
}
