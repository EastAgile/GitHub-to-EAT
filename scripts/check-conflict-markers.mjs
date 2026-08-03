#!/usr/bin/env node
/**
 * Fail the lint gate on an unresolved merge-conflict marker. `biome check` only
 * parses JS, so a botched resolution in Markdown (CONTRACT.md, the declared
 * source of truth) shipped once with nothing to catch it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Built from repeats so this file can scan itself. `=======` is left out — a Markdown
// setext underline is exactly that, and no real conflict omits the other two markers.
const MARKERS = ["<", ">", "|"].map((c) => c.repeat(7));
const PATTERN = new RegExp(`^(?:${MARKERS.map((m) => m.replace(/\|/g, "\\|")).join("|")})(?: |$)`);

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

/** @type {string[]} */
const hits = [];
for (const file of files) {
  /** @type {Buffer} */
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue; // a directory-typed entry (submodule), or removed since the listing
  }
  if (buf.includes(0)) continue; // binary
  for (const [i, line] of buf.toString("utf8").split("\n").entries()) {
    if (PATTERN.test(line)) hits.push(`${file}:${i + 1}: ${line.slice(0, 80)}`);
  }
}

if (hits.length) {
  process.stderr.write(
    `Found ${hits.length} unresolved merge-conflict marker(s):\n${hits.join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write(`No merge-conflict markers (${files.length} files checked).\n`);
