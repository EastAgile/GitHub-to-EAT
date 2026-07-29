import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { AuthError, EATClient } from "../src/client.js";
import { markerFor } from "../src/dedup.js";
import { runDirect } from "../src/direct.js";
import { DEFAULT_CUSTOMIZATION, FALLBACK_LIMITS } from "../src/mapping.js";
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
      listEpics: client.listEpics.bind(client),
      createEpic: client.createEpic.bind(client),
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

// --- milestone allowlist: a title nobody carries must not import silently ----

/** @param {Partial<import("../src/mapping.js").Customization>} overrides */
function customization(overrides) {
  return { ...DEFAULT_CUSTOMIZATION, ...overrides };
}

/** fetchAll-shaped stub whose two issues carry milestones "v1.0" and "v2.0". */
function milestonedRepo() {
  return {
    issues: [
      {
        number: 7,
        title: "one",
        body: "",
        state: "open",
        labels: [],
        milestone: { title: "v1.0" },
      },
      {
        number: 8,
        title: "two",
        body: "",
        state: "open",
        labels: [],
        milestone: { title: "v2.0" },
      },
    ],
    comments: [],
    labels: [],
  };
}

test("a milestone title matching no fetched issue imports nothing and warns", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const stream = capture();
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream,
      customization: customization({ milestones: ["v9.9"] }),
      github: { fetchAll: async () => milestonedRepo() },
    });
    assert.equal(outcome.importedStories, 0);
    assert.equal((mock.state.stories[91] ?? []).length, 0);
    assert.match(stream.buf, /warning:.*v9\.9/);
    assert.match(stream.buf, /milestone/);
  } finally {
    await mock.close();
  }
});

test("the milestone warning names only the unmatched titles, and imports the matched ones", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const stream = capture();
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream,
      customization: customization({ milestones: ["v1.0", "typo"] }),
      github: { fetchAll: async () => milestonedRepo() },
    });
    assert.equal(outcome.importedStories, 1);
    assert.equal(mock.state.stories[91][0].title, "one");
    assert.match(stream.buf, /warning:.*typo/);
    assert.ok(!/warning:.*v1\.0/.test(stream.buf));
  } finally {
    await mock.close();
  }
});

test("an empty milestone allowlist imports every issue and warns about nothing", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const stream = capture();
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream,
      customization: customization({ milestones: [] }),
      github: { fetchAll: async () => milestonedRepo() },
    });
    assert.equal(outcome.importedStories, 2);
    assert.equal(mock.state.stories[91].length, 2);
    assert.ok(!/warning:/.test(stream.buf), stream.buf);
  } finally {
    await mock.close();
  }
});

/** fetchAll-shaped stub: "v1.0" sits on an open issue, "v2.0" only on a closed one. */
function mixedStateRepo() {
  return {
    issues: [
      {
        number: 7,
        title: "one",
        body: "",
        state: "open",
        labels: [],
        milestone: { title: "v1.0" },
      },
      {
        number: 8,
        title: "two",
        body: "",
        state: "closed",
        closed_at: "2020-02-01T00:00:00Z",
        labels: [],
        milestone: { title: "v2.0" },
      },
    ],
    comments: [],
    labels: [],
  };
}

test("a milestone the states filter has already excluded still warns", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const stream = capture();
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream,
      customization: customization({ states: "open", milestones: ["v2.0"] }),
      github: { fetchAll: async () => mixedStateRepo() },
    });
    assert.equal(outcome.importedStories, 0);
    assert.equal((mock.state.stories[91] ?? []).length, 0);
    assert.match(stream.buf, /warning:.*v2\.0/);
  } finally {
    await mock.close();
  }
});

test("a states filter that matches no issue warns instead of importing nothing silently", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const stream = capture();
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream,
      customization: customization({ states: "closed" }),
      github: { fetchAll: async () => milestonedRepo() },
    });
    assert.equal(outcome.importedStories, 0);
    assert.match(stream.buf, /warning:.*closed only/);
  } finally {
    await mock.close();
  }
});

test("an unfiltered run that maps no story stays silent", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const stream = capture();
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream,
      customization: customization({}),
      github: { fetchAll: async () => ({ issues: [], comments: [], labels: [] }) },
    });
    assert.ok(!stream.buf.includes("warning:"));
  } finally {
    await mock.close();
  }
});

test("every milestone title matching keeps the run silent", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const stream = capture();
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream,
      customization: customization({ milestones: ["v1.0", "v2.0"] }),
      github: { fetchAll: async () => milestonedRepo() },
    });
    assert.ok(!stream.buf.includes("warning:"), stream.buf);
  } finally {
    await mock.close();
  }
});

// --- org issue types the table does not know (#31927) ------------------------

/**
 * fetchAll-shaped stub: `types` become one issue each, all open, no labels.
 *
 * @param {(object | null | undefined)[]} types
 */
function typedRepo(types) {
  return {
    issues: types.map((type, i) => ({
      number: i + 1,
      title: "one",
      body: "",
      state: "open",
      labels: [],
      type,
    })),
    comments: [],
    labels: [],
  };
}

/**
 * @param {object} options
 * @param {(object | null | undefined)[]} options.types
 * @param {Partial<import("../src/mapping.js").Customization>} [options.overrides]
 */
async function runTyped({ types, overrides = {} }) {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const stream = capture();
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream,
      customization: customization(overrides),
      github: { fetchAll: async () => typedRepo(types) },
    });
    return stream.buf;
  } finally {
    await mock.close();
  }
}

test("issue types the table does not know are counted in one warning", async () => {
  const buf = await runTyped({
    types: [{ name: "Spike" }, { name: "Improvement" }, { name: "Bug" }, null],
  });
  assert.match(buf, /warning: 2 issue\(s\) carry an issue type this importer does not recognise/);
  assert.match(buf, /labels \+ title/);
});

// The count is the whole message: an org-authored type name is untrusted remote
// text, so two different unrecognised names must produce identical output.
test("the unrecognised-type warning never echoes the org's own type name", async () => {
  const evil = await runTyped({ types: [{ name: "Sp\u001b[31mike" }] });
  const plain = await runTyped({ types: [{ name: "Improvement" }] });
  assert.match(evil, /warning: 1 issue\(s\) carry an issue type/);
  assert.ok(!evil.includes("\u001b"));
  assert.equal(evil, plain);
});

test("types that all classify — or no type at all — keep the run silent", async () => {
  const buf = await runTyped({
    types: [{ name: "Bug" }, { name: "task" }, { name: "" }, {}, null, undefined],
  });
  assert.ok(!buf.includes("warning:"), buf);
});

test("a fixed --story-type ignores the type field, so it warns about nothing", async () => {
  const buf = await runTyped({
    types: [{ name: "Spike" }],
    overrides: { storyType: "bug" },
  });
  assert.ok(!buf.includes("warning:"), buf);
});

test("issues the filters dropped are not counted as unrecognised types", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const stream = capture();
    const repo = typedRepo([{ name: "Spike" }, { name: "Spike" }]);
    repo.issues[0].state = "closed";
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream,
      customization: customization({ states: "closed" }),
      github: { fetchAll: async () => repo },
    });
    assert.match(stream.buf, /warning: 1 issue\(s\) carry an issue type/);
  } finally {
    await mock.close();
  }
});

// --- sub-issue cross-links, end to end (#31928) ------------------------------

/** A fetched repo whose #7 parents #12 and #14, in fetchAll's shape. */
function fetchedSubIssueRepo() {
  return {
    issues: [
      {
        number: 7,
        title: "parent",
        body: "roll-up",
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        labels: [],
        sub_issues_summary: { total: 2, completed: 0, percent_completed: 0 },
      },
      {
        number: 12,
        title: "child one",
        body: "first",
        state: "open",
        created_at: "2024-01-02T00:00:00Z",
        labels: [],
      },
      {
        number: 14,
        title: "child two",
        body: "",
        state: "open",
        created_at: "2024-01-03T00:00:00Z",
        labels: [],
      },
    ],
    comments: [],
    labels: [],
    subIssues: new Map([["7", ["12", "14"]]]),
  };
}

test("runDirect writes cross-links on a parent and both its sub-issues, marker still last", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const options = {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedSubIssueRepo() },
    };

    const first = await runDirect(client, 91, "o", "r", options);
    assert.equal(first.importedStories, 3);

    const byTitle = new Map(mock.state.stories[91].map((row) => [row.title, row]));
    assert.equal(
      byTitle.get("parent").description,
      `roll-up\n\nSub-issues: #12, #14\n\n${markerFor("o", "r", "7")}`,
    );
    assert.equal(
      byTitle.get("child one").description,
      `first\n\nSub-issue of #7\n\n${markerFor("o", "r", "12")}`,
    );
    assert.equal(
      byTitle.get("child two").description,
      `Sub-issue of #7\n\n${markerFor("o", "r", "14")}`,
    );

    // The prescan reads these same descriptions back, so a re-run must skip all three.
    const before = mock.state.stories[91].map((row) => row.description);
    const rerun = await runDirect(client, 91, "o", "r", options);
    assert.equal(rerun.importedStories, 0);
    assert.equal(rerun.skipped, 3);
    assert.deepEqual(
      mock.state.stories[91].map((row) => row.description),
      before,
    );
  } finally {
    await mock.close();
  }
});

test("cross-linked descriptions still dedup on the marker alone, without provenance", async () => {
  const mock = await startMockServer(makeState({ provenance: false }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const options = {
      included: ["issues"],
      stream: capture(),
      github: { fetchAll: async () => fetchedSubIssueRepo() },
    };
    assert.equal((await runDirect(client, 91, "o", "r", options)).importedStories, 3);
    const rerun = await runDirect(client, 91, "o", "r", options);
    assert.equal(rerun.importedStories, 0);
    assert.equal(rerun.skipped, 3);
    assert.equal(mock.state.stories[91].length, 3);
  } finally {
    await mock.close();
  }
});

/**
 * Point the real `GitHubClient` at a throwaway server for the length of `fn` by
 * rewriting api.github.com onto it — `runDirect` builds its own client, so this is
 * the only way to exercise the wiring it does.
 *
 * @param {import("node:http").RequestListener} handler
 * @param {() => Promise<void>} fn
 */
async function withGitHubOrigin(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    realFetch(String(input).replace("https://api.github.com", `http://127.0.0.1:${port}`), init);
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

/** @param {import("node:http").ServerResponse} res @param {number} code @param {unknown} body */
const reply = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * Serves one parent whose sub-issue listing 404s, everything else empty.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} path
 */
const failingSubIssues = (res, path) => {
  if (path === "/repos/o/r/issues") {
    return reply(res, 200, [
      { number: 7, title: "parent", state: "open", labels: [], sub_issues_summary: { total: 1 } },
    ]);
  }
  if (path === "/repos/o/r/issues/7/sub_issues") return reply(res, 404, { message: "gone" });
  reply(res, 200, []);
};

test("runDirect hands the real GitHub client a warn sink, so a 404 listing is not silent", async () => {
  const mock = await startMockServer();
  const stream = capture();
  try {
    await withGitHubOrigin(
      (req, res) => failingSubIssues(res, new URL(req.url ?? "", "http://x").pathname),
      async () => {
        const client = new EATClient(mock.baseUrl, "ea_token");
        const outcome = await runDirect(client, 91, "o", "r", { included: ["issues"], stream });
        assert.equal(outcome.importedStories, 1);
      },
    );
  } finally {
    await mock.close();
  }
  assert.match(stream.buf, /warning: .*#7.*sub-issues/);
});

test("a sub-issue warning is flushed after the progress line, never glued to the spinner", async () => {
  const mock = await startMockServer();
  const stream = { ...capture(), isTTY: true, columns: 80 };
  try {
    await withGitHubOrigin(
      (req, res) => failingSubIssues(res, new URL(req.url ?? "", "http://x").pathname),
      async () => {
        const client = new EATClient(mock.baseUrl, "ea_token");
        await runDirect(client, 91, "o", "r", { included: ["issues"], stream });
      },
    );
  } finally {
    await mock.close();
  }
  const warningAt = stream.buf.indexOf("warning:");
  const fetchDoneAt = stream.buf.indexOf("from GitHub — done in");
  assert.ok(fetchDoneAt !== -1, "the fetch progress line finished");
  assert.ok(
    warningAt > fetchDoneAt,
    `warning comes after the progress line, got ${JSON.stringify(stream.buf.slice(0, 300))}`,
  );
  assert.ok(
    stream.buf.slice(0, warningAt).endsWith("\n"),
    "the warning starts on its own line, not glued to the spinner's open \\r line",
  );
});

// --- releases (#31932) -------------------------------------------------------

/** One published release + one draft, shaped like the live REST rows. */
function releaseRows() {
  return [
    {
      id: 100,
      tag_name: "v2.0.0",
      name: "the human title, which is never the story title",
      body: " shipped \n",
      draft: false,
      prerelease: false,
      created_at: "2026-07-08T11:46:45Z",
      published_at: "2026-07-08T11:59:40Z",
      html_url: "https://github.com/o/r/releases/tag/v2.0.0",
    },
    {
      id: 101,
      tag_name: "v2.1.0-draft",
      body: null,
      draft: true,
      created_at: "2026-07-20T00:00:00Z",
      published_at: null,
    },
  ];
}

test("the releases fetch is asked for only when --include names it", async () => {
  /** @type {any[]} */
  const calls = [];
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const github = {
      /** @param {any} [options] */
      fetchAll: async (options) => {
        calls.push(options);
        return { ...fetchedRepo(), releases: [] };
      },
    };
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      dryRun: true,
      stream: capture(),
      github,
    });
    await runDirect(client, 91, "o", "r", {
      included: ["issues", "releases"],
      dryRun: true,
      stream: capture(),
      github,
    });
    // No `included` at all: the default must select nothing, so a caller that never
    // opts in cannot touch /releases — the request count of a default run is fixed.
    await runDirect(client, 91, "o", "r", { dryRun: true, stream: capture(), github });
  } finally {
    await mock.close();
  }
  assert.deepEqual(calls, [{ releases: false }, { releases: true }, { releases: false }]);
});

test("releases import as release stories carrying the server importer's provenance key", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues", "releases"],
      stream: capture(),
      github: { fetchAll: async () => ({ ...fetchedRepo(), releases: releaseRows() }) },
    });
    assert.equal(outcome.importedStories, 4);

    const rows = mock.state.stories[91];
    const published = rows.find((r) => r.import_external_id === "release-100");
    assert.ok(published, `wrote release-100, got ${rows.map((r) => r.import_external_id)}`);
    assert.equal(published.import_source, "github");
    assert.equal(published.title, "v2.0.0");
    assert.equal(published.story_type, "release");
    assert.equal(published.current_state, "accepted");
    assert.equal(published.completed_at, "2026-07-08T11:59:40Z");
    assert.equal(published.created, "2026-07-08T11:46:45Z");
    assert.ok(published.description.startsWith("shipped\n\n"));
    assert.ok(published.description.endsWith(markerFor("o", "r", "release-100")));

    const draft = rows.find((r) => r.import_external_id === "release-101");
    assert.ok(draft, "the draft imports too, rather than being skipped");
    assert.equal(draft.current_state, "unstarted");
    assert.equal(draft.completed_at, undefined);
    assert.equal(draft.created, "2026-07-20T00:00:00Z");
    assert.equal(draft.description, markerFor("o", "r", "release-101"));
    // `release` stories never bear points, so no estimate is ever sent.
    assert.equal(draft.estimate, undefined);
    assert.equal(published.estimate, undefined);
    // `release` is a seeded, globally-scoped story type — GET /story_types lists it
    // with allow_points:false, and /meta's workflow graph has a `release` entry.
    for (const row of rows) assert.ok(row.story_type in mock.state.meta.transitions);
  } finally {
    await mock.close();
  }
});

test("a release story the server importer already wrote is skipped, not duplicated", async () => {
  const mock = await startMockServer();
  try {
    // Exactly the row agile-tracker's github.rs writes: namespaced id, no marker line.
    mock.state.stories[91] = [
      {
        story_id: 999,
        project_id: 91,
        title: "v2.0.0",
        description: "shipped",
        story_type: "release",
        current_state: "accepted",
        import_source: "github",
        import_external_id: "release-100",
        labels: [],
        tasks: [],
        tasks_count: 0,
        comments: [],
        comment_count: 0,
      },
    ];
    const client = new EATClient(mock.baseUrl, "ea_token");
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues", "releases"],
      stream: capture(),
      github: {
        fetchAll: async () => ({ issues: [], comments: [], labels: [], releases: releaseRows() }),
      },
    });
    assert.equal(outcome.skipped, 1);
    assert.equal(outcome.importedStories, 1);
    assert.deepEqual(
      mock.state.stories[91].map((r) => r.import_external_id),
      ["release-100", "release-101"],
    );
  } finally {
    await mock.close();
  }
});

test("without server provenance, the release marker alone dedups a re-run", async () => {
  const mock = await startMockServer(makeState({ provenance: false }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const options = {
      included: ["issues", "releases"],
      stream: capture(),
      github: {
        fetchAll: async () => ({ issues: [], comments: [], labels: [], releases: releaseRows() }),
      },
    };
    const first = await runDirect(client, 91, "o", "r", options);
    assert.equal(first.importedStories, 2);
    // No pair was sent, so only the description marker can carry the key.
    assert.equal(mock.state.stories[91][0].import_external_id, undefined);
    assert.equal(
      mock.state.stories[91][0].description,
      "shipped\n\nImported from https://api.github.com/repos/o/r/releases/100",
    );

    const rerun = await runDirect(client, 91, "o", "r", options);
    assert.equal(rerun.importedStories, 0);
    assert.equal(rerun.skipped, 2);
    assert.equal(mock.state.stories[91].length, 2);
  } finally {
    await mock.close();
  }
});

test("a release with no usable id or tag warns rather than vanishing", async () => {
  const mock = await startMockServer();
  const stream = capture();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues", "releases"],
      dryRun: true,
      stream,
      github: {
        fetchAll: async () => ({
          issues: [],
          comments: [],
          labels: [],
          releases: [{ id: 0, tag_name: "v1" }, { id: 5, tag_name: "  " }, releaseRows()[0]],
        }),
      },
    });
    assert.equal(outcome.importedStories, 1);
  } finally {
    await mock.close();
  }
  assert.match(
    stream.buf,
    /warning: 2 fetched release\(s\) carry no positive numeric id or no tag name/,
  );
  assert.match(stream.buf, /are not imported/);
});

test("no unusable-release warning when every fetched release maps", async () => {
  const mock = await startMockServer();
  const stream = capture();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await runDirect(client, 91, "o", "r", {
      included: ["issues", "releases"],
      dryRun: true,
      stream,
      github: { fetchAll: async () => ({ ...fetchedRepo(), releases: releaseRows() }) },
    });
  } finally {
    await mock.close();
  }
  assert.doesNotMatch(stream.buf, /release\(s\)/);
});

test("a filter that matches no issue does not claim 'nothing to import' when releases will", async () => {
  const mock = await startMockServer();
  const withReleases = capture();
  const issuesOnly = capture();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const customization = { ...DEFAULT_CUSTOMIZATION, states: /** @type {const} */ ("closed") };
    await runDirect(client, 91, "o", "r", {
      included: ["issues", "releases"],
      dryRun: true,
      stream: withReleases,
      customization,
      github: {
        fetchAll: async () => ({
          issues: [{ number: 7, title: "open", state: "open", labels: [] }],
          comments: [],
          labels: [],
          // The unmappable one must not be counted as something the run imports.
          releases: [...releaseRows(), { id: 0, tag_name: "v9" }],
        }),
      },
    });
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      dryRun: true,
      stream: issuesOnly,
      customization,
      github: {
        fetchAll: async () => ({
          issues: [{ number: 7, title: "open", state: "open", labels: [] }],
          comments: [],
          labels: [],
          releases: [],
        }),
      },
    });
  } finally {
    await mock.close();
  }
  // "up to": the count is pre-prescan, so a re-run may already hold some of them.
  assert.match(withReleases.buf, /no issues to import; the run would import up to 2 release\(s\)/);
  assert.doesNotMatch(withReleases.buf, /nothing to import/);
  // The issues-only wording is unchanged.
  assert.match(issuesOnly.buf, /nothing to import\./);
});

test("a run whose releases are all unmappable is back to 'nothing to import'", async () => {
  const mock = await startMockServer();
  const stream = capture();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await runDirect(client, 91, "o", "r", {
      included: ["issues", "releases"],
      dryRun: true,
      stream,
      customization: { ...DEFAULT_CUSTOMIZATION, states: /** @type {const} */ ("closed") },
      github: {
        fetchAll: async () => ({
          issues: [{ number: 7, title: "open", state: "open", labels: [] }],
          comments: [],
          labels: [],
          releases: [{ id: 0, tag_name: "v9" }],
        }),
      },
    });
  } finally {
    await mock.close();
  }
  assert.match(stream.buf, /nothing to import\./);
  assert.doesNotMatch(stream.buf, /the run would import up to/);
});

test("a clamp warning names a release as a release, not as an issue", async () => {
  const mock = await startMockServer();
  const stream = capture();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const [published] = releaseRows();
    published.body = "x".repeat(FALLBACK_LIMITS.storyDescription + 50);
    await runDirect(client, 91, "o", "r", {
      included: ["issues", "releases"],
      dryRun: true,
      stream,
      github: {
        fetchAll: async () => ({ issues: [], comments: [], labels: [], releases: [published] }),
      },
    });
  } finally {
    await mock.close();
  }
  assert.match(stream.buf, /warning: release #100: description truncated/);
  assert.doesNotMatch(stream.buf, /issue #release-100/);
});

// --- milestones → epics (#31931) ---------------------------------------------

/** @param {any} [overrides] */
function epicRepo(overrides = {}) {
  return {
    issues: [
      {
        number: 7,
        title: "in v1",
        body: "",
        state: "open",
        created_at: "2024-05-01T00:00:00Z",
        labels: [],
        milestone: { title: "v1.0", state: "open", due_on: "2024-12-01T00:00:00Z" },
      },
      {
        number: 3,
        title: "also in v1",
        body: "",
        state: "closed",
        created_at: "2020-01-01T00:00:00Z",
        closed_at: "2020-02-01T00:00:00Z",
        labels: [],
        milestone: { title: "v1.0", state: "open", due_on: "2024-12-01T00:00:00Z" },
      },
      {
        number: 9,
        title: "no milestone",
        body: "",
        state: "open",
        created_at: "2024-06-01T00:00:00Z",
        labels: [],
      },
    ],
    comments: [],
    labels: [],
    ...overrides,
  };
}

test("a milestone becomes an epic and every member issue's story carries its label", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues", "milestones"],
      stream: capture(),
      github: { fetchAll: async () => epicRepo() },
    });

    assert.equal(outcome.importedStories, 3);
    // the epic's backing label is the epic's, not a plan label: nothing is counted
    assert.equal(outcome.importedLabels, 0);

    const epics = mock.state.epics[91];
    assert.equal(epics.length, 1);
    assert.equal(epics[0].epic_title, "v1.0");
    assert.equal(epics[0].epic_desc, "GitHub milestone — State: open, Due: 2024-12-01");

    const byTitle = Object.fromEntries(mock.state.stories[91].map((s) => [s.title, s]));
    assert.deepEqual(
      byTitle["in v1"].labels.map((/** @type {any} */ l) => l.label_name),
      ["v1.0"],
    );
    assert.deepEqual(
      byTitle["also in v1"].labels.map((/** @type {any} */ l) => l.label_name),
      ["v1.0"],
    );
    assert.deepEqual(byTitle["no milestone"].labels, []);
    // the label the stories carry IS the epic's backing label — that join is the epic
    assert.equal(byTitle["in v1"].labels[0].label_id, epics[0].label_id);
  } finally {
    await mock.close();
  }
});

test("a re-run creates no duplicate epic and no duplicate label", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const options = {
      included: ["issues", "milestones"],
      stream: capture(),
      github: { fetchAll: async () => epicRepo() },
    };
    await runDirect(client, 91, "o", "r", options);
    const rerun = await runDirect(client, 91, "o", "r", options);

    assert.equal(rerun.importedStories, 0);
    assert.equal(rerun.skipped, 3);
    assert.equal(mock.state.epics[91].length, 1);
    assert.equal(mock.state.labels[91].length, 1);
    assert.equal(mock.state.stories[91].length, 3);
  } finally {
    await mock.close();
  }
});

test("a new issue joining an existing milestone reuses that epic instead of 409ing", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const first = epicRepo();
    await runDirect(client, 91, "o", "r", {
      included: ["issues", "milestones"],
      stream: capture(),
      github: { fetchAll: async () => first },
    });
    const grown = epicRepo();
    grown.issues.push({
      number: 11,
      title: "joined later",
      body: "",
      state: "open",
      created_at: "2025-01-01T00:00:00Z",
      labels: [],
      milestone: { title: "v1.0", state: "closed", due_on: null },
    });
    const out = capture();
    const second = await runDirect(client, 91, "o", "r", {
      included: ["issues", "milestones"],
      stream: out,
      github: { fetchAll: async () => grown },
    });

    assert.equal(second.importedStories, 1);
    assert.equal(mock.state.epics[91].length, 1);
    // epic_desc is written only on creation, so the reused epic keeps the first note
    assert.equal(
      mock.state.epics[91][0].epic_desc,
      "GitHub milestone — State: open, Due: 2024-12-01",
    );
    assert.ok(!out.buf.includes("warning:"), out.buf);
    const joined = mock.state.stories[91].find((s) => s.title === "joined later");
    assert.equal(joined.labels[0].label_id, mock.state.epics[91][0].label_id);
  } finally {
    await mock.close();
  }
});

test("without --include milestones nothing is fetched, labelled, scanned or written", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    /** @type {any[]} */
    const fetchArgs = [];
    const outcome = await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: capture(),
      github: {
        fetchAll: async (options) => {
          fetchArgs.push(options);
          return epicRepo();
        },
      },
    });

    assert.equal(outcome.importedStories, 3);
    // the milestone rides on the issue rows already fetched, so no flag asks for more
    assert.deepEqual(fetchArgs, [{ releases: false }]);
    assert.deepEqual(
      mock.state.requests.filter((r) => r.includes("/epics")),
      [],
    );
    assert.deepEqual(mock.state.epics[91] ?? [], []);
    for (const story of mock.state.stories[91]) assert.deepEqual(story.labels, []);
  } finally {
    await mock.close();
  }
});

test("a default run notes the milestones it is leaving behind, once", async () => {
  const mock = await startMockServer();
  try {
    const out = capture();
    await runDirect(new EATClient(mock.baseUrl, "ea_token"), 91, "o", "r", {
      included: ["issues"],
      stream: out,
      github: { fetchAll: async () => epicRepo() },
    });
    assert.match(out.buf, /note: 2 issue\(s\) carry a GitHub milestone/);
    assert.match(out.buf, /--include issues,milestones/);
    assert.equal(out.buf.split("note: ").length - 1, 1);
  } finally {
    await mock.close();
  }
});

test("the leaving-behind note never fires with the flag on, or with no milestones", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const withFlag = capture();
    await runDirect(client, 91, "o", "r", {
      included: ["issues", "milestones"],
      stream: withFlag,
      github: { fetchAll: async () => epicRepo() },
    });
    assert.ok(!withFlag.buf.includes("note:"), withFlag.buf);

    const noMilestones = capture();
    await runDirect(client, 91, "o", "r2", {
      included: ["issues"],
      stream: noMilestones,
      github: { fetchAll: async () => fetchedRepo() },
    });
    assert.ok(!noMilestones.buf.includes("note:"), noMilestones.buf);
  } finally {
    await mock.close();
  }
});

test("the note counts only issues the run's filters actually keep", async () => {
  const mock = await startMockServer();
  try {
    const out = capture();
    await runDirect(new EATClient(mock.baseUrl, "ea_token"), 91, "o", "r", {
      included: ["issues"],
      customization: { ...DEFAULT_CUSTOMIZATION, states: "closed" },
      stream: out,
      github: { fetchAll: async () => epicRepo() },
    });
    assert.match(out.buf, /note: 1 issue\(s\) carry a GitHub milestone/);
  } finally {
    await mock.close();
  }
});

test("--milestones narrows which epics exist without dropping the mapping", async () => {
  const mock = await startMockServer();
  try {
    const repo = epicRepo();
    repo.issues.push({
      number: 12,
      title: "in v2",
      body: "",
      state: "open",
      created_at: "2024-07-01T00:00:00Z",
      labels: [],
      milestone: { title: "v2.0", state: "open" },
    });
    const outcome = await runDirect(new EATClient(mock.baseUrl, "ea_token"), 91, "o", "r", {
      included: ["issues", "milestones"],
      customization: { ...DEFAULT_CUSTOMIZATION, milestones: ["v2.0"] },
      stream: capture(),
      github: { fetchAll: async () => repo },
    });
    assert.equal(outcome.importedStories, 1);
    assert.deepEqual(
      mock.state.epics[91].map((e) => e.epic_title),
      ["v2.0"],
    );
  } finally {
    await mock.close();
  }
});

test("a dry run plans the epics without creating any", async () => {
  const mock = await startMockServer();
  try {
    const outcome = await runDirect(new EATClient(mock.baseUrl, "ea_token"), 91, "o", "r", {
      included: ["issues", "milestones"],
      dryRun: true,
      stream: capture(),
      github: { fetchAll: async () => epicRepo() },
    });
    assert.equal(outcome.dryRun, true);
    assert.equal(outcome.importedStories, 3);
    // epics are not counted in the plan's label total, exactly as on a real run
    assert.equal(outcome.importedLabels, 0);
    assert.deepEqual(mock.state.epics[91] ?? [], []);
    assert.deepEqual(
      mock.state.requests.filter((r) => r.includes("/epics")),
      [],
    );
  } finally {
    await mock.close();
  }
});

test("a milestone title longer than the column width is reported, not silently merged", async () => {
  const mock = await startMockServer();
  try {
    const long = "v".repeat(260);
    const repo = epicRepo({
      issues: [
        {
          number: 1,
          title: "long milestone",
          body: "",
          state: "open",
          created_at: "2024-01-01T00:00:00Z",
          labels: [],
          milestone: { title: `${long}a`, state: "open" },
        },
        {
          number: 2,
          title: "other long milestone",
          body: "",
          state: "open",
          created_at: "2024-01-02T00:00:00Z",
          labels: [],
          milestone: { title: `${long}b`, state: "open" },
        },
      ],
    });
    const out = capture();
    await runDirect(new EATClient(mock.baseUrl, "ea_token"), 91, "o", "r", {
      included: ["issues", "milestones"],
      stream: out,
      github: { fetchAll: async () => repo },
    });
    assert.match(out.buf, /warning: 2 milestone title\(s\) are longer than 255 bytes/);
    assert.match(out.buf, /titles that agree on that prefix share one epic/);
    // both titles clamp to the same 255 bytes, so they really do share one epic
    assert.equal(mock.state.epics[91].length, 1);
  } finally {
    await mock.close();
  }
});

test("titles inside the column width raise no truncation warning", async () => {
  const mock = await startMockServer();
  try {
    const out = capture();
    await runDirect(new EATClient(mock.baseUrl, "ea_token"), 91, "o", "r", {
      included: ["issues", "milestones"],
      stream: out,
      github: { fetchAll: async () => epicRepo() },
    });
    assert.ok(!out.buf.includes("longer than 255 bytes"), out.buf);
  } finally {
    await mock.close();
  }
});

test("the leaving-behind note ignores pull requests and honours --milestones", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const repo = epicRepo();
    repo.issues.push({
      number: 20,
      title: "a PR in a milestone",
      body: "",
      state: "open",
      created_at: "2024-08-01T00:00:00Z",
      labels: [],
      pull_request: { url: "https://api.github.com/repos/o/r/pulls/20" },
      milestone: { title: "v9.9", state: "open" },
    });
    repo.issues.push({
      number: 21,
      title: "in v2",
      body: "",
      state: "open",
      created_at: "2024-09-01T00:00:00Z",
      labels: [],
      milestone: { title: "v2.0", state: "open" },
    });

    // The PR row carries a milestone but is never mapped, so it is not counted.
    const all = capture();
    await runDirect(client, 91, "o", "r", {
      included: ["issues"],
      stream: all,
      github: { fetchAll: async () => repo },
    });
    assert.match(all.buf, /note: 3 issue\(s\) carry a GitHub milestone/);

    // --milestones narrows what maps, so it narrows what the note counts.
    const filtered = capture();
    await runDirect(client, 91, "o", "r2", {
      included: ["issues"],
      customization: { ...DEFAULT_CUSTOMIZATION, milestones: ["v2.0"] },
      stream: filtered,
      github: { fetchAll: async () => repo },
    });
    assert.match(filtered.buf, /note: 1 issue\(s\) carry a GitHub milestone/);
  } finally {
    await mock.close();
  }
});

// The release marker is 14 bytes longer than the issue marker for the same repo, so
// runDirect must reserve the *per-op* one. Reserving the issue form would clear
// clampPlan and still 400 `too_long` on the real write, which the clamp guarantee
// says is impossible — hence non-dry-run, against a limit-publishing server.
test("a release's over-long notes are clamped against its own marker, end to end", async () => {
  const limit = 400;
  const mock = await startMockServer(makeState({ maxLengths: { description: limit } }));
  const stream = capture();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const [published] = releaseRows();
    published.body = "x".repeat(limit * 2);
    const result = await runDirect(client, 91, "o", "r", {
      included: ["issues", "releases"],
      stream,
      github: {
        fetchAll: async () => ({ issues: [], comments: [], labels: [], releases: [published] }),
      },
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.importedStories, 1);

    const [row] = mock.state.stories[91];
    assert.equal(row.story_type, "release");
    const marker = markerFor("o", "r", "release-100");
    assert.ok(
      row.description.endsWith(marker),
      `marker survived, got ${row.description.slice(-80)}`,
    );
    assert.ok(
      Buffer.byteLength(row.description, "utf8") <= limit,
      `within the server limit, got ${Buffer.byteLength(row.description, "utf8")}`,
    );
    // The shorter issue marker would have fit too; only the release form proves the wiring.
    assert.ok(marker.length > markerFor("o", "r", "100").length);
  } finally {
    await mock.close();
  }
});
