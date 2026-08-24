/**
 * The flip (story #57634). Everything here drives the real transports against a local GitHub
 * stub, so a listing that moved to the wrong one shows up as a request on the wrong path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EATClient } from "../src/client.js";
import {
  fetchFloor,
  HybridFetcher,
  ISSUE_PAGE_POINTS,
  ISSUE_PAGE_POINTS_WITH_DEPS,
} from "../src/direct.js";
import { RateBudgetError } from "../src/github.js";
import { startMockServer } from "../src/mockserver.js";
import { capture, issueNode, releaseRow, withGitHubStub } from "./helpers.js";

/**
 * @param {string} base
 * @param {{ warn?: (message: string) => void, onProgress?: (status: any) => void }} [options]
 */
function fetcherAt(base, options = {}) {
  return new HybridFetcher("o", "r", { apiBase: base, token: "ghp_secret", ...options });
}

// --- the split: the issue graph over GraphQL, releases alone over REST --------

test("the issue graph is fetched over GraphQL and never over the REST listings", async () => {
  /** @type {any} */
  let fetched;
  await withGitHubStub(
    { issues: [issueNode()], labels: [{ name: "bug", color: "ff0000" }] },
    async ({ base, seen }) => {
      fetched = await fetcherAt(base).fetchAll({});
      const rest = seen.filter((r) => r.method === "GET").map((r) => r.path);
      assert.deepEqual(
        rest,
        ["/rate_limit"],
        "no REST issue, comment or label listing is requested",
      );
      assert.deepEqual(
        seen
          .filter((r) => r.method === "POST")
          .map((r) => r.operationName)
          .sort(),
        ["ImportIssues", "ImportLabels"],
      );
    },
  );
  assert.deepEqual(
    fetched.issues.map((/** @type {any} */ i) => i.number),
    [7],
  );
  assert.deepEqual(fetched.labels, [{ name: "bug", color: "ff0000" }]);
});

test("releases stay on the REST listing, beside the GraphQL issue graph", async () => {
  /** @type {any} */
  let fetched;
  await withGitHubStub(
    { issues: [issueNode()], releases: [releaseRow()] },
    async ({ base, seen }) => {
      fetched = await fetcherAt(base).fetchAll({ releases: true });
      assert.deepEqual(
        seen.filter((r) => r.method === "GET").map((r) => r.path),
        ["/rate_limit", "/repos/o/r/releases"],
      );
      // The GraphQL fetcher refuses `releases` outright, so a route that drifted onto it
      // would fail rather than quietly ask for a listing GraphQL does not serve.
      assert.deepEqual(
        seen
          .filter((r) => r.method === "POST")
          .map((r) => r.operationName)
          .sort(),
        ["ImportIssues", "ImportLabels"],
      );
    },
  );
  assert.deepEqual(
    fetched.releases.map((/** @type {any} */ r) => r.tag_name),
    ["v2.0.0"],
  );
});

test("the token reaches the REST half too — the probe and the release listing both carry it", async () => {
  // CONTRACT.md promises the bearer on both transports. Dropping it from the REST half
  // makes the probe read the anonymous bucket and 404s /releases on a private repo.
  await withGitHubStub(
    { issues: [issueNode()], releases: [releaseRow()] },
    async ({ base, seen }) => {
      await fetcherAt(base).fetchAll({ releases: true });
      const rest = seen.filter((r) => r.method === "GET");
      assert.deepEqual(
        rest.map((r) => [r.path, r.authorization]),
        [
          ["/rate_limit", "Bearer ghp_secret"],
          ["/repos/o/r/releases", "Bearer ghp_secret"],
        ],
      );
      assert.ok(
        seen
          .filter((r) => r.method === "POST")
          .every((r) => r.authorization === "Bearer ghp_secret"),
        "and GraphQL carries the same one",
      );
    },
  );
});

test("without --include releases the REST release listing is never touched", async () => {
  await withGitHubStub(
    { issues: [issueNode()], releases: [releaseRow()] },
    async ({ base, seen }) => {
      const fetched = await fetcherAt(base).fetchAll({});
      assert.deepEqual(fetched.releases, []);
      assert.deepEqual(
        seen.filter((r) => r.path.startsWith("/repos/")),
        [],
      );
    },
  );
});

test("--include prs adds the PR connection, still on GraphQL", async () => {
  await withGitHubStub(
    {
      issues: [issueNode()],
      pullRequests: [issueNode({ number: 10, state: "MERGED", mergedAt: "2026-04-01T00:00:00Z" })],
    },
    async ({ base, seen }) => {
      const fetched = await fetcherAt(base).fetchAll({ pullRequests: true });
      assert.deepEqual(
        fetched.issues.map((/** @type {any} */ i) => i.number),
        [7, 10],
      );
      assert.ok(
        seen.some((r) => r.operationName === "ImportPullRequests"),
        "the PR listing rides GraphQL too",
      );
      assert.deepEqual(
        seen.filter((r) => r.method === "GET").map((r) => r.path),
        ["/rate_limit"],
      );
    },
  );
});

test("the fetcher refuses to be built without a token, so no path reaches GraphQL anonymously", () => {
  // The CLI's usage error is the first guard; this is the one that holds if it ever moves.
  assert.throws(
    () => new HybridFetcher("o", "r", { apiBase: "http://127.0.0.1:1" }),
    (/** @type {any} */ err) => {
      assert.equal(err.constructor.name, "GitHubAuthError");
      assert.match(err.message, /--token \/ GITHUB_TOKEN/);
      return true;
    },
  );
});

// --- the point-budget gate ----------------------------------------------------

test("a spent GraphQL point budget refuses the fetch before it spends a point", async () => {
  await withGitHubStub(
    { issues: [issueNode()], budget: { resources: { graphql: { remaining: 1 } } } },
    async ({ base, seen }) => {
      await assert.rejects(
        () => fetcherAt(base).fetchAll({}),
        (/** @type {any} */ err) => {
          assert.ok(err instanceof RateBudgetError, `got ${err?.constructor?.name}`);
          assert.match(err.message, /\b1\b/);
          assert.match(err.message, new RegExp(`\\b${fetchFloor({})}\\b`));
          return true;
        },
      );
      assert.deepEqual(
        seen.filter((r) => r.method === "POST"),
        [],
        "refused before any query is sent",
      );
    },
  );
});

test("the deps selection raises the floor by the point it costs", async () => {
  assert.equal(ISSUE_PAGE_POINTS_WITH_DEPS, ISSUE_PAGE_POINTS + 1);
  assert.equal(fetchFloor({ dependencies: true }), fetchFloor({}) + 1);
  await withGitHubStub(
    { issues: [issueNode()], budget: { resources: { graphql: { remaining: fetchFloor({}) } } } },
    async ({ base, seen }) => {
      // The same budget that affords a plain page cannot afford one carrying blockedBy.
      await fetcherAt(base).fetchAll({});
      assert.ok(seen.some((r) => r.operationName === "ImportIssues"));
      await assert.rejects(
        () => fetcherAt(base).fetchAll({ dependencies: true }),
        (/** @type {any} */ err) => {
          assert.ok(err instanceof RateBudgetError, `got ${err?.constructor?.name}`);
          assert.match(err.message, new RegExp(`\\b${fetchFloor({ dependencies: true })}\\b`));
          return true;
        },
      );
    },
  );
});

test("the floor prices the labels listing too — it always runs beside the issues one", async () => {
  // A budget that affords the issue page alone dies on the concurrent ImportLabels query,
  // so pricing the issue page alone promised a clean refusal it could not give.
  assert.equal(fetchFloor({}), ISSUE_PAGE_POINTS + 1);
  await withGitHubStub(
    {
      issues: [issueNode()],
      budget: { resources: { graphql: { remaining: ISSUE_PAGE_POINTS } } },
    },
    async ({ base, seen }) => {
      await assert.rejects(
        () => fetcherAt(base).fetchAll({}),
        (/** @type {any} */ err) => err instanceof RateBudgetError,
      );
      assert.deepEqual(
        seen.filter((r) => r.method === "POST"),
        [],
        "refused before either listing is sent",
      );
    },
  );
});

test("--include prs raises the floor again — a third listing runs with the other two", async () => {
  assert.equal(fetchFloor({ pullRequests: true }), fetchFloor({}) + 1);
  await withGitHubStub(
    { issues: [issueNode()], budget: { resources: { graphql: { remaining: fetchFloor({}) } } } },
    async ({ base }) => {
      await fetcherAt(base).fetchAll({});
      await assert.rejects(
        () => fetcherAt(base).fetchAll({ pullRequests: true }),
        (/** @type {any} */ err) => {
          assert.ok(err instanceof RateBudgetError, `got ${err?.constructor?.name}`);
          assert.match(err.message, new RegExp(`\\b${fetchFloor({ pullRequests: true })}\\b`));
          return true;
        },
      );
    },
  );
});

test("a host publishing no point budget stays ungated, as a headerless host always has", async () => {
  await withGitHubStub(
    { issues: [issueNode()], budget: { resources: { core: { remaining: 0 } } } },
    async ({ base, seen }) => {
      const fetched = await fetcherAt(base).fetchAll({});
      assert.equal(fetched.issues.length, 1);
      assert.ok(seen.some((r) => r.operationName === "ImportIssues"));
    },
  );
});

test("a spent core budget never refuses a release import — only graphql is gated", async () => {
  await withGitHubStub(
    {
      issues: [issueNode()],
      releases: [releaseRow()],
      budget: { resources: { core: { remaining: 0 }, graphql: { remaining: 5000 } } },
    },
    async ({ base, seen }) => {
      const fetched = await fetcherAt(base).fetchAll({ releases: true });
      assert.equal(fetched.releases.length, 1, "gating core would refuse a run that works today");
      assert.ok(seen.some((r) => r.path === "/repos/o/r/releases"));
    },
  );
});

test("the budget is read once per fetch, from the free probe and not from the pages", async () => {
  await withGitHubStub({ issues: [issueNode()] }, async ({ base, seen }) => {
    await fetcherAt(base).fetchAll({});
    assert.deepEqual(
      seen.filter((r) => r.path === "/rate_limit").length,
      1,
      "one uncounted probe, before the listing",
    );
    assert.equal(seen[0].path, "/rate_limit", "the probe runs first, so the refusal is preflight");
  });
});

// --- the floor is a floor: what a mid-walk exhaustion costs -------------------

/**
 * One issue whose `blockedBy` overflows page one, so the walk must hydrate the rest.
 *
 * @param {(request: any) => any} onHydrate what the ImportIssueBlockedBy follow-up answers
 */
function overflowingBlockers(onHydrate) {
  const page = { pageInfo: { hasNextPage: false, endCursor: null } };
  return (/** @type {any} */ request) => {
    if (request.operationName === "ImportIssueBlockedBy") return onHydrate(request);
    if (request.operationName === "ImportLabels") {
      return { data: { repository: { labels: { ...page, nodes: [] } } } };
    }
    return {
      data: {
        repository: {
          issues: {
            totalCount: 1,
            ...page,
            nodes: [
              issueNode({
                number: 7,
                title: "Add a widget",
                blockedBy: {
                  nodes: [{ number: 90, title: "Upstream fix" }],
                  pageInfo: { hasNextPage: true, endCursor: "blockers-2" },
                },
              }),
            ],
          },
        },
      },
    };
  };
}

test("a budget spent after the gate degrades the blockers instead of failing the run", async () => {
  // The gate is a floor read once, so a run it lets through can still exhaust the budget
  // mid-walk. This is what that costs, and CONTRACT.md now says so.
  /** @type {string[]} */
  const warnings = [];
  /** @type {any} */
  let fetched;
  await withGitHubStub(
    {
      graphql: overflowingBlockers(() => ({
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      })),
    },
    async ({ base }) => {
      fetched = await fetcherAt(base, { warn: (m) => warnings.push(m) }).fetchAll({
        dependencies: true,
      });
    },
  );
  assert.deepEqual(
    fetched.blockedBy.get("7").map((/** @type {any} */ b) => b.number),
    [90],
    "only the blockers page one carried survive; the rest are lost for good",
  );
  assert.ok(
    warnings.some((w) => /point budget stopped the dependency walks/.test(w)),
    warnings.join(""),
  );
});

test("a listing page the budget cannot pay fails the run, so nothing is half-written", async () => {
  let served = 0;
  await withGitHubStub(
    {
      graphql: (request) => {
        if (request.operationName === "ImportLabels") {
          return {
            data: {
              repository: {
                labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          };
        }
        served += 1;
        if (served > 1) {
          return { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] };
        }
        return {
          data: {
            repository: {
              issues: {
                totalCount: 150,
                pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                nodes: [issueNode()],
              },
            },
          },
        };
      },
    },
    async ({ base }) => {
      await assert.rejects(
        () => fetcherAt(base).fetchAll({}),
        (/** @type {any} */ err) => {
          assert.equal(err.constructor.name, "RateLimitError");
          return true;
        },
      );
    },
  );
});

// --- `fetching X/Y`, exact from totalCount ------------------------------------

test("the fetch line counts pages from totalCount, not from what has been fetched", async () => {
  const { runDirect } = await import("../src/direct.js");
  const mock = await startMockServer();
  const stream = { ...capture(), isTTY: true, columns: 120 };
  try {
    // One page, and a totalCount the walk never reaches: only totalCount can say "of 2".
    // Two served pages would let the page counter alone render the same line.
    await withGitHubStub(
      {
        graphql: (request) => {
          if (request.operationName === "ImportLabels") {
            return {
              data: {
                repository: {
                  labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                },
              },
            };
          }
          return {
            data: {
              repository: {
                issues: {
                  totalCount: 150,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [issueNode({ number: 1 })],
                },
              },
            },
          };
        },
      },
      async ({ base }) => {
        await runDirect(new EATClient(mock.baseUrl, "ea_token"), 91, "o", "r", {
          included: ["issues"],
          token: "ghp_secret",
          apiBase: base,
          stream,
        });
      },
    );
  } finally {
    await mock.close();
  }
  // 150 issues at 100 per page is 2 pages, and this walk fetched exactly one: the "2" can
  // come from nowhere but `totalCount`. The finished line re-reads the thunk, so it lands.
  assert.match(stream.buf, /fetching o\/r from GitHub page 1\/2 — done in/);
});

// --- the pipeline end to end: GraphQL → mapping → the EAT mock ----------------

test("runDirect writes GraphQL-fetched issues and REST-fetched releases into EAT", async () => {
  const { runDirect } = await import("../src/direct.js");
  const mock = await startMockServer();
  try {
    await withGitHubStub(
      {
        issues: [issueNode({ number: 7, title: "Add a widget" })],
        labels: [{ name: "bug", color: "ff0000" }],
        releases: [releaseRow()],
      },
      async ({ base }) => {
        const client = new EATClient(mock.baseUrl, "ea_token");
        const outcome = await runDirect(client, 91, "o", "r", {
          included: ["issues", "releases"],
          token: "ghp_secret",
          apiBase: base,
          stream: capture(),
        });
        assert.equal(outcome.importedStories, 2);
      },
    );
    const titles = mock.state.stories[91].map((/** @type {any} */ s) => s.title).sort();
    assert.deepEqual(titles, ["Add a widget", "v2.0.0"]);
  } finally {
    await mock.close();
  }
});

// --- the whole CLI, end to end: real argv, real EAT mock, real GitHub stub ----

/** The fixture repo, exercising every `--include` type at once. */
function repoFixture() {
  return {
    issues: [
      issueNode({
        number: 7,
        title: "Add a widget",
        milestone: { title: "v1.0", dueOn: null, state: "OPEN" },
        labels: { nodes: [{ name: "bug", color: "ff0000" }] },
        comments: {
          nodes: [
            {
              body: "confirmed",
              createdAt: "2026-01-03T00:00:00Z",
              author: { __typename: "User", login: "alice", databaseId: 11, url: "u" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        subIssues: { nodes: [{ number: 3 }], pageInfo: { hasNextPage: false, endCursor: null } },
        blockedBy: {
          nodes: [{ number: 90, title: "Upstream fix" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      issueNode({
        number: 3,
        title: "older closed issue",
        state: "CLOSED",
        createdAt: "2020-01-01T00:00:00Z",
        closedAt: "2020-02-01T00:00:00Z",
        blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
    ],
    pullRequests: [
      issueNode({
        number: 10,
        title: "merged PR",
        state: "MERGED",
        mergedAt: "2026-05-01T00:00:00Z",
        createdAt: "2026-04-01T00:00:00Z",
        url: "https://github.com/o/r/pull/10",
      }),
    ],
    labels: [{ name: "bug", color: "ff0000" }],
    releases: [releaseRow()],
  };
}

test("the CLI imports a repo end to end over GraphQL, with releases alone over REST", async () => {
  const { main } = await import("../src/cli.js");
  const { runDirect } = await import("../src/direct.js");
  const { inTempDir, withEnv } = await import("./helpers.js");
  const mock = await startMockServer();
  try {
    await withGitHubStub(repoFixture(), async ({ base, seen }) => {
      const out = capture();
      const err = capture();
      const code = await inTempDir(() =>
        withEnv(
          { EAT_AGENT_KEY: "key", EAT_API_BASE: mock.baseUrl, EAT_APP_BASE: "https://eat.example" },
          () =>
            main(
              [
                ...["--project", "91", "--repo", "o/r", "--engine", "direct"],
                ...["--include", "issues,prs,milestones,releases,deps"],
                ...["--token", "ghp_secret", "-y"],
              ],
              {
                confirm: null,
                stdout: out,
                stderr: err,
                // Only the API base is redirected; every other seam is the real one.
                runDirect: (client, project, owner, repo, opts) =>
                  runDirect(client, project, owner, repo, { ...opts, apiBase: base }),
              },
            ),
        ),
      );
      assert.equal(code, 0, `${out.buf}\n${err.buf}`);
      assert.match(out.buf, /Imported 4 stories \(2 labels\), skipped 0, 0 error\(s\)\./);
      // Sorted: the listings run concurrently, so only the probe's position is fixed.
      assert.equal(seen[0].path, "/rate_limit", "the free probe runs before anything is spent");
      assert.deepEqual(
        seen.map((r) => r.operationName ?? `${r.method} ${r.path}`).sort(),
        [
          "GET /rate_limit",
          "GET /repos/o/r/releases",
          "ImportIssues",
          "ImportLabels",
          "ImportPullRequests",
        ],
        "one free probe, three GraphQL listings, one REST listing — and nothing else",
      );
    });

    const stories = mock.state.stories[91];
    assert.deepEqual(stories.map((/** @type {any} */ s) => s.title).sort(), [
      "Add a widget",
      "merged PR",
      "older closed issue",
      "v2.0.0",
    ]);
    const widget = stories.find((/** @type {any} */ s) => s.title === "Add a widget");
    assert.deepEqual(
      widget.comments.map((/** @type {any} */ c) => c.comment_text),
      ["confirmed"],
    );
    assert.deepEqual(
      widget.blockers.map((/** @type {any} */ b) => b.blocker_desc),
      ["Blocked by #90 (Upstream fix)"],
    );
    assert.match(widget.description, /Sub-issues: #3/);
    assert.deepEqual(widget.labels.map((/** @type {any} */ l) => l.label_name).sort(), [
      "bug",
      "v1.0",
    ]);
    assert.deepEqual(
      (mock.state.epics[91] ?? []).map((/** @type {any} */ e) => e.epic_title),
      ["v1.0"],
    );
    const release = stories.find((/** @type {any} */ s) => s.title === "v2.0.0");
    assert.equal(release.story_type, "release");
  } finally {
    await mock.close();
  }
});

// --- the server engine is untouched by the flip ------------------------------

/**
 * Every byte the server engine printed on `main` at 65d9d02, frozen rather than rebuilt from
 * the modules under change: a golden the code can regenerate proves nothing about a move.
 */
const SERVER_ENGINE_STDOUT =
  "Import mapping (GitHub → East Agile Tracker):\n" +
  "  issues:\n" +
  "    - open issue → story (unstarted); closed issue → story (accepted, keeps the closed date)\n" +
  "    - labels → labels (with colors); issue-body checklists → story tasks\n" +
  "    - comments → comments (body only)\n" +
  "  prs:\n" +
  "    - open PR → story (started); merged PR → story (accepted, 'pull-request' label)\n" +
  "    - closed-unmerged PR → story (rejected)\n" +
  "    - a merged PR that closes an imported issue folds into that issue's story\n" +
  "  milestones:\n" +
  "    - milestone → epic (an issue keeps its milestone as the epic's label)\n" +
  "  releases:\n" +
  "    - release → release-type story (tag → title, notes → description, publish date kept)\n" +
  "  deps:\n" +
  "    - issue 'blocked by' dependency → a blocker on its story " +
  "('Blocked by #90 (Upstream fix)', unresolved)\n" +
  "    - a blocker is recorded whether or not the blocking issue is itself imported\n" +
  "Imports append to the project; re-runs skip already-imported items; nothing is updated " +
  "or deleted.\n" +
  "Importing o/r into project 91 (Mock Project)...\n" +
  "Imported 6 stories (0 labels), skipped 0, 0 error(s).\n" +
  "Board: https://eat.example/projects/91\n";

const SERVER_ENGINE_STDERR = "waiting for the server to import GitHub issues...\n";

const SERVER_ENGINE_IMPORT_BODY = {
  source: "github",
  owner: "o",
  repo: "r",
  include_pull_requests: true,
  include_milestones: true,
  include_releases: true,
  include_dependencies: true,
};

/**
 * Run `fn` with every request to api.github.com recorded and refused. The server engine
 * must reach GitHub through EAT alone, so any hit at all is the flip leaking into it.
 *
 * @param {(hits: string[]) => Promise<void>} fn
 */
async function withGitHubTrapped(fn) {
  /** @type {string[]} */
  const hits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (/** @type {any} */ input, /** @type {any} */ init) => {
    const url = String(typeof input === "string" ? input : (input?.url ?? input));
    if (url.startsWith("https://api.github.com")) {
      hits.push(url);
      return Promise.reject(new Error(`the server engine reached GitHub: ${url}`));
    }
    return realFetch(input, init);
  };
  try {
    await fn(hits);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("the server engine's output and import body are byte-identical to before the flip", async () => {
  const { inTempDir, withEnv } = await import("./helpers.js");
  const mock = await startMockServer();
  try {
    await withGitHubTrapped(async (hits) => {
      // Imported under the trap, not before it. A fetch at module load still escapes it —
      // the file's static imports build the graph first; the wiring guard pins that half.
      const { main } = await import("../src/cli.js");
      const out = capture();
      const err = capture();
      const code = await inTempDir(() =>
        withEnv(
          { EAT_AGENT_KEY: "key", EAT_API_BASE: mock.baseUrl, EAT_APP_BASE: "https://eat.example" },
          () =>
            main(
              [
                ...["--project", "91", "--repo", "o/r"],
                ...["--include", "issues,prs,milestones,releases,deps", "-y"],
              ],
              { confirm: null, stdout: out, stderr: err },
            ),
        ),
      );
      assert.equal(code, 0, err.buf);
      // No token, as before: the server engine fetches on EAT's own credential.
      assert.equal(out.buf, SERVER_ENGINE_STDOUT);
      assert.equal(err.buf, SERVER_ENGINE_STDERR);
      assert.deepEqual(hits, [], "the server engine never talks to GitHub itself");
    });
    assert.equal(mock.state.imports.length, 1);
    assert.deepEqual(mock.state.imports[0].body, SERVER_ENGINE_IMPORT_BODY);
  } finally {
    await mock.close();
  }
});
