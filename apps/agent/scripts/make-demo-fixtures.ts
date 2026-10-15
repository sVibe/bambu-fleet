import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDemoSession } from "../src/demo.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "demo");
const { session, files } = buildDemoSession();
mkdirSync(join(root, "files"), { recursive: true });
writeFileSync(join(root, "session.jsonl"), session);
for (const [name, bytes] of Object.entries(files)) writeFileSync(join(root, "files", name), bytes);
console.log(`Wrote demo session and ${Object.keys(files).length} files to ${root}`);
