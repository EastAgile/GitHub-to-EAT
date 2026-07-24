import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthError, EATClient } from "../src/client.js";
import { markerFor } from "../src/dedup.js";
import { runDirect } from "../src/direct.js";
import { makeState, startMockServer } from "../src/mockserver.js";
import { capture } from "./helpers.js";

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

    // GitHub slugs are case-insensitive — a differently-cased re-run must skip too.
    const recased = await runDirect(client, 91, "O", "R", options);
    assert.equal(recased.importedStories, 0);
    assert.equal(recased.skipped, 2);
    assert.equal(mock.state.stories[91].length, 2);
  } finally {
    await mock.close();
  }
});

test("runDirect runs the customize hook after fetch and maps with its result", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    /** @type {any} */
    let seenFetched = null;
    const res = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
      customize: async (fetched) => {
        seenFetched = fetched;
        return {
          states: "open",
          milestones: null,
          storyType: "chore",
          comments: false,
          tasks: false,
        };
      },
    });
    // The hook saw the fetched payload; states:"open" drops the closed issue (#3).
    assert.equal(seenFetched.issues.length, 2);
    assert.equal(res.importedStories, 1);
    const rows = mock.state.stories[91];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "newer open issue");
    assert.equal(rows[0].story_type, "chore");
  } finally {
    await mock.close();
  }
});

test("dry-run computes the plan locally and writes nothing", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const options = {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    };

    const plan = await runDirect(client, 91, "o", "r", { ...options, dryRun: true });
    assert.equal(plan.importedStories, 2);
    assert.equal(plan.importedLabels, 1);
    assert.equal(plan.skipped, 0);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.errors, []);
    assert.equal((mock.state.stories[91] ?? []).length, 0);
    assert.equal((mock.state.labels[91] ?? []).length, 0);

    // After a real import, a dry-run re-run reports everything as would-skip.
    await runDirect(client, 91, "o", "r", options);
    const rerun = await runDirect(client, 91, "o", "r", { ...options, dryRun: true });
    assert.equal(rerun.importedStories, 0);
    assert.equal(rerun.importedLabels, 0);
    assert.equal(rerun.skipped, 2);
    assert.equal(rerun.dryRun, true);
    assert.equal(mock.state.stories[91].length, 2);
  } finally {
    await mock.close();
  }
});

test("a story left incomplete by an interrupted run stays skipped but warns", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const github = { fetchAll: async () => fetchedRepo() };
    // First run dies on the closed issue's comment, after its story (and marker) landed.
    const failing = {
      createLabel: client.createLabel.bind(client),
      createStory: client.createStory.bind(client),
      createTask: client.createTask.bind(client),
      listStoryPage: client.listStoryPage.bind(client),
      createComment: async () => {
        throw new AuthError("simulated mid-run failure");
      },
    };
    await assert.rejects(
      runDirect(failing, 91, "o", "r", { included: ["issues"], stream: capture(), github }),
      AuthError,
    );
    assert.equal(mock.state.stories[91].length, 1);

    const out = capture();
    const rerun = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: out,
      github,
    });
    // The incomplete story stays skipped (with a warning); the unwritten one imports.
    assert.equal(rerun.skipped, 1);
    assert.equal(rerun.importedStories, 1);
    assert.match(out.buf, /warning: issue #3 .*comments 0\/1/);
    assert.doesNotMatch(out.buf, /issue #7/);
    assert.equal(mock.state.stories[91].length, 2);
  } finally {
    await mock.close();
  }
});

test("over-long text is clamped to the published limits and the import completes", async () => {
  const mock = await startMockServer(
    makeState({ maxLengths: { comment_text: 200, description: 300 } }),
  );
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const repo = fetchedRepo();
    repo.issues[0].body = "B".repeat(1000);
    repo.comments.push({
      issue_url: "https://api.github.com/repos/o/r/issues/7",
      user: { login: "bob" },
      created_at: "2024-05-02T00:00:00Z",
      body: "b".repeat(5000),
    });
    const out = capture();
    const result = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: out,
      github: { fetchAll: async () => repo },
    });
    assert.equal(result.importedStories, 2);
    assert.deepEqual(result.errors, []);
    assert.match(out.buf, /warning: issue #7: description truncated/);
    assert.match(out.buf, /warning: issue #7: comment 1 truncated/);

    const rows = mock.state.stories[91];
    const newer = rows.find((r) => r.title === "newer open issue");
    // The clamped description still ends with the dedup marker, inside the limit.
    assert.ok(newer.description.length <= 300);
    assert.ok(newer.description.endsWith(markerFor("o", "r", "7")));
    assert.ok(newer.comments[0].comment_text.length <= 200);
    assert.ok(newer.comments[0].comment_text.includes("[truncated by github-to-eat"));
  } finally {
    await mock.close();
  }
});

// --- backdating end-to-end (story #32427) --------------------------------------

test("against a backdating server, rows carry the GitHub dates and the @login: prefix", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    });
    const rows = mock.state.stories[91];
    const closed = rows.find((r) => r.title === "older closed issue");
    const open = rows.find((r) => r.title === "newer open issue");
    assert.equal(closed.created_at, "2020-01-01T00:00:00Z");
    assert.equal(closed.completed_at, "2020-02-01T00:00:00Z");
    assert.equal(open.created_at, "2024-05-01T00:00:00Z");
    // Open issues send no completion.
    assert.ok(!("completed_at" in open));
    // The comment date rides on the write, so the prefix collapses to @login:.
    assert.equal(closed.comments[0].comment_text, "@alice:\n\nconfirmed");
    assert.equal(closed.comments[0].created_at, "2020-01-05T00:00:00Z");
  } finally {
    await mock.close();
  }
});

test("against an older (non-backdating) server, the dated prefix is preserved and no dates leak", async () => {
  const mock = await startMockServer(makeState({ backdating: false }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    });
    const rows = mock.state.stories[91];
    const closed = rows.find((r) => r.title === "older closed issue");
    assert.ok(!("created_at" in closed));
    assert.ok(!("completed_at" in closed));
    assert.equal(closed.comments[0].comment_text, "@alice on 2020-01-05:\n\nconfirmed");
    assert.ok(!("created_at" in closed.comments[0]));
  } finally {
    await mock.close();
  }
});
