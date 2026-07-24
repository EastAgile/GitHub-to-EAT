import assert from "node:assert/strict";
import { test } from "node:test";

import { formatImportStatus, makeImportReporter, runWithProgress } from "../src/progress.js";
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

test("formatImportStatus renders a short line per phase", () => {
  assert.equal(formatImportStatus({ status: "pending" }), "queued");
  assert.equal(
    formatImportStatus({ status: "fetching", progress_current: 2, progress_total: 5 }),
    "fetching 2/5",
  );
  assert.equal(formatImportStatus({ status: "fetching", progress_total: null }), "fetching");
  assert.equal(
    formatImportStatus({ status: "writing", progress_current: 5, progress_total: 5 }),
    "writing 5/5",
  );
  assert.equal(formatImportStatus({ status: "writing" }), "writing");
  assert.equal(formatImportStatus({ status: "done" }), "done");
  assert.equal(formatImportStatus({ status: "failed" }), "failed");
  assert.equal(formatImportStatus({ status: "weird" }), "weird");
});

test("formatImportStatus treats a null current as 0 only with a total", () => {
  assert.equal(
    formatImportStatus({ status: "fetching", progress_current: null, progress_total: 4 }),
    "fetching 0/4",
  );
});

test("makeImportReporter on a TTY overwrites one line and pads the shorter", () => {
  const out = ttyCapture();
  const report = makeImportReporter({ stream: out });
  report({ status: "fetching", progress_current: 1, progress_total: 10 }); // "fetching 1/10"
  report({ status: "done" }); // "done" — shorter, must clear the tail
  report.close();
  assert.ok(out.buf.startsWith("\rfetching 1/10"));
  assert.ok(out.buf.includes("\rdone"));
  assert.ok(/\rdone {9}/.test(out.buf), JSON.stringify(out.buf)); // padded to clear "fetching 1/10"
  assert.ok(out.buf.endsWith("\n")); // close writes a trailing newline
});

test("makeImportReporter close writes no newline when nothing was drawn", () => {
  const out = ttyCapture();
  const report = makeImportReporter({ stream: out });
  report.close();
  assert.equal(out.buf, "");
});

test("makeImportReporter on a non-TTY prints one line per change and dedups", () => {
  const out = capture();
  const report = makeImportReporter({ stream: out });
  report({ status: "fetching", progress_current: 1, progress_total: 3 });
  report({ status: "fetching", progress_current: 1, progress_total: 3 }); // unchanged: no spam
  report({ status: "fetching", progress_current: 2, progress_total: 3 });
  report({ status: "done" });
  report.close();
  assert.equal(out.buf, "fetching 1/3\nfetching 2/3\ndone\n");
});
