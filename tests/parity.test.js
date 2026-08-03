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
