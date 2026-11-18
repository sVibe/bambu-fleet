import type { Env } from "./env.ts";

/**
 * Minimal client for PrintNode's REST API (https://www.printnode.com/en/docs/api/curl). Requests use
 * HTTP Basic auth with the API key as the user name and no password.
 */
const API = "https://api.printnode.com";

export class PrintNodeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PrintNodeComputer {
  id: number;
  name: string;
  hostname?: string | null;
  state?: string | null;
}

export interface PrintNodeCapabilities {
  /** Paper name → [width, height] in tenths of a millimetre; null when the driver doesn't say. */
  papers?: Record<string, [number | null, number | null]>;
  dpis?: string[];
  [key: string]: unknown;
}

export interface PrintNodePrinter {
  id: number;
  computer: PrintNodeComputer;
  name: string;
  description?: string | null;
  capabilities?: PrintNodeCapabilities | null;
  default?: boolean;
  state?: string | null;
}

export interface PrintNodeAccount {
  id: number;
  email: string;
  firstname?: string;
  lastname?: string;
  credits?: number | null;
  numComputers?: number;
  totalPrints?: number;
}

export interface PrintNodeState {
  printJobId: number;
  state: string;
  message: string | null;
  createTimestamp: string;
}

export interface PrintNodeWebhook {
  webhookId: number;
  url: string;
  messages: string[];
  counts?: {
    droppedEvents: number;
    failedRequests: number;
    receivedEvents: number;
    successfulRequests: number;
  };
}

export interface NewPrintJob {
  printerId: number;
  title: string;
  /** A PDF goes through the printer's driver; raw data (such as ZPL) goes to the printer as is. */
  document: { type: "pdf" | "raw"; bytes: Uint8Array };
  /** Times the document is sent to the printer; works without driver support for copies. */
  qty: number;
  /** fit_to_page false prints at the PDF's own size instead of scaling it to the driver's paper. */
  options?: { paper?: string; rotate?: number; fit_to_page?: boolean };
  /** Seconds PrintNode keeps the job when the computer is offline before giving up. */
  expireAfter: number;
  /** PrintNode refuses a second job with the same key for 24 hours. */
  idempotencyKey: string;
}

export function base64(bytes: Uint8Array): string {
  let s = "";
  // Chunks keep String.fromCharCode under the argument-count limit.
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export type PrintNode = ReturnType<typeof printNodeClient>;

export function printNodeClient(apiKey: string, fetcher: typeof fetch = fetch) {
  async function request<T>(method: string, path: string, body?: unknown, headers?: HeadersInit): Promise<T> {
    const h = new Headers(headers);
    h.set("authorization", `Basic ${btoa(`${apiKey}:`)}`);
    if (body !== undefined) h.set("content-type", "application/json");
    let res: Response;
    try {
      res = await fetcher(`${API}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new PrintNodeError(0, "PrintNode didn't answer");
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new PrintNodeError(502, "PrintNode sent an unreadable answer");
    }
    if (!res.ok) {
      const message = (parsed as { message?: string } | null)?.message;
      throw new PrintNodeError(
        res.status,
        res.status === 401
          ? "PrintNode rejected the API key"
          : res.status === 429
            ? "PrintNode is busy (too many requests); try again in a moment"
            : (message ?? `PrintNode error ${res.status}`),
      );
    }
    return parsed as T;
  }

  return {
    whoami: () => request<PrintNodeAccount>("GET", "/whoami"),
    printers: () => request<PrintNodePrinter[]>("GET", "/printers"),
    /** Returns PrintNode's id for the new job. */
    createJob: (job: NewPrintJob) =>
      request<number>(
        "POST",
        "/printjobs",
        {
          printerId: job.printerId,
          title: job.title,
          contentType: job.document.type === "pdf" ? "pdf_base64" : "raw_base64",
          content: base64(job.document.bytes),
          source: "Bambu Fleet",
          qty: job.qty,
          // PrintNode ignores options for raw jobs.
          ...(job.document.type === "pdf" ? { options: job.options } : {}),
          expireAfter: job.expireAfter,
        },
        { "x-idempotency-key": job.idempotencyKey },
      ),
    /**
     * Every state the jobs have been through. PrintNode groups them in one array per job; the docs
     * describe a flat list, so both are accepted.
     */
    states: async (ids: number[]) =>
      (
        await request<(PrintNodeState | PrintNodeState[])[] | null>(
          "GET",
          `/printjobs/${ids.join(",")}/states`,
        )
      )?.flat() ?? [],
    webhooks: () => request<PrintNodeWebhook[]>("GET", "/webhooks"),
    createWebhook: (url: string, secret: string) =>
      request<PrintNodeWebhook[]>("POST", "/webhook", { url, secret, messages: ["*"] }),
    deleteWebhook: (id: number) => request<unknown>("DELETE", `/webhook/${id}`),
  };
}

export function printNodeFor(env: Env): PrintNode | null {
  return env.PRINTNODE_API_KEY ? printNodeClient(env.PRINTNODE_API_KEY) : null;
}
