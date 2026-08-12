/**
 * Wire shape → {@link import("./parity-compare.js").ParityRow} for the two-engine parity harness
 * (#32775). Split from `parity.e2e.test.js` so the default suite can pin the EAT read shape:
 * the e2e is opt-in, and a drift there would otherwise vanish instead of failing red.
 */

/** Both engines' back-link footers, which carry the source id on rows with no provenance. */
const BACK_LINK =
  /(?:\[View original issue]\(|Imported from )https?:\/\/(?:api\.)?github\.com\/(?:repos\/)?[^/\s]+\/[^/\s]+\/(issues|pull|releases)\/(\d+)\)?$/i;

/**
 * The row's cross-engine key: the provenance id both importers write, else the
 * back-link footer's id for a server too old to persist provenance.
 *
 * @param {any} row
 * @returns {string}
 */
export function keyOf(row) {
  if (row.import_external_id != null) return String(row.import_external_id);
  const last = String(row.description ?? "")
    .trimEnd()
    .split("\n")
    .pop()
    ?.trim();
  const match = BACK_LINK.exec(last ?? "");
  if (!match) return `unkeyed-story-${row.story_id}`;
  return match[1].toLowerCase() === "releases" ? `release-${match[2]}` : match[2];
}

/**
 * Assemble one project's parity rows from the three reads the harness makes: the full list
 * walk, the `fields=story_id,tasks` walk, and one comment page per row.
 *
 * `errors` are the harness's own, not parity mismatches: an embed that came back empty makes
 * both engines read nothing, and "nothing equals nothing" is the one verdict a parity run
 * must never reach on its own. The counts checked against are the server's, on the same row,
 * behind the same `expired IS NULL` filter as the embed.
 *
 * @param {any[]} rows the full list walk
 * @param {any[]} withTasks the `fields=story_id,tasks` walk, one entry per row
 * @param {any[][]} commentsByRow comment pages, positionally parallel to `rows`
 * @returns {{ rows: import("./parity-compare.js").ParityRow[], errors: string[] }}
 */
export function toParityRows(rows, withTasks, commentsByRow) {
  const tasksById = new Map(withTasks.map((r) => [r.story_id, r.tasks ?? []]));
  /** @type {string[]} */
  const errors = [];
  if (withTasks.length !== rows.length) {
    errors.push(
      `the tasks walk returned ${withTasks.length} row(s) for a list walk of ${rows.length}`,
    );
  }

  /** @param {any} row @param {string} field @param {any[]} embedded */
  const checkCount = (row, field, embedded) => {
    const where = `story ${row.story_id} (#${keyOf(row)})`;
    if (!(field in row)) {
      errors.push(`${where}: the list row carries no ${field}, so the embed cannot be checked`);
      return;
    }
    if (embedded.length !== row[field]) {
      errors.push(`${where}: read ${embedded.length} against the row's own ${field}=${row[field]}`);
    }
  };

  const parity = rows.map((row, i) => {
    const tasks = tasksById.get(row.story_id);
    if (tasks === undefined) {
      errors.push(`story ${row.story_id} (#${keyOf(row)}) is missing from the tasks walk`);
    }
    checkCount(row, "comment_count", commentsByRow[i] ?? []);
    checkCount(row, "tasks_count", tasks ?? []);
    return toParityRow(row, tasks ?? [], commentsByRow[i] ?? []);
  });
  return { rows: parity, errors };
}

/**
 * @param {any} row
 * @param {any[]} tasks
 * @param {any[]} comments
 * @returns {import("./parity-compare.js").ParityRow}
 */
function toParityRow(row, tasks, comments) {
  return {
    key: keyOf(row),
    name: row.name,
    story_type: row.story_type,
    current_state: row.current_state,
    icebox: row.icebox,
    created: row.created,
    started: row.started,
    rejected_at: row.rejected_at,
    description: row.description ?? "",
    import_source: row.import_source,
    import_external_id: row.import_external_id,
    tasks: tasks.map((t) => ({ description: t.task_desc, complete: t.complete })),
    // `comment_text` is an `Option<String>` server side, and a null reaching the
    // comparison throws out of it — aborting the run with no report at all.
    comments: comments.map((c) => ({
      text: c.comment_text ?? "",
      created: c.created,
      author: c.author,
    })),
    labels: (row.labels ?? []).map((/** @type {any} */ l) => ({
      name: l.label_name ?? l.name,
      background_color_hex: l.background_color_hex ?? null,
      text_color_hex: l.text_color_hex ?? null,
    })),
    requestor: row.requestor,
    owners: row.owners ?? [],
  };
}
