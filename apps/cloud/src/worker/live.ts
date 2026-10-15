import { DurableObject } from "cloudflare:workers";
import type { PrinterLiveState } from "@fleet/shared";
import type { LiveMessage } from "../api-types.ts";
import type { Env } from "./env.ts";

/**
 * Single instance ("fleet") holding the latest live state of every printer and fanning updates
 * out to browsers over hibernatable WebSockets. Live state never touches D1.
 */
export class FleetLive extends DurableObject<Env> {
  private states: Map<string, PrinterLiveState> | null = null;

  private async load(): Promise<Map<string, PrinterLiveState>> {
    if (!this.states) {
      const stored = await this.ctx.storage.list<PrinterLiveState>({ prefix: "state:" });
      this.states = new Map([...stored.values()].map((s) => [s.serial, s]));
    }
    return this.states;
  }

  async update(states: PrinterLiveState[]): Promise<void> {
    const map = await this.load();
    const changed: PrinterLiveState[] = [];
    for (const s of states) {
      const prev = map.get(s.serial);
      if (prev && prev.updatedAt > s.updatedAt) continue;
      map.set(s.serial, s);
      changed.push(s);
    }
    if (changed.length === 0) return;
    const entries = changed.map((s) => [`state:${s.serial}`, s] as const);
    // Storage accepts at most 128 keys per put.
    for (let i = 0; i < entries.length; i += 128) {
      await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    }
    this.broadcast({ type: "states", states: changed });
  }

  async snapshot(): Promise<PrinterLiveState[]> {
    return [...(await this.load()).values()];
  }

  async forget(serial: string): Promise<void> {
    (await this.load()).delete(serial);
    await this.ctx.storage.delete(`state:${serial}`);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const message: LiveMessage = { type: "snapshot", states: await this.snapshot() };
    server.send(JSON.stringify(message));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  private broadcast(message: LiveMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // socket went away; the runtime will call webSocketClose
      }
    }
  }
}

export function fleetLive(env: Env) {
  return env.FLEET_LIVE.get(env.FLEET_LIVE.idFromName("fleet"));
}
