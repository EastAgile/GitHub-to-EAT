import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CUSTOMIZATION,
  inferStoryType,
  mapRepo,
  milestoneEpicDescription,
} from "../src/mapping.js";

// Engine parity. CONTRACT.md claims the direct engine mirrors the server importer
// everywhere except the three tracked exceptions, and until now that claim lived only
// in prose. Every expectation below is the server's own: copied from the assertions in
// agile-tracker `platform/backend/src/services/import/{github,common}.rs`, so a
// divergence in a mirrored path fails here instead of reaching a board.

const issue = (/** @type {object} */ over = {}) => ({
  number: 7,
  title: "Add a widget",
  body: "",
  state: "open",
  labels: [],
  created_at: "2026-01-02T03:04:05Z",
  closed_at: null,
  ...over,
});
const oneStory = (/** @type {object} */ over) =>
  mapRepo({ issues: [issue(over)], comments: [], labels: [] }).stories[0];

// github.rs `milestone_epic_desc`, expectations from its own test
// `milestone_epic_desc_formats_and_omits`.
for (const [due, state, expected] of /** @type {[any, any, string | null][]} */ ([
  ["2024-12-01T00:00:00Z", "open", "GitHub milestone — State: open, Due: 2024-12-01"],
  [null, "closed", "GitHub milestone — State: closed"],
  ["2025-01-15T00:00:00Z", null, "GitHub milestone — Due: 2025-01-15"],
  [null, null, null],
  ["  ", "", null],
  // Rust's `d.split('T').next()` yields the whole string when there is no `T`.
  ["2025-01-15", "open", "GitHub milestone — State: open, Due: 2025-01-15"],
])) {
  test(`parity: milestone_epic_desc(${JSON.stringify(due)}, ${JSON.stringify(state)})`, () => {
    assert.equal(milestoneEpicDescription({ due_on: due, state }), expected);
  });
}

test("parity: issue_to_record's state and external id", () => {
  assert.equal(oneStory({}).current_state, "unstarted");
  assert.equal(oneStory({}).external_id, "7");
  const closed = oneStory({ state: "closed", closed_at: "2026-02-03T04:05:06Z" });
  assert.equal(closed.current_state, "accepted");
  assert.equal(closed.completed_at, "2026-02-03T04:05:06Z");
});

// common.rs `infer_story_type` — the direct engine is a line-for-line port.
for (const [labels, title, expected] of /** @type {[string[], string, string][]} */ ([
  [[], "Add a widget", "feature"],
  [["Bug"], "Add a widget", "bug"],
  [["needs-fix"], "Add a widget", "bug"],
  [["defect"], "Add a widget", "bug"],
  [[], "Fix the crash", "bug"],
  [[], "bug: crash", "bug"],
  [["chore"], "Add a widget", "chore"],
  [["maintenance"], "Add a widget", "chore"],
  [["devops"], "Add a widget", "chore"],
  [["infra"], "Add a widget", "chore"],
  [["chore", "bug"], "Add a widget", "bug"],
  [[], "prefix bug", "feature"],
])) {
  test(`parity: infer_story_type(${JSON.stringify(labels)}, ${JSON.stringify(title)})`, () => {
    assert.equal(inferStoryType(labels, title), expected);
  });
}

// github.rs `release_to_record`: published = !draft AND published_at present.
const release = (/** @type {object} */ over = {}) => ({
  id: 900,
  tag_name: "v1.0",
  name: "the release name the server never deserializes",
  body: "  notes  ",
  draft: false,
  created_at: "2024-03-01T00:00:00Z",
  published_at: "2024-03-02T00:00:00Z",
  ...over,
});
const oneRelease = (/** @type {object} */ over) =>
  mapRepo(
    { issues: [], comments: [], labels: [], releases: [release(over)] },
    DEFAULT_CUSTOMIZATION,
  ).stories[0];

test("parity: a published release", () => {
  const s = oneRelease({});
  assert.equal(s.name, "v1.0", "title is tag_name — GhRelease has no `name` member");
  assert.equal(s.story_type, "release");
  assert.equal(s.current_state, "accepted");
  assert.equal(s.completed_at, "2024-03-02T00:00:00Z");
  assert.equal(s.description, "notes");
  assert.equal(s.external_id, "release-900");
});

test("parity: a draft release imports to the backlog, and so does one with no publish date", () => {
  const draft = oneRelease({ draft: true, published_at: null });
  assert.equal(draft.current_state, "unstarted");
  assert.equal(draft.completed_at, null);
  assert.equal(oneRelease({ draft: false, published_at: null }).current_state, "unstarted");
  assert.equal(oneRelease({ body: "   " }).description, null);
});

// --- people (story #33465) ---------------------------------------------------
// From github.rs `to_person` / `valid_gh_user`: the `(source, external_id)` rows the server writes.

const PEOPLE_REPO = {
  issues: [
    issue({
      number: 7,
      user: { id: 12, login: "alice", html_url: "https://github.com/alice" },
      assignees: [{ id: 34, login: "bob" }, { id: 0, login: "ghost-by-id" }, null],
    }),
    issue({ number: 8, user: null, assignees: [{ id: 56, login: " carol " }] }),
  ],
  comments: [
    {
      issue_url: "https://api.github.com/repos/o/r/issues/7",
      user: { id: 34, login: "bob" },
      created_at: "2026-03-04T05:06:07Z",
      body: "verbatim body",
    },
    {
      issue_url: "https://api.github.com/repos/o/r/issues/8",
      user: { id: 78, login: "" },
      created_at: "2026-03-05T05:06:07Z",
      body: "from a ghost",
    },
  ],
  labels: [],
};

const triple = (/** @type {any} */ p) =>
  p === null ? null : [p.source, p.external_id, p.username];

test("parity: the people triples the server importer would write", () => {
  const { stories } = mapRepo(PEOPLE_REPO, DEFAULT_CUSTOMIZATION, { sendPeople: true });
  const seven = /** @type {any} */ (stories.find((s) => s.external_id === "7"));
  const eight = /** @type {any} */ (stories.find((s) => s.external_id === "8"));

  assert.deepEqual(triple(seven.requestor), ["github", "12", "alice"]);
  // A ghost assignee (id 0, or no user object at all) is dropped; the rest stay in order.
  assert.deepEqual(seven.owners.map(triple), [["github", "34", "bob"]]);
  assert.deepEqual(
    seven.comments.map((/** @type {any} */ c) => triple(c.author)),
    [["github", "34", "bob"]],
  );

  // A ghost issue author leaves no requestor — the server falls back to the caller.
  assert.equal(eight.requestor, null);
  assert.deepEqual(eight.owners.map(triple), [["github", "56", "carol"]]);
  // A ghost comment author likewise: no author, and the body is still verbatim.
  assert.deepEqual(eight.comments, [
    { text: "from a ghost", created_at: "2026-03-05T05:06:07Z", author: null },
  ]);
});

test("parity: the login is the display name too, and html_url rides along when GitHub sent one", () => {
  const { stories } = mapRepo(PEOPLE_REPO, DEFAULT_CUSTOMIZATION, { sendPeople: true });
  const seven = /** @type {any} */ (stories.find((s) => s.external_id === "7"));
  assert.equal(seven.requestor.display_name, "alice");
  assert.equal(seven.requestor.html_url, "https://github.com/alice");
  // GhUser.html_url is Option<String>: absent stays absent, never an empty string.
  assert.equal("html_url" in seven.owners[0], false);
});

test("parity: a comment body is stored verbatim — no '@login' prefix, like the server's", () => {
  const { stories } = mapRepo(PEOPLE_REPO, DEFAULT_CUSTOMIZATION, { sendPeople: true });
  const seven = /** @type {any} */ (stories.find((s) => s.external_id === "7"));
  assert.equal(seven.comments[0].text, "verbatim body");
});
