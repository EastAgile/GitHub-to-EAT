/** Shared test utilities (not picked up as a test file by the runner). */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A writable sink that records everything written to it.
 *
 * @returns {{ buf: string, isTTY: boolean, write(chunk: string): boolean }}
 */
export function capture() {
  return {
    buf: "",
    isTTY: false,
    write(chunk) {
      this.buf += chunk;
      return true;
    },
  };
}

/**
 * Run `fn` with the working directory set to a fresh temp dir; restore after.
 *
 * @template T
 * @param {(dir: string) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function inTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gh2eat-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(prev);
  }
}

/**
 * Run `fn` with env vars overridden (undefined deletes); restore after.
 *
 * @template T
 * @param {Record<string, string | undefined>} overrides
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withEnv(overrides, fn) {
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
