import assert from "node:assert/strict";
import { test } from "node:test";

import { runWithProgress } from "../src/progress.js";
import { capture } from "./helpers.js";

test("returns the function's result", async () => {
  const out = capture();
  assert.equal(await runWithProgress(() => 42, "working", { stream: out }), 42);
  assert.ok(out.buf.includes("working"));
});

test("propagates errors", async () => {
  const out = capture();
  class Boom extends Error {}
  await assert.rejects(
    runWithProgress(
      () => {
        throw new Boom("nope");
      },
      "working",
      { stream: out },
    ),
    Boom,
  );
});
