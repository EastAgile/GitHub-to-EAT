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

// --- pull requests (story #31933) --------------------------------------------
// From github.rs `issue_to_record`'s `is_pr` branches, expectations copied from its own
// tests `open_pr_maps_to_started_with_marker_and_label`,
// `merged_pr_maps_to_accepted_with_completed_and_label`,
// `closed_unmerged_pr_maps_to_rejected_with_label` and
// `state_reason_on_a_pull_request_row_is_ignored`.

const pr = (/** @type {object} */ over = {}) =>
  issue({
    number: 10,
    title: "Add feature X",
    body: "PR body",
    html_url: "https://github.com/o/r/pull/10",
    created_at: "2024-03-01T08:00:00Z",
    pull_request: { merged_at: null },
    ...over,
  });
const onePr = (/** @type {object} */ over = {}) =>
  mapRepo({ issues: [pr(over)], comments: [], labels: [] }, DEFAULT_CUSTOMIZATION, {
    pullRequests: true,
  }).stories[0];

test("parity: an open PR maps to started and carries the pull-request label", () => {
  const s = onePr();
  assert.equal(s.current_state, "started");
  assert.equal(s.completed_at, null);
  assert.ok(s.labels.includes("pull-request"));
  // Type inference runs for PRs too (feature title → feature).
  assert.equal(s.story_type, "feature");
  // The PR's own URL rides as a first-class `pull_request` link (story #30751).
  assert.deepEqual(s.links, [{ url: "https://github.com/o/r/pull/10", link_type: "pull_request" }]);
});

test("parity: a merged PR maps to accepted, a closed-unmerged one to rejected", () => {
  const merged = onePr({
    state: "closed",
    closed_at: "2024-03-05T12:00:00Z",
    title: "Fix the thing",
    pull_request: { merged_at: "2024-03-05T12:00:00Z" },
  });
  assert.equal(merged.current_state, "accepted");
  assert.equal(merged.completed_at, "2024-03-05T12:00:00Z");
  // Inference applies to PR rows as well: a "Fix …" title is a bug.
  assert.equal(merged.story_type, "bug");

  const unmerged = onePr({ state: "closed", closed_at: "2024-03-05T12:00:00Z" });
  assert.equal(unmerged.current_state, "rejected");
  assert.equal(unmerged.completed_at, "2024-03-05T12:00:00Z");
  assert.ok(unmerged.labels.includes("pull-request"));
});

// `closed_reason` is computed `if closed && !is_pr` (github.rs:999), so a PR never earns a
// reason label and its `state_reason` cannot move it off the merge mapping, in either direction.
for (const [reason, merged_at, state] of /** @type {[string, string | null, string][]} */ ([
  ["not_planned", null, "rejected"],
  ["duplicate", "2024-03-05T12:00:00Z", "accepted"],
])) {
  test(`parity: state_reason '${reason}' on a PR row is ignored`, () => {
    const s = onePr({
      state: "closed",
      closed_at: "2024-03-05T12:00:00Z",
      state_reason: reason,
      pull_request: { merged_at },
    });
    assert.equal(s.current_state, state);
    assert.deepEqual(s.labels, ["pull-request"]);
  });
}

// The PR branch of `current_state` (github.rs:1025-1030) is unconditional, where the
// closed-reason branch below it is gated on `type_accepts_rejected`. So a chore-typed PR
// closed unmerged still lands `rejected`, unlike a chore issue closed `not_planned`.
test("parity: a chore-typed closed-unmerged PR is still rejected", () => {
  const s = onePr({
    state: "closed",
    closed_at: "2024-03-05T12:00:00Z",
    labels: [{ name: "chore" }],
  });
  assert.equal(s.story_type, "chore");
  assert.equal(s.current_state, "rejected");
});

// The synthetic label is pushed after `infer_story_type` has read the author's own labels
// (github.rs:992-994), so it can never reclassify the story — a `pull-request` label does
// not make a chore, and the author's own labels still decide.
test("parity: the pull-request label lands after type inference, never before it", () => {
  assert.equal(onePr({ title: "Fix the parser" }).story_type, "bug");
  assert.equal(inferStoryType(["pull-request"], "Add feature X"), "feature");
  // Already carrying the label: it is deduped, not doubled.
  assert.deepEqual(onePr({ labels: [{ name: "pull-request" }] }).labels, ["pull-request"]);
});

test("parity: a PR's creator is an owner as well as its requestor", () => {
  const { stories } = mapRepo(
    {
      issues: [
        pr({
          user: { id: 12, login: "alice" },
          assignees: [{ id: 34, login: "bob" }],
        }),
      ],
      comments: [],
      labels: [],
    },
    DEFAULT_CUSTOMIZATION,
    { sendPeople: true, sendDates: true, pullRequests: true },
  );
  assert.deepEqual(triple(stories[0].requestor), ["github", "12", "alice"]);
  // Assignees first, then the creator — github.rs:1067-1079 pushes onto the assignee list.
  assert.deepEqual(/** @type {any[]} */ (stories[0].owners).map(triple), [
    ["github", "34", "bob"],
    ["github", "12", "alice"],
  ]);
});

test("parity: a creator who is also an assignee is one owner, not two", () => {
  const { stories } = mapRepo(
    {
      issues: [pr({ user: { id: 12, login: "alice" }, assignees: [{ id: 12, login: "alice" }] })],
      comments: [],
      labels: [],
    },
    DEFAULT_CUSTOMIZATION,
    { sendPeople: true, sendDates: true, pullRequests: true },
  );
  assert.deepEqual(/** @type {any[]} */ (stories[0].owners).map(triple), [
    ["github", "12", "alice"],
  ]);
});

// github.rs:434-472. A **merged** PR whose body closes an imported issue that is itself
// `closed` resolved it, so it must not create a second story; the PR's URL lands on the
// issue's story as a `pull_request` link instead (stories #26313 / #26528).
const REF_REPO = (/** @type {object} */ prOver, /** @type {object} */ issueOver = {}) => ({
  issues: [
    issue({ number: 7, state: "closed", closed_at: "2024-03-04T00:00:00Z", ...issueOver }),
    pr({ number: 10, body: "Fixes #7", ...prOver }),
  ],
  comments: [],
  labels: [],
});
const mapRefs = (/** @type {any} */ repo) =>
  mapRepo(repo, DEFAULT_CUSTOMIZATION, { pullRequests: true });

test("parity: a merged PR that closed a closed imported issue folds into that issue's story", () => {
  const { stories } = mapRefs(
    REF_REPO({ state: "closed", pull_request: { merged_at: "2024-03-05T12:00:00Z" } }),
  );
  assert.deepEqual(
    stories.map((s) => s.external_id),
    ["7"],
  );
  assert.deepEqual(stories[0].links, [
    { url: "https://github.com/o/r/pull/10", link_type: "pull_request" },
  ]);
});

// The dedup is gated on the issue being closed: a still-open issue means the merge did not
// resolve it, so the PR keeps its own story and the link is recorded anyway (github.rs:417-425).
test("parity: a merged PR referencing a still-open issue keeps its own story", () => {
  const { stories } = mapRefs(
    REF_REPO(
      { state: "closed", pull_request: { merged_at: "2024-03-05T12:00:00Z" } },
      { state: "open", closed_at: null },
    ),
  );
  assert.deepEqual(
    stories.map((s) => s.external_id),
    ["7", "10"],
  );
  assert.deepEqual(stories[0].links, [
    { url: "https://github.com/o/r/pull/10", link_type: "pull_request" },
  ]);
});

test("parity: an open PR referencing a closed issue is linked, never deduped", () => {
  const { stories } = mapRefs(REF_REPO({}));
  assert.deepEqual(
    stories.map((s) => s.external_id),
    ["7", "10"],
  );
  assert.deepEqual(stories[0].links, [
    { url: "https://github.com/o/r/pull/10", link_type: "pull_request" },
  ]);
});

// github.rs `parse_closing_issue_refs`: nine keywords, word-bounded, `:`/whitespace tolerated
// before the `#`, same-repo `#N` only. Unreferenced or cross-repo forms record nothing.
for (const [body, expected] of /** @type {[string, string[]][]} */ ([
  ["Closes #7", ["7"]],
  ["closed:#7", ["7"]],
  ["FIXES\n#7", ["7"]],
  ["resolve   #7", ["7"]],
  ["Fixes #7 and closes #7", ["7"]],
  ["closely #7", []],
  ["unfixes #7", []],
  ["Fixes o/r#7", []],
  ["Fixes #8", []],
  ["mentions #7", []],
])) {
  test(`parity: parse_closing_issue_refs(${JSON.stringify(body)})`, () => {
    const { stories } = mapRefs(REF_REPO({ body }));
    const seven = /** @type {any} */ (stories.find((s) => s.external_id === "7"));
    assert.deepEqual(
      seven.links.map((/** @type {any} */ l) => l.url),
      expected.map(() => "https://github.com/o/r/pull/10"),
    );
  });
}

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
