/**
 * Pure field-equivalence comparison between one server-engine import and one
 * direct-engine import of the same repo (story #32775). No I/O — the live
 * harness in `parity.e2e.test.js` reads both projects and hands the rows here,
 * and `parity-compare.test.js` exercises the rules on fixtures.
 */

import { sliceBytes, TRUNCATION_NOTICE } from "../src/mapping.js";

/**
 * @typedef {object} ParityRow
 * @property {string} key GitHub issue number, or `release-<id>` for a release
 * @property {string} [name]
 * @property {string} story_type
 * @property {string | null} current_state
 * @property {boolean} [icebox]
 * @property {string | null} created
 * @property {string | null} [started]
 * @property {string | null} [rejected_at]
 * @property {string | null} [completed_at]
 * @property {string} description
 * @property {string | null} import_source
 * @property {string | null} import_external_id
 * @property {{ description: string, complete: boolean }[]} tasks
 * @property {{ text: string, created: string | null, author: unknown }[]} comments
 * @property {{ name: string, background_color_hex: string | null,
 *   text_color_hex: string | null }[]} labels
 * @property {unknown} requestor
 * @property {unknown[]} owners
 */

/**
 * @typedef {object} Mismatch
 * @property {string} key
 * @property {string} field
 * @property {unknown} server
 * @property {unknown} direct
 */

/**
 * @typedef {Mismatch & { reason: string }} Tolerated
 */

/**
 * The divergences this harness accepts, each naming the ask that tracks it.
 * Anything not on this list fails the run.
 */
export const DIVERGENCES = {
  BACKLINK:
    "description back-link footer: server writes '[View original issue](url)', direct writes " +
    "'Imported from url' (its pre-provenance dedup marker) — story #36736",
  REJECTED_COMPLETED_AT:
    "completed_at on a rejected row: the server importer writes it, the public create rejects " +
    "it (rejected has a NULL state_rank) — server ask #36701",
  CLAMP:
    "long text (description / task / comment) cut by the CLI to the write route's published " +
    "maxLength and closed with the truncation notice, where the importer writes the column " +
    "directly and keeps the source whole — server ask #35629",
  NAME_CLAMP:
    "story name clamped at 255 bytes by the CLI (what the public route validates) vs 255 chars " +
    "by the importer (`title.chars().take(255)`) — server ask #35629 (/s/y9q8ea68)",
  COMMENT_TRIM:
    "comment body: the CLI trims it before sending, the server importer stores it verbatim " +
    "(it only calls trim() to skip blank comments) — declared in CONTRACT.md's people section",
  TASK_ORDER:
    "task order: the public create cannot set task_order (it defaults to 0.0) where the importer " +
    "writes the entry index, and the story projection orders by task_order with no tiebreaker, " +
    "so tasks come back in unspecified order — server ask #44443 (/s/hxc5em5x)",
  AGENT_KEY_COMPLETED_AT:
    "completed_at is on no agent-key read path — absent from the story list row, the detail " +
    "payload and the fields= allowlist, and the project export that carries it rejects agent " +
    "keys — server ask #44442 (/s/zs8x675e)",
};

/** The only fields `unavailable` can name, because they are the only ones it gates. */
const UNAVAILABLE_FIELDS = new Set(["completed_at"]);

/**
 * A run that compared too few rows proves nothing, so the caller fails on this
 * rather than on an empty mismatch list.
 *
 * @param {{ compared: number }} counts
 * @param {number} [minRows]
 * @returns {string | null} why the run is too thin to certify parity, or null
 */
export function floorViolation({ compared }, minRows = 1) {
  const floor = Math.max(1, Number.isFinite(minRows) ? minRows : 1);
  if (compared >= floor) return null;
  return `compared ${compared} row(s), below the floor of ${floor} — a run that compares nothing (or almost nothing) certifies nothing`;
}

const SCALAR_FIELDS = [
  "story_type",
  "current_state",
  "icebox",
  "import_source",
  "import_external_id",
];

const INSTANT_FIELDS = ["created", "started", "rejected_at"];

/** @param {string} s @returns {string} */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The footers the two engines may write on THIS row: the direct engine's dedup
 * marker in `dedup.js`'s exact shape, and the server's `original_url` link. Both
 * are pinned to the run's repo and to the row's own external id, so a footer
 * naming another issue — or a body whose last line merely looks like one — is
 * content, not a footer, and must not be stripped away.
 *
 * @param {string} key
 * @param {{ owner: string, name: string }} [repo] the run's repo; without it any
 *   owner/name is accepted and only the external id is pinned
 * @returns {RegExp}
 */
function backLinkFor(key, repo) {
  const scope = repo
    ? `${escapeRegExp(repo.owner)}/${escapeRegExp(repo.name)}`
    : "[^/\\s]+/[^/\\s]+";
  const release = /^release-(\d+)$/.exec(key);
  const target = release
    ? `(?:api\\.github\\.com/repos/${scope}/releases/${release[1]}|github\\.com/${scope}/releases/tag/[^\\s)]+)`
    : `github\\.com/${scope}/(?:issues|pull)/${escapeRegExp(key)}`;
  return new RegExp(
    `^(?:Imported from https://${target}|\\[View original issue\\]\\(https://${target}\\))$`,
    "i",
  );
}

/**
 * Split one description into its body and its back-link footer, so two bodies
 * compare on their content. Only the last non-blank line is eligible, the same
 * rule `dedup.js` reads the marker by.
 *
 * @param {string} description
 * @param {string} key
 * @param {{ owner: string, name: string }} [repo]
 * @returns {{ body: string, footer: string | null }}
 */
function popBackLink(description, key, repo) {
  const lines = description.trimEnd().split("\n");
  if (!backLinkFor(key, repo).test(lines[lines.length - 1].trim())) {
    return { body: description.trimEnd(), footer: null };
  }
  const footer = /** @type {string} */ (lines.pop()).trim();
  return { body: lines.join("\n").trimEnd(), footer };
}

/**
 * Timestamps agree to the second: the two engines write the same GitHub
 * instant, but not the same spelling of it (`Z` vs `+00:00`, ms or not).
 *
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
function sameSecond(a, b) {
  if (a == null || b == null) return a == null && b == null;
  const [x, y] = [Date.parse(a), Date.parse(b)];
  if (Number.isNaN(x) || Number.isNaN(y)) return a === b;
  return Math.floor(x / 1000) === Math.floor(y / 1000);
}

const byteLen = (/** @type {string} */ s) => Buffer.byteLength(s, "utf8");

/** The ellipsis `clampPlan` appends when it cuts a story name. */
const NAME_ELLIPSIS = "…";
/** `limits::STORY_NAME` — the same 255 both ends clamp to, in different units. */
const NAME_LIMIT = 255;

/**
 * True when `clamped` is `full` cut short by `clampBlock`: the notice closes it,
 * something precedes the notice, and the text it cut really was the longer one.
 *
 * @param {string} clamped
 * @param {string} full
 * @returns {boolean}
 */
function clampedPrefixOf(clamped, full) {
  const cut = clamped.indexOf(TRUNCATION_NOTICE);
  if (cut <= 0 || !clamped.endsWith(TRUNCATION_NOTICE)) return false;
  return byteLen(full) > byteLen(clamped) && full.startsWith(clamped.slice(0, cut).trimEnd());
}

/**
 * True when `clamped` is exactly what `clampPlan` would write for the title
 * `full` came from. `full` is the importer's own cut (255 chars, so ≥255 bytes)
 * or the whole title, and either way it is a prefix of the source at least
 * `NAME_LIMIT` bytes long — so the CLI's 252-byte prefix is recoverable from it.
 *
 * @param {string} clamped
 * @param {string} full
 * @returns {boolean}
 */
function clampedNameOf(clamped, full) {
  if (!clamped.endsWith(NAME_ELLIPSIS) || byteLen(full) < NAME_LIMIT) return false;
  return clamped === `${sliceBytes(full, NAME_LIMIT - byteLen(NAME_ELLIPSIS))}${NAME_ELLIPSIS}`;
}

/**
 * @typedef {object} Tolerance one accepted shape of difference for a text field
 * @property {string} reason the {@link DIVERGENCES} entry it is filed under
 * @property {(server: string, direct: string) => boolean} matches tried both ways round
 */

/** @type {Tolerance} */
const CLAMP = { reason: DIVERGENCES.CLAMP, matches: clampedPrefixOf };
/** @type {Tolerance} */
const NAME_CLAMP = { reason: DIVERGENCES.NAME_CLAMP, matches: clampedNameOf };
/** @type {Tolerance} */
const COMMENT_TRIM = { reason: DIVERGENCES.COMMENT_TRIM, matches: (a, b) => a.trim() === b };

/**
 * Compare one text field: equal, tolerated (the reason), or genuinely different.
 *
 * @param {string} a
 * @param {string} b
 * @param {Tolerance[]} tolerances
 * @returns {"equal" | "differ" | string}
 */
function compareText(a, b, tolerances) {
  if (a === b) return "equal";
  for (const t of tolerances) if (t.matches(a, b) || t.matches(b, a)) return t.reason;
  return "differ";
}

/**
 * Render one report line's value. Long text is cut with its true length shown,
 * so a difference past the cut is never mistaken for equality.
 *
 * @param {unknown} value
 * @returns {string}
 */
function render(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= 200 ? text : `${text.slice(0, 200)}… (${text.length} chars)`;
}

/**
 * The whole comparison as text: every mismatching field on its own line keyed
 * by GitHub issue, then the tolerated divergences, then what went uncompared.
 *
 * @param {ReturnType<typeof compareProjects>} result
 * @returns {string}
 */
export function formatReport({ mismatches, tolerated, skipped, counts }) {
  const issues = new Set(mismatches.map((m) => m.key)).size;
  const lines = [
    `PARITY: ${mismatches.length} mismatching field(s) across ${issues} issue(s)`,
    `story count: server ${counts.server}, direct ${counts.direct}, compared ${counts.compared}`,
  ];
  if (counts.server !== counts.serverKeys || counts.direct !== counts.directKeys) {
    lines.push(`distinct keys: server ${counts.serverKeys}, direct ${counts.directKeys}`);
  }
  if (mismatches.length) lines.push("");
  for (const m of mismatches) {
    const gutter = `issue #${m.key}`.padEnd(16);
    lines.push(`  ${gutter} ${m.field.padEnd(26)} server=${render(m.server)}`);
    lines.push(`  ${" ".repeat(16)} ${" ".repeat(26)} direct=${render(m.direct)}`);
  }

  /** @type {Map<string, string[]>} */
  const byReason = new Map();
  for (const t of tolerated) {
    if (!byReason.has(t.reason)) byReason.set(t.reason, []);
    /** @type {string[]} */ (byReason.get(t.reason)).push(t.key);
  }
  if (byReason.size) {
    lines.push("", "tolerated (known divergences):");
    for (const [reason, keys] of byReason) {
      const sample = keys
        .slice(0, 5)
        .map((k) => `#${k}`)
        .join(", ");
      lines.push(`  ${keys.length} row(s) — ${reason}`, `    e.g. ${sample}`);
    }
  }
  if (skipped.length) {
    lines.push("", "not compared:");
    for (const s of skipped) lines.push(`  ${s.field} — ${s.reason}`);
  }
  return lines.join("\n");
}

/**
 * One person's cross-project identity. The numeric id differs between two
 * projects that imported the same GitHub account, so it is never part of the key.
 *
 * @param {any} person an EAT actor block, or the join row wrapping one, or null
 * @returns {string}
 */
export function actorKey(person) {
  if (!person || typeof person !== "object") return "none";
  // Owners and requestors arrive wrapped in their join row (`{member_id, …, actor}`).
  const actor = person.actor ?? person;
  if (!actor || typeof actor !== "object") return "none";
  switch (actor.kind) {
    case "external":
      return `external:${actor.source ?? "?"}/${actor.username ?? actor.name ?? "?"}`;
    case "member":
      return `member:${actor.email ?? actor.name ?? "?"}`;
    case "agent":
      return `agent:${actor.name ?? "?"}`;
    default:
      return `${actor.kind ?? "unknown"}:${actor.name ?? ""}`;
  }
}

/** @param {string | null | undefined} at @returns {number} */
const seconds = (at) => Math.floor((at ? Date.parse(at) : 0) / 1000) || 0;

/**
 * Sort by an encoded tuple, not `localeCompare`: ICU treats the separator as
 * ignorable — so the field boundaries vanish — and ties on normalisation,
 * zero-width and soft-hyphen differences, whereupon `Array#sort` falls back to
 * input order, which the two engines need not share.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => unknown[]} tuple
 * @returns {T[]}
 */
function canonical(items, tuple) {
  return [...(items ?? [])]
    .map((item) => ({ item, sortKey: JSON.stringify(tuple(item)) }))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
    .map(({ item }) => item);
}

/**
 * The list endpoint orders comments by `created`, which leaves same-instant
 * comments free to come back either way round. The trimmed text leads the tuple
 * so {@link DIVERGENCES.COMMENT_TRIM} still pairs a comment with itself.
 *
 * @param {ParityRow["comments"]} comments
 * @returns {ParityRow["comments"]}
 */
const canonicalComments = (comments) =>
  canonical(comments, (c) => [
    seconds(c.created),
    (c.text ?? "").trim(),
    actorKey(c.author),
    c.text,
  ]);

/** @param {ParityRow["labels"]} labels @returns {ParityRow["labels"]} */
const canonicalLabels = (labels) =>
  canonical(labels, (l) => [l.name, l.background_color_hex, l.text_color_hex]);

/**
 * Position carries no cross-engine meaning ({@link DIVERGENCES.TASK_ORDER}), so
 * the comparison canonicalises it away rather than pairing tasks by index.
 *
 * @param {ParityRow["tasks"]} tasks
 * @returns {ParityRow["tasks"]}
 */
const canonicalTasks = (tasks) => canonical(tasks, (t) => [t.description, t.complete]);

/**
 * Every key more than one row on a side claims. Building the row maps collapses
 * them silently, so a dedup or re-import regression that wrote an issue twice
 * would otherwise compare — and pass — as one row.
 *
 * @param {ParityRow[]} rows
 * @returns {Map<string, number>}
 */
function countByKey(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  return counts;
}

/**
 * @param {ParityRow[]} serverRows
 * @param {ParityRow[]} directRows
 * @param {{ unavailable?: Record<string, string>, repo?: { owner: string, name: string } }}
 *   [options] `unavailable` names fields no read path can supply, with the reason; they are
 *   reported, never silently dropped. `repo` pins the back-link footers to the run's repo.
 * @returns {{ mismatches: Mismatch[], tolerated: Tolerated[],
 *   skipped: { field: string, reason: string }[],
 *   counts: { server: number, direct: number, compared: number,
 *     serverKeys: number, directKeys: number } }}
 */
export function compareProjects(serverRows, directRows, { unavailable = {}, repo } = {}) {
  for (const field of Object.keys(unavailable)) {
    if (!UNAVAILABLE_FIELDS.has(field)) {
      throw new TypeError(
        `unavailable: ${field} is compared regardless, so reporting it as uncompared would be a lie — only ${[...UNAVAILABLE_FIELDS].join(", ")} is gated`,
      );
    }
  }
  const server = new Map(serverRows.map((r) => [r.key, r]));
  const direct = new Map(directRows.map((r) => [r.key, r]));
  /** @type {Mismatch[]} */
  const mismatches = [];
  /** @type {Tolerated[]} */
  const tolerated = [];
  let compared = 0;

  const [serverCounts, directCounts] = [countByKey(serverRows), countByKey(directRows)];
  for (const key of new Set([...serverCounts.keys(), ...directCounts.keys()])) {
    const [x, y] = [serverCounts.get(key) ?? 0, directCounts.get(key) ?? 0];
    if (x > 1 || y > 1) mismatches.push({ key, field: "duplicate-key", server: x, direct: y });
  }

  for (const key of new Set([...server.keys(), ...direct.keys()])) {
    const a = server.get(key);
    const b = direct.get(key);
    if (!a || !b) {
      mismatches.push({
        key,
        field: "story",
        server: a ? "present" : "missing",
        direct: b ? "present" : "missing",
      });
      continue;
    }
    compared += 1;

    for (const field of INSTANT_FIELDS) {
      const x = /** @type {string | null} */ (a[/** @type {keyof ParityRow} */ (field)]);
      const y = /** @type {string | null} */ (b[/** @type {keyof ParityRow} */ (field)]);
      if (!sameSecond(x, y)) mismatches.push({ key, field, server: x, direct: y });
    }

    if (!("completed_at" in unavailable) && !sameSecond(a.completed_at, b.completed_at)) {
      const entry = { key, field: "completed_at", server: a.completed_at, direct: b.completed_at };
      const known =
        a.current_state === "rejected" && b.current_state === "rejected" && b.completed_at == null;
      if (known) tolerated.push({ ...entry, reason: DIVERGENCES.REJECTED_COMPLETED_AT });
      else mismatches.push(entry);
    }

    for (const field of SCALAR_FIELDS) {
      const x = a[/** @type {keyof ParityRow} */ (field)];
      const y = b[/** @type {keyof ParityRow} */ (field)];
      if (x !== y) mismatches.push({ key, field, server: x, direct: y });
    }

    /** @param {string} field @param {string} x @param {string} y @param {Tolerance[]} [allow] */
    const text = (field, x, y, allow = [CLAMP]) => {
      const verdict = compareText(x, y, allow);
      if (verdict === "differ") mismatches.push({ key, field, server: x, direct: y });
      else if (verdict !== "equal") {
        tolerated.push({ key, field, server: x, direct: y, reason: verdict });
      }
      return verdict;
    };
    /** @param {string} field @param {unknown} x @param {unknown} y */
    const same = (field, x, y) => {
      if (x !== y) mismatches.push({ key, field, server: x, direct: y });
    };

    text("name", a.name ?? "", b.name ?? "", [NAME_CLAMP]);

    const [rawA, rawB] = [a.description ?? "", b.description ?? ""];
    const [popA, popB] = [popBackLink(rawA, key, repo), popBackLink(rawB, key, repo)];
    if (text("description", popA.body, popB.body) === "equal" && rawA !== rawB) {
      const entry = { key, field: "description", server: rawA, direct: rawB };
      // Only a footer that was really popped earns the tolerance; anything else
      // left over (trailing whitespace, say) is content the two engines disagree on.
      if (popA.footer || popB.footer) tolerated.push({ ...entry, reason: DIVERGENCES.BACKLINK });
      else mismatches.push(entry);
    }

    const [tasksA, tasksB] = [canonicalTasks(a.tasks), canonicalTasks(b.tasks)];
    if (tasksA.length !== tasksB.length) {
      same("tasks.length", tasksA.length, tasksB.length);
    } else {
      tasksA.forEach((task, i) => {
        text(`tasks[${i}].description`, task.description, tasksB[i].description);
        same(`tasks[${i}].complete`, task.complete, tasksB[i].complete);
      });
    }

    const [commentsA, commentsB] = [canonicalComments(a.comments), canonicalComments(b.comments)];
    if (commentsA.length !== commentsB.length) {
      same("comments.length", commentsA.length, commentsB.length);
    } else {
      commentsA.forEach((comment, i) => {
        text(`comments[${i}].text`, comment.text, commentsB[i].text, [CLAMP, COMMENT_TRIM]);
        if (!sameSecond(comment.created, commentsB[i].created)) {
          same(`comments[${i}].created`, comment.created, commentsB[i].created);
        }
        same(`comments[${i}].author`, actorKey(comment.author), actorKey(commentsB[i].author));
      });
    }

    const [labelsA, labelsB] = [canonicalLabels(a.labels), canonicalLabels(b.labels)];
    if (labelsA.length !== labelsB.length) {
      same("labels.length", labelsA.length, labelsB.length);
    } else {
      labelsA.forEach((label, i) => {
        for (const part of ["name", "background_color_hex", "text_color_hex"]) {
          const field = /** @type {keyof typeof label} */ (part);
          same(`labels[${i}].${part}`, label[field], labelsB[i][field]);
        }
      });
    }

    same("requestor", actorKey(a.requestor), actorKey(b.requestor));
    const people = (/** @type {unknown[]} */ owners) =>
      (owners ?? []).map(actorKey).sort().join(", ");
    same("owners", people(a.owners), people(b.owners));
  }

  const skipped = Object.entries(unavailable).map(([field, reason]) => ({ field, reason }));
  return {
    mismatches,
    tolerated,
    skipped,
    counts: {
      server: serverRows.length,
      direct: directRows.length,
      compared,
      serverKeys: server.size,
      directKeys: direct.size,
    },
  };
}
