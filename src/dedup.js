/**
 * Re-run safety for the direct engine. Primary key: the re-import provenance
 * pair (`import_source` + `import_external_id`, EAT #31427) written on every
 * story and read back via the `GET /stories` list filters. Fallback: a marker
 * line in the description, for older servers and legacy marker-only rows.
 * See CONTRACT.md "Marker dedup".
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
  const match = last.match(
    new RegExp(
      `^Imported from https://github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/issues/(\\d+)$`,
      "i",
    ),
  );
  return match ? match[1] : null;
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
 * Cursor-walk the whole project and map each already-imported external id to
 * its story row. Rows carry `tasks_count`/`comment_count` so the caller can
 * spot stories an interrupted run left without their sub-resources.
 *
 * @param {PrescanClient} client
 * @param {number} projectId
 * @param {string} owner
 * @param {string} repo
 * @param {{ pageSize?: number }} [options]
 * @returns {Promise<Map<string, any>>}
 */
export async function prescanImported(client, projectId, owner, repo, { pageSize = 200 } = {}) {
  const imported = new Map();
  /** @type {string | undefined} */
  let cursor;
  do {
    const page = await client.listStoryPage(projectId, {
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
      fields: "story_id,description,tasks_count,comment_count",
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
 * `tasks_count`/`comment_count` for the interrupted-run warning, like
 * {@link prescanImported}. Rows without an `import_external_id` are skipped.
 *
 * @param {PrescanClient} client
 * @param {number} projectId
 * @param {string} [source]
 * @param {{ pageSize?: number }} [options]
 * @returns {Promise<Map<string, any>>}
 */
export async function prescanProvenance(
  client,
  projectId,
  source = "github",
  { pageSize = 200 } = {},
) {
  const imported = new Map();
  /** @type {string | undefined} */
  let cursor;
  do {
    const page = await client.listStoryPage(projectId, {
      importSource: source,
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
      fields: "story_id,import_external_id,tasks_count,comment_count",
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
 * Drop already-imported stories from the plan, stamp the marker on survivors, and
 * prune labels no surviving story references. Returns a new plan; the input is untouched.
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
  const referenced = new Set(
    survivors.flatMap((op) => op.labels.map((name) => name.toLowerCase())),
  );
  const labels = plan.labels.filter((label) => referenced.has(label.name.toLowerCase()));
  return { plan: { labels, stories }, skipped: plan.stories.length - survivors.length };
}
