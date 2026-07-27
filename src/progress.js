/** A lightweight elapsed-time progress indicator for long, blocking calls. */

const FRAMES = "|/-\\";
const BAR_CELLS = 16;
const TICK_MS = 120;

/**
 * A minimal writable sink (structural, so tests can pass a collector).
 *
 * @typedef {{ write(chunk: string): unknown, isTTY?: boolean, columns?: number }} OutStream
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Strip terminal control characters (C0/C1, incl. CR/LF/ESC) and cap length.
 * Server-supplied text is rendered raw to the terminal, and the `\r`-drawn
 * progress line would otherwise let a hostile status/error rewrite the line.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function scrubControl(value, max = 200) {
  return String(value ?? "")
    .replace(CONTROL, "")
    .slice(0, max);
}

const PHASE_LABELS = /** @type {const} */ ({
  pending: "queued",
  fetching: "fetching",
  writing: "writing",
  done: "done",
  failed: "failed",
});

/**
 * Split a status doc into display parts. All numbers are coerced (a non-finite
 * value becomes 0 for current, null for total) and an unknown status is
 * scrubbed — every field is server-supplied and drawn straight to a TTY.
 *
 * @param {{ status?: string, progress_current?: number | null,
 *   progress_total?: number | null }} status
 * @returns {{ status: string, label: string, current: number, total: number | null }}
 */
function phaseParts(status) {
  const totalRaw = status.progress_total == null ? null : Number(status.progress_total);
  const total = totalRaw != null && Number.isFinite(totalRaw) ? totalRaw : null;
  const currentNum = Number(status.progress_current);
  const current = Number.isFinite(currentNum) ? currentNum : 0;
  const s = String(status.status);
  const label = Object.hasOwn(PHASE_LABELS, s)
    ? /** @type {Record<string, string>} */ (PHASE_LABELS)[s]
    : scrubControl(status.status, 40);
  return { status: s, label, current, total };
}

/**
 * A short human line for one async-import status doc, per lifecycle phase.
 * Only the count-bearing phases (fetching/writing) show the `X/Y`.
 *
 * @param {{ status?: string, progress_current?: number | null,
 *   progress_total?: number | null }} status
 * @returns {string}
 */
export function formatImportStatus(status) {
  const { status: s, label, current, total } = phaseParts(status);
  const showXY = (s === "fetching" || s === "writing") && total != null;
  return showXY ? `${label} ${current}/${total}` : label;
}

/**
 * A fixed-width `[███░░░]` bar; `current` is clamped into `[0, total]`.
 *
 * @param {number} current
 * @param {number} total
 * @param {number} cells
 * @returns {string}
 */
function renderBar(current, total, cells) {
  const ratio = total > 0 ? current / total : 0;
  const filled = Math.max(0, Math.min(cells, Math.round(ratio * cells)));
  return `[${"█".repeat(filled)}${"░".repeat(cells - filled)}]`;
}

/**
 * The animated TTY line for one status: a spinner + phase, a per-phase bar and
 * `X/Y` when the phase exposes counts, and elapsed seconds. Terminal phases
 * (done/failed) drop the spinner so the line reads as finished.
 *
 * @param {any} status
 * @param {string} frame current spinner glyph
 * @param {number} elapsedS
 * @param {number} cells bar width
 * @returns {string}
 */
function renderLiveLine(status, frame, elapsedS, cells) {
  const { status: s, label, current, total } = phaseParts(status);
  const secs = `(${Math.max(0, Math.round(elapsedS))}s)`;
  if (s === "done" || s === "failed") return `${label} ${secs}`;
  const hasBar = (s === "fetching" || s === "writing") && total != null && total > 0;
  if (hasBar) {
    return `${frame} ${label} ${renderBar(current, total, cells)} ${current}/${total} ${secs}`;
  }
  return `${frame} ${label} ${secs}`;
}

/**
 * A live progress reporter: an `onProgress(status)` closure with `.close()`.
 *
 * On a TTY the line is **time-driven**: a spinner (and elapsed clock) advance on
 * their own interval independent of poll cadence, so a long or count-less phase
 * still reads as alive between the backoff-spaced polls. It carries a per-phase
 * bar + `X/Y` when the phase exposes counts, freezes on a terminal status, and
 * overwrites one line with `\r` (padding to clear a longer previous line). On a
 * non-TTY it prints a line only when the text changes — no timer, no spinner —
 * so a pipe/CI log is not spammed. `.close()` stops the timer and writes a
 * trailing newline on a TTY iff a line was drawn.
 *
 * @param {{ stream?: OutStream, now?: () => number,
 *   setInterval?: (fn: () => void, ms?: number) => any,
 *   clearInterval?: (id: any) => void, intervalMs?: number,
 *   frames?: string, barCells?: number }} [options]
 * @returns {((status: any) => void) & { close(): void }}
 */
export function makeImportReporter({
  stream,
  now = () => performance.now(),
  setInterval: startInterval = globalThis.setInterval,
  clearInterval: stopInterval = globalThis.clearInterval,
  intervalMs = TICK_MS,
  frames = FRAMES,
  barCells = BAR_CELLS,
} = {}) {
  const out = stream ?? process.stderr;
  let last = "";
  let width = 0;
  let drew = false;
  let closed = false;
  /** @type {any} */
  let latest = null;
  let start = 0;
  let frame = 0;
  /** @type {any} */
  let timer = null;

  const paint = () => {
    if (latest == null) return;
    let line = renderLiveLine(
      latest,
      frames[frame % frames.length],
      (now() - start) / 1000,
      barCells,
    );
    frame += 1;
    // Cap to the terminal so bar+text never wrap and corrupt the \r redraw.
    const max = typeof out.columns === "number" && out.columns > 0 ? out.columns : Infinity;
    if (line.length > max) line = line.slice(0, max);
    const pad = " ".repeat(Math.max(0, width - line.length));
    out.write(`\r${line}${pad}`);
    width = line.length;
    drew = true;
  };

  const stop = () => {
    if (timer != null) {
      stopInterval(timer);
      timer = null;
    }
  };

  /** @param {any} status */
  const report = (status) => {
    if (!out.isTTY) {
      const text = formatImportStatus(status);
      if (text !== last) {
        out.write(`${text}\n`);
        drew = true;
      }
      last = text;
      return;
    }
    if (latest == null) start = now();
    latest = status;
    paint();
    if (status.status === "done" || status.status === "failed") {
      stop(); // terminal: freeze the glyph, no more ticks
    } else if (timer == null) {
      timer = startInterval(paint, intervalMs);
      if (timer && typeof timer.unref === "function") timer.unref(); // never keep the loop alive
    }
  };
  // Idempotent so a catch can close the line before writing an error, and the
  // finally can call it again without a spurious second newline.
  report.close = () => {
    if (closed) return;
    closed = true;
    stop();
    if (out.isTTY && drew) out.write("\n");
  };
  return report;
}
