import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { log, logToFile } from "../src/log.ts";

describe("file logging", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-log-"));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes JSON lines and rotates past the size limit", () => {
    const path = join(dir, "logs", "agent.log");
    logToFile(path, 200);
    log.info("first", { n: 1 });
    log.warn("second", { n: 2 });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["first", "second"]);

    for (let i = 0; i < 5; i++) log.info("filler", { i });
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(path, "utf8").length).toBeLessThanOrEqual(200);
  });
});
