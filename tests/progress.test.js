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

function ttyCapture() {
  const out = capture();
  out.isTTY = true;
  return out;
}

test("the TTY completion line says failed when the wrapped call rejects", async () => {
  const out = ttyCapture();
  class Boom extends Error {}
  await assert.rejects(
    runWithProgress(() => Promise.reject(new Boom("nope")), "working", { stream: out }),
    Boom,
  );
  assert.match(out.buf, /working — failed after \d+s\n/);
  assert.doesNotMatch(out.buf, /done in/);
});

test("the TTY completion line still says done when the wrapped call resolves", async () => {
  const out = ttyCapture();
  assert.equal(await runWithProgress(() => 7, "working", { stream: out }), 7);
  assert.match(out.buf, /working — done in \d+s\n/);
  assert.doesNotMatch(out.buf, /failed after/);
});

test("non-TTY output stays a single start line for both outcomes", async () => {
  const ok = capture();
  await runWithProgress(() => 1, "working", { stream: ok });
  assert.equal(ok.buf, "working...\n");
  const bad = capture();
  await assert.rejects(
    runWithProgress(() => Promise.reject(new Error("x")), "working", { stream: bad }),
  );
  assert.equal(bad.buf, "working...\n");
});
