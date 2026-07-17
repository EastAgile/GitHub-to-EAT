import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDedup,
  markedExternalIds,
  markerFor,
  prescanImported,
  withMarker,
} from "../src/dedup.js";

test("markerFor renders the stable marker line", () => {
  assert.equal(
    markerFor("octocat", "hello-world", "42"),
    "Imported from https://github.com/octocat/hello-world/issues/42",
  );
});

test("withMarker appends to a body and stands alone on a null one", () => {
  const marker = markerFor("o", "r", "1");
  assert.equal(withMarker("some body", marker), `some body\n\n${marker}`);
  assert.equal(withMarker(null, marker), marker);
  assert.equal(withMarker("", marker), marker);
});

test("markedExternalIds collects only this repo's markers", () => {
  const rows = [
    { story_id: 1, description: `fixed\n\n${markerFor("o", "r", "3")}` },
    { story_id: 2, description: `other repo\n\n${markerFor("someone", "else", "9")}` },
    { story_id: 3, description: "no marker here" },
    { story_id: 4, description: null },
    { story_id: 5 },
  ];
  assert.deepEqual([...markedExternalIds(rows, "o", "r")], ["3"]);
});

test("markedExternalIds escapes regex metacharacters in repo names", () => {
  const rows = [
    { story_id: 1, description: markerFor("o", "r.j", "5") },
    { story_id: 2, description: markerFor("o", "rxj", "6") },
  ];
  assert.deepEqual([...markedExternalIds(rows, "o", "r.j")], ["5"]);
});

test("prescanImported walks every cursor page with the sparse fieldset", () => {
  /** @type {any[]} */
  const calls = [];
  const client = {
    /** @param {number} projectId @param {any} opts */
    async listStoryPage(projectId, opts) {
      calls.push({ projectId, ...opts });
      if (!opts.cursor) {
        return {
          items: [{ story_id: 1, description: markerFor("o", "r", "3") }],
          next_cursor: "1",
        };
      }
      return { items: [{ story_id: 2, description: markerFor("o", "r", "7") }], next_cursor: null };
    },
  };
  return prescanImported(client, 91, "o", "r", { pageSize: 1 }).then((ids) => {
    assert.deepEqual([...ids].sort(), ["3", "7"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].fields, "story_id,description");
    assert.equal(calls[0].limit, 1);
    assert.equal(calls[1].cursor, "1");
  });
});

test("applyDedup skips imported stories, stamps markers, and prunes their labels", () => {
  const plan = /** @type {import("../src/writer.js").WritePlan} */ ({
    labels: [{ name: "bug" }, { name: "docs" }],
    stories: [
      {
        external_id: "3",
        name: "already imported",
        description: "old",
        story_type: "bug",
        current_state: "accepted",
        created_at: null,
        completed_at: null,
        labels: ["bug"],
        tasks: [],
        comments: [],
      },
      {
        external_id: "7",
        name: "fresh",
        description: null,
        story_type: "feature",
        current_state: "unstarted",
        created_at: null,
        completed_at: null,
        labels: ["docs"],
        tasks: [],
        comments: [],
      },
    ],
  });
  const { plan: deduped, skipped } = applyDedup(plan, new Set(["3"]), "o", "r");
  assert.equal(skipped, 1);
  assert.deepEqual(
    deduped.stories.map((s) => s.external_id),
    ["7"],
  );
  assert.equal(deduped.stories[0].description, markerFor("o", "r", "7"));
  assert.deepEqual(
    deduped.labels.map((l) => l.name),
    ["docs"],
  );
  // The input plan is not mutated.
  assert.equal(plan.stories[1].description, null);
});
