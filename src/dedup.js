/**
 * Re-run safety for the direct engine. Primary key: the re-import provenance
 * pair (`import_source` + `import_external_id`, EAT #31427) written on every
 * story and read back via the `GET /stories` list filters. Fallback: a marker
 * line in the description, for older servers and legacy marker-only rows.
 * See CONTRACT.md "Marker dedup".
 */

import { epicTitleKey, RELEASE_EXTERNAL_ID, releaseExternalId } from "./mapping.js";

/**
 * A release renders the API resource: only `/releases/tag/{tag}` browses, the tag is not
 * recoverable from the numeric key, and `github.com/…/releases/{id}` 404s.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} externalId the GitHub issue number, or `release-<id>` for a release
 * @returns {string}
 */
export function markerFor(owner, repo, externalId) {
  const release = RELEASE_EXTERNAL_ID.exec(externalId);
  return release
    ? `Imported from https://api.github.com/repos/${owner}/${repo}/releases/${release[1]}`
    : `Imported from https://github.com/${owner}/${repo}/issues/${externalId}`;
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
 * Read the marker off one story description, or null. Only the last non-blank
 * line counts — that is the one place the writer ever puts it, and an issue
 * body merely quoting the marker sentence mid-text must not poison the dedup.
 * Case-insensitive: GitHub slugs are, and forbid same-name-other-case repos.
 *
 * @param {string | null | undefined} description
 * @param {string} owner
 * @param {string} repo
 * @returns {string | null}
 */
export function markerExternalId(description, owner, repo) {
  const lines = (description ?? "").trimEnd().split("\n");
  const last = lines[lines.length - 1].trim();
  const scope = `${escapeRegExp(owner)}/${escapeRegExp(repo)}`;
  const issue = last.match(
    new RegExp(`^Imported from https://github\\.com/${scope}/issues/(\\d+)$`, "i"),
  );
  if (issue) return issue[1];
  const release = last.match(
    new RegExp(`^Imported from https://api\\.github\\.com/repos/${scope}/releases/(\\d+)$`, "i"),
  );
  return release ? releaseExternalId(release[1]) : null;
}

/**
 * The subset of {@link import("./client.js").EATClient} the prescan needs.
 *
 * @typedef {object} PrescanClient
 * @property {(projectId: number, opts: { limit?: number, cursor?: string,
 *   fields?: string, importSource?: string, importExternalId?: string })
 *   => Promise<{ items: any[], next_cursor: string | null }>} listStoryPage
 */

/**
 * Every label name on one already-imported story row, keyed the way epics are. Both
 * spellings are read for the same reason the epic scan reads two: `label_name` is what
 * every server version emits, `name` is the newer alias.
 *
 * @param {any} row
 * @returns {Set<string>}
 */
export function storyLabelKeys(row) {
  const labels = Array.isArray(row?.labels) ? row.labels : [];
  return new Set(
    labels
      .map((/** @type {any} */ l) => (typeof l === "string" ? l : (l?.label_name ?? l?.name)))
      .filter((/** @type {unknown} */ n) => typeof n === "string")
      .map(epicTitleKey),
  );
}

/**
 * Cursor-walk the whole project and map each already-imported external id to
 * its story row. Rows carry `tasks_count`/`blocker_count`/`comment_count` so the
 * caller can spot stories an interrupted run left without their sub-resources.
 *
 * @param {PrescanClient} client
 * @param {number} projectId
 * @param {string} owner
 * @param {string} repo
 * @param {{ pageSize?: number, withLabels?: boolean }} [options] `withLabels` adds the
 *   label array an epic run needs to tell a grouped skipped story from an unlabelled one;
 *   off, the request stays byte-identical to a run without the flag
 * @returns {Promise<Map<string, any>>}
 */
export async function prescanImported(
  client,
  projectId,
  owner,
  repo,
  { pageSize = 200, withLabels = false } = {},
) {
  const imported = new Map();
  const labels = withLabels ? ",labels" : "";
  /** @type {string | undefined} */
  let cursor;
  do {
    const page = await client.listStoryPage(projectId, {
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
      fields: `story_id,description,tasks_count,blocker_count,comment_count${labels}`,
    });
    for (const row of page.items ?? []) {
      const id = markerExternalId(row.description, owner, repo);
      if (id !== null && !imported.has(id)) imported.set(id, row);
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return imported;
}

/**
 * Cursor-walk the project filtered by `import_source` and map each row's
 * `import_external_id` to its story row — the primary re-import key on a
 * server that persists provenance (EAT #31427). Rows carry
 * `tasks_count`/`blocker_count`/`comment_count` for the interrupted-run warning,
 * like {@link prescanImported}. Rows without an `import_external_id` are skipped.
 *
 * @param {PrescanClient} client
 * @param {number} projectId
 * @param {string} [source]
 * @param {{ pageSize?: number, withLabels?: boolean }} [options] `withLabels` as in
 *   {@link prescanImported}
 * @returns {Promise<Map<string, any>>}
 */
export async function prescanProvenance(
  client,
  projectId,
  source = "github",
  { pageSize = 200, withLabels = false } = {},
) {
  const imported = new Map();
  const labels = withLabels ? ",labels" : "";
  /** @type {string | undefined} */
  let cursor;
  do {
    const page = await client.listStoryPage(projectId, {
      importSource: source,
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
      fields: `story_id,import_external_id,tasks_count,blocker_count,comment_count${labels}`,
    });
    for (const row of page.items ?? []) {
      const id = row.import_external_id;
      if (id === null || id === undefined) continue;
      const key = String(id);
      if (!imported.has(key)) imported.set(key, row);
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return imported;
}

/**
 * Merge already-imported maps (both keyed by external-id string); the first
 * occurrence of a key wins. Lets the marker and provenance prescans run in
 * union so legacy marker-only rows and pair-only rows are both skipped.
 *
 * @param {...Map<string, any>} maps
 * @returns {Map<string, any>}
 */
export function unionImported(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [id, row] of map) if (!merged.has(id)) merged.set(id, row);
  }
  return merged;
}

/**
 * Drop already-imported stories from the plan, stamp the marker on survivors, and prune
 * the labels — and the epics — no surviving story references. Returns a new plan; the
 * input is untouched. The caller compares the two plans to report what the pruning cost
 * ({@link import("./direct.js")}'s epic warnings), so this stays a pure filter.
 *
 * @param {import("./writer.js").WritePlan} plan
 * @param {{ has(id: string): boolean }} importedIds Set or prescan Map
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
  const referenced = new Set(survivors.flatMap((op) => op.labels.map(epicTitleKey)));
  const labels = plan.labels.filter((label) => referenced.has(epicTitleKey(label.name)));
  // An epic's join is its label, so an epic no survivor carries has nothing to group:
  // a fully-skipped re-run plans no epic work at all.
  const epics = (plan.epics ?? []).filter((epic) => referenced.has(epicTitleKey(epic.title)));
  return { plan: { labels, stories, epics }, skipped: plan.stories.length - survivors.length };
}
