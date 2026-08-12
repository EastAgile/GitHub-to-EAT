/**
 * The direct engine's default mapping profile: GitHub issue JSON in → EAT write-op plan out (pure, no HTTP).
 * Mirrors the server importer's issue mapping (agile-tracker github.rs + common.rs) so both engines classify
 * identically, with three deliberate exceptions the server never produces: the closed-reason state and
 * labels, the org issue-type field (the server's `GhIssue` has no `type`, so serde drops it), and the
 * sub-issue cross-link block.
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
  "closed as not planned / duplicate → rejected (a chore → accepted, having no rejected " +
  "state), plus a 'not-planned' / 'duplicate' label";
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

/** The synthetic label every PR story carries, and the `link_type` its URL rides as. */
export const PULL_REQUEST_LABEL = "pull-request";
export const PULL_REQUEST_LINK_TYPE = "pull_request";

// One definition of each opener, so the legend, the description assembly far below,
// and the parity harness that has to re-recognise the block cannot drift apart.
export const SUB_ISSUE_OF_PREFIX = "Sub-issue of";
export const SUB_ISSUES_PREFIX = "Sub-issues:";
// Direct-only for the same reason as the two lines above. Built from the prefixes the
// assembly itself renders, so renaming one cannot leave this line describing the old text.
const SUB_ISSUES_LINE =
  `sub-issues → '${SUB_ISSUE_OF_PREFIX} #n' / '${SUB_ISSUES_PREFIX} #n, #n' in the ` +
  "description's last paragraph";

// Milestone titles are untrusted remote data: Cc kills ESC/C0/C1/DEL, Cf kills the bidi
// overrides that would reorder a warning line — at the cost of splitting ZWJ emoji.
export const stripControls = (/** @type {string} */ s) => s.replace(/[\p{Cc}\p{Cf}]/gu, "");

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

// The server importer's own note format (github.rs milestone_epic_desc): same prefix,
// same order, same em dash, so a milestone reads identically whichever engine wrote it.
const MILESTONE_NOTE_PREFIX = "GitHub milestone";
const MILESTONE_STATE_LABEL = "State";
const MILESTONE_DUE_LABEL = "Due";

/**
 * The epic's description for a milestone, or null when it carries neither a state nor a
 * due date. The date is trimmed to its `YYYY-MM-DD` prefix, like the server's.
 *
 * @param {unknown} milestone
 * @returns {string | null}
 */
export function milestoneEpicDescription(milestone) {
  const row = /** @type {{ state?: unknown, due_on?: unknown } | null | undefined} */ (milestone);
  /** @type {string[]} */
  const parts = [];
  const state = typeof row?.state === "string" ? row.state.trim() : "";
  if (state) parts.push(`${MILESTONE_STATE_LABEL}: ${state}`);
  const due = typeof row?.due_on === "string" ? row.due_on.trim() : "";
  if (due) parts.push(`${MILESTONE_DUE_LABEL}: ${due.split("T")[0]}`);
  return parts.length ? `${MILESTONE_NOTE_PREFIX} — ${parts.join(", ")}` : null;
}

/** Epic titles and label names are `varchar(255)`, and EAT validates the byte length. */
export const EPIC_TITLE_LIMIT = 255;

/**
 * The server keys epics on `LOWER(TRIM(epic_title))`. Every key — plan side, listing
 * side, dedup side — goes through here, so no two of them can drift apart.
 *
 * @param {string} title
 * @returns {string}
 */
export const epicTitleKey = (title) => title.trim().toLowerCase();

/**
 * Cut to the column width here, not at write time, so the epic and the label its
 * stories carry are always the same string. "" when the milestone names no title.
 * Re-trimmed after the cut: the slice can land on a space the server then trims
 * away, which would key the plan on a title no listing ever returns.
 *
 * @param {unknown} milestone
 * @returns {string}
 */
export function milestoneEpicTitle(milestone) {
  const title = /** @type {{ title?: unknown } | null | undefined} */ (milestone)?.title;
  return typeof title === "string" ? sliceBytes(title.trim(), EPIC_TITLE_LIMIT).trim() : "";
}

const MILESTONE_EPIC_LINE = "milestone → epic (an issue keeps its milestone as the epic's label)";
// Direct-only: the server legend has always printed the one line above. The example is
// rendered by the description builder itself, so the two cannot drift.
const MILESTONE_NOTE_LINE =
  "milestone state + due date → the epic's description ('" +
  `${milestoneEpicDescription({ state: "open", due_on: "2024-12-01" })}'); ` +
  "a closed milestone leaves its epic open";
const MILESTONE_REUSE_LINE =
  "an epic that already exists is reused, never duplicated; epics and their backing " +
  "labels are not counted in the import totals";

/**
 * No customization flag reaches milestones — `--milestones` selects issues, it does not
 * switch the epic mapping off — so only the engine shapes these lines.
 *
 * @param {import("./engine.js").Engine} [engine]
 * @returns {string[]}
 */
export function milestonesLegend(engine = "server") {
  const lines = [MILESTONE_EPIC_LINE];
  if (engine === "direct") lines.push(MILESTONE_NOTE_LINE, MILESTONE_REUSE_LINE);
  return lines;
}

/** The default (server-engine) milestones legend the MAPPINGS registry re-exports. */
export const MILESTONES_LEGEND = milestonesLegend();

const RELEASE_LINE =
  "release → release-type story (tag → title, notes → description, publish date kept)";
// Direct-only: naming drafts in the server legend would change bytes the server
// engine has always printed, and only the direct engine's mapping is documented here.
const RELEASE_DRAFT_LINE =
  "draft release → story in the backlog (unstarted); no publish date to keep";

/**
 * No customization flag reaches releases — the filters select issues and `release` is the
 * type that defines them — so only the engine shapes these lines.
 *
 * @param {import("./engine.js").Engine} [engine]
 * @returns {string[]}
 */
export function releasesLegend(engine = "server") {
  const lines = [RELEASE_LINE];
  if (engine === "direct") lines.push(RELEASE_DRAFT_LINE);
  return lines;
}

/** The default (server-engine) releases legend the MAPPINGS registry re-exports. */
export const RELEASES_LEGEND = releasesLegend();

const PR_STATE_LINE = `open PR → story (started); merged PR → story (accepted, '${PULL_REQUEST_LABEL}' label)`;
const PR_REJECTED_LINE = "closed-unmerged PR → story (rejected)";
const PR_FOLD_LINE = "a merged PR that closes an imported issue folds into that issue's story";
// Direct-only, like the lines the other renderers add: naming these in the server legend
// would change bytes it has always printed. Byte-compatibility only — the server importer
// writes the same link rows (github.rs:501-513, 1084-1097); its block just never said so.
const PR_SELF_LINK_LINE = `the PR's own URL → a '${PULL_REQUEST_LINK_TYPE}' link on its story`;
const PR_CROSS_LINK_LINE =
  "a PR that closes an imported issue links onto that issue's story; the fold above " +
  "needs that issue closed too";

/**
 * No customization flag reaches PRs — the filters select rows, they do not switch the PR
 * mapping off — so only the engine shapes these lines.
 *
 * @param {import("./engine.js").Engine} [engine]
 * @returns {string[]}
 */
export function prsLegend(engine = "server") {
  const lines = [PR_STATE_LINE, PR_REJECTED_LINE, PR_FOLD_LINE];
  if (engine === "direct") lines.push(PR_SELF_LINK_LINE, PR_CROSS_LINK_LINE);
  return lines;
}

/** The default (server-engine) PR legend the MAPPINGS registry re-exports. */
export const PRS_LEGEND = prsLegend();

// The example is rendered by the description builder itself, so the two cannot drift.
const DEPENDENCY_LINE =
  "issue 'blocked by' dependency → a blocker on its story " +
  `('${blockedByDesc(90, "Upstream fix")}', unresolved)`;
// A lower bound: a listing past 100 dependencies pages, and each page is a request.
const DEPENDENCY_COST_LINE =
  "costs at least one extra GitHub request per issue — an anonymous run (60/h) may need --token";
const DEPENDENCY_UNIMPORTED_LINE =
  "a blocker is recorded whether or not the blocking issue is itself imported";

/**
 * No customization flag reaches dependencies — the filters select issues, and a
 * blocker is not one of the mapping overrides — so only the engine shapes these.
 *
 * @param {import("./engine.js").Engine} [engine]
 * @returns {string[]}
 */
export function depsLegend(engine = "server") {
  // The scope rule holds on both engines; only the request budget is the caller's,
  // and naming it on the server legend — which holds the platform PAT — would be a lie.
  const lines = [DEPENDENCY_LINE, DEPENDENCY_UNIMPORTED_LINE];
  if (engine === "direct") lines.push(DEPENDENCY_COST_LINE);
  return lines;
}

/** The default (server-engine) deps legend the MAPPINGS registry re-exports. */
export const DEPS_LEGEND = depsLegend();

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
  // "all issues", not "all": the override never retypes a release, which the same
  // legend has just said imports as a release-type story.
  if (storyType !== "infer") lines.push(`story type: all issues ${storyType}`);
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
 * The textual fallback for a server that does not accept `ExternalPersonInput`: the author —
 * and, off `sendDates`, the date — rides in a prefix instead of the write's own fields.
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
 * @typedef {object} ExternalPerson one imported GitHub person, `ExternalPersonInput`-shaped
 * @property {"github"} source
 * @property {string} external_id the numeric GitHub user id, stringified
 * @property {string} username the login
 * @property {string} display_name the login again — GitHub payloads carry no profile name
 * @property {string} [html_url] the profile URL, when the payload carried one
 */

/**
 * Mirrors github.rs `valid_gh_user` + `to_person`: no numeric id (the rename-proof
 * dedup key) or no login means no person is carried at all.
 *
 * @param {unknown} user
 * @returns {ExternalPerson | null}
 */
function externalPerson(user) {
  const row = /** @type {{ id?: unknown, login?: unknown, html_url?: unknown } | null} */ (
    user ?? null
  );
  // Safe-integer, not merely non-zero: past 2^53 two GitHub ids stringify to one
  // external_id, merging two people onto one external_member row.
  const id = row?.id;
  if (!Number.isSafeInteger(id) || id === 0) return null;
  const login = typeof row?.login === "string" ? row.login.trim() : "";
  if (!login) return null;
  const htmlUrl = typeof row?.html_url === "string" ? row.html_url.trim() : "";
  return {
    source: /** @type {const} */ ("github"),
    external_id: String(id),
    username: login,
    display_name: login,
    ...(htmlUrl ? { html_url: htmlUrl } : {}),
  };
}

/**
 * @typedef {object} LabelOp one EAT label to get-or-create
 * @property {string} name
 * @property {string} [background_color_hex] lowercase `#rrggbb`
 * @property {string} [text_color_hex] contrast-picked when a background exists
 */

/**
 * @typedef {object} BlockerOp one EAT blocker row to create on a story
 * @property {string} desc `blocker_desc`
 * @property {boolean} [resolved] `CreateBlocker.resolved` is `Option<bool>`; absent is false
 */

/**
 * One `blocked_by` entry's blocker text. Byte-identical to github.rs
 * `blocked_by_desc`, so both engines write the same blocker for a repo.
 *
 * @param {number} number the blocking issue's number
 * @param {string} title its title
 * @returns {string}
 */
export function blockedByDesc(number, title) {
  return `Blocked by #${number} (${title.trim()})`;
}

/**
 * One issue's `blocked_by` rows as blocker ops, mirroring github.rs
 * `list_blocked_by`: skip `number <= 0`, deduplicate by number, keep GitHub's order.
 *
 * @param {any[] | undefined} rows
 * @returns {BlockerOp[]}
 */
function blockersFrom(rows) {
  /** @type {BlockerOp[]} */
  const out = [];
  const seen = new Set();
  for (const row of rows ?? []) {
    // `#[serde(default)]` on both fields: a missing or non-numeric number reads
    // as 0, which the server's own `row.number <= 0` guard drops.
    const number = Number.isInteger(row?.number) ? row.number : 0;
    if (number <= 0 || seen.has(number)) continue;
    seen.add(number);
    out.push({ desc: blockedByDesc(number, String(row?.title ?? "")), resolved: false });
  }
  return out;
}

/**
 * @typedef {object} EpicOp one EAT epic to get-or-create
 * @property {string} title the epic's name, and the name of the label its stories carry
 * @property {string | null} description the milestone's state + due note
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
 * GitHub's auto-close keywords followed by a same-repo `#N`, mirroring `parse_closing_issue_refs`
 * (github.rs:566-615): word-bounded before, no longer word after, `:`/whitespace tolerated.
 */
const CLOSING_ISSUE_REF =
  /(?<![0-9a-z_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \t\n\r:]*#(\d+)/g;

/**
 * Issue numbers a PR body says it closes, deduplicated. Detection is keyword-only — the
 * listing carries no structured closing reference — so it misses UI-panel and cross-repo links.
 *
 * @param {string} body
 * @returns {string[]}
 */
function parseClosingIssueRefs(body) {
  /** @type {string[]} */
  const out = [];
  for (const match of body.toLowerCase().matchAll(CLOSING_ISSUE_REF)) {
    const number = Number(match[1]);
    // Rust's `parse::<i64>()` refuses what does not fit; past 2^53 JS would merge two numbers.
    if (!Number.isSafeInteger(number)) continue;
    const external = String(number);
    if (!out.includes(external)) out.push(external);
  }
  return out;
}

/**
 * A row's `html_url` as a link target, or null when it carries none. Blank is dropped rather
 * than sent: `POST .../links` requires a non-empty url, so an empty one would 400 the run.
 *
 * @param {any} row
 * @returns {string | null}
 */
function linkUrl(row) {
  const url = typeof row?.html_url === "string" ? row.html_url.trim() : "";
  return url || null;
}

/**
 * @param {any} row a PR listing row
 * @returns {StoryOp["links"]}
 */
const selfLink = (row) => {
  const url = linkUrl(row);
  return url ? [{ url, link_type: PULL_REQUEST_LINK_TYPE }] : [];
};

/**
 * @param {string[] | undefined} urls
 * @returns {StoryOp["links"]}
 */
const referencingPrLinks = (urls) =>
  (urls ?? []).map((url) => ({ url, link_type: PULL_REQUEST_LINK_TYPE }));

/**
 * Ghosts (null) drop out and the numeric GitHub id is the key, so a PR's creator listed as an
 * assignee too is one owner rather than two.
 *
 * @param {(ExternalPerson | null)[]} people
 * @returns {ExternalPerson[]}
 */
function dedupePeople(people) {
  /** @type {Map<string, ExternalPerson>} */
  const byId = new Map();
  for (const person of people) {
    if (person && !byId.has(person.external_id)) byId.set(person.external_id, person);
  }
  return [...byId.values()];
}

/**
 * PR↔issue relationships, mirroring github.rs:434-472. Returns the PR numbers that fold into
 * an issue's story (#26313) and, per issue number, the referencing PR URLs (#26528).
 *
 * @param {any[]} issues the fetched rows, PRs included
 * @returns {{ folded: Set<string>, prLinks: Map<string, string[]> }}
 */
function pullRequestRefs(issues) {
  /** @type {Set<string>} */
  const imported = new Set();
  /** @type {Set<string>} */
  const closedIssues = new Set();
  for (const row of issues) {
    if (row.pull_request) continue;
    const number = String(row.number);
    imported.add(number);
    if (String(row.state ?? "").toLowerCase() === "closed") closedIssues.add(number);
  }

  /** @type {Set<string>} */
  const folded = new Set();
  /** @type {Map<string, string[]>} */
  const prLinks = new Map();
  for (const row of issues) {
    if (!row.pull_request) continue;
    const url = linkUrl(row);
    if (typeof row.body !== "string" || !url) continue;
    const merged = row.pull_request.merged_at != null;
    for (const referenced of parseClosingIssueRefs(row.body)) {
      if (!imported.has(referenced)) continue;
      const urls = prLinks.get(referenced) ?? [];
      if (!urls.includes(url)) urls.push(url);
      prLinks.set(referenced, urls);
      // GitHub only auto-closes on merge, so a merged PR resolved an issue already closed
      // here; a still-open one was not (a race, or a reopen), so that PR keeps its story.
      if (merged && closedIssues.has(referenced)) folded.add(String(row.number));
    }
  }
  return { folded, prLinks };
}

// The server importer namespaces a release's external id (`github.rs:896`) so a
// release id can't collide with an issue / PR number in the #26483 dedup key.
const RELEASE_ID_PREFIX = "release-";

/** Both derived from the prefix above, so the writer's key and the marker's parse cannot drift. */
export const RELEASE_EXTERNAL_ID = new RegExp(`^${RELEASE_ID_PREFIX}(\\d+)$`);
export const releaseExternalId = (/** @type {string | number} */ id) => `${RELEASE_ID_PREFIX}${id}`;

/**
 * A row this run maps at all: a PR only under `--include prs`. Exported so {@link mapRepo},
 * the pipeline's warnings and the wizard's questions share one gate rather than three.
 *
 * @param {any} row an issues-listing row, PR or issue
 * @param {boolean} pullRequests
 * @returns {boolean}
 */
export const mappableRow = (row, pullRequests) => pullRequests || !row.pull_request;

/**
 * The rows past both selection filters. The fold and the PR links are computed over these:
 * a filter that keeps an issue out leaves no story to fold a PR into.
 *
 * @param {any[]} issues
 * @param {Customization} customization
 * @returns {any[]}
 */
const selectedRows = (issues, { states, milestones }) =>
  issues.filter((row) => matchesStates(row, states) && matchesMilestones(row, milestones));

/**
 * The PR rows {@link mapRepo} folds into an imported issue's story. They write no story of
 * their own, so anything counting the rows a run imports has to subtract them.
 *
 * @param {any[]} issues
 * @param {Customization} customization
 * @param {boolean} pullRequests
 * @returns {Set<string>} folded PR numbers
 */
export function foldedPullRequests(issues, customization, pullRequests) {
  if (!pullRequests) return new Set();
  return pullRequestRefs(selectedRows(issues, customization)).folded;
}

/**
 * Safe-integer, not merely integer: past 2^53 two GitHub ids collapse onto one JS number
 * (so onto one `external_id` and one Idempotency-Key — the second create replays the first
 * and a release is lost), and from 1e21 `String()` goes exponential, which the marker
 * cannot parse back. A blank tag has no story name — a `400` that would abort the run.
 *
 * @param {any} release
 * @returns {boolean}
 */
export function mappableRelease(release) {
  const id = release?.id;
  const tag = release?.tag_name;
  return Number.isSafeInteger(id) && id > 0 && typeof tag === "string" && tag.trim() !== "";
}

/**
 * How one plan op is named in a warning — `issue #64`, or `release #100` for the
 * namespaced release key, which would otherwise read `issue #release-100`.
 *
 * @param {string} externalId
 * @returns {string}
 */
export function describeOp(externalId) {
  const release = RELEASE_EXTERNAL_ID.exec(externalId);
  return release ? `release #${release[1]}` : `issue #${externalId}`;
}

/** RFC3339, the one form `POST /stories`' `DateTime<Utc>` fields deserialize. */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * The server reads a release date and treats an unreadable one as absent (`parse_source_datetime`,
 * github.rs:869-876); the direct engine instead *forwards* it, so anything the create cannot
 * deserialize is a `400` that aborts the run. `Date.parse` is too loose to gate that on its own —
 * it reads "0", "-1" and "12345" as years.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function sourceDate(value) {
  if (typeof value !== "string") return null;
  const shape = RFC3339.exec(value);
  if (!shape || Number.isNaN(Date.parse(value))) return null;
  // Date.parse rolls Feb 30 forward into March; chrono refuses it, so check the day survives.
  const [, year, month, day] = shape;
  const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const real = probe.getUTCMonth() === Number(month) - 1 && probe.getUTCDate() === Number(day);
  return real ? value : null;
}

/**
 * Mirrors `release_to_record` (github.rs:868-899): the release's own `name` is never
 * deserialized server-side, and `release` is seeded `allow_points = false`, so never estimated.
 *
 * @param {any} release
 * @returns {StoryOp}
 */
function releaseToStory(release) {
  const publishedAt = sourceDate(release.published_at);
  const published = release.draft !== true && publishedAt !== null;
  const body = typeof release.body === "string" ? release.body.trim() : "";
  return {
    external_id: releaseExternalId(release.id),
    // Untrimmed, like github.rs:885's `title: release.tag_name` — trimming here would be
    // the one input on which the two engines gave a release different titles.
    name: release.tag_name,
    description: body || null,
    story_type: "release",
    current_state: published ? "accepted" : "unstarted",
    created_at: sourceDate(release.created_at),
    started_at: null,
    completed_at: published ? publishedAt : null,
    labels: [],
    // `release_to_record` maps no people either — a release has no author or assignees.
    requestor: null,
    owners: [],
    tasks: [],
    comments: [],
    blockers: [],
  };
}

/**
 * Story types whose state set includes `rejected` — the server's `valid_states_for_type`
 * (`handlers/stories.rs`) gives a chore only unstarted/started/accepted, so a chore
 * closed as wontfix has nowhere to land and keeps `accepted`.
 */
const REJECTABLE_TYPES = new Set(["feature", "bug"]);

/**
 * States at or past `state_rank` 2 — the server's create-time `completed_at` guard.
 * `rejected` is off that axis (it has no rank), so it is not one of them.
 */
export const DONE_STATES = new Set(["finished", "delivered", "accepted"]);

/**
 * States at or past `state_rank` 1 — the server's create-time `started_at` guard
 * (#35489). `rejected` is off the axis too, so it is not one of them either.
 */
export const STARTED_STATES = new Set(["started", ...DONE_STATES]);

/**
 * @typedef {object} StoryOp one EAT story to create, with its sub-resources
 * @property {string} external_id the GitHub issue number, or `release-<id>` for a release
 * @property {string} name EAT's create-body title field
 * @property {string | null} description issue body, trimmed, plus `crossLinks` — or a
 *   release's notes
 * @property {string} [crossLinks] the cross-link block already at the tail of
 *   `description` (empty when the issue is in no sub-issue relation). Carried so
 *   {@link clampPlan} can cut the body around it; the writer never sends it.
 * @property {"bug" | "chore" | "feature" | "release"} story_type
 * @property {"unstarted" | "started" | "accepted" | "rejected"} current_state
 * @property {string | null} created_at
 * @property {string | null} [started_at] an open PR's own `created_at`; null on every
 *   other row (github.rs:1186)
 * @property {string | null} completed_at the GitHub closed date, or a release's
 *   `published_at`, kept
 * @property {string[]} labels label names on this story
 * @property {{ url: string, link_type: string }[]} [links] a PR's own URL, or the URLs of
 *   the PRs that close this issue
 * @property {ExternalPerson | null} [requestor] the issue author, null for a ghost
 * @property {ExternalPerson[]} [owners] the assignees, ghosts dropped, a PR's creator last
 * @property {{ description: string, complete: boolean }[]} tasks
 * @property {{ text: string, created_at: string | null,
 *   author?: ExternalPerson | null }[]} comments
 * @property {BlockerOp[]} [blockers] one per `blocked_by` entry (`--include deps`)
 */

/**
 * Map a fetched repo ({@link import("./github.js").GitHubClient#fetchAll}'s shape) to the direct
 * writer's plan. Comments join by `issue_url`, so a PR's chatter lands only when its PR is mapped.
 *
 * @param {{ issues: any[], comments: any[], labels: any[],
 *   subIssues?: Map<string, string[]> | null, releases?: any[] | null,
 *   blockedBy?: Map<string, any[]> | null }} repo
 * @param {Customization} [customization] per-run overrides; the default reproduces
 *   this profile unchanged (the filter/override stories consume the other fields)
 * @param {{ sendDates?: boolean, epics?: boolean, sendPeople?: boolean,
 *   pullRequests?: boolean }} [options] `sendDates`
 *   sends the comment's date on the write (off, it stays in the `@login on <date>:` prefix);
 *   `epics` (`--include milestones`) maps each milestone to an epic; `sendPeople` maps the
 *   GitHub people onto `requestor`/`owners`/`author` (off, the `@login` prefix is all there is);
 *   `pullRequests` (`--include prs`) maps PR rows to stories instead of dropping them
 * @returns {{ labels: LabelOp[], stories: StoryOp[], epics: EpicOp[] }}
 */
export function mapRepo(
  { issues, comments, labels, subIssues, releases, blockedBy },
  customization = DEFAULT_CUSTOMIZATION,
  { sendDates = false, epics = false, sendPeople = false, pullRequests = false } = {},
) {
  const links = indexSubIssues(subIssues);
  const { folded, prLinks } = pullRequests
    ? pullRequestRefs(selectedRows(issues, customization))
    : { folded: new Set(), prLinks: new Map() };
  /** @type {Map<string, string | null>} repo-level color authority, by lowercased name */
  const repoColors = new Map(
    labels.map((l) => [
      String(l.name ?? "").toLowerCase(),
      l.color ? normalizeHexColor(String(l.color)) : null,
    ]),
  );

  /** @type {Map<string, LabelOp>} keyed by lowercased name, like the server's label cache */
  const labelOps = new Map();
  /** @type {Map<string, EpicOp>} keyed by lowercased title, like the server's epic cache */
  const epicOps = new Map();
  /** @type {Map<string, StoryOp["comments"]>} comments per issue number */
  const byIssue = new Map();
  const person = (/** @type {unknown} */ user) => (sendPeople ? externalPerson(user) : null);

  /** @type {StoryOp[]} */
  const stories = [];
  for (const issue of issues) {
    const isPr = Boolean(issue.pull_request);
    if (isPr && (!pullRequests || folded.has(String(issue.number)))) continue;
    const state = String(issue.state ?? "").toLowerCase();
    if (!matchesStates(issue, customization.states)) continue;
    if (!matchesMilestones(issue, customization.milestones)) continue;

    /** @type {string[]} */
    const names = [];
    /** @type {Set<string>} names already on this story, lowercased like labelOps */
    const seen = new Set();
    /** @param {string} name @returns {string} the lowercased key, or "" for a blank name */
    const addName = (name) => {
      if (!name) return "";
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        names.push(name);
      }
      return key;
    };
    /** @param {unknown} rawName @param {unknown} rawColor */
    const addLabel = (rawName, rawColor) => {
      const name = String(rawName ?? "").trim();
      const key = addName(name);
      if (!key) return;
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

    // Also after typing, so the synthetic label can never reclassify the story.
    if (isPr) addLabel(PULL_REQUEST_LABEL, null);

    const closed = state === "closed";
    // Abandoned work must stay out of velocity: `accepted` is a done state, `rejected`
    // is not, so billing a wontfix as accepted credits work nobody did.
    const abandoned = isPr ? null : closedReasonLabel(closed, issue.state_reason);
    addLabel(abandoned, null);
    /** @type {StoryOp["current_state"]} */
    let currentState;
    if (isPr) {
      // Unlike the closed-reason branch this is ungated by type: the server writes a
      // closed-unmerged chore PR `rejected` too (github.rs:1025-1030).
      currentState = !closed
        ? "started"
        : issue.pull_request?.merged_at != null
          ? "accepted"
          : "rejected";
    } else if (closed) {
      currentState = abandoned && REJECTABLE_TYPES.has(storyType) ? "rejected" : "accepted";
    } else {
      currentState = "unstarted";
    }

    // Also after typing, for the same reason. The epic's own label is the join, so the
    // title rides in `names` only — POST /epics creates that label itself.
    const epicTitle = epics ? milestoneEpicTitle(issue.milestone) : "";
    if (epicTitle) {
      const key = epicTitleKey(epicTitle);
      if (!epicOps.has(key)) {
        epicOps.set(key, {
          title: epicTitle,
          description: milestoneEpicDescription(issue.milestone),
        });
      }
      // The first spelling wins, so every story in one epic carries one label name.
      addName(/** @type {EpicOp} */ (epicOps.get(key)).title);
    }

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
      current_state: currentState,
      created_at: issue.created_at ?? null,
      // An open PR is in progress, so its history is a single `NULL → started @ created`
      // (github.rs:1186).
      started_at: (isPr && !closed ? issue.created_at : null) ?? null,
      completed_at: (closed ? issue.closed_at : null) ?? null,
      labels: names,
      links: isPr ? selfLink(issue) : referencingPrLinks(prLinks.get(externalId)),
      requestor: person(issue.user),
      // A PR's creator authored the work, so they are an owner as well as the requestor —
      // deduped by id when they are an assignee too.
      owners: dedupePeople(
        (Array.isArray(issue.assignees) ? issue.assignees : [])
          .concat(isPr ? [issue.user] : [])
          .map(person),
      ),
      tasks: customization.tasks ? parseChecklist(body) : [],
      comments: /** @type {StoryOp["comments"]} */ ([]),
      blockers: blockersFrom(blockedBy?.get(externalId)),
    };
    byIssue.set(story.external_id, story.comments);
    stories.push(story);
  }

  // No issue customization reaches releases: the filters select issues, and `release` is
  // the whole point of the type, so `--story-type` cannot override it.
  for (const release of Array.isArray(releases) ? releases : []) {
    if (mappableRelease(release)) stories.push(releaseToStory(release));
  }

  for (const comment of customization.comments ? comments : []) {
    if (!(comment.body ?? "").trim()) continue;
    const target = byIssue.get(issueNumberFromUrl(comment.issue_url) ?? "");
    if (target) {
      // Both probes, because they are independent: only `sendDates` puts the date on the
      // write, so without it the prefix is still the date's only ride.
      target.push({
        text:
          sendPeople && sendDates ? (comment.body ?? "").trim() : commentText(comment, sendDates),
        created_at: comment.created_at ?? null,
        author: person(comment.user),
      });
    }
  }

  return { labels: [...labelOps.values()], stories, epics: [...epicOps.values()] };
}

/**
 * @typedef {object} FieldLimits max UTF-8 bytes per write field
 * @property {number} storyName
 * @property {number} storyDescription
 * @property {number} taskDescription
 * @property {number} commentText
 * @property {number} epicDescription
 * @property {number} blockerDesc
 */

/**
 * Applied only to a server whose openapi.json publishes no `maxLength` (production
 * now publishes them). Text limits sit between the longest comment a real server
 * accepted (13,101 chars) and one it rejected `too_long` (46,411).
 *
 * @type {FieldLimits}
 */
export const FALLBACK_LIMITS = {
  storyName: 255,
  storyDescription: 16_000,
  taskDescription: 16_000,
  commentText: 16_000,
  // Not a guess: `limits::EPIC_DESCRIPTION`, which openapi.json does not publish.
  epicDescription: 100_000,
  // `limits::BLOCKER_DESC` — the `blocker_desc` column width.
  blockerDesc: 255,
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
export function sliceBytes(text, maxBytes) {
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
 * @param {{ labels: LabelOp[], stories: StoryOp[], epics?: EpicOp[] }} plan
 * @param {FieldLimits} limits
 * @param {{ reserveDescription?: (op: StoryOp) => number,
 *   warn?: (message: string) => void }} [options] `reserveDescription` holds
 *   back room per story for text appended later (the dedup marker)
 * @returns {{ labels: LabelOp[], stories: StoryOp[], epics: EpicOp[] }}
 */
export function clampPlan(plan, limits, { reserveDescription = () => 0, warn = () => {} } = {}) {
  const stories = plan.stories.map((op) => {
    const out = { ...op };
    /** @param {string} field @param {number} limit */
    const notice = (field, limit) =>
      warn(
        `warning: ${describeOp(op.external_id)}: ${field} truncated to ${limit} bytes (server limit)\n`,
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
    // Plain truncation, like github.rs's writer: a blocker is a one-liner, and
    // the notice would cost more room than the text it annotates.
    out.blockers = (op.blockers ?? []).map((blocker, i) => {
      if (byteLen(blocker.desc) <= limits.blockerDesc) return blocker;
      notice(`blocker ${i + 1}`, limits.blockerDesc);
      return { ...blocker, desc: sliceBytes(blocker.desc, limits.blockerDesc) };
    });
    return out;
  });
  // Epic titles were cut to the column width at map time; descriptions are clamped here
  // so the epic stage cannot 400 before a single story is written.
  const epics = (plan.epics ?? []).map((epic) =>
    epic.description !== null && byteLen(epic.description) > limits.epicDescription
      ? { ...epic, description: clampBlock(epic.description, limits.epicDescription) }
      : epic,
  );
  return { labels: plan.labels, stories, epics };
}
