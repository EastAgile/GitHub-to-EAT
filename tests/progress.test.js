import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatImportStatus,
  makeImportReporter,
  runWithProgress,
  scrubControl,
} from "../src/progress.js";
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

test("scrubControl strips control chars (CR/LF/ESC/TAB) and caps length", () => {
  // Only the control bytes go; the ANSI sequence's printable tail (`[2K`) stays.
  assert.equal(scrubControl("a\rb\nc\x1b[2Kd\te"), "abc[2Kde");
  assert.equal(scrubControl("x".repeat(300)).length, 200);
  assert.equal(scrubControl(null), "");
  assert.equal(scrubControl("hello", 40), "hello");
});

test("formatImportStatus scrubs a hostile unknown status and coerces bad numbers", () => {
  // A status carrying CR/ANSI-ESC/newline must not survive to the \r-drawn line.
  assert.equal(
    formatImportStatus(/** @type {any} */ ({ status: "weird\r\x1b[31mHACKED\nboard: evil" })),
    "weird[31mHACKEDboard: evil",
  );
  // Non-int progress falls back to 0; a non-numeric total hides the X/Y entirely.
  assert.equal(
    formatImportStatus(
      /** @type {any} */ ({ status: "fetching", progress_current: "1;rm -rf", progress_total: 3 }),
    ),
    "fetching 0/3",
  );
  assert.equal(
    formatImportStatus(
      /** @type {any} */ ({ status: "fetching", progress_current: 2, progress_total: "lots" }),
    ),
    "fetching",
  );
});

/**
 * A synchronous stand-in for setInterval/clearInterval so the time-driven TTY
 * animation is deterministic: tests fire ticks by hand and count clears.
 */
function fakeTimers() {
  /** @type {Array<() => void>} */
  const ticks = [];
  let cleared = 0;
  return {
    ticks,
    get cleared() {
      return cleared;
    },
    setInterval: /** @param {() => void} fn */ (fn) => {
      ticks.push(fn);
      return { id: ticks.length, unref() {} };
    },
    clearInterval: () => {
      cleared += 1;
    },
  };
}

test("makeImportReporter animates a TTY line with spinner, bar, X/Y and elapsed", () => {
  const out = ttyCapture();
  const timers = fakeTimers();
  const report = makeImportReporter({
    stream: out,
    now: () => 0,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    frames: "|",
    barCells: 10,
  });
  report({ status: "fetching", progress_current: 3, progress_total: 6 });
  // spinner + per-phase bar (3/6 of 10 cells = 5 filled) + X/Y + elapsed
  assert.ok(out.buf.includes("\r| fetching [█████░░░░░] 3/6 (0s)"), JSON.stringify(out.buf));
});

test("makeImportReporter drops the bar for a phase with no counts", () => {
  const out = ttyCapture();
  const report = makeImportReporter({
    stream: out,
    now: () => 3000,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    frames: "|",
  });
  report({ status: "pending" });
  report({ status: "writing" }); // writing with a null total → spinner + label only
  report.close();
  assert.ok(out.buf.includes("\r| queued (0s)"), JSON.stringify(out.buf));
  assert.ok(out.buf.includes("\r| writing (0s)"));
  assert.ok(!out.buf.includes("["), "no bar when the phase has no total");
});

test("makeImportReporter keeps the spinner moving between polls (liveness)", () => {
  const out = ttyCapture();
  const timers = fakeTimers();
  const report = makeImportReporter({
    stream: out,
    now: () => 0,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    frames: "AB",
  });
  report({ status: "writing" }); // draw #1 → frame 'A'
  timers.ticks[0](); // tick, same status → frame 'B'
  timers.ticks[0](); // tick, same status → frame 'A'
  // The glyph advances with no new status arriving — that is the "still alive" signal.
  assert.ok(out.buf.includes("\rA writing"), JSON.stringify(out.buf));
  assert.ok(out.buf.includes("\rB writing"));
});

test("makeImportReporter counts elapsed seconds from the injected clock", () => {
  const out = ttyCapture();
  let t = 0;
  const timers = fakeTimers();
  const report = makeImportReporter({
    stream: out,
    now: () => t,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    frames: "|",
  });
  report({ status: "writing" }); // (0s)
  t = 5000;
  timers.ticks[0](); // (5s) — clock advanced, still working
  assert.ok(out.buf.includes("writing (0s)"), JSON.stringify(out.buf));
  assert.ok(out.buf.includes("writing (5s)"));
});

test("makeImportReporter freezes and stops the timer on a terminal status", () => {
  const out = ttyCapture();
  const timers = fakeTimers();
  const report = makeImportReporter({
    stream: out,
    now: () => 0,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    frames: "|",
  });
  report({ status: "fetching", progress_current: 1, progress_total: 3 });
  report({ status: "done" });
  assert.equal(timers.ticks.length, 1, "one timer for the whole run, not one per status");
  assert.ok(timers.cleared >= 1, "timer stopped once the job is terminal");
  assert.ok(out.buf.includes("\rdone (0s)"), JSON.stringify(out.buf));
  assert.ok(!/\r\| done/.test(out.buf), "no spinner glyph on a terminal line");
  report.close();
  assert.ok(out.buf.endsWith("\n"));
});

test("makeImportReporter pads a shorter line to clear a longer previous one", () => {
  const out = ttyCapture();
  const report = makeImportReporter({
    stream: out,
    now: () => 0,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    frames: "|",
    barCells: 4,
  });
  report({ status: "fetching", progress_current: 4, progress_total: 4 }); // long line
  report({ status: "done" }); // "done (0s)" — shorter, must clear the tail
  const lastDraw = out.buf.slice(out.buf.lastIndexOf("\rdone"));
  assert.ok(/^\rdone \(0s\) {2,}/.test(lastDraw), JSON.stringify(lastDraw));
});

test("makeImportReporter never starts a timer on a non-TTY stream", () => {
  const out = capture(); // isTTY false
  const timers = fakeTimers();
  const report = makeImportReporter({
    stream: out,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  report({ status: "fetching", progress_current: 1, progress_total: 3 });
  report({ status: "done" });
  report.close();
  assert.equal(timers.ticks.length, 0, "no animation off a TTY");
  assert.equal(out.buf, "fetching 1/3\ndone\n", "byte-identical to the line-per-change behaviour");
});

test("makeImportReporter caps the drawn line to the terminal width", () => {
  const out = Object.assign(ttyCapture(), { columns: 12 });
  const report = makeImportReporter({
    stream: out,
    now: () => 0,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    frames: "|",
    barCells: 20,
  });
  report({ status: "fetching", progress_current: 1, progress_total: 20 });
  for (const seg of out.buf.split("\r").filter(Boolean)) {
    assert.ok(seg.replace(/\n$/, "").length <= 12, JSON.stringify(seg));
  }
});

test("makeImportReporter close writes no newline when nothing was drawn", () => {
  const out = ttyCapture();
  const report = makeImportReporter({ stream: out });
  report.close();
  assert.equal(out.buf, "");
});

test("makeImportReporter close is idempotent (one newline for close-in-catch + finally)", () => {
  const out = ttyCapture();
  const report = makeImportReporter({ stream: out });
  report({ status: "fetching", progress_current: 1, progress_total: 3 });
  report.close();
  report.close(); // second call (e.g. from a finally after a catch) adds nothing
  assert.equal((out.buf.match(/\n/g) ?? []).length, 1);
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
