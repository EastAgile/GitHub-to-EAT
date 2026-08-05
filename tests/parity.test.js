import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedByDesc,
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

// Both probes on: the fully-supported path, the only one the server importer has.
const mapPeople = () =>
  mapRepo(PEOPLE_REPO, DEFAULT_CUSTOMIZATION, { sendPeople: true, sendDates: true });

test("parity: the people triples the server importer would write", () => {
  const { stories } = mapPeople();
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
  const { stories } = mapPeople();
  const seven = /** @type {any} */ (stories.find((s) => s.external_id === "7"));
  assert.equal(seven.requestor.display_name, "alice");
  assert.equal(seven.requestor.html_url, "https://github.com/alice");
  // GhUser.html_url is Option<String>: absent stays absent.
  assert.equal("html_url" in seven.owners[0], false);
});

// Two deliberate CLI-side normalisations, not server parity: `to_person` passes
// html_url through untouched, and the importer stores the comment body untrimmed.
test("cli-side: a blank html_url is dropped and the comment body is trimmed", () => {
  const { stories } = mapRepo(
    {
      issues: [issue({ number: 7, user: { id: 12, login: "alice", html_url: "   " } })],
      comments: [
        {
          issue_url: "https://api.github.com/repos/o/r/issues/7",
          user: { id: 34, login: "bob" },
          created_at: "2026-03-04T05:06:07Z",
          body: "  padded body  ",
        },
      ],
      labels: [],
    },
    DEFAULT_CUSTOMIZATION,
    { sendPeople: true, sendDates: true },
  );
  const seven = /** @type {any} */ (stories[0]);
  assert.equal("html_url" in seven.requestor, false);
  assert.equal(seven.comments[0].text, "padded body");
});

test("parity: a comment body carries no '@login' prefix, like the server's", () => {
  const { stories } = mapPeople();
  const seven = /** @type {any} */ (stories.find((s) => s.external_id === "7"));
  assert.equal(seven.comments[0].text, "verbatim body");
});

// --- issue dependencies → blockers (story #31934 / EAT #35491) ----------------
// From github.rs `blocked_by_desc` / `list_blocked_by` and their own tests.

/** One story, mapped with `rows` as its `blocked_by` listing. */
const withBlockers = (/** @type {any[]} */ rows) =>
  mapRepo({
    issues: [issue({ number: 7 })],
    comments: [],
    labels: [],
    blockedBy: new Map([["7", rows]]),
  }).stories[0];

test("parity: blocked_by_desc is 'Blocked by #<n> (<title>)', unresolved", () => {
  assert.equal(blockedByDesc(90, "Upstream fix"), "Blocked by #90 (Upstream fix)");
  assert.deepEqual(withBlockers([{ number: 90, title: "Upstream fix" }]).blockers, [
    { desc: "Blocked by #90 (Upstream fix)", resolved: false },
  ]);
});

test("parity: the dependency's title is trimmed, like github.rs `row.title.trim()`", () => {
  assert.equal(blockedByDesc(90, "  Upstream fix \n"), "Blocked by #90 (Upstream fix)");
});

test("parity: `#[serde(default)]` means an absent title maps to the empty string", () => {
  // GhDependencyRef defaults `title` to String::new() — the parens still render.
  assert.deepEqual(withBlockers([{ number: 90 }]).blockers, [
    { desc: "Blocked by #90 ()", resolved: false },
  ]);
});

test("parity: rows with number <= 0 are skipped and the rest keep GitHub's order", () => {
  // `if row.number <= 0 || seen.contains(...) { continue }` — serde defaults a
  // missing/unparseable number to 0, which the same guard drops.
  const rows = [
    { number: 90, title: "Upstream fix" },
    { number: 0, title: "defaulted" },
    { number: -3, title: "negative" },
    {},
    { number: 12, title: "Second" },
  ];
  assert.deepEqual(
    (withBlockers(rows).blockers ?? []).map((b) => b.desc),
    ["Blocked by #90 (Upstream fix)", "Blocked by #12 (Second)"],
  );
});

test("parity: repeats are deduplicated by number, first title winning", () => {
  const rows = [
    { number: 90, title: "Upstream fix" },
    { number: 12, title: "Second" },
    { number: 90, title: "a later page repeated it, renamed" },
  ];
  assert.deepEqual(
    (withBlockers(rows).blockers ?? []).map((b) => b.desc),
    ["Blocked by #90 (Upstream fix)", "Blocked by #12 (Second)"],
  );
});

test("parity: an issue with no dependencies, or none fetched, carries no blockers", () => {
  assert.deepEqual(withBlockers([]).blockers, []);
  // The stage never ran (`--include deps` off, or it degraded): same output.
  const { stories } = mapRepo({ issues: [issue({ number: 7 })], comments: [], labels: [] });
  assert.deepEqual(stories[0].blockers, []);
});

test("parity: a blocker is recorded whether or not the blocking issue was imported", () => {
  // github.rs never intersects `blocked_by` with the import set — #90 is not in
  // this repo's listing and still earns its line.
  const { stories } = mapRepo({
    issues: [issue({ number: 7 }), issue({ number: 12, title: "Second" })],
    comments: [],
    labels: [],
    blockedBy: new Map([
      [
        "7",
        [
          { number: 12, title: "Second" },
          { number: 90, title: "Absent" },
        ],
      ],
    ]),
  });
  assert.deepEqual(
    /** @type {any} */ (stories.find((s) => s.external_id === "7")).blockers.map(
      (/** @type {any} */ b) => b.desc,
    ),
    ["Blocked by #12 (Second)", "Blocked by #90 (Absent)"],
  );
  assert.deepEqual(/** @type {any} */ (stories.find((s) => s.external_id === "12")).blockers, []);
});

test("parity: a release carries no blockers — release_to_record leaves the list empty", () => {
  const { stories } = mapRepo({
    issues: [],
    comments: [],
    labels: [],
    releases: [release({})],
    blockedBy: new Map([["release-900", [{ number: 90, title: "Upstream fix" }]]]),
  });
  assert.deepEqual(stories[0].blockers, []);
});
