/**
 * End-to-end test against a real East Agile Tracker.
 *
 * Opt-in and skipped by default. It exercises the full CLI against a live EAT
 * project, so it needs configuration the normal suite does not have — point it
 * at a disposable project.
 *
 * Configure via environment to enable:
 *
 *     EAT_AGENT_KEY     owner-role agent key for the project
 *     EAT_E2E_PROJECT   id of a disposable EAT project to import into
 *     EAT_E2E_REPO      public GitHub repo as OWNER/NAME
 *     EAT_API_BASE      (optional) override the API base URL
 *
 * Run just this test with:  node --test tests/e2e.test.js
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { main } from "../src/cli.js";
import { capture } from "./helpers.js";

const REQUIRED = ["EAT_AGENT_KEY", "EAT_E2E_PROJECT", "EAT_E2E_REPO"];
const missing = REQUIRED.filter((name) => !process.env[name]);

test("import against a real EAT", {
  skip: missing.length ? `e2e not configured (missing ${missing.join(", ")})` : false,
}, async () => {
  const project = process.env.EAT_E2E_PROJECT ?? "";
  const repo = process.env.EAT_E2E_REPO ?? "";
  const out = capture();

  const started = performance.now();
  const code = await main(["--project", project, "--repo", repo], {
    stdout: out,
    stderr: capture(),
  });
  const elapsed = (performance.now() - started) / 1000;

  // Surfaces how long a real synchronous import takes — input for the v2
  // async-import decision.
  console.log(`[e2e] import of ${repo} took ${elapsed.toFixed(1)}s`);

  assert.equal(code, 0, out.buf);
  assert.ok(out.buf.includes("Imported"));
  assert.ok(out.buf.includes("Board:"));
});
