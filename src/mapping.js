/**
 * The direct engine's default mapping profile: GitHub issue JSON in → EAT write-op plan out (pure, no HTTP).
 * Mirrors the server importer's issue mapping (agile-tracker github.rs + common.rs) so both engines classify
 * identically, with three deliberate exceptions the server never produces: the closed-reason labels, the
 * org issue-type field (the server's `GhIssue` has no `type`, so serde drops it), and the sub-issue
 * cross-link block.
 */

// Composed so `--customize` can drop the tasks fragment / comments line without
// the default legend drifting: ISSUES_LEGEND stays byte-identical to before.
const STATE_LINE =
  "open issue → story (unstarted); closed issue → story (accepted, keeps the closed date)";
const LABELS_LINE = "labels → labels (with colors)";
const TASKS_SUFFIX = "; issue-body checklists → story tasks";
const COMMENTS_LINE = "comments → comments (body only)";
// Direct-only: the server importer flattens every closed issue, so naming the
// reason labels in its legend would promise output it does not produce.
const CLOSED_REASON_LINE =
  "closed as not planned / duplicate → accepted, plus a 'not-planned' / 'duplicate' label";
/**
 * Direct-only for the same reason: the server's issue struct has no `type` field. Built from
 * {@link ISSUE_TYPE_STORY_TYPES} (a function, so the table can stay beside its lookup) so a
 * new entry can never leave this line naming fewer names than the mapper accepts.
 *
 * @returns {string}
 */
function issueTypeLine() {
  /** @type {Map<string, string[]>} display names per story type, in table order */
  const groups = new Map();
  for (const [name, storyType] of ISSUE_TYPE_STORY_TYPES) {
    const display = name[0].toUpperCase() + name.slice(1);
    groups.set(storyType, [...(groups.get(storyType) ?? []), display]);
  }
  const rules = [...groups]
    .map(([storyType, names]) => `${names.join(" / ")} → ${storyType}`)
    .join("; ");
  return `issue type ${rules}; otherwise labels + title decide`;
}

// One definition of each opener, so the legend below and the description assembly
// far below cannot drift apart.
const SUB_ISSUE_OF_PREFIX = "Sub-issue of";
const SUB_ISSUES_PREFIX = "Sub-issues:";
// Direct-only for the same reason as the two lines above. Built from the prefixes the
// assembly itself renders, so renaming one cannot leave this line describing the old text.
const SUB_ISSUES_LINE =
  `sub-issues → '${SUB_ISSUE_OF_PREFIX} #n' / '${SUB_ISSUES_PREFIX} #n, #n' in the ` +
  "description's last paragraph";

// Milestone titles are untrusted remote data; strip terminal control chars
// (ESC/C0/C1/DEL) before they reach the terminal, in the wizard and the legend alike.
export const stripControls = (/** @type {string} */ s) => s.replace(/\p{Cc}/gu, "");

/**
 * The issues legend for a run, and the only place these lines are assembled. It describes the
 * mapping, not the selection, so a *filter* (`states`, `milestones`) never drops a line; only
 * the mapping overrides do — `comments`/`tasks`, and `storyType`, which switches the rule the
 * issue-type line describes off for the whole run.
 *
 * @param {import("./engine.js").Engine} [engine]
 * @param {Customization | null} [customization]
 * @returns {string[]}
 */
export function issuesLegend(engine = "server", customization = null) {
  const { comments, tasks, storyType } = customization ?? DEFAULT_CUSTOMIZATION;
  const lines = [STATE_LINE];
  if (engine === "direct") {
    lines.push(CLOSED_REASON_LINE);
    if (storyType === "infer") lines.push(issueTypeLine());
    lines.push(SUB_ISSUES_LINE);
  }
  lines.push(tasks ? `${LABELS_LINE}${TASKS_SUFFIX}` : LABELS_LINE);
  if (comments) lines.push(COMMENTS_LINE);
  return lines;
}

/**
 * One human-readable line per non-default choice, for the legend's `Customized:`
 * block. Empty when every field is at its default (an all-default customization
 * must render nothing, keeping the legend byte-identical).
 *
 * @param {Customization} customization
 * @returns {string[]}
 */
export function describeCustomization({ states, milestones, storyType, comments, tasks }) {
  const lines = describeFilters({ states, milestones });
  if (storyType !== "infer") lines.push(`story type: all ${storyType}`);
  if (!comments) lines.push("comments: not imported");
  if (!tasks) lines.push("tasks: not imported");
  return lines;
}

/**
 * Whether a milestone allowlist is actually in force. Legend, matcher and the
 * zero-import warner must agree that an empty one means "all" — and `string[] | null`
 * is truthy-checkable — so the rule lives here and nowhere else.
 *
 * @param {Customization["milestones"]} milestones
 * @returns {milestones is string[]}
 */
export function hasMilestoneFilter(milestones) {
  return Boolean(milestones?.length);
}

/**
 * The subset of {@link describeCustomization} that can drop issues, so a run
 * that maps nothing can name the filters responsible in the same words.
 *
 * @param {Pick<Customization, "states" | "milestones">} customization
 * @returns {string[]}
 */
export function describeFilters({ states, milestones }) {
  /** @type {string[]} */
  const lines = [];
  if (states !== "all") lines.push(`issue states: ${states} only`);
  if (hasMilestoneFilter(milestones)) {
    lines.push(`milestones: ${milestones.map(stripControls).join(", ")}`);
  }
  return lines;
}

/**
 * @param {any} issue
 * @param {Customization["states"]} states
 * @returns {boolean}
 */
export function matchesStates(issue, states) {
  return states === "all" || String(issue.state ?? "").toLowerCase() === states;
}

/**
 * @param {any} issue
 * @param {Customization["milestones"]} milestones
 * @returns {boolean}
 */
export function matchesMilestones(issue, milestones) {
  return !hasMilestoneFilter(milestones) || milestones.includes(issue.milestone?.title);
}

/**
 * @typedef {object} Customization per-run mapping overrides (`--customize`)
 * @property {"all" | "open" | "closed"} states which GitHub issue states to import
 * @property {string[] | null} milestones exact `milestone.title` allowlist; null — or an
 *   empty array, treated the same way — imports every issue
 * @property {"infer" | "feature" | "bug" | "chore"} storyType "infer" reads the org's issue
 *   type first, falling back to {@link inferStoryType}
 * @property {boolean} comments import issue comments
 * @property {boolean} tasks import body checklists as tasks
 */

/**
 * The no-op customization: every field set so the mapping matches the default
 * profile byte-for-byte. The wizard story replaces these with the member's answers.
 *
 * @type {Customization}
 */
export const DEFAULT_CUSTOMIZATION = {
  states: "all",
  milestones: null,
  storyType: "infer",
  comments: true,
  tasks: true,
};

/**
 * The default (server-engine) issues legend the MAPPINGS registry re-exports — the renderer's
 * own output, not a second copy of it, so the registry entry can never describe a dead path.
 */
export const ISSUES_LEGEND = issuesLegend();

/** @type {Customization["states"][]} */
const STATES = ["all", "open", "closed"];

/** @type {Customization["storyType"][]} */
const STORY_TYPES = ["infer", "feature", "bug", "chore"];

/** The CLI flags {@link parseCustomization} reads, in help/usage order. */
const CUSTOMIZATION_FLAGS = ["states", "milestones", "story-type", "no-comments", "no-tasks"];

/**
 * Which customization flags a parsed argv actually carried, `--`-prefixed for
 * error messages. Drives "implies --engine direct" and the conflict checks.
 *
 * @param {Record<string, unknown>} values `parseArgs` values
 * @returns {string[]}
 */
export function customizationFlagsGiven(values) {
  return CUSTOMIZATION_FLAGS.filter((flag) => values[flag] !== undefined).map(
    (flag) => `--${flag}`,
  );
}

/**
 * @param {string} flag
 * @param {string} value
 * @param {readonly (string | undefined)[]} allowed
 * @returns {never}
 */
function invalidValue(flag, value, allowed) {
  throw new Error(
    `argument ${flag}: invalid value '${stripControls(value)}'; valid values: ${allowed.join(", ")}`,
  );
}

/**
 * One `--milestones` occurrence's titles. Splitting on commas would put a
 * comma-bearing GitHub milestone out of reach, so `\,` escapes one.
 *
 * @param {string} occurrence
 * @returns {string[]}
 */
const splitTitles = (occurrence) =>
  occurrence.split(/(?<!\\),/).map((title) => title.replace(/\\,/g, ","));

/**
 * The declarative counterpart to the wizard: same object, no terminal. Omitted
 * flags keep their {@link DEFAULT_CUSTOMIZATION} value; a bad value throws.
 * `--milestones` may repeat; every occurrence's titles flatten into one list.
 *
 * @param {Record<string, unknown>} values `parseArgs` values
 * @returns {Customization}
 */
export function parseCustomization(values) {
  const states = /** @type {string | undefined} */ (values.states);
  if (states !== undefined && !STATES.includes(/** @type {any} */ (states))) {
    invalidValue("--states", states, STATES);
  }
  const storyType = /** @type {string | undefined} */ (values["story-type"]);
  if (storyType !== undefined && !STORY_TYPES.includes(/** @type {any} */ (storyType))) {
    invalidValue("--story-type", storyType, STORY_TYPES);
  }

  const raw = /** @type {string | string[] | undefined} */ (values.milestones);
  /** @type {string[] | null} */
  let milestones = null;
  if (raw !== undefined) {
    milestones = [
      ...new Set(
        (Array.isArray(raw) ? raw : [raw])
          .flatMap(splitTitles)
          .map((title) => title.trim())
          .filter(Boolean),
      ),
    ];
    if (!milestones.length) {
      throw new Error(
        "argument --milestones: needs at least one milestone title, " +
          'e.g. --milestones "v1.0,v2.0"',
      );
    }
  }

  return {
    states: /** @type {Customization["states"]} */ (states ?? DEFAULT_CUSTOMIZATION.states),
    milestones,
    storyType: /** @type {Customization["storyType"]} */ (
      storyType ?? DEFAULT_CUSTOMIZATION.storyType
    ),
    comments: !values["no-comments"],
    tasks: !values["no-tasks"],
  };
}

/**
 * The story types GitHub's org-defined issue-type names declare, by lowercased name.
 * Only these classify; anything else falls through to {@link inferStoryType}. `Task` is
 * ordinary product work in GitHub's own seeded set, so it types as `feature`, not `chore`.
 *
 * @type {Map<string, "bug" | "chore" | "feature">}
 */
export const ISSUE_TYPE_STORY_TYPES = new Map([
  ["bug", "bug"],
  ["feature", "feature"],
  ["enhancement", "feature"],
  ["task", "feature"],
  ["chore", "chore"],
]);

/** The table's names as an org sees them, for the unrecognised-type warning. */
export const ISSUE_TYPE_NAMES = [...ISSUE_TYPE_STORY_TYPES.keys()].map(
  (name) => name[0].toUpperCase() + name.slice(1),
);

/**
 * The story type an org's issue type declares, or null. Names are org-authored free text, so
 * the match is case-insensitive on the trimmed name — and string-guarded, never coercing a
 * non-string. Matching is exact, so a name like `Bug Report` does not classify.
 *
 * @param {unknown} issueType the REST row's `type` (null when unset; the key is absent
 *   entirely on personal-account repos and older GitHub Enterprise Server)
 * @returns {"bug" | "chore" | "feature" | null}
 */
export function storyTypeFromIssueType(issueType) {
  const name = /** @type {{ name?: unknown } | null | undefined} */ (issueType)?.name;
  if (typeof name !== "string") return null;
  return ISSUE_TYPE_STORY_TYPES.get(name.trim().toLowerCase()) ?? null;
}

/**
 * Infer a story type from the conventional labels + the title — the fallback when the org
 * set no issue type. Bug is checked first: a row that matches both rules is a bug.
 *
 * @param {string[]} labels label names
 * @param {string} title
 * @returns {"bug" | "chore" | "feature"}
 */
export function inferStoryType(labels, title) {
  const lower = labels.map((l) => l.toLowerCase());
  const lowerTitle = title.toLowerCase();
  if (
    lower.some((l) => l.includes("bug") || l.includes("fix") || l.includes("defect")) ||
    lowerTitle.startsWith("fix") ||
    lowerTitle.startsWith("bug")
  ) {
    return "bug";
  }
  if (
    lower.some(
      (l) =>
        l.includes("chore") ||
        l.includes("maintenance") ||
        l.includes("devops") ||
        l.includes("infra"),
    )
  ) {
    return "chore";
  }
  return "feature";
}

/**
 * Normalize a GitHub label color (6 hex digits, `#` optional) to lowercase
 * `#rrggbb`. Anything else is dropped — a bad color must never fail an import.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeHexColor(raw) {
  const h = raw.trim().replace(/^#+/, "");
  return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toLowerCase()}` : null;
}

/**
 * Pick a readable text color for a `#rrggbb` background: black on light,
 * white on dark (perceptual-luminance threshold), black on malformed.
 *
 * @param {string} bg
 * @returns {"#000000" | "#ffffff"}
 */
export function contrastTextColor(bg) {
  const hex = normalizeHexColor(bg);
  if (!hex) return "#000000";
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000000" : "#ffffff";
}

/**
 * Parse GitHub-flavored checklist items (`- [ ]` / `- [x]`, also `*`/`+` markers) in body order.
 * Nested items flatten, blank items are dropped; the lines stay in the description verbatim.
 *
 * @param {string} body
 * @returns {{ description: string, complete: boolean }[]}
 */
export function parseChecklist(body) {
  /** @type {{ description: string, complete: boolean }[]} */
  const out = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.trimStart().match(/^[-*+] \[( |x|X)\](.*)$/);
    if (!match) continue;
    const description = match[2].trim();
    if (!description) continue;
    out.push({ description, complete: match[1] !== " " });
  }
  return out;
}

/**
 * A sub-issue reference as the fetcher renders one: digits only. Anything else is
 * dropped rather than rendered, so no org-authored text can ride into a description.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
const isIssueNumber = (value) => typeof value === "string" && /^[0-9]+$/.test(value);

/**
 * Index a fetched parent → children map into the two lookups the description assembly
 * needs. GitHub gives an issue one parent; if a payload claims two, the first wins.
 *
 * @param {Map<string, string[]> | null | undefined} subIssues
 * @returns {{ children: Map<string, string[]>, parents: Map<string, string> }}
 */
function indexSubIssues(subIssues) {
  /** @type {Map<string, string[]>} */
  const children = new Map();
  /** @type {Map<string, string>} */
  const parents = new Map();
  for (const [parent, kids] of subIssues instanceof Map ? subIssues : []) {
    if (!isIssueNumber(parent) || !Array.isArray(kids)) continue;
    /** @type {string[]} */
    const kept = [];
    for (const kid of kids) {
      // `parents` is the arbiter for both directions, so a child claimed twice cannot
      // leave one story listing it while the child disclaims that story.
      if (!isIssueNumber(kid) || kid === parent || parents.has(kid)) continue;
      parents.set(kid, parent);
      kept.push(kid);
    }
    children.set(parent, kept);
  }
  return { children, parents };
}

/**
 * One issue's cross-link lines: its parent first, then its children — reading
 * top-down, where the story sits before what sits under it.
 *
 * @param {string} externalId
 * @param {ReturnType<typeof indexSubIssues>} index
 * @returns {string[]}
 */
function subIssueLines(externalId, { children, parents }) {
  /** @type {string[]} */
  const lines = [];
  const parent = parents.get(externalId);
  if (parent !== undefined) lines.push(`${SUB_ISSUE_OF_PREFIX} #${parent}`);
  const kids = children.get(externalId);
  if (kids?.length) lines.push(`${SUB_ISSUES_PREFIX} ${kids.map((n) => `#${n}`).join(", ")}`);
  return lines;
}

/** @param {string | null | undefined} issueUrl @returns {string | null} */
function issueNumberFromUrl(issueUrl) {
  const match = (issueUrl ?? "").match(/\/issues\/(\d+)$/);
  return match ? match[1] : null;
}

/**
 * The public EAT API has no comment-author attribution (EAT-team ask pending), so the author
 * rides in the text prefix; a deleted GitHub account renders as `@ghost`. When `sendDates` is
 * false the date rides there too (`@login on <date>:`), matching an older server; when true the
 * comment's real `created_at` is sent on the write instead, so the prefix collapses to `@login:`.
 *
 * @param {{ user?: { login?: string } | null, created_at?: string | null, body?: string | null }} comment
 * @param {boolean} sendDates
 * @returns {string}
 */
function commentText(comment, sendDates) {
  const login = comment.user?.login || "ghost";
  const date = (comment.created_at ?? "").slice(0, 10);
  const prefix = date && !sendDates ? `@${login} on ${date}:` : `@${login}:`;
  return `${prefix}\n\n${(comment.body ?? "").trim()}`;
}

/**
 * @typedef {object} LabelOp one EAT label to get-or-create
 * @property {string} name
 * @property {string} [background_color_hex] lowercase `#rrggbb`
 * @property {string} [text_color_hex] contrast-picked when a background exists
 */

/** The closed `state_reason` values that earn a label, by GitHub's spelling. */
export const CLOSED_REASON_LABELS = new Map([
  ["not_planned", "not-planned"],
  ["duplicate", "duplicate"],
]);

/**
 * Only GitHub's exact lowercase spellings map — an open row, `completed`, an absent or
 * non-string reason and any reason GitHub adds later all leave that output identical to v3.
 *
 * @param {boolean} closed
 * @param {unknown} stateReason
 * @returns {string | null}
 */
function closedReasonLabel(closed, stateReason) {
  if (!closed || typeof stateReason !== "string") return null;
  return CLOSED_REASON_LABELS.get(stateReason) ?? null;
}

/**
 * @typedef {object} StoryOp one EAT story to create, with its sub-resources
 * @property {string} external_id the GitHub issue number, as a string
 * @property {string} name EAT's create-body title field
 * @property {string | null} description issue body, trimmed, plus `crossLinks`
 * @property {string} [crossLinks] the cross-link block already at the tail of
 *   `description` (empty when the issue is in no sub-issue relation). Carried so
 *   {@link clampPlan} can cut the body around it; the writer never sends it.
 * @property {"bug" | "chore" | "feature"} story_type
 * @property {"unstarted" | "accepted"} current_state
 * @property {string | null} created_at
 * @property {string | null} completed_at the GitHub closed date, kept
 * @property {string[]} labels label names on this story
 * @property {{ description: string, complete: boolean }[]} tasks
 * @property {{ text: string, created_at: string | null }[]} comments
 */

/**
 * Map a fetched repo ({@link import("./github.js").GitHubClient#fetchAll}'s shape) to the direct
 * writer's plan. Joining comments by `issue_url` drops PR chatter — those numbers are unmapped PRs.
 *
 * @param {{ issues: any[], comments: any[], labels: any[],
 *   subIssues?: Map<string, string[]> | null }} repo
 * @param {Customization} [customization] per-run overrides; the default reproduces
 *   this profile unchanged (the filter/override stories consume the other fields)
 * @param {boolean} [sendDates] when true the comment's date is sent on the write, so
 *   its prefix collapses to `@login:`; when false (default) it stays `@login on <date>:`,
 *   reproducing the older-server output byte-for-byte
 * @returns {{ labels: LabelOp[], stories: StoryOp[] }}
 */
export function mapRepo(
  { issues, comments, labels, subIssues },
  customization = DEFAULT_CUSTOMIZATION,
  sendDates = false,
) {
  const links = indexSubIssues(subIssues);
  /** @type {Map<string, string | null>} repo-level color authority, by lowercased name */
  const repoColors = new Map(
    labels.map((l) => [
      String(l.name ?? "").toLowerCase(),
      l.color ? normalizeHexColor(String(l.color)) : null,
    ]),
  );

  /** @type {Map<string, LabelOp>} keyed by lowercased name, like the server's label cache */
  const labelOps = new Map();
  /** @type {Map<string, { text: string, created_at: string | null }[]>} comments per issue number */
  const byIssue = new Map();

  /** @type {StoryOp[]} */
  const stories = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const state = String(issue.state ?? "").toLowerCase();
    if (!matchesStates(issue, customization.states)) continue;
    if (!matchesMilestones(issue, customization.milestones)) continue;

    /** @type {string[]} */
    const names = [];
    /** @type {Set<string>} names already on this story, lowercased like labelOps */
    const seen = new Set();
    /** @param {unknown} rawName @param {unknown} rawColor */
    const addLabel = (rawName, rawColor) => {
      const name = String(rawName ?? "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        names.push(name);
      }
      if (!labelOps.has(key)) {
        const color =
          (rawColor ? normalizeHexColor(String(rawColor)) : null) ?? repoColors.get(key);
        labelOps.set(
          key,
          color
            ? { name, background_color_hex: color, text_color_hex: contrastTextColor(color) }
            : { name },
        );
      }
    };
    for (const label of issue.labels ?? []) addLabel(label.name, label.color);

    const title = String(issue.title ?? "");
    // Run here so the heuristic reads the author's own labels, never one this
    // mapper appends to `names` below.
    const storyType =
      customization.storyType === "infer"
        ? (storyTypeFromIssueType(issue.type) ?? inferStoryType(names, title))
        : customization.storyType;

    const closed = state === "closed";
    // Closed is closed, so the state stays `accepted`; the label is what lets a
    // board filter tell closed-as-done from closed-as-wontfix.
    addLabel(closedReasonLabel(closed, issue.state_reason), null);

    const body = (issue.body ?? "").trim();
    const externalId = String(issue.number);
    // The block is the description's last paragraph, so the dedup marker the writer
    // appends after it stays the last line — `markerExternalId` reads only that line.
    const crossLinks = subIssueLines(externalId, links).join("\n");
    const story = {
      external_id: externalId,
      name: title,
      description: [body, crossLinks].filter(Boolean).join("\n\n") || null,
      crossLinks,
      story_type: storyType,
      current_state: /** @type {"unstarted" | "accepted"} */ (closed ? "accepted" : "unstarted"),
      created_at: issue.created_at ?? null,
      completed_at: (closed ? issue.closed_at : null) ?? null,
      labels: names,
      tasks: customization.tasks ? parseChecklist(body) : [],
      comments: /** @type {{ text: string, created_at: string | null }[]} */ ([]),
    };
    byIssue.set(story.external_id, story.comments);
    stories.push(story);
  }

  for (const comment of customization.comments ? comments : []) {
    if (!(comment.body ?? "").trim()) continue;
    const target = byIssue.get(issueNumberFromUrl(comment.issue_url) ?? "");
    if (target) {
      target.push({
        text: commentText(comment, sendDates),
        created_at: comment.created_at ?? null,
      });
    }
  }

  return { labels: [...labelOps.values()], stories };
}

/**
 * @typedef {object} FieldLimits max UTF-8 bytes per write field
 * @property {number} storyName
 * @property {number} storyDescription
 * @property {number} taskDescription
 * @property {number} commentText
 */

/**
 * Applied when the server's openapi.json publishes no `maxLength` (today's
 * servers publish none). Text limits sit between the longest comment a real
 * server accepted (13,101 chars) and one it rejected `too_long` (46,411).
 *
 * @type {FieldLimits}
 */
export const FALLBACK_LIMITS = {
  storyName: 255,
  storyDescription: 16_000,
  taskDescription: 16_000,
  commentText: 16_000,
};

export const TRUNCATION_NOTICE =
  "[truncated by github-to-eat: the full text exceeds the server's length limit]";

// The server measures every text limit with Rust's str::len() — UTF-8 bytes — while
// JS String.length counts UTF-16 units, so multi-byte text overflows silently.
const byteLen = (/** @type {string} */ s) => Buffer.byteLength(s, "utf8");

/**
 * Longest prefix of `text` fitting `maxBytes`, cut on a code-point boundary so an
 * astral character is never split into a lone surrogate.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function sliceBytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (byteLen(text) <= maxBytes) return text;
  let used = 0;
  let out = "";
  for (const ch of text) {
    const size = byteLen(ch);
    if (used + size > maxBytes) break;
    used += size;
    out += ch;
  }
  return out;
}

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string} within `limit`, ending with {@link TRUNCATION_NOTICE} when cut
 */
function clampBlock(text, limit) {
  if (byteLen(text) <= limit) return text;
  const room = limit - byteLen(TRUNCATION_NOTICE) - 2;
  if (room <= 0) return sliceBytes(text, limit);
  return `${sliceBytes(text, room)}\n\n${TRUNCATION_NOTICE}`;
}

/**
 * Cut every plan text field down to the server's limits so one giant GitHub
 * comment cannot 400 the whole run. Returns a new plan; the input is untouched.
 *
 * @param {{ labels: LabelOp[], stories: StoryOp[] }} plan
 * @param {FieldLimits} limits
 * @param {{ reserveDescription?: (op: StoryOp) => number,
 *   warn?: (message: string) => void }} [options] `reserveDescription` holds
 *   back room per story for text appended later (the dedup marker)
 * @returns {{ labels: LabelOp[], stories: StoryOp[] }}
 */
export function clampPlan(plan, limits, { reserveDescription = () => 0, warn = () => {} } = {}) {
  const stories = plan.stories.map((op) => {
    const out = { ...op };
    /** @param {string} field @param {number} limit */
    const notice = (field, limit) =>
      warn(
        `warning: issue #${op.external_id}: ${field} truncated to ${limit} bytes (server limit)\n`,
      );

    if (byteLen(out.name) > limits.storyName) {
      // The appended ellipsis costs 3 bytes, so hold them back from the prefix.
      out.name = `${sliceBytes(out.name, limits.storyName - byteLen("…"))}…`;
      notice("name", limits.storyName);
    }
    const descriptionLimit = limits.storyDescription - reserveDescription(op);
    if (out.description !== null && byteLen(out.description) > descriptionLimit) {
      // The cross-link block is the description's tail and no later run can repair it
      // (an import never updates), so the body is cut around it, not with it.
      const tail = op.crossLinks ? `\n\n${op.crossLinks}` : "";
      const bodyLimit = descriptionLimit - byteLen(tail);
      out.description =
        tail && bodyLimit > 0 && out.description.endsWith(tail)
          ? clampBlock(out.description.slice(0, -tail.length), bodyLimit) + tail
          : clampBlock(out.description, descriptionLimit);
      notice("description", descriptionLimit);
    }
    out.tasks = op.tasks.map((task, i) => {
      if (byteLen(task.description) <= limits.taskDescription) return task;
      notice(`task ${i + 1}`, limits.taskDescription);
      return { ...task, description: clampBlock(task.description, limits.taskDescription) };
    });
    out.comments = op.comments.map((comment, i) => {
      if (byteLen(comment.text) <= limits.commentText) return comment;
      notice(`comment ${i + 1}`, limits.commentText);
      return { ...comment, text: clampBlock(comment.text, limits.commentText) };
    });
    return out;
  });
  return { labels: plan.labels, stories };
}
