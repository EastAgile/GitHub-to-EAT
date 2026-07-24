import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthError, EATClient } from "../src/client.js";
import { markerFor } from "../src/dedup.js";
import { runDirect } from "../src/direct.js";
import { makeState, startMockServer } from "../src/mockserver.js";
import { capture } from "./helpers.js";

/**
 * Wrap a client method, recording each call's arguments.
 *
 * @param {any} client
 * @param {string} method
 * @returns {any[][]}
 */
function spy(client, method) {
  /** @type {any[][]} */
  const calls = [];
  const orig = client[method].bind(client);
  /** @param {any[]} args */
  client[method] = (...args) => {
    calls.push(args);
    return orig(...args);
  };
  return calls;
}

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

test("against a supporting server every create carries the full pair (AC1)", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const creates = spy(client, "createStory");
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    });
    assert.equal(creates.length, 2);
    for (const [, story] of creates) {
      // Both or neither — a lone field would 400 against the owner-gated pair.
      assert.equal("import_source" in story, "import_external_id" in story);
      assert.equal(story.import_source, "github");
    }
    assert.deepEqual(creates.map(([, s]) => s.import_external_id).sort(), ["3", "7"]);
    // The pair was persisted and reads back through the list filter.
    const rows = mock.state.stories[91];
    assert.equal(
      rows.every((r) => r.import_source === "github"),
      true,
    );
  } finally {
    await mock.close();
  }
});

test("prescan uses the provenance filters on a supporting server, not on an old one (AC2)", async () => {
  const supporting = await startMockServer();
  try {
    const client = new EATClient(supporting.baseUrl, "ea_token");
    const pages = spy(client, "listStoryPage");
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    });
    assert.ok(pages.some(([, opts]) => opts.importSource === "github"));
  } finally {
    await supporting.close();
  }

  const old = await startMockServer(makeState({ provenance: false }));
  try {
    const client = new EATClient(old.baseUrl, "ea_token");
    const pages = spy(client, "listStoryPage");
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    });
    assert.ok(pages.every(([, opts]) => opts.importSource === undefined));
  } finally {
    await old.close();
  }
});

test("a legacy marker-only row is still skipped on a supporting server (AC3)", async () => {
  // Marker in the description, but no server-side pair — an older marker-only CLI run.
  const state = makeState({
    stories: {
      91: [
        {
          story_id: 100,
          title: "older closed issue",
          description: `steps\n\n${markerFor("o", "r", "3")}`,
          tasks_count: 1,
          comment_count: 1,
        },
      ],
    },
  });
  const mock = await startMockServer(state);
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const result = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    });
    // #3 skipped via the marker prescan (the pair filter can't see it); #7 imported.
    assert.equal(result.skipped, 1);
    assert.equal(result.importedStories, 1);
    assert.equal(mock.state.stories[91].length, 2);
  } finally {
    await mock.close();
  }
});

test("a server-style provenance row (pair, no marker) is skipped and counted (AC4)", async () => {
  // Written by the server engine: the pair, no description marker.
  const state = makeState({
    stories: {
      91: [
        {
          story_id: 200,
          title: "newer open issue",
          description: null,
          import_source: "github",
          import_external_id: "7",
          tasks_count: 0,
          comment_count: 0,
        },
      ],
    },
  });
  const mock = await startMockServer(state);
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const result = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    });
    // #7 skipped via the provenance filter (no marker to match); #3 imported.
    assert.equal(result.skipped, 1);
    assert.equal(result.importedStories, 1);
    const rows = mock.state.stories[91];
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.title === "older closed issue"));
  } finally {
    await mock.close();
  }
});

test("old-server fallback is byte-identical v3 marker behaviour (AC5)", async () => {
  const mock = await startMockServer(makeState({ provenance: false }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const creates = spy(client, "createStory");
    const options = {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedRepo() },
    };
    const first = await runDirect(client, 91, "o", "r", options);
    assert.equal(first.importedStories, 2);
    // No pair is ever sent to a server that does not advertise it.
    for (const [, story] of creates) {
      assert.equal("import_source" in story, false);
      assert.equal("import_external_id" in story, false);
    }
    // Re-run still dedups purely via the description markers.
    const rerun = await runDirect(client, 91, "o", "r", options);
    assert.equal(rerun.skipped, 2);
    assert.equal(rerun.importedStories, 0);
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
