/**
 * Wire shape → {@link import("./parity-compare.js").ParityRow} for the parity harness (#32775).
 * Split from the opt-in `parity.e2e.test.js` so the default suite pins the EAT read shape.
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
 * `GET …/stories/{id}/comments` returns a bare array, or an `{items, next_cursor}` envelope once
 * `cursor`/`limit`/`order` is sent. An unknown shape reads empty; `comment_count` catches it.
 *
 * @param {any} page
 * @returns {any[]}
 */
export function commentsFrom(page) {
  if (Array.isArray(page)) return page;
  return Array.isArray(page?.items) ? page.items : [];
}

/**
 * Every key the comparison reads off a list row. A key absent on both sides compares
 * equal to itself, so its absence is a broken readback rather than agreement.
 */
const COMPARED_KEYS = [
  "description",
  "story_type",
  "current_state",
  "icebox",
  "created",
  "started",
  "rejected_at",
  "import_source",
  "import_external_id",
  "requestor",
  "owners",
  "labels",
];

/**
 * `errors` stop "both engines read nothing" passing as parity. `tasks_count` is `expired IS NULL`
 * where `fetch_counts_for_page`'s `comment_count` is not, so a soft-deleted comment reads broken.
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

  /** @param {any} row */
  const checkCompared = (row) => {
    const where = `story ${row.story_id} (#${keyOf(row)})`;
    for (const field of COMPARED_KEYS) {
      if (!(field in row)) {
        errors.push(`${where}: the list row carries no ${field}, so it cannot be compared`);
      }
    }
    // `name` is the newer alias of `title`; a server that publishes neither leaves the
    // comparison reading undefined on both sides, which is not agreement on the title.
    if (!("name" in row) && !("title" in row)) {
      errors.push(`${where}: the list row carries neither name nor title`);
    }
  };

  const parity = rows.map((row, i) => {
    const tasks = tasksById.get(row.story_id);
    if (tasks === undefined) {
      errors.push(`story ${row.story_id} (#${keyOf(row)}) is missing from the tasks walk`);
    }
    checkCount(row, "comment_count", commentsByRow[i] ?? []);
    checkCount(row, "tasks_count", tasks ?? []);
    checkCompared(row);
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
    name: row.name ?? row.title,
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
