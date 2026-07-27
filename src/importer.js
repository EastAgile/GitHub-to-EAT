/** The import flow: call the server import and normalize its result. */

import { EATError, EATTimeout } from "./client.js";
import { scrubControl } from "./progress.js";

/**
 * The subset of the client the importer needs (kept structural for tests).
 *
 * @typedef {object} ImportClient
 * @property {(projectId: number, owner: string, repo: string,
 *   options: { idempotencyKey: string, token?: string,
 *     flags?: Record<string, boolean>, dryRun?: boolean }) => Promise<any>} importGithub
 * @property {(projectId: number, importId: string) => Promise<any>} [getImport]
 *   present on clients that speak the v2 async accept
 */

/**
 * Timing seams for {@link pollImport}, all overridable in tests.
 *
 * @typedef {object} PollOptions
 * @property {(ms: number) => Promise<void>} [sleep] delay between polls
 * @property {number} [baseMs] first backoff delay (default 500)
 * @property {number} [maxMs] backoff ceiling (default 5000)
 * @property {number} [maxWaitMs] give up after this much virtual elapsed (default 900000)
 */

const DEFAULT_POLL = { baseMs: 500, maxMs: 5000, maxWaitMs: 900_000 };

/** @param {number} ms */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll an async import job to a terminal state and return its `result`.
 *
 * Backoff is capped-exponential; elapsed time is tracked **virtually** as the
 * sum of slept delays, so an injected fake `sleep` stays deterministic.
 *
 * @param {ImportClient} client
 * @param {number} projectId
 * @param {string} importId
 * @param {{ onProgress?: (status: any) => void, poll?: PollOptions }} [options]
 * @returns {Promise<any>} the terminal `result` (the sync ImportResult body)
 */
export async function pollImport(client, projectId, importId, { onProgress, poll } = {}) {
  const { sleep = realSleep, baseMs, maxMs, maxWaitMs } = { ...DEFAULT_POLL, ...poll };
  if (!client.getImport) throw new EATError("client does not support import polling");
  let delay = baseMs;
  let elapsed = 0;
  for (;;) {
    const status = await client.getImport(projectId, importId);
    onProgress?.(status);
    if (status.status === "done") {
      if (status.result == null) {
        throw new EATError(`import ${importId} finished with no result`);
      }
      return status.result;
    }
    if (status.status === "failed") {
      // error/error_code are server-supplied and land in a terminal-rendered message.
      const detail = scrubControl(status.error || status.error_code || "unknown error");
      throw new EATError(`import failed: ${detail}`);
    }
    if (elapsed + delay > maxWaitMs) {
      throw new EATTimeout(
        `import ${importId} did not finish within ${Math.round(maxWaitMs / 1000)}s`,
      );
    }
    await sleep(delay);
    elapsed += delay;
    delay = Math.min(delay * 2, maxMs);
  }
}

/**
 * @typedef {object} ImportOutcome
 * @property {number} importedStories
 * @property {number} importedLabels
 * @property {number} skipped
 * @property {unknown[]} errors
 * @property {Record<string, unknown[]>} unmatched
 * @property {string[]} externalMembersCreated logins of external_member rows
 *   newly created by the import; empty when the server predates the field
 * @property {boolean} dryRun true when the server confirmed this was a
 *   dry-run plan (its response echoes the flag), not a real import
 */

// Logins are rendered raw to the user's terminal, so only GitHub's login
// grammar is trusted; anything else (ANSI escapes, newlines) is garbage.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;

/**
 * Perform the GitHub import and return a normalized outcome.
 *
 * The server returns `imported` as a nested object (`{"stories": N,
 * "labels": M}`); a flat integer from older/other sources is also tolerated.
 * `unmatched` lists GitHub users the server could not map to EAT members.
 *
 * When the server answers the async accept (`202 { import_id, status }`
 * instead of the synchronous 200 body), poll the job to a terminal state and
 * use its `result` — downstream normalization is then identical for both.
 *
 * `onWait` wraps only the initial (blocking) POST — the sync-200 fallback path
 * has no poll events, so this is where its progress indicator lives; the async
 * path then hands off to `onProgress` for the poll loop (sequential, one writer).
 *
 * @param {ImportClient} client
 * @param {number} projectId
 * @param {string} owner
 * @param {string} repo
 * @param {{ idempotencyKey: string, token?: string,
 *   flags?: Record<string, boolean>, dryRun?: boolean,
 *   onProgress?: (status: any) => void, poll?: PollOptions,
 *   onWait?: <T>(thunk: () => Promise<T>) => Promise<T> }} options
 * @returns {Promise<ImportOutcome>}
 */
export async function runImport(
  client,
  projectId,
  owner,
  repo,
  { idempotencyKey, token, flags, dryRun, onProgress, poll, onWait },
) {
  const post = () =>
    client.importGithub(projectId, owner, repo, { idempotencyKey, token, flags, dryRun });
  let raw = await (onWait ? onWait(post) : post());
  if (raw && raw.import_id != null && raw.imported === undefined) {
    raw = await pollImport(client, projectId, raw.import_id, { onProgress, poll });
  }
  const imported = raw.imported;
  let stories = 0;
  let labels = 0;
  if (imported && typeof imported === "object") {
    stories = Number(imported.stories ?? 0) || 0;
    labels = Number(imported.labels ?? 0) || 0;
  } else {
    stories = Number(imported ?? 0) || 0;
  }
  const created = raw.external_members_created;
  return {
    importedStories: stories,
    importedLabels: labels,
    skipped: Number(raw.skipped ?? 0) || 0,
    errors: [...(raw.errors || [])],
    unmatched: { ...(raw.unmatched || {}) },
    externalMembersCreated: Array.isArray(created)
      ? [
          ...new Set(
            created.filter((login) => typeof login === "string" && GITHUB_LOGIN.test(login)),
          ),
        ]
      : [],
    dryRun: raw.dry_run === true,
  };
}
