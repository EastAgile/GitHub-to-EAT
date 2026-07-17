/**
 * Re-run safety for the direct engine: the public API exposes no import provenance,
 * so written stories carry a marker line a prescan reads back. See CONTRACT.md "Marker dedup".
 */

/**
 * @param {string} owner
 * @param {string} repo
 * @param {string} externalId the GitHub issue number, as a string
 * @returns {string}
 */
export function markerFor(owner, repo, externalId) {
  return `Imported from https://github.com/${owner}/${repo}/issues/${externalId}`;
}

/**
 * @param {string | null} description
 * @param {string} marker
 * @returns {string}
 */
export function withMarker(description, marker) {
  return description ? `${description}\n\n${marker}` : marker;
}

/** @param {string} s @returns {string} */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the external ids of this repo's markers from prescanned story rows.
 * Markers for other repos are ignored — dedup is scoped per (owner, repo).
 *
 * @param {Array<{ description?: string | null }>} rows
 * @param {string} owner
 * @param {string} repo
 * @returns {Set<string>}
 */
export function markedExternalIds(rows, owner, repo) {
  const pattern = new RegExp(
    `^Imported from https://github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/issues/(\\d+)\\s*$`,
    "gm",
  );
  const ids = new Set();
  for (const row of rows) {
    for (const match of (row.description ?? "").matchAll(pattern)) {
      ids.add(match[1]);
    }
  }
  return ids;
}

/**
 * The subset of {@link import("./client.js").EATClient} the prescan needs.
 *
 * @typedef {object} PrescanClient
 * @property {(projectId: number, opts: { limit?: number, cursor?: string,
 *   fields?: string }) => Promise<{ items: any[], next_cursor: string | null }>} listStoryPage
 */

/**
 * Cursor-walk the whole project with the sparse fieldset and collect the
 * already-imported external ids for this repo.
 *
 * @param {PrescanClient} client
 * @param {number} projectId
 * @param {string} owner
 * @param {string} repo
 * @param {{ pageSize?: number }} [options]
 * @returns {Promise<Set<string>>}
 */
export async function prescanImported(client, projectId, owner, repo, { pageSize = 200 } = {}) {
  const ids = new Set();
  /** @type {string | undefined} */
  let cursor;
  do {
    const page = await client.listStoryPage(projectId, {
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
      fields: "story_id,description",
    });
    for (const id of markedExternalIds(page.items ?? [], owner, repo)) ids.add(id);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return ids;
}

/**
 * Drop already-imported stories from the plan, stamp the marker on survivors, and
 * prune labels no surviving story references. Returns a new plan; the input is untouched.
 *
 * @param {import("./writer.js").WritePlan} plan
 * @param {Set<string>} importedIds
 * @param {string} owner
 * @param {string} repo
 * @returns {{ plan: import("./writer.js").WritePlan, skipped: number }}
 */
export function applyDedup(plan, importedIds, owner, repo) {
  const survivors = plan.stories.filter((op) => !importedIds.has(op.external_id));
  const stories = survivors.map((op) => ({
    ...op,
    description: withMarker(op.description, markerFor(owner, repo, op.external_id)),
  }));
  const referenced = new Set(
    survivors.flatMap((op) => op.labels.map((name) => name.toLowerCase())),
  );
  const labels = plan.labels.filter((label) => referenced.has(label.name.toLowerCase()));
  return { plan: { labels, stories }, skipped: plan.stories.length - survivors.length };
}
