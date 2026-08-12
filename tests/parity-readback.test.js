import assert from "node:assert/strict";
import test from "node:test";

import { commentsFrom, keyOf, toParityRows } from "./parity-readback.js";

/** One EAT list row as the agent-key `GET /stories` walk returns it, recorded 2026-08-06. */
const listRow = (/** @type {any} */ over = {}) => ({
  story_id: 4211,
  story_ref: "91-4211",
  project_id: 91,
  title: "Fix the flaky import",
  name: "Fix the flaky import",
  description: "Body\n\n[View original issue](https://github.com/o/r/issues/7)",
  story_type: "feature",
  current_state: "accepted",
  estimate: null,
  position: 1,
  icebox: false,
  labels: [
    {
      label_id: 9,
      label_name: "bug",
      background_color_hex: "#d73a4a",
      text_color_hex: "#ffffff",
    },
  ],
  owners: [
    {
      member_id: null,
      agent_id: null,
      external_member_id: 4,
      actor: { kind: "external", id: 4, source: "github", username: "sam", name: "sam" },
    },
  ],
  requestor: { kind: "external", id: 5, source: "github", username: "kim", name: "kim" },
  started: null,
  created: "2026-01-02T03:04:05Z",
  rejected_at: null,
  updated_at: "2026-08-06T09:00:00Z",
  blocker_count: 0,
  comment_count: 1,
  tasks_count: 1,
  tasks_complete_count: 1,
  import_source: "github",
  import_external_id: "7",
  ...over,
});

/** The `fields=story_id,tasks` walk's row for the same story. */
const taskRow = (/** @type {any} */ over = {}) => ({
  story_id: 4211,
  tasks: [{ task_id: 12, task_desc: "ship it", complete: true, task_order: 0.0 }],
  ...over,
});

/** One row of `GET /stories/:id/comments`. */
const commentRow = (/** @type {any} */ over = {}) => ({
  comment_id: 77,
  story_id: 4211,
  comment_text: "Looks good to me",
  created: "2026-01-03T00:00:00Z",
  author: { kind: "external", id: 4, source: "github", username: "sam", name: "sam" },
  ...over,
});

// --- keyOf ------------------------------------------------------------------

test("the provenance pair keys the row when the server persists it", () => {
  assert.equal(keyOf(listRow({ import_external_id: "42" })), "42");
});

test("a numeric provenance id keys as its string, so both engines agree", () => {
  assert.equal(keyOf(listRow({ import_external_id: 42 })), "42");
});

test("without provenance the key falls back to the back-link footer's issue number", () => {
  const row = listRow({
    import_external_id: null,
    description: "Body\n\n[View original issue](https://github.com/o/r/issues/912)",
  });

  assert.equal(keyOf(row), "912");
});

test("a release back-link keys as release-<id>, matching the mapper's external id", () => {
  const row = listRow({
    import_external_id: null,
    description: "Imported from https://api.github.com/repos/o/r/releases/33",
  });

  assert.equal(keyOf(row), "release-33");
});

test("a pull back-link keys on the PR number", () => {
  const row = listRow({
    import_external_id: null,
    description: "Body\n\n[View original issue](https://github.com/o/r/pull/8)",
  });

  assert.equal(keyOf(row), "8");
});

test("a row with neither provenance nor a back-link keys as unkeyed, never as a collision", () => {
  const a = keyOf(listRow({ import_external_id: null, description: "just a body", story_id: 1 }));
  const b = keyOf(listRow({ import_external_id: null, description: "just a body", story_id: 2 }));

  assert.equal(a, "unkeyed-story-1");
  assert.notEqual(a, b);
});

test("only the last non-blank line is read, so a quoted marker mid-body never keys the row", () => {
  const row = listRow({
    import_external_id: null,
    description: "Imported from https://github.com/o/r/issues/999\n\nreal body\n",
  });

  assert.equal(keyOf(row), "unkeyed-story-4211");
});

// --- the readback row shape -------------------------------------------------

test("the EAT list row maps onto the parity row the comparison expects", () => {
  const { rows, errors } = toParityRows([listRow()], [taskRow()], [[commentRow()]]);

  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    key: "7",
    name: "Fix the flaky import",
    story_type: "feature",
    current_state: "accepted",
    icebox: false,
    created: "2026-01-02T03:04:05Z",
    started: null,
    rejected_at: null,
    description: "Body\n\n[View original issue](https://github.com/o/r/issues/7)",
    import_source: "github",
    import_external_id: "7",
    tasks: [{ description: "ship it", complete: true }],
    comments: [
      {
        text: "Looks good to me",
        created: "2026-01-03T00:00:00Z",
        author: { kind: "external", id: 4, source: "github", username: "sam", name: "sam" },
      },
    ],
    labels: [{ name: "bug", background_color_hex: "#d73a4a", text_color_hex: "#ffffff" }],
    requestor: { kind: "external", id: 5, source: "github", username: "kim", name: "kim" },
    owners: [
      {
        member_id: null,
        agent_id: null,
        external_member_id: 4,
        actor: { kind: "external", id: 4, source: "github", username: "sam", name: "sam" },
      },
    ],
  });
});

test("a NULL comment_text reads as the empty string, not as a crash", () => {
  const { rows, errors } = toParityRows(
    [listRow()],
    [taskRow()],
    [[commentRow({ comment_text: null })]],
  );

  assert.deepEqual(errors, []);
  assert.equal(rows[0].comments[0].text, "");
});

// --- harness errors: a read that came back empty is not "both sides agree" ---

test("a comment page shorter than the row's own comment_count is a harness error", () => {
  const { errors } = toParityRows([listRow({ comment_count: 3 })], [taskRow()], [[commentRow()]]);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /comment/);
  assert.match(errors[0], /3/);
});

test("a row carrying no comment_count at all is an error, never a silent zero", () => {
  const noCount = listRow();
  delete noCount.comment_count;
  const { errors } = toParityRows([noCount], [taskRow()], [[]]);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /comment_count/);
});

test("a task embed shorter than the row's own tasks_count is a harness error", () => {
  const { errors } = toParityRows([listRow({ tasks_count: 2 })], [taskRow()], [[commentRow()]]);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /tasks/);
});

test("a row carrying no tasks_count at all is an error, never a silent zero", () => {
  const noCount = listRow();
  delete noCount.tasks_count;
  const { errors } = toParityRows([noCount], [taskRow()], [[commentRow()]]);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /tasks_count/);
});

test("a story the second walk never returned is an error, not an empty task list", () => {
  // Same row count both walks, so only the missing id — not a length check — can catch this.
  const { errors } = toParityRows(
    [listRow(), listRow({ story_id: 4212, import_external_id: "8", tasks_count: 0 })],
    [taskRow(), taskRow({ story_id: 9999, tasks: [] })],
    [[commentRow()], []],
  );

  assert.ok(errors.length >= 1, `expected a missing-row error, got ${JSON.stringify(errors)}`);
  assert.match(errors.join("\n"), /4212/);
});

test("the two walks returning different row counts is an error on its own", () => {
  const { errors } = toParityRows([listRow()], [taskRow(), taskRow({ story_id: 4212 })], [[]]);

  assert.ok(errors.length >= 1);
  assert.match(errors.join("\n"), /walk/i);
});

// --- absence is a broken readback, never agreement --------------------------

test("a row with no `name` reads its `title`, the spelling every server version publishes", () => {
  const noAlias = listRow();
  delete noAlias.name;
  const { rows, errors } = toParityRows([noAlias], [taskRow()], [[commentRow()]]);

  assert.deepEqual(errors, []);
  assert.equal(rows[0].name, "Fix the flaky import");
});

test("a row carrying neither name nor title is an error, not an empty name", () => {
  const nameless = listRow();
  delete nameless.name;
  delete nameless.title;
  const { errors } = toParityRows([nameless], [taskRow()], [[commentRow()]]);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /name/);
  assert.match(errors[0], /title/);
});

for (const field of [
  "description",
  "story_type",
  "current_state",
  "icebox",
  "created",
  "started",
  "rejected_at",
  "import_source",
  "import_external_id",
  "requestor",
  "owners",
  "labels",
]) {
  test(`a row carrying no ${field} is an error — absent on both sides is not agreement`, () => {
    const row = listRow();
    delete row[field];
    const { errors } = toParityRows([row], [taskRow()], [[commentRow()]]);

    assert.equal(errors.length, 1, `expected one error, got ${JSON.stringify(errors)}`);
    assert.match(errors[0], new RegExp(field));
  });
}

test("a null value is compared, so only an absent key is a readback error", () => {
  const { errors } = toParityRows(
    [listRow({ requestor: null, import_source: null, import_external_id: null, labels: [] })],
    [taskRow()],
    [[commentRow()]],
  );

  assert.deepEqual(errors, []);
});

test("a clean read reports no errors, so the check cannot be vacuously satisfied", () => {
  const { errors } = toParityRows(
    [listRow(), listRow({ story_id: 4212, import_external_id: "8", comment_count: 0 })],
    [taskRow(), taskRow({ story_id: 4212 })],
    [[commentRow()], []],
  );

  assert.deepEqual(errors, []);
});

// --- the comment route's two response shapes ---------------------------------

test("the comment route's bare array — its no-params shape — reads straight through", () => {
  assert.deepEqual(commentsFrom([commentRow()]), [commentRow()]);
});

test("the cursor envelope any of cursor/limit/order opts into is unwrapped, not crashed on", () => {
  assert.deepEqual(commentsFrom({ items: [commentRow()], next_cursor: null }), [commentRow()]);
});

test("a shape carrying neither reads empty, which the row's own comment_count then catches", () => {
  assert.deepEqual(commentsFrom(null), []);
  assert.deepEqual(commentsFrom({ next_cursor: null }), []);
});
