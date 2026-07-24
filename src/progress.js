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

/**
 * A short human line for one async-import status doc, per lifecycle phase.
 *
 * @param {{ status?: string, progress_current?: number | null,
 *   progress_total?: number | null }} status
 * @returns {string}
 */
export function formatImportStatus(status) {
  const total = status.progress_total;
  // A null current only reads as 0 once we know the total (an "X/Y" is coming).
  const current = status.progress_current ?? 0;
  /** @param {string} label */
  const xy = (label) => (total != null ? `${label} ${current}/${total}` : label);
  switch (status.status) {
    case "pending":
      return "queued";
    case "fetching":
      return xy("fetching");
    case "writing":
      return xy("writing");
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return String(status.status);
  }
}

/**
 * A live progress reporter: an `onProgress(status)` closure with `.close()`.
 *
 * On a TTY it overwrites one line with `\r` (padding to clear the previous,
 * longer line); on a non-TTY it prints a line only when the text changes, so
 * a fast poller does not spam. `.close()` writes a trailing newline on a TTY
 * iff a line was drawn.
 *
 * @param {{ stream?: OutStream }} [options]
 * @returns {((status: any) => void) & { close(): void }}
 */
export function makeImportReporter({ stream } = {}) {
  const out = stream ?? process.stderr;
  let last = "";
  let width = 0;
  let drew = false;
  /** @param {any} status */
  const report = (status) => {
    const text = formatImportStatus(status);
    if (out.isTTY) {
      const pad = " ".repeat(Math.max(0, width - text.length));
      out.write(`\r${text}${pad}`);
      width = text.length;
      drew = true;
    } else if (text !== last) {
      out.write(`${text}\n`);
      drew = true;
    }
    last = text;
  };
  report.close = () => {
    if (out.isTTY && drew) out.write("\n");
  };
  return report;
}
