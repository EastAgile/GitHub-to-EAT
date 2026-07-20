/** The import flow: call the server import and normalize its result. */

/**
 * The subset of the client the importer needs (kept structural for tests).
 *
 * @typedef {object} ImportClient
 * @property {(projectId: number, owner: string, repo: string,
 *   options: { idempotencyKey: string, token?: string,
 *     flags?: Record<string, boolean>, dryRun?: boolean }) => Promise<any>} importGithub
 */

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
 * @param {ImportClient} client
 * @param {number} projectId
 * @param {string} owner
 * @param {string} repo
 * @param {{ idempotencyKey: string, token?: string,
 *   flags?: Record<string, boolean>, dryRun?: boolean }} options
 * @returns {Promise<ImportOutcome>}
 */
export async function runImport(
  client,
  projectId,
  owner,
  repo,
  { idempotencyKey, token, flags, dryRun },
) {
  const raw = await client.importGithub(projectId, owner, repo, {
    idempotencyKey,
    token,
    flags,
    dryRun,
  });
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
