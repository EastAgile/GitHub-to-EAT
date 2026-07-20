/**
 * The direct engine's default mapping profile: GitHub issue JSON in → EAT write-op plan out (pure, no HTTP).
 * Mirrors the server importer's issue mapping (agile-tracker github.rs + common.rs) so both engines classify identically.
 */

/**
 * The issues legend shown by the CLI. Lives next to the functions that implement each line
 * and is re-exported through the MAPPINGS registry, so legend and mapper can't drift apart.
 */
export const ISSUES_LEGEND = [
  "open issue → story (unstarted); closed issue → story (accepted, keeps the closed date)",
  "labels → labels (with colors); issue-body checklists → story tasks",
  "comments → comments (body only)",
];

/**
 * @typedef {object} Customization per-run mapping overrides (`--customize`)
 * @property {"all" | "open" | "closed"} states which GitHub issue states to import
 * @property {string[] | null} milestones exact `milestone.title` allowlist; null imports every issue
 * @property {"infer" | "feature" | "bug" | "chore"} storyType "infer" uses {@link inferStoryType}
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
 * GitHub issues carry no native type, so infer one from the conventional labels + the title.
 * Bug is checked first: a row that matches both rules is a bug.
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

/** @param {string | null | undefined} issueUrl @returns {string | null} */
function issueNumberFromUrl(issueUrl) {
  const match = (issueUrl ?? "").match(/\/issues\/(\d+)$/);
  return match ? match[1] : null;
}

/**
 * The public EAT API has no comment-author attribution (EAT-team ask pending), so author + date
 * ride in the text as `@login on <date>:`; a deleted GitHub account renders as `@ghost`.
 *
 * @param {{ user?: { login?: string } | null, created_at?: string | null, body?: string | null }} comment
 * @returns {string}
 */
function commentText(comment) {
  const login = comment.user?.login || "ghost";
  const date = (comment.created_at ?? "").slice(0, 10);
  const prefix = date ? `@${login} on ${date}:` : `@${login}:`;
  return `${prefix}\n\n${(comment.body ?? "").trim()}`;
}

/**
 * @typedef {object} LabelOp one EAT label to get-or-create
 * @property {string} name
 * @property {string} [background_color_hex] lowercase `#rrggbb`
 * @property {string} [text_color_hex] contrast-picked when a background exists
 */

/**
 * @typedef {object} StoryOp one EAT story to create, with its sub-resources
 * @property {string} external_id the GitHub issue number, as a string
 * @property {string} name EAT's create-body title field
 * @property {string | null} description issue body, trimmed
 * @property {"bug" | "chore" | "feature"} story_type
 * @property {"unstarted" | "accepted"} current_state
 * @property {string | null} created_at
 * @property {string | null} completed_at the GitHub closed date, kept
 * @property {string[]} labels label names on this story
 * @property {{ description: string, complete: boolean }[]} tasks
 * @property {{ text: string }[]} comments
 */

/**
 * Map a fetched repo ({@link import("./github.js").GitHubClient#fetchAll}'s shape) to the direct
 * writer's plan. Joining comments by `issue_url` drops PR chatter — those numbers are unmapped PRs.
 *
 * @param {{ issues: any[], comments: any[], labels: any[] }} repo
 * @param {Customization} [customization] per-run overrides; the default reproduces
 *   this profile unchanged (the filter/override stories consume the other fields)
 * @returns {{ labels: LabelOp[], stories: StoryOp[] }}
 */
export function mapRepo({ issues, comments, labels }, customization = DEFAULT_CUSTOMIZATION) {
  /** @type {Map<string, string | null>} repo-level color authority, by lowercased name */
  const repoColors = new Map(
    labels.map((l) => [
      String(l.name ?? "").toLowerCase(),
      l.color ? normalizeHexColor(String(l.color)) : null,
    ]),
  );

  /** @type {Map<string, LabelOp>} keyed by lowercased name, like the server's label cache */
  const labelOps = new Map();
  /** @type {Map<string, { text: string }[]>} comments per issue number */
  const byIssue = new Map();

  /** @type {StoryOp[]} */
  const stories = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const state = String(issue.state ?? "").toLowerCase();
    if (customization.states !== "all" && state !== customization.states) continue;
    if (customization.milestones && !customization.milestones.includes(issue.milestone?.title)) {
      continue;
    }

    /** @type {string[]} */
    const names = [];
    for (const label of issue.labels ?? []) {
      const name = String(label.name ?? "").trim();
      if (!name) continue;
      names.push(name);
      const key = name.toLowerCase();
      if (!labelOps.has(key)) {
        const color =
          (label.color ? normalizeHexColor(String(label.color)) : null) ?? repoColors.get(key);
        labelOps.set(
          key,
          color
            ? { name, background_color_hex: color, text_color_hex: contrastTextColor(color) }
            : { name },
        );
      }
    }

    const title = String(issue.title ?? "");
    const body = (issue.body ?? "").trim();
    const closed = state === "closed";
    const story = {
      external_id: String(issue.number),
      name: title,
      description: body || null,
      story_type:
        customization.storyType === "infer"
          ? inferStoryType(names, title)
          : customization.storyType,
      current_state: /** @type {"unstarted" | "accepted"} */ (closed ? "accepted" : "unstarted"),
      created_at: issue.created_at ?? null,
      completed_at: (closed ? issue.closed_at : null) ?? null,
      labels: names,
      tasks: customization.tasks ? parseChecklist(body) : [],
      comments: /** @type {{ text: string }[]} */ ([]),
    };
    byIssue.set(story.external_id, story.comments);
    stories.push(story);
  }

  for (const comment of customization.comments ? comments : []) {
    if (!(comment.body ?? "").trim()) continue;
    const target = byIssue.get(issueNumberFromUrl(comment.issue_url) ?? "");
    if (target) target.push({ text: commentText(comment) });
  }

  return { labels: [...labelOps.values()], stories };
}

/**
 * @typedef {object} FieldLimits max chars per write field
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

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string} within `limit`, ending with {@link TRUNCATION_NOTICE} when cut
 */
function clampBlock(text, limit) {
  if (text.length <= limit) return text;
  const room = limit - TRUNCATION_NOTICE.length - 2;
  if (room <= 0) return text.slice(0, Math.max(0, limit));
  return `${text.slice(0, room)}\n\n${TRUNCATION_NOTICE}`;
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
        `warning: issue #${op.external_id}: ${field} truncated to ${limit} chars (server limit)\n`,
      );

    if (out.name.length > limits.storyName) {
      out.name = `${out.name.slice(0, limits.storyName - 1)}…`;
      notice("name", limits.storyName);
    }
    const descriptionLimit = limits.storyDescription - reserveDescription(op);
    if (out.description !== null && out.description.length > descriptionLimit) {
      out.description = clampBlock(out.description, descriptionLimit);
      notice("description", descriptionLimit);
    }
    out.tasks = op.tasks.map((task, i) => {
      if (task.description.length <= limits.taskDescription) return task;
      notice(`task ${i + 1}`, limits.taskDescription);
      return { ...task, description: clampBlock(task.description, limits.taskDescription) };
    });
    out.comments = op.comments.map((comment, i) => {
      if (comment.text.length <= limits.commentText) return comment;
      notice(`comment ${i + 1}`, limits.commentText);
      return { text: clampBlock(comment.text, limits.commentText) };
    });
    return out;
  });
  return { labels: plan.labels, stories };
}
