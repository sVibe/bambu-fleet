import { type JobAnalysis, Md5 } from "@fleet/shared";
import { analyzeThreeMf } from "@fleet/threemf";

/**
 * Parses a `.gcode.3mf` off the main thread: one streaming pass computes the MD5 the file is stored
 * under and the per-plate analysis (filaments, parts, grams), so large files don't freeze the page.
 */

export type AnalyzeMessage =
  | { type: "progress"; bytes: number }
  | { type: "done"; md5: string; plates: JobAnalysis[] }
  | { type: "error"; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<File>) => void) | null;
  postMessage(message: AnalyzeMessage): void;
};

scope.onmessage = async (event) => {
  const file = event.data;
  const md5 = new Md5();
  let bytes = 0;
  let reported = 0;
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      md5.update(chunk);
      bytes += chunk.length;
      if (bytes - reported > 4 * 1024 * 1024) {
        reported = bytes;
        scope.postMessage({ type: "progress", bytes });
      }
      controller.enqueue(chunk);
    },
  });
  try {
    const plates = await analyzeThreeMf(file.stream().pipeThrough(tap), {
      fileName: file.name,
      partImages: false,
    });
    scope.postMessage({ type: "done", md5: md5.hex(), plates });
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
