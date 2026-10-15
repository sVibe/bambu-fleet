import { Unzip, UnzipInflate } from "fflate";

export type ByteSource = Uint8Array | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/** Receives an entry's decompressed bytes chunk by chunk. */
export interface EntrySink {
  data(chunk: Uint8Array): void;
  end(): void;
}

async function* chunks(source: ByteSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  yield* source as AsyncIterable<Uint8Array>;
}

/**
 * Stream a ZIP archive and hand selected entries to sinks without holding the archive in memory.
 * `pick` returns a sink for entries to read, or null to skip them.
 */
export async function walkZip(source: ByteSource, pick: (name: string) => EntrySink | null): Promise<void> {
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    const sink = pick(file.name);
    if (!sink) return;
    file.ondata = (err, data, final) => {
      if (err) {
        failure ??= err;
        return;
      }
      if (data.length) sink.data(data);
      if (final) sink.end();
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  for await (const chunk of chunks(source)) {
    unzip.push(chunk);
    if (failure) throw failure;
  }
  unzip.push(new Uint8Array(0), true);
  if (failure) throw failure;
}

/** Sink that buffers a whole (small) entry. */
export function collect(onDone: (bytes: Uint8Array) => void): EntrySink {
  const parts: Uint8Array[] = [];
  return {
    data: (chunk) => parts.push(chunk.slice()),
    end: () => {
      const size = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(size);
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
      }
      onDone(out);
    },
  };
}
