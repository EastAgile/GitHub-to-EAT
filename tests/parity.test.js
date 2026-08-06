import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedByDesc,
  clampPlan,
  DEFAULT_CUSTOMIZATION,
  FALLBACK_LIMITS,
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
// From github.rs `issue_to_record`'s `is_pr` branches, expectations copied from its own tests.

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

// github.rs:1186 — `let started_at = if is_pr && !closed { created_at } else { None };`
// Expectations copied from `open_pr_maps_to_started_with_marker_and_label`,
// `merged_pr_maps_to_accepted_with_completed_and_label` and
// `closed_unmerged_pr_maps_to_rejected_with_label` (story #36700).
test("parity: an open PR seeds started_at from its created_at", () => {
  const s = onePr();
  assert.equal(s.started_at, s.created_at);
  assert.equal(s.started_at, "2024-03-01T08:00:00Z");
});

for (const [label, over] of /** @type {[string, object][]} */ ([
  ["merged", { pull_request: { merged_at: "2024-03-05T12:00:00Z" } }],
  ["closed-unmerged", {}],
])) {
  test(`parity: a ${label} PR carries no started marker`, () => {
    const s = onePr({ state: "closed", closed_at: "2024-03-05T12:00:00Z", ...over });
    assert.equal(s.started_at, null);
  });
}

// `is_pr &&` — the rule is PR-only, so no issue row earns one whatever its state.
for (const over of [{}, { state: "closed", closed_at: "2026-02-03T04:05:06Z" }]) {
  test(`parity: an issue row (${JSON.stringify(over)}) carries no started marker`, () => {
    assert.equal(oneStory(over).started_at, null);
  });
}

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

// The PR branch of `current_state` (github.rs:1025-1030) is ungated, where the closed-reason
// branch below it checks `type_accepts_rejected` — so a chore PR closed unmerged is rejected.
test("parity: a chore-typed closed-unmerged PR is still rejected", () => {
  const s = onePr({
    state: "closed",
    closed_at: "2024-03-05T12:00:00Z",
    labels: [{ name: "chore" }],
  });
  assert.equal(s.story_type, "chore");
  assert.equal(s.current_state, "rejected");
});

// Pushed after `infer_story_type` has read the author's own labels (github.rs:992-994), so
// the synthetic label can never reclassify the story.
test("parity: the pull-request label lands after type inference, never before it", () => {
  // Position, not just outcome: `inferStoryType` matches none of "pull-request"'s
  // substrings, so asserting the story_type alone would pass however it were ordered.
  assert.deepEqual(onePr({ labels: [{ name: "chore" }] }).labels, ["chore", "pull-request"]);
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

// github.rs:434-472: a merged PR that closed an already-closed imported issue resolved it, so
// it writes no second story — its URL lands on that issue's story instead (#26313 / #26528).
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
  // `#[serde(default)]` turns a *missing* number into 0, which the server's own
  // `row.number <= 0` guard drops; a wrong-typed one is a serde error, not a 0.
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

// The two dependency divergences CONTRACT.md's deps section names, pinned so the
// claim cannot rot into prose (see "Engine parity" — a divergence ships with a test).

test("divergence: the CLI clamps a blocker in bytes where the importer takes 255 chars", () => {
  // `POST /blockers` validates in bytes (`str::len()`), so the CLI must cut earlier
  // than common.rs's `chars().take(255)` — server ask #35629 (/s/y9q8ea68) tracks it.
  const title = "é".repeat(238); // 255 chars once wrapped, 493 bytes
  const desc = blockedByDesc(90, title);
  assert.equal([...desc].length, 255, "exactly the server importer's char cut");
  assert.ok(Buffer.byteLength(desc, "utf8") > 255, "and past the public route's byte limit");

  const op = mapRepo({
    issues: [issue({ number: 7 })],
    comments: [],
    labels: [],
    blockedBy: new Map([["7", [{ number: 90, title }]]]),
  }).stories[0];
  const clamped = /** @type {any} */ (
    clampPlan({ labels: [], stories: [op] }, FALLBACK_LIMITS).stories[0]
  ).blockers[0].desc;
  // 254, not 255: the cut never splits a character, so the last é does not fit.
  assert.ok(Buffer.byteLength(clamped, "utf8") <= 255, "inside the route's byte limit");
  assert.ok(
    [...clamped].length < 255,
    `the CLI keeps fewer characters by design, got ${[...clamped].length}`,
  );
  assert.ok(desc.startsWith(clamped), "a prefix of what the importer would write");
});

test("divergence: the CLI cannot set blocker_display_order; the importer writes the index", () => {
  // `CreateBlocker` has no order field, so every direct-engine row keeps the
  // column's DEFAULT 0 where common.rs pushes `idx as i64`.
  const { stories } = mapRepo({
    issues: [issue({ number: 7 })],
    comments: [],
    labels: [],
    blockedBy: new Map([
      [
        "7",
        [
          { number: 12, title: "Second" },
          { number: 90, title: "Upstream fix" },
        ],
      ],
    ]),
  });
  const blockers = /** @type {any} */ (stories[0]).blockers;
  assert.deepEqual(
    blockers.map((/** @type {any} */ b) => Object.keys(b).sort()),
    [
      ["desc", "resolved"],
      ["desc", "resolved"],
    ],
    "nothing order-shaped to send",
  );
  assert.deepEqual(
    blockers.map((/** @type {any} */ b) => b.desc),
    ["Blocked by #12 (Second)", "Blocked by #90 (Upstream fix)"],
  );
});
