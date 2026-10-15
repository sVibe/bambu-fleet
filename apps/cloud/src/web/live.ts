import type { PrinterLiveState } from "@fleet/shared";
import { useEffect, useState } from "react";
import type { LiveMessage } from "../api-types.ts";

export type LiveStatus = "connecting" | "live" | "offline";

/** Live printer states pushed over `/api/live`, reconnecting with backoff. */
export function useLiveStates(): { states: Map<string, PrinterLiveState>; status: LiveStatus } {
  const [states, setStates] = useState(() => new Map<string, PrinterLiveState>());
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry = 0;
    let closed = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const url = new URL("/api/live", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onopen = () => {
        retry = 0;
        setStatus("live");
        ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("ping"), 25_000);
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data === "pong") return;
        const message = JSON.parse(event.data) as LiveMessage;
        setStates((prev) => {
          const next = message.type === "snapshot" ? new Map<string, PrinterLiveState>() : new Map(prev);
          for (const s of message.states) next.set(s.serial, s);
          return next;
        });
      };
      socket.onclose = () => {
        clearInterval(ping);
        if (closed) return;
        setStatus("offline");
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, 1000 * 2 ** retry);
      };
    };
    connect();
    return () => {
      closed = true;
      clearInterval(ping);
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { states, status };
}

/** Re-render periodically so relative times and staleness stay current. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
