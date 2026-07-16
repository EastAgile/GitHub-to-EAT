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
 * @returns {{ labels: LabelOp[], stories: StoryOp[] }}
 */
export function mapRepo({ issues, comments, labels }) {
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
    const closed = String(issue.state ?? "").toLowerCase() === "closed";
    const story = {
      external_id: String(issue.number),
      name: title,
      description: body || null,
      story_type: inferStoryType(names, title),
      current_state: /** @type {"unstarted" | "accepted"} */ (closed ? "accepted" : "unstarted"),
      created_at: issue.created_at ?? null,
      completed_at: (closed ? issue.closed_at : null) ?? null,
      labels: names,
      tasks: parseChecklist(body),
      comments: /** @type {{ text: string }[]} */ ([]),
    };
    byIssue.set(story.external_id, story.comments);
    stories.push(story);
  }

  for (const comment of comments) {
    if (!(comment.body ?? "").trim()) continue;
    const target = byIssue.get(issueNumberFromUrl(comment.issue_url) ?? "");
    if (target) target.push({ text: commentText(comment) });
  }

  return { labels: [...labelOps.values()], stories };
}
