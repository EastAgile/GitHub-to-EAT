/** A lightweight elapsed-time progress indicator for long, blocking calls. */

const FRAMES = "|/-\\";

/**
 * A minimal writable sink (structural, so tests can pass a collector).
 *
 * @typedef {{ write(chunk: string): unknown, isTTY?: boolean }} OutStream
 */

/**
 * Run `func()` while showing elapsed time; return its result.
 *
 * Animates a spinner only when `stream` is a TTY; otherwise prints a single
 * start line. Any error thrown by `func` propagates to the caller.
 *
 * @template T
 * @param {() => Promise<T> | T} func
 * @param {string} message
 * @param {{ stream?: OutStream, intervalMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function runWithProgress(func, message, { stream, intervalMs = 500 } = {}) {
  const out = stream ?? process.stderr;
  const start = performance.now();

  if (!out.isTTY) {
    out.write(`${message}...\n`);
    return await func();
  }

  let i = 0;
  const draw = () => {
    const elapsed = (performance.now() - start) / 1000;
    out.write(`\r${FRAMES[i % FRAMES.length]} ${message} (${elapsed.toFixed(0)}s) `);
    i += 1;
  };
  draw();
  const timer = setInterval(draw, intervalMs);
  let failed = false;
  try {
    return await func();
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    clearInterval(timer);
    const total = (performance.now() - start) / 1000;
    out.write(`\r${message} — ${failed ? "failed after" : "done in"} ${total.toFixed(0)}s\n`);
  }
}
