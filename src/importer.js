/** The import flow: call the server import and normalize its result. */

/**
 * The subset of the client the importer needs (kept structural for tests).
 *
 * @typedef {object} ImportClient
 * @property {(projectId: number, owner: string, repo: string,
 *   options: { idempotencyKey: string, token?: string }) => Promise<any>} importGithub
 */

/**
 * @typedef {object} ImportOutcome
 * @property {number} importedStories
 * @property {number} importedLabels
 * @property {number} skipped
 * @property {unknown[]} errors
 * @property {Record<string, unknown[]>} unmatched
 */

/**
 * Perform the GitHub import and return a normalized outcome.
 *
 * The server returns `imported` as a nested object (`{"stories": N,
 * "labels": M}`); a flat integer from older/other sources is also tolerated.
 * `unmatched` lists GitHub users the server could not map to EAT members.
 *
 * @param {ImportClient} client
 * @param {number} projectId
 * @param {string} owner
 * @param {string} repo
 * @param {{ idempotencyKey: string, token?: string }} options
 * @returns {Promise<ImportOutcome>}
 */
export async function runImport(client, projectId, owner, repo, { idempotencyKey, token }) {
  const raw = await client.importGithub(projectId, owner, repo, { idempotencyKey, token });
  const imported = raw.imported;
  let stories = 0;
  let labels = 0;
  if (imported && typeof imported === "object") {
    stories = Number(imported.stories ?? 0) || 0;
    labels = Number(imported.labels ?? 0) || 0;
  } else {
    stories = Number(imported ?? 0) || 0;
  }
  return {
    importedStories: stories,
    importedLabels: labels,
    skipped: Number(raw.skipped ?? 0) || 0,
    errors: [...(raw.errors || [])],
    unmatched: { ...(raw.unmatched || {}) },
  };
}
