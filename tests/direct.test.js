import assert from "node:assert/strict";
import { test } from "node:test";

import { EATClient } from "../src/client.js";
import { markerFor } from "../src/dedup.js";
import { DirectEngineError, runDirect } from "../src/direct.js";
import { startMockServer } from "../src/mockserver.js";
import { capture } from "./helpers.js";

const stubClient = /** @type {import("../src/client.js").EATClient} */ (
  /** @type {unknown} */ ({})
);

test("dry-run still rejects — the local dry-run lands in the next story", async () => {
  await assert.rejects(
    () => runDirect(stubClient, 91, "o", "r", { included: ["issues"], dryRun: true }),
    (err) => {
      assert.ok(err instanceof DirectEngineError);
      assert.match(err.message, /dry-run/);
      return true;
    },
  );
});

/** A fetched-repo stub shaped like GitHubClient#fetchAll's result. */
function fetchedRepo() {
  return {
    issues: [
      {
        number: 7,
        title: "newer open issue",
        body: "",
        state: "open",
        created_at: "2024-05-01T00:00:00Z",
        labels: [],
      },
      {
        number: 3,
        title: "older closed issue",
        body: "steps\n\n- [x] step one",
        state: "closed",
        created_at: "2020-01-01T00:00:00Z",
        closed_at: "2020-02-01T00:00:00Z",
        labels: [{ name: "bug", color: "ff0000" }],
      },
    ],
    comments: [
      {
        issue_url: "https://api.github.com/repos/o/r/issues/3",
        user: { login: "alice" },
        created_at: "2020-01-05T00:00:00Z",
        body: "confirmed",
      },
    ],
    labels: [{ name: "bug", color: "ff0000" }],
  };
}

test("runDirect imports once, then a re-run skips everything via the markers", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const options = {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    };

    const first = await runDirect(client, 91, "o", "r", options);
    assert.equal(first.importedStories, 2);
    assert.equal(first.importedLabels, 1);
    assert.equal(first.skipped, 0);
    assert.equal(first.dryRun, false);
    assert.deepEqual(first.errors, []);

    const rows = mock.state.stories[91];
    assert.equal(rows.length, 2);
    // Oldest first, marker stamped at the end of every written description.
    assert.equal(rows[0].title, "older closed issue");
    assert.ok(rows[0].description.endsWith(markerFor("o", "r", "3")));
    assert.equal(rows[1].description, markerFor("o", "r", "7"));
    assert.equal(rows[0].tasks.length, 1);
    assert.equal(rows[0].comments.length, 1);

    const rerun = await runDirect(client, 91, "o", "r", options);
    assert.equal(rerun.importedStories, 0);
    assert.equal(rerun.importedLabels, 0);
    assert.equal(rerun.skipped, 2);
    assert.equal(mock.state.stories[91].length, 2);
  } finally {
    await mock.close();
  }
});
