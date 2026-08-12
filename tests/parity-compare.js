/**
 * Field-equivalence rules for a server-engine vs. direct-engine import of one repo (#32775).
 * Pure — `parity.e2e.test.js` runs them live, `parity-compare.test.js` on fixtures.
 */

import {
  CLOSED_REASON_LABELS,
  FALLBACK_LIMITS,
  SUB_ISSUE_OF_PREFIX,
  SUB_ISSUES_PREFIX,
  sliceBytes,
  TRUNCATION_NOTICE,
} from "../src/mapping.js";

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

/** @typedef {Mismatch & { reason: string }} Tolerated */

/** Divergences this harness accepts, each naming the ask that tracks it; all else fails the run. */
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
    "directly and is bound only by its own column widths (see TASK_TRUNCATE) — server ask #35629",
  TASK_TRUNCATE:
    "task description cut to 255 chars by the importer's own column width " +
    "(`task.desc.chars().take(255)` in services/import/writer.rs), where the CLI writes the " +
    "checklist entry whole — the mirror of CLAMP, and why CLAMP alone cannot cover tasks",
  CROSS_LINKS:
    "sub-issue cross-link block: the direct engine renders '" +
    SUB_ISSUE_OF_PREFIX +
    " #n' / '" +
    SUB_ISSUES_PREFIX +
    " #n' as the description's last paragraph and the importer never fetches /sub_issues — " +
    "one of the three direct-only exceptions named in src/mapping.js's header and in " +
    "CONTRACT.md's 'issues → stories' section",
  CLOSED_REASON:
    "closed as not planned / duplicate: the direct engine rejects the story (a chore stays " +
    "accepted, having no rejected state) and attaches the reason label, where the importer " +
    "flattens every closed issue to accepted — src/mapping.js's CLOSED_REASON_LABELS and " +
    "header, and CONTRACT.md's 'issues → stories' section",
  ISSUE_TYPE:
    "story_type read off GitHub's org issue-type field, which the direct engine maps and the " +
    "importer cannot see (its GhIssue has no `type`, so serde drops it) — src/mapping.js's " +
    "header and CONTRACT.md's 'issues → stories' section; a fixture repo that uses issue " +
    "types must name story_type unavailable, because no read tells the two rules apart",
  NAME_CLAMP:
    "story name clamped at 255 bytes by the CLI (what the public route validates) vs 255 chars " +
    "by the importer (`title.chars().take(255)`) — server ask #35629 (/s/y9q8ea68)",
  COMMENT_TRIM:
    "comment body: the CLI trims it before sending, the server importer stores it verbatim " +
    "(it only calls trim() to skip blank comments) — declared in CONTRACT.md's people section",
  COMMENT_TRIM_CLAMP:
    "comment body both whitespace-led and over the limit: the CLI trims it and then clamps " +
    "the remainder, so neither the trim nor the clamp divergence explains it on its own",
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
const UNAVAILABLE_FIELDS = new Set(["completed_at", "story_type"]);

/**
 * A run that compared too few rows proves nothing, so the caller fails on this
 * rather than on an empty mismatch list.
 *
 * @param {{ compared: number }} counts
 * @param {number} [minRows]
 * @returns {string | null} why the run is too thin to certify parity, or null
 */
export function floorViolation({ compared }, minRows = 1) {
  // A NaN from `EAT_PARITY_MIN_ROWS=1O` used to fall back to 1, so a run configured
  // to demand 50 rows certified itself on one.
  if (!Number.isFinite(minRows) || minRows < 1) {
    return `row floor ${String(minRows)} is not a row count — set EAT_PARITY_MIN_ROWS to an integer ≥ 1`;
  }
  if (compared >= minRows) return null;
  return `compared ${compared} row(s), below the floor of ${minRows} — a run that compares nothing (or almost nothing) certifies nothing`;
}

/** The row families AC 2 claims equivalence for, each counted only where both engines read data. */
export const COVERAGE_FAMILIES = ["comments", "tasks", "labels", "owners", "requestor"];

/** @param {string} family @returns {string} */
const floorVar = (family) => `EAT_PARITY_MIN_${family.toUpperCase()}`;

/**
 * Per-family row floors, read the way `EAT_PARITY_MIN_ROWS` is. Blank is not zero: an
 * unset floor defaults to 1, and only an explicit `0` opts a family out of the gate.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, number>}
 */
export function coverageFloors(env = {}) {
  return Object.fromEntries(
    COVERAGE_FAMILIES.map((family) => {
      const raw = env[floorVar(family)];
      if (raw === undefined) return [family, 1];
      return [family, raw.trim() === "" ? Number.NaN : Number(raw)];
    }),
  );
}

/**
 * A family both engines read nothing for was never compared, so "equal" is not a finding
 * about it. Malformed floors fail the same way {@link floorViolation}'s do.
 *
 * @param {Record<string, number>} coverage
 * @param {Record<string, number>} floors
 * @returns {string[]} one line per family that cannot certify parity
 */
export function coverageViolations(coverage, floors) {
  /** @type {string[]} */
  const out = [];
  for (const family of COVERAGE_FAMILIES) {
    const floor = floors[family];
    if (!Number.isInteger(floor) || floor < 0) {
      out.push(
        `coverage floor ${String(floor)} for ${family} is not a row count — set ${floorVar(family)} to an integer ≥ 0`,
      );
      continue;
    }
    const rows = coverage[family] ?? 0;
    if (rows < floor) {
      out.push(
        `${family}: both engines carried data on ${rows} row(s), below the floor of ${floor} — a family measured on nothing certifies nothing`,
      );
    }
  }
  return out;
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
 * The two engines' footers for THIS row — `dedup.js`'s marker and the server's `original_url`.
 * Both pin the repo and the row's own id, so a look-alike last line is content, not a footer.
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
  const releaseTarget = release
    ? `(?:api\\.github\\.com/repos/${scope}/releases/${release[1]}|github\\.com/${scope}/releases/tag/[^\\s)]+)`
    : "";
  // `dedup.js`'s `markerFor` writes /issues/ or /releases/ and reads /issues/ back, so
  // an `Imported from …/pull/N` line is content the direct engine never wrote.
  const marker = release ? releaseTarget : `github\\.com/${scope}/issues/${escapeRegExp(key)}`;
  const original = release
    ? releaseTarget
    : `github\\.com/${scope}/(?:issues|pull)/${escapeRegExp(key)}`;
  return new RegExp(
    `^(?:Imported from https://${marker}|\\[View original issue\\]\\(https://${original}\\))$`,
    "i",
  );
}

/** The block `mapping.js` renders from a row's sub-issue links, at most its two lines. */
const CROSS_LINK_LINE = new RegExp(
  `^(?:${escapeRegExp(SUB_ISSUE_OF_PREFIX)} #\\d+|${escapeRegExp(SUB_ISSUES_PREFIX)} #\\d+(?:, #\\d+)*)$`,
);

/**
 * Split the DIRECT body from the cross-link block at its tail. Only that engine writes the
 * block, so a look-alike line the server body carries too is the issue author's content and
 * stays put. `clampPlan` cuts the body *around* the block, so the truncation notice is not
 * last and the clamp tolerance cannot see it.
 *
 * @param {string} body the direct engine's description body
 * @param {string} serverBody the server engine's, which never carries the block
 * @returns {{ body: string, tail: string }}
 */
function popCrossLinks(body, serverBody) {
  const lines = body.split("\n");
  /** @type {string[]} */
  const tail = [];
  while (lines.length && tail.length < 2 && CROSS_LINK_LINE.test(lines[lines.length - 1].trim())) {
    tail.unshift(/** @type {string} */ (lines.pop()).trim());
  }
  const block = tail.join("\n");
  if (!block || serverBody.trimEnd().endsWith(block)) return { body, tail: "" };
  return { body: lines.join("\n").trimEnd(), tail: block };
}

/**
 * Split a description into body + back-link footer, so two bodies compare on content. Only the
 * last non-blank line is eligible — the same rule `dedup.js` reads its marker by.
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

/**
 * True when `clamped` is `full` cut short by `clampBlock` at `limit`: the notice closes it,
 * the cut landed on the limit, and the text it cut really was the longer one.
 *
 * @param {string} clamped
 * @param {string} full
 * @param {number} limit the run's resolved byte limit for this field
 * @returns {boolean}
 */
function clampedPrefixOf(clamped, full, limit) {
  // Anchored on exactly what `clampBlock` writes — `sliceBytes(text, room)` then "\n\n" then
  // the notice — so a quoted notice cannot move the anchor and no trim can empty it.
  const suffix = `\n\n${TRUNCATION_NOTICE}`;
  if (!clamped.endsWith(suffix)) return false;
  const anchor = clamped.slice(0, clamped.length - suffix.length);
  if (!anchor) return false;
  // `sliceBytes` cuts on a code-point boundary, so `clampBlock` lands within 3 bytes of
  // the limit; anything shorter is the CLI losing text, not the limit taking it.
  if (byteLen(clamped) < limit - 3) return false;
  return byteLen(full) > byteLen(clamped) && full.startsWith(anchor);
}

/**
 * True when `clamped` is what `clampPlan` would write for the title `full` came from. `full` is
 * a source prefix of ≥ `limit` bytes, so the CLI's `limit - 3` byte cut is recoverable from it.
 *
 * @param {string} clamped
 * @param {string} full
 * @param {number} limit the run's resolved `storyName` byte limit
 * @returns {boolean}
 */
function clampedNameOf(clamped, full, limit) {
  if (!clamped.endsWith(NAME_ELLIPSIS) || byteLen(full) < limit) return false;
  return clamped === `${sliceBytes(full, limit - byteLen(NAME_ELLIPSIS))}${NAME_ELLIPSIS}`;
}

/**
 * @typedef {object} Tolerance one accepted shape of difference for a text field
 * @property {string} reason the {@link DIVERGENCES} entry it is filed under
 * @property {(server: string, direct: string) => boolean} matches directional — every
 *   divergence names which engine diverges, so the mirror image stays a mismatch
 */

/** @param {number} limit @returns {Tolerance} */
const clampTo = (limit) => ({
  reason: DIVERGENCES.CLAMP,
  matches: (server, direct) => clampedPrefixOf(direct, server, limit),
});
/** @param {number} limit @returns {Tolerance} */
const nameClampTo = (limit) => ({
  reason: DIVERGENCES.NAME_CLAMP,
  matches: (server, direct) => clampedNameOf(direct, server, limit),
});
/** @type {Tolerance} */
const COMMENT_TRIM = {
  reason: DIVERGENCES.COMMENT_TRIM,
  matches: (server, direct) => server.trim() === direct,
};
/** The CLI trims a comment and then clamps it, so the two divergences can land together. */
const trimmedClampTo = (/** @type {number} */ limit) => ({
  reason: DIVERGENCES.COMMENT_TRIM_CLAMP,
  matches: (/** @type {string} */ server, /** @type {string} */ direct) =>
    clampedPrefixOf(direct, server.trim(), limit),
});

/** The importer's own column width for a task description (`chars().take(255)`). */
const IMPORTER_TASK_CHARS = 255;

/** @type {Tolerance} */
const TASK_TRUNCATE = {
  reason: DIVERGENCES.TASK_TRUNCATE,
  matches: (server, direct) => {
    const [cut, whole] = [[...server], [...direct]];
    return (
      cut.length === IMPORTER_TASK_CHARS &&
      whole.length > IMPORTER_TASK_CHARS &&
      whole.slice(0, IMPORTER_TASK_CHARS).join("") === server
    );
  },
};

/**
 * Compare one text field: equal, tolerated (the reason), or genuinely different.
 *
 * @param {string} a the server engine's value
 * @param {string} b the direct engine's value
 * @param {Tolerance[]} tolerances
 * @returns {"equal" | "differ" | string}
 */
function compareText(a, b, tolerances) {
  if (a === b) return "equal";
  for (const t of tolerances) if (t.matches(a, b)) return t.reason;
  return "differ";
}

const WINDOW = 200;
/** Context kept before the first difference, so the window reads in its surroundings. */
const WINDOW_LEAD = 40;

/** @param {string} text @param {number} start @returns {string} */
function windowAt(text, start) {
  if (text.length <= WINDOW) return text;
  const end = Math.min(text.length, start + WINDOW);
  const [head, tail] = [start > 0 ? "…" : "", end < text.length ? "…" : ""];
  return `${head}${text.slice(start, end)}${tail} (${text.length} chars)`;
}

/**
 * Both sides are cut at the same offset, around the first character they differ at — a
 * cut at 0 prints two identical heads for a difference deep in a long body.
 *
 * @param {unknown} server
 * @param {unknown} direct
 * @returns {[string, string]}
 */
function renderPair(server, direct) {
  const [x, y] = [
    JSON.stringify(server) ?? String(server),
    JSON.stringify(direct) ?? String(direct),
  ];
  if (x.length <= WINDOW && y.length <= WINDOW) return [x, y];
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  const start = Math.max(0, i - WINDOW_LEAD);
  return [windowAt(x, start), windowAt(y, start)];
}

/**
 * The whole comparison as text: mismatches keyed by issue, then tolerated, then uncompared.
 *
 * @param {ReturnType<typeof compareProjects>} result
 * @returns {string}
 */
export function formatReport({ mismatches, tolerated, skipped, counts, coverage }) {
  const issues = new Set(mismatches.map((m) => m.key)).size;
  const lines = [
    `PARITY: ${mismatches.length} mismatching field(s) across ${issues} issue(s)`,
    `story count: server ${counts.server}, direct ${counts.direct}, compared ${counts.compared}`,
  ];
  if (counts.server !== counts.serverKeys || counts.direct !== counts.directKeys) {
    lines.push(`distinct keys: server ${counts.serverKeys}, direct ${counts.directKeys}`);
  }
  // "Equal" and "both sides read nothing" are the same verdict, so the run has to say
  // how many rows each family was measured on rather than let an empty read pass as parity.
  const families = Object.entries(coverage)
    .map(([family, rows]) => `${family} ${rows}`)
    .join(", ");
  lines.push(`rows both engines carried data on: ${families}`);
  if (mismatches.length) lines.push("");
  for (const m of mismatches) {
    const gutter = `issue #${m.key}`.padEnd(16);
    const [server, direct] = renderPair(m.server, m.direct);
    lines.push(`  ${gutter} ${m.field.padEnd(26)} server=${server}`);
    lines.push(`  ${" ".repeat(16)} ${" ".repeat(26)} direct=${direct}`);
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
 * Not `localeCompare`: it ignores the separator and ties on normalisation/zero-width text,
 * so `Array#sort` falls back to an input order the two engines need not share.
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
 * The list endpoint orders by `created`, so same-instant comments come back either way round.
 * The trimmed text leads the tuple so {@link DIVERGENCES.COMMENT_TRIM} still pairs correctly.
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

/** The names `mapping.js` attaches for a closed `state_reason`; the importer writes none of them. */
const CLOSURE_LABEL_NAMES = new Set(CLOSED_REASON_LABELS.values());

/**
 * The one closure-reason label the direct engine added on top of the server's set, or null.
 * Positive evidence for {@link DIVERGENCES.CLOSED_REASON} — without it a state or label
 * difference is an ordinary mismatch, in either direction.
 *
 * @param {ParityRow["labels"]} serverLabels
 * @param {ParityRow["labels"]} directLabels
 * @returns {string | null}
 */
function closureLabel(serverLabels, directLabels) {
  if (directLabels.length !== serverLabels.length + 1) return null;
  const remaining = [...directLabels];
  for (const label of serverLabels) {
    const at = remaining.findIndex((l) => l.name === label.name);
    if (at < 0) return null;
    remaining.splice(at, 1);
  }
  return CLOSURE_LABEL_NAMES.has(remaining[0].name) ? remaining[0].name : null;
}

/**
 * Position carries no cross-engine meaning ({@link DIVERGENCES.TASK_ORDER}), so
 * the comparison canonicalises it away rather than pairing tasks by index.
 *
 * @param {ParityRow["tasks"]} tasks
 * @returns {ParityRow["tasks"]}
 */
const canonicalTasks = (tasks) => canonical(tasks, (t) => [t.description, t.complete]);

/**
 * Building the row maps collapses duplicate keys silently, so a dedup or re-import regression
 * that wrote an issue twice would otherwise compare — and pass — as one row.
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
 * @param {{ unavailable?: Record<string, string>, repo?: { owner: string, name: string },
 *   limits?: import("../src/mapping.js").FieldLimits }} [options]
 *   `unavailable` fields are reported, never silently dropped; `repo` pins the back-link footers,
 *   and `limits` are the write limits the clamp tolerances check the cut against.
 * @returns {{ mismatches: Mismatch[], tolerated: Tolerated[],
 *   skipped: { field: string, reason: string }[],
 *   counts: { server: number, direct: number, compared: number,
 *     serverKeys: number, directKeys: number },
 *   coverage: Record<string, number> }}
 */
export function compareProjects(
  serverRows,
  directRows,
  { unavailable = {}, repo, limits = FALLBACK_LIMITS } = {},
) {
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
  /** @type {Record<string, number>} */
  const coverage = { comments: 0, tasks: 0, labels: 0, owners: 0, requestor: 0 };

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

    const [labelsA, labelsB] = [canonicalLabels(a.labels), canonicalLabels(b.labels)];
    const closure = closureLabel(labelsA, labelsB);

    for (const field of INSTANT_FIELDS) {
      const x = /** @type {string | null} */ (a[/** @type {keyof ParityRow} */ (field)]);
      const y = /** @type {string | null} */ (b[/** @type {keyof ParityRow} */ (field)]);
      if (sameSecond(x, y)) continue;
      const entry = { key, field, server: x, direct: y };
      if (field === "rejected_at" && closure && x == null && y != null) {
        tolerated.push({ ...entry, reason: DIVERGENCES.CLOSED_REASON });
      } else mismatches.push(entry);
    }

    if (!("completed_at" in unavailable) && !sameSecond(a.completed_at, b.completed_at)) {
      const entry = { key, field: "completed_at", server: a.completed_at, direct: b.completed_at };
      const known =
        a.current_state === "rejected" && b.current_state === "rejected" && b.completed_at == null;
      if (known) tolerated.push({ ...entry, reason: DIVERGENCES.REJECTED_COMPLETED_AT });
      else mismatches.push(entry);
    }

    for (const field of SCALAR_FIELDS) {
      if (field in unavailable) continue;
      const x = a[/** @type {keyof ParityRow} */ (field)];
      const y = b[/** @type {keyof ParityRow} */ (field)];
      if (x === y) continue;
      const entry = { key, field, server: x, direct: y };
      if (field === "current_state" && closure && x === "accepted" && y === "rejected") {
        tolerated.push({ ...entry, reason: DIVERGENCES.CLOSED_REASON });
      } else mismatches.push(entry);
    }

    /** @param {string} field @param {string} x @param {string} y @param {Tolerance[]} allow */
    const text = (field, x, y, allow) => {
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

    text("name", a.name ?? "", b.name ?? "", [nameClampTo(limits.storyName)]);

    const [rawA, rawB] = [a.description ?? "", b.description ?? ""];
    const [popA, popB] = [popBackLink(rawA, key, repo), popBackLink(rawB, key, repo)];
    const xlB = popCrossLinks(popB.body, popA.body);
    if (xlB.tail) {
      const field = "description.cross-links";
      tolerated.push({ key, field, server: "", direct: xlB.tail, reason: DIVERGENCES.CROSS_LINKS });
    }
    // The direct engine's own room: `clampPlan` reserves the marker footer, then cuts
    // the body around the cross-link tail, so both come off the limit its notice sits on.
    const bodyLimit =
      limits.storyDescription -
      (popB.footer ? byteLen(popB.footer) + 2 : 0) -
      (xlB.tail ? byteLen(xlB.tail) + 2 : 0);
    const body = text("description", popA.body, xlB.body, [clampTo(bodyLimit)]);
    if (body === "equal" && rawA !== rawB) {
      const entry = { key, field: "description", server: rawA, direct: rawB };
      // Only the DIRECT side's own marker earns the tolerance: a direct row without it lost
      // `dedup.js`'s re-import key, which is the whole dedup on a server with no provenance.
      if (popB.footer) tolerated.push({ ...entry, reason: DIVERGENCES.BACKLINK });
      else if (popA.footer || !xlB.tail) mismatches.push(entry);
    }

    const [tasksA, tasksB] = [canonicalTasks(a.tasks), canonicalTasks(b.tasks)];
    if (tasksA.length && tasksB.length) coverage.tasks += 1;
    if (tasksA.length !== tasksB.length) {
      same("tasks.length", tasksA.length, tasksB.length);
    } else {
      tasksA.forEach((task, i) => {
        text(`tasks[${i}].description`, task.description, tasksB[i].description, [
          clampTo(limits.taskDescription),
          TASK_TRUNCATE,
        ]);
        same(`tasks[${i}].complete`, task.complete, tasksB[i].complete);
      });
    }

    const [commentsA, commentsB] = [canonicalComments(a.comments), canonicalComments(b.comments)];
    if (commentsA.length && commentsB.length) coverage.comments += 1;
    if (commentsA.length !== commentsB.length) {
      same("comments.length", commentsA.length, commentsB.length);
    } else {
      commentsA.forEach((comment, i) => {
        text(`comments[${i}].text`, comment.text, commentsB[i].text, [
          clampTo(limits.commentText),
          COMMENT_TRIM,
          trimmedClampTo(limits.commentText),
        ]);
        if (!sameSecond(comment.created, commentsB[i].created)) {
          same(`comments[${i}].created`, comment.created, commentsB[i].created);
        }
        same(`comments[${i}].author`, actorKey(comment.author), actorKey(commentsB[i].author));
      });
    }

    if (labelsA.length && labelsB.length) coverage.labels += 1;
    // The closure-reason label is the direct engine's alone, so it comes off before the
    // sets are paired; without it a size difference stays an ordinary mismatch.
    const dropAt = closure ? labelsB.findIndex((l) => l.name === closure) : -1;
    const pairedB =
      dropAt < 0 ? labelsB : [...labelsB.slice(0, dropAt), ...labelsB.slice(dropAt + 1)];
    if (closure) {
      tolerated.push({
        key,
        field: "labels",
        server: "",
        direct: closure,
        reason: DIVERGENCES.CLOSED_REASON,
      });
    }
    if (labelsA.length !== pairedB.length) {
      same("labels.length", labelsA.length, pairedB.length);
    } else {
      labelsA.forEach((label, i) => {
        for (const part of ["name", "background_color_hex", "text_color_hex"]) {
          const field = /** @type {keyof typeof label} */ (part);
          same(`labels[${i}].${part}`, label[field], pairedB[i][field]);
        }
      });
    }

    same("requestor", actorKey(a.requestor), actorKey(b.requestor));
    if (actorKey(a.requestor) !== "none" && actorKey(b.requestor) !== "none") {
      coverage.requestor += 1;
    }
    const people = (/** @type {unknown[]} */ owners) =>
      (owners ?? []).map(actorKey).sort().join(", ");
    same("owners", people(a.owners), people(b.owners));
    if ((a.owners ?? []).length && (b.owners ?? []).length) coverage.owners += 1;
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
    coverage,
  };
}
