import type { IngestBatch, IngestEvent, PrinterLiveState } from "@fleet/shared";
import { AGENT_VERSION } from "./config.ts";
import { errorMessage } from "./log.ts";

export type SendResult = { ok: true } | { ok: false; status: number; error: string };

export interface CloudSender {
  sendEvents(events: IngestEvent[]): Promise<SendResult>;
  sendStates(states: PrinterLiveState[]): Promise<SendResult>;
}

export interface CloudOptions {
  url: string;
  agentKey: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

/** Posts to the dashboard's `/ingest` API with the agent key (and an Access service token if set). */
export class HttpCloudSender implements CloudSender {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(options: CloudOptions) {
    this.base = options.url.replace(/\/$/, "");
    this.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${options.agentKey}`,
      "user-agent": `bambu-fleet-agent/${AGENT_VERSION}`,
    };
    if (options.accessClientId && options.accessClientSecret) {
      this.headers["cf-access-client-id"] = options.accessClientId;
      this.headers["cf-access-client-secret"] = options.accessClientSecret;
    }
  }

  sendEvents(events: IngestEvent[]): Promise<SendResult> {
    const body: IngestBatch = { agentVersion: AGENT_VERSION, events };
    return this.post("/ingest/events", body);
  }

  sendStates(states: PrinterLiveState[]): Promise<SendResult> {
    return this.post("/ingest/state", { states });
  }

  private async post(path: string, body: unknown): Promise<SendResult> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
        redirect: "manual",
      });
      if (res.ok) return { ok: true };
      // A redirect usually means Cloudflare Access is asking for a login: missing service token.
      const text =
        res.status >= 300 && res.status < 400 ? "redirected (check Access service token)" : await res.text();
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    } catch (err) {
      return { ok: false, status: 0, error: errorMessage(err) };
    }
  }
}
