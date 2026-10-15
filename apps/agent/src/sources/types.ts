export interface SourceHandlers {
  /** A decoded MQTT report payload (`{ print: {...} }`) from one printer. */
  onReport(serial: string, payload: Record<string, unknown>, at: number): void;
  onConnection(serial: string, connected: boolean, at: number): void;
}

/**
 * Where printer state comes from. Today: the printer's own local MQTT (read-only, allowed while
 * the printer stays on Bambu Cloud). Later: a Fleet Hub `/v1/hub/devices` poller can implement this too.
 */
export interface PrinterSource {
  start(handlers: SourceHandlers): void;
  stop(): Promise<void>;
}
