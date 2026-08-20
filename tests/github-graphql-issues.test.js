import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  GitHubAuthError,
  GitHubError,
  RateLimitError,
  MAX_SUB_ISSUE_PAGES as REST_MAX_SUB_ISSUE_PAGES,
  RepoNotFoundError,
} from "../src/github.js";
import {
  ACTOR_SELECTION,
  commentsSelection,
  fetchedIssue,
  GHOST_USER,
  GitHubGraphQLFetcher,
  issueCommentsQuery,
  issueNodeSelection,
  issueSubIssuesQuery,
  issuesQuery,
  labelsQuery,
  MAX_LISTING_PAGES,
  MAX_SUB_ISSUE_PAGES,
  nodeSelection,
  Pager,
  personFromActor,
} from "../src/github-graphql-issues.js";
import { mapRepo } from "../src/mapping.js";
import { formatImportStatus } from "../src/progress.js";
import { capture } from "./helpers.js";

const ISSUE_URL = "https://api.github.com/repos/octocat/hello/issues/7";

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Run `fn` against a throwaway GraphQL endpoint. `respond` answers one request from
 * the operation and variables it carries; every request body is recorded in `seen`.
 *
 * @param {(request: { operationName: string, query: string,
 *   variables: Record<string, any> }) => unknown} respond
 * @param {(base: string, seen: any[]) => Promise<void>} fn
 */
async function withGraphQL(respond, fn) {
  /** @type {any[]} */
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const request = JSON.parse(await readBody(req));
    seen.push(request);
    /** @type {unknown} */
    let payload;
    try {
      payload = respond(request);
    } catch (err) {
      // An unanswered request stalls the fetch to its 30s timeout, and the fixture guard that
      // actually fired is buried. Hand the message back as the failure instead.
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    await fn(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

/**
 * @param {string} base
 * @param {{ warn?: (message: string) => void,
 *   onProgress?: (status: any) => void }} [options]
 */
function fetcherAt(base, { warn, onProgress } = {}) {
  return new GitHubGraphQLFetcher("octocat", "hello", {
    apiBase: base,
    token: "ghp_secret",
    warn,
    onProgress,
  });
}

/** @param {object} [over] */
const issueNode = (over = {}) => ({
  number: 7,
  title: "Add a widget",
  body: "hello",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-01-02T03:04:05Z",
  closedAt: null,
  url: "https://github.com/octocat/hello/issues/7",
  author: {
    __typename: "User",
    login: "octocat",
    databaseId: 1,
    url: "https://github.com/octocat",
  },
  assignees: { nodes: [] },
  labels: { nodes: [] },
  milestone: null,
  issueType: null,
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  subIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  ...over,
});

/**
 * @param {any[]} nodes
 * @param {{ hasNextPage?: boolean, endCursor?: string | null, totalCount?: number,
 *   remaining?: number }} [page]
 */
const issuesEnvelope = (
  nodes,
  { hasNextPage = false, endCursor = null, totalCount = nodes.length, remaining = 4999 } = {},
) => ({
  data: {
    rateLimit: { remaining, resetAt: "2030-01-01T00:00:00Z" },
    repository: { issues: { totalCount, pageInfo: { hasNextPage, endCursor }, nodes } },
  },
});

/**
 * @param {any[]} nodes
 * @param {{ hasNextPage?: boolean, endCursor?: string | null }} [page]
 */
const labelsEnvelope = (nodes, { hasNextPage = false, endCursor = null } = {}) => ({
  data: {
    rateLimit: { remaining: 4999, resetAt: "2030-01-01T00:00:00Z" },
    repository: { labels: { pageInfo: { hasNextPage, endCursor }, nodes } },
  },
});

/**
 * One issues page and one (empty) labels page — the responder most tests want.
 *
 * @param {any[]} nodes
 * @param {{ hasNextPage?: boolean, endCursor?: string | null, totalCount?: number,
 *   remaining?: number }} [page]
 */
const oneRepo = (nodes, page) => (/** @type {{ operationName: string }} */ request) =>
  request.operationName === "ImportLabels" ? labelsEnvelope([]) : issuesEnvelope(nodes, page);

// --- the query, ported from github.rs `issues_query` --------------------------

test("the issues query asks for rateLimit at the top level, beside repository", () => {
  const query = issuesQuery();
  assert.match(
    query,
    /query ImportIssues\(\$owner: String!, \$name: String!, \$first: Int!, \$after: String\)/,
  );
  assert.match(query, /rateLimit \{ remaining resetAt \}/);
  // Beside `repository`, not inside it: the transport reads `data.rateLimit`.
  assert.ok(query.indexOf("rateLimit") < query.indexOf("repository("));
});

test("the issues listing pages by CREATED_AT DESC and asks for an exact totalCount", () => {
  const query = issuesQuery();
  assert.match(
    query,
    /issues\(first: \$first, after: \$after, orderBy: \{field: CREATED_AT, direction: DESC\}\)/,
  );
  assert.match(query, /totalCount pageInfo \{ hasNextPage endCursor \}/);
});

test("every actor implementer declares its own databaseId", () => {
  assert.match(ACTOR_SELECTION, /__typename login url/);
  for (const type of ["User", "Bot", "Organization", "Mannequin"]) {
    assert.match(ACTOR_SELECTION, new RegExp(`\\.\\.\\. on ${type} \\{ databaseId \\}`));
  }
});

test("the assignee sub-selection carries no __typename, exactly as the server's does", () => {
  assert.match(
    issueNodeSelection(),
    /assignees\(first: 100\) \{ nodes \{ login databaseId url \} \}/,
  );
});

test("the node selection is composed from the shared actor and comment parts", () => {
  const selection = issueNodeSelection();
  assert.ok(selection.includes(ACTOR_SELECTION));
  assert.ok(selection.includes(commentsSelection()));
});

test("the issue node selects issueType and subIssues unconditionally, and no blockedBy", () => {
  const selection = issueNodeSelection();
  assert.match(selection, /issueType \{ name \}/);
  assert.match(
    selection,
    /subIssues\(first: 100\) \{ pageInfo \{ hasNextPage endCursor \} nodes \{ number \} \}/,
  );
  assert.doesNotMatch(selection, /blockedBy/);
});

test("the shared node selection is exported, so a pull-request node can reuse it", () => {
  const selection = nodeSelection("mergedAt", [commentsSelection()]);
  assert.match(selection, /^number title body state mergedAt createdAt closedAt url /);
  assert.ok(selection.includes(ACTOR_SELECTION));
  assert.ok(selection.includes(commentsSelection()));
  assert.doesNotMatch(selection, /stateReason|issueType|subIssues/);
  // A node type with no state-detail field leaves no gap where one would have gone.
  assert.match(nodeSelection("", []), /^number title body state createdAt closedAt url /);
});

test("the labels query walks the repository's own label listing", () => {
  const query = labelsQuery();
  assert.match(query, /query ImportLabels/);
  assert.match(
    query,
    /labels\(first: \$first, after: \$after\) \{ pageInfo \{ hasNextPage endCursor \} nodes \{ name color \} \}/,
  );
});

// --- the rename layer, ported from github.rs `impl From<GqlIssueNode> for GhIssue` ---

test("the rename layer gives an issue row REST's field names", () => {
  const { issue } = fetchedIssue(
    issueNode({
      closedAt: "2026-02-03T04:05:06Z",
      milestone: { title: "v1", dueOn: "2026-03-01T00:00:00Z", state: "OPEN" },
      issueType: { name: "Bug" },
    }),
    ISSUE_URL,
  );
  assert.equal(issue.html_url, "https://github.com/octocat/hello/issues/7");
  assert.equal(issue.created_at, "2026-01-02T03:04:05Z");
  assert.equal(issue.closed_at, "2026-02-03T04:05:06Z");
  assert.deepEqual(issue.milestone, { title: "v1", due_on: "2026-03-01T00:00:00Z", state: "open" });
  assert.deepEqual(issue.type, { name: "Bug" });
  assert.deepEqual(issue.user, {
    id: 1,
    login: "octocat",
    html_url: "https://github.com/octocat",
  });
  for (const camel of ["url", "createdAt", "closedAt", "stateReason", "issueType", "subIssues"]) {
    assert.ok(!(camel in issue), `${camel} survived the rename`);
  }
});

test("an issue row carries no pull_request key, so mapping.js reads it as an issue", () => {
  const { issue } = fetchedIssue(issueNode(), ISSUE_URL);
  assert.ok(!("pull_request" in issue));
});

test("the enums arrive lowercased, so mapping.js's exact-match vocabularies still hit", () => {
  const { issue } = fetchedIssue(
    issueNode({ state: "CLOSED", stateReason: "NOT_PLANNED", closedAt: "2026-02-03T04:05:06Z" }),
    ISSUE_URL,
  );
  assert.equal(issue.state, "closed");
  assert.equal(issue.state_reason, "not_planned");
  const story = mapRepo({ issues: [issue], comments: [], labels: [] }).stories[0];
  assert.ok(story.labels.includes("not-planned"));
  assert.equal(story.current_state, "rejected");
});

test("labels and assignees arrive as REST rows", () => {
  const { issue } = fetchedIssue(
    issueNode({
      labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
      assignees: {
        nodes: [{ login: "hubot", databaseId: 5, url: "https://github.com/hubot" }],
      },
    }),
    ISSUE_URL,
  );
  assert.deepEqual(issue.labels, [{ name: "bug", color: "d73a4a" }]);
  assert.deepEqual(issue.assignees, [
    { id: 5, login: "hubot", html_url: "https://github.com/hubot" },
  ]);
});

test("a Bot author gains REST's [bot] suffix, and never a second one", () => {
  const bot = (/** @type {string} */ login) =>
    personFromActor({ __typename: "Bot", login, databaseId: 49699333, url: "u" }).login;
  assert.equal(bot("dependabot"), "dependabot[bot]");
  assert.equal(bot("dependabot[bot]"), "dependabot[bot]");
  assert.equal(
    personFromActor({ __typename: "User", login: "dependabot", databaseId: 1, url: "u" }).login,
    "dependabot",
  );
});

test("an actor without a databaseId becomes id 0, the id mapping.js refuses", () => {
  const person = personFromActor({ __typename: "Mannequin", login: "ex-employee", url: "u" });
  assert.equal(person.id, 0);
});

test("a deleted author becomes REST's ghost user", () => {
  const { issue } = fetchedIssue(issueNode({ author: null }), ISSUE_URL);
  assert.deepEqual(issue.user, GHOST_USER);
  assert.equal(GHOST_USER.id, 10137);
  assert.equal(GHOST_USER.login, "ghost");
  assert.equal(GHOST_USER.html_url, "https://github.com/ghost");
});

test("the issue row keeps an unusable author instead of filtering it there", () => {
  // github.rs filters in `issue_to_record`, not in the shape conversion; here that
  // filter is mapping.js `externalPerson`, which this row must still reach.
  const { issue } = fetchedIssue(
    issueNode({ author: { __typename: "User", login: "gone", url: "u" } }),
    ISSUE_URL,
  );
  assert.equal(issue.user.id, 0);
  const story = mapRepo({ issues: [issue], comments: [], labels: [] }, undefined, {
    sendPeople: true,
  }).stories[0];
  assert.equal(story.requestor, null);
});

// --- comments and sub-issues nested under the issue node ----------------------

test("comments flatten into REST rows whose issue_url keys them back to their issue", () => {
  const { comments } = fetchedIssue(
    issueNode({
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            body: "first",
            createdAt: "2026-01-03T00:00:00Z",
            author: { __typename: "User", login: "octocat", databaseId: 1, url: "u" },
          },
        ],
      },
    }),
    ISSUE_URL,
  );
  assert.deepEqual(comments, [
    {
      body: "first",
      created_at: "2026-01-03T00:00:00Z",
      issue_url: ISSUE_URL,
      user: { id: 1, login: "octocat", html_url: "u" },
    },
  ]);
});

test("a whitespace-only comment body is dropped, as comment_nodes_to_records drops it", () => {
  const { comments } = fetchedIssue(
    issueNode({
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { body: "   \n ", createdAt: "2026-01-03T00:00:00Z", author: null },
          { body: null, createdAt: "2026-01-03T00:00:00Z", author: null },
          { body: "kept", createdAt: "2026-01-03T00:00:00Z", author: null },
        ],
      },
    }),
    ISSUE_URL,
  );
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, "kept");
  assert.deepEqual(comments[0].user, GHOST_USER);
});

test("a non-string comment body is coerced, so mapping.js can trim it", () => {
  const { issue, comments } = fetchedIssue(
    issueNode({
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ body: 42, createdAt: "2026-01-03T00:00:00Z", author: null }],
      },
    }),
    ISSUE_URL,
  );
  assert.equal(comments[0].body, "42");
  const story = mapRepo({ issues: [issue], comments, labels: [] }).stories[0];
  assert.match(story.comments[0].text, /42/);
});

test("a node the token cannot read is dropped from its connection, not carried as null", () => {
  const { issue, comments, subIssues } = fetchedIssue(
    issueNode({
      labels: { nodes: [null, { name: "bug", color: "d73a4a" }] },
      assignees: { nodes: [null, { login: "hubot", databaseId: 5, url: "u" }] },
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [null, { body: "kept", createdAt: "2026-01-03T00:00:00Z", author: null }],
      },
      subIssues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [null, { number: 8 }],
      },
    }),
    ISSUE_URL,
  );
  assert.deepEqual(issue.labels, [{ name: "bug", color: "d73a4a" }]);
  assert.deepEqual(issue.assignees, [{ id: 5, login: "hubot", html_url: "u" }]);
  assert.equal(comments.length, 1);
  assert.deepEqual(subIssues, ["8"]);
});

test("a connection that sends no nodes array reads as empty rather than crashing", () => {
  const { issue, comments, subIssues } = fetchedIssue(
    issueNode({
      labels: {},
      assignees: { nodes: null },
      comments: { pageInfo: { hasNextPage: false, endCursor: null } },
      subIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: "nope" },
    }),
    ISSUE_URL,
  );
  assert.deepEqual(issue.labels, []);
  assert.deepEqual(issue.assignees, []);
  assert.deepEqual(comments, []);
  assert.deepEqual(subIssues, []);
});

test("sub-issue numbers land under their parent, self-references and non-numbers dropped", () => {
  const { subIssues } = fetchedIssue(
    issueNode({
      subIssues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ number: 8 }, { number: 8 }, { number: 7 }, { number: 0 }, { number: 9 }],
      },
    }),
    ISSUE_URL,
  );
  assert.deepEqual(subIssues, ["8", "9"]);
});

test("a connection with a further page reports the cursor that resumes it", () => {
  const { truncated } = fetchedIssue(
    issueNode({
      comments: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [] },
      subIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    }),
    ISSUE_URL,
  );
  assert.deepEqual(truncated, { comments: "c1", subIssues: null });
});

test("a further page with no cursor is still truncated, so the shortfall stays loud", () => {
  const { truncated } = fetchedIssue(
    issueNode({
      comments: { pageInfo: { hasNextPage: true, endCursor: "" }, nodes: [] },
      subIssues: { pageInfo: { hasNextPage: true }, nodes: [] },
    }),
    ISSUE_URL,
  );
  assert.deepEqual(truncated, { comments: "", subIssues: "" });
});

// --- the cursor walk ----------------------------------------------------------

test("a cursor that stops advancing fails the walk instead of looping", () => {
  const pager = new Pager();
  assert.equal(pager.advance("c1"), true);
  assert.throws(
    () => pager.advance("c1"),
    (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(err.message, /cursor stopped advancing/);
      return true;
    },
  );
});

test("an exhausted listing ends the walk", () => {
  assert.equal(new Pager().advance(null), false);
});

test("a listing past every plausible repository size fails the walk", () => {
  const pager = new Pager();
  pager.page = MAX_LISTING_PAGES;
  assert.throws(() => pager.advance("c1"), /past every plausible repository size/);
});

test("the fetcher follows endCursor until hasNextPage is false", async () => {
  /** @type {(request: any) => unknown} */
  const respond = (request) => {
    if (request.operationName === "ImportLabels") return labelsEnvelope([]);
    return request.variables.after === null || request.variables.after === undefined
      ? issuesEnvelope([issueNode({ number: 7 })], {
          hasNextPage: true,
          endCursor: "c1",
          totalCount: 2,
        })
      : issuesEnvelope([issueNode({ number: 8 })], { totalCount: 2 });
  };
  await withGraphQL(respond, async (base, seen) => {
    const { issues } = await fetcherAt(base).fetchAll();
    assert.deepEqual(
      issues.map((issue) => issue.number),
      [7, 8],
    );
    const listings = seen.filter((request) => request.operationName === "ImportIssues");
    assert.equal(listings.length, 2);
    assert.equal(listings[0].variables.first, 100);
    assert.equal(listings[1].variables.after, "c1");
  });
});

test("a repeating cursor fails the fetch rather than paginating forever", async () => {
  const respond = (/** @type {any} */ request) =>
    request.operationName === "ImportLabels"
      ? labelsEnvelope([])
      : issuesEnvelope([issueNode()], { hasNextPage: true, endCursor: "same" });
  await withGraphQL(respond, async (base) => {
    await assert.rejects(fetcherAt(base).fetchAll(), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(err.message, /cursor stopped advancing/);
      return true;
    });
  });
});

test("totalCount drives an exact fetching X/Y line", async () => {
  /** @type {any[]} */
  const reported = [];
  const respond = (/** @type {any} */ request) => {
    if (request.operationName === "ImportLabels") return labelsEnvelope([]);
    return request.variables.after
      ? issuesEnvelope([issueNode({ number: 8 })], { totalCount: 150 })
      : issuesEnvelope([issueNode()], { hasNextPage: true, endCursor: "c1", totalCount: 150 });
  };
  await withGraphQL(respond, async (base) => {
    await fetcherAt(base, { onProgress: (status) => reported.push(status) }).fetchAll();
    assert.deepEqual(reported.map(formatImportStatus), ["fetching 1/2", "fetching 2/2"]);
  });
});

test("a listing that reports no totalCount still reports its phase", async () => {
  /** @type {any[]} */
  const reported = [];
  const respond = (/** @type {any} */ request) =>
    request.operationName === "ImportLabels"
      ? labelsEnvelope([])
      : {
          data: {
            repository: {
              issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        };
  await withGraphQL(respond, async (base) => {
    await fetcherAt(base, { onProgress: (status) => reported.push(status) }).fetchAll();
    assert.deepEqual(reported.map(formatImportStatus), ["fetching"]);
  });
});

// --- the fetched repo ---------------------------------------------------------

test("fetchAll returns the issues, their comments, the repo labels and the hierarchy", async () => {
  const parent = issueNode({
    number: 7,
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ body: "on seven", createdAt: "2026-01-03T00:00:00Z", author: null }],
    },
    subIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 8 }] },
  });
  const child = issueNode({ number: 8, title: "Child" });
  const respond = (/** @type {any} */ request) =>
    request.operationName === "ImportLabels"
      ? labelsEnvelope([{ name: "bug", color: "d73a4a" }])
      : issuesEnvelope([parent, child]);
  await withGraphQL(respond, async (base) => {
    const fetched = await fetcherAt(base).fetchAll();
    assert.deepEqual(
      fetched.issues.map((issue) => issue.number),
      [7, 8],
    );
    assert.equal(fetched.comments.length, 1);
    assert.equal(fetched.comments[0].issue_url, `${base}/repos/octocat/hello/issues/7`);
    assert.deepEqual(fetched.labels, [{ name: "bug", color: "d73a4a" }]);
    assert.deepEqual([...fetched.subIssues], [["7", ["8"]]]);
  });
});

test("the fetched repo maps straight through mapping.js, comments on the right story", async () => {
  const respond = oneRepo([
    issueNode({
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            body: "on seven",
            createdAt: "2026-01-03T00:00:00Z",
            author: { __typename: "User", login: "octocat", databaseId: 1, url: "u" },
          },
        ],
      },
    }),
  ]);
  await withGraphQL(respond, async (base) => {
    const fetched = await fetcherAt(base).fetchAll();
    const story = mapRepo(fetched).stories[0];
    assert.equal(story.external_id, "7");
    assert.equal(story.comments.length, 1);
    assert.match(story.comments[0].text, /on seven/);
  });
});

test("the repo's label listing follows its own cursor", async () => {
  const respond = (/** @type {any} */ request) => {
    if (request.operationName !== "ImportLabels") return issuesEnvelope([]);
    return request.variables.after
      ? labelsEnvelope([{ name: "chore", color: "ffffff" }])
      : labelsEnvelope([{ name: "bug", color: "d73a4a" }], {
          hasNextPage: true,
          endCursor: "l1",
        });
  };
  await withGraphQL(respond, async (base) => {
    const { labels } = await fetcherAt(base).fetchAll();
    assert.deepEqual(
      labels.map((label) => label.name),
      ["bug", "chore"],
    );
  });
});

test("a spent point budget warns, because the listing asks for rateLimit", async () => {
  const warned = capture();
  const respond = oneRepo([issueNode()], { remaining: 5 });
  await withGraphQL(respond, async (base) => {
    await fetcherAt(base, { warn: (message) => void warned.write(message) }).fetchAll();
  });
  assert.match(warned.buf, /point budget is nearly exhausted/);
});

test("an issue whose comments hydration cannot drain warns rather than truncating quietly", async () => {
  const warned = capture();
  const respond = oneRepo([
    issueNode({
      comments: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
    }),
  ]);
  await withGraphQL(respond, async (base) => {
    await fetcherAt(base, { warn: (message) => void warned.write(message) }).fetchAll();
  });
  assert.match(warned.buf, /#7/);
  assert.match(warned.buf, /comments/);
});

test("a listing that promises a page but sends no cursor warns instead of stopping silently", async () => {
  const warned = capture();
  const respond = oneRepo([issueNode()], { hasNextPage: true, endCursor: null });
  await withGraphQL(respond, async (base, seen) => {
    const { issues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.equal(issues.length, 1);
    assert.equal(seen.filter((request) => request.operationName === "ImportIssues").length, 1);
  });
  assert.match(warned.buf, /another page of issues but sent no cursor/);
});

test("an issue whose sub-issues hydration cannot drain warns too", async () => {
  const warned = capture();
  const respond = oneRepo([
    issueNode({
      subIssues: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [{ number: 8 }] },
    }),
  ]);
  await withGraphQL(respond, async (base) => {
    await fetcherAt(base, { warn: (message) => void warned.write(message) }).fetchAll();
  });
  assert.match(warned.buf, /sub-issues/);
});

test("an empty endCursor is no cursor: the walk warns and stops instead of re-reading", async () => {
  const warned = capture();
  const respond = oneRepo([issueNode()], { hasNextPage: true, endCursor: "" });
  await withGraphQL(respond, async (base, seen) => {
    const { issues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.equal(issues.length, 1);
    assert.equal(seen.filter((request) => request.operationName === "ImportIssues").length, 1);
  });
  assert.match(warned.buf, /another page of issues but sent no cursor/);
});

test("an overflowing connection that sends no cursor still warns", async () => {
  /** @type {string[]} */
  const warnings = [];
  const respond = oneRepo([
    issueNode({
      comments: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
    }),
  ]);
  await withGraphQL(respond, async (base) => {
    await fetcherAt(base, { warn: (message) => warnings.push(message) }).fetchAll();
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /#7/);
  assert.match(warnings[0], /comments/);
});

test("many overflowing issues are summarised in one line, not one line each", async () => {
  /** @type {string[]} */
  const warnings = [];
  const nodes = Array.from({ length: 12 }, (_, index) =>
    issueNode({
      number: index + 1,
      comments: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
    }),
  );
  await withGraphQL(oneRepo(nodes), async (base) => {
    await fetcherAt(base, { warn: (message) => warnings.push(message) }).fetchAll();
  });
  assert.equal(warnings.length, 1, `one aggregated warning, got ${warnings.length}`);
  assert.match(warnings[0], /12 issue\(s\) have comments this fetch could not finish reading/);
  // The list of numbers is capped, so a repo-wide overflow cannot render one line per issue.
  assert.match(warnings[0], /and 2 more/);
  assert.equal((warnings[0].match(/#\d+/g) ?? []).length, 10);
});

test("a fetcher built without a warn sink still reports an overflow, on stderr", async () => {
  const respond = oneRepo([
    issueNode({ comments: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } }),
  ]);
  /** @type {string[]} */
  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = /** @type {any} */ (
    (/** @type {any} */ chunk) => {
      written.push(String(chunk));
      return true;
    }
  );
  try {
    await withGraphQL(respond, async (base) => {
      await fetcherAt(base).fetchAll();
    });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(written.length, 1);
  assert.match(written[0], /#7/);
});

test("a repo that gains issues mid-walk never renders a page count below the page", async () => {
  /** @type {any[]} */
  const reported = [];
  const respond = (/** @type {any} */ request) => {
    if (request.operationName === "ImportLabels") return labelsEnvelope([]);
    return request.variables.after
      ? issuesEnvelope([issueNode({ number: 8 })], { totalCount: 100 })
      : issuesEnvelope([issueNode()], { hasNextPage: true, endCursor: "c1", totalCount: 100 });
  };
  await withGraphQL(respond, async (base) => {
    await fetcherAt(base, { onProgress: (status) => reported.push(status) }).fetchAll();
    assert.deepEqual(reported.map(formatImportStatus), ["fetching 1/1", "fetching 2/2"]);
  });
});

test("an issue whose number is unusable keeps its row, loses its links, and says so", async () => {
  const warned = capture();
  const respond = oneRepo([
    issueNode({
      number: "7\r\u001b[2Kgotcha",
      comments: {
        pageInfo: { hasNextPage: true, endCursor: "c1" },
        nodes: [{ body: "orphan", createdAt: "2026-01-03T00:00:00Z", author: null }],
      },
      subIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 8 }] },
    }),
  ]);
  await withGraphQL(respond, async (base) => {
    const fetched = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    // The REST path keeps such a row too; only the number-keyed stages skip it.
    assert.equal(fetched.issues.length, 1);
    assert.equal(fetched.comments.length, 0);
    assert.equal(fetched.subIssues.size, 0);
  });
  assert.match(warned.buf, /1 issue\(s\) arrived without a usable issue number/);
  assert.doesNotMatch(warned.buf, /gotcha/);
});

// --- what the transport already decides, reaching the fetcher unchanged -------

test("the fetcher refuses to be built without a token, as the transport does", () => {
  assert.throws(
    () => new GitHubGraphQLFetcher("octocat", "hello", { apiBase: "https://example.invalid" }),
    GitHubAuthError,
  );
});

test("a null repository reaches the caller as repo-not-found", async () => {
  await withGraphQL(
    () => ({ data: { repository: null } }),
    async (base) => {
      await assert.rejects(fetcherAt(base).fetchAll(), RepoNotFoundError);
    },
  );
});

test("a repository without the listing is an unexpected shape, not an empty repo", async () => {
  await withGraphQL(
    () => ({ data: { repository: {} } }),
    async (base) => {
      await assert.rejects(fetcherAt(base).fetchAll(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /unexpected response shape/);
        return true;
      });
    },
  );
});

test("fetchAll refuses the listings it does not implement yet, as a GitHubError", async () => {
  await withGraphQL(oneRepo([]), async (base) => {
    for (const option of ["pullRequests", "releases", "dependencies"]) {
      // src/cli.js formats only EATError and GitHubError; anything else reaches the
      // user as an unhandled rejection with a Node stack trace.
      await assert.rejects(fetcherAt(base).fetchAll({ [option]: true }), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, new RegExp(option));
        return true;
      });
    }
  });
});

// --- overflow hydration (story #57632) ----------------------------------------

/**
 * @param {any[]} nodes
 * @param {{ hasNextPage?: boolean, endCursor?: string | null }} [page]
 */
const conn = (nodes, { hasNextPage = false, endCursor = null } = {}) => ({
  pageInfo: { hasNextPage, endCursor },
  nodes,
});

/** @param {number} at */
const commentNode = (at) => ({
  body: `comment ${at}`,
  createdAt: "2026-01-03T00:00:00Z",
  author: null,
});

/**
 * One issues page, one (empty) labels page, and `hydrate` for every follow-up query.
 *
 * @param {any[]} nodes
 * @param {(request: any) => any} hydrate the `repository` a follow-up answers with
 */
const hydratingRepo = (nodes, hydrate) => (/** @type {any} */ request) => {
  if (request.operationName === "ImportLabels") return labelsEnvelope([]);
  if (request.operationName === "ImportIssues") return issuesEnvelope(nodes);
  return { data: { repository: hydrate(request) } };
};

/**
 * The follow-up answer a test that forbids a follow-up must never receive. Answering rather
 * than throwing keeps a wrong request a failed assertion, not a fetch stalled to its timeout.
 */
const NEVER_ASKED = () => ({
  issue: { comments: conn([commentNode(999)]), subIssues: conn([{ number: 999 }]) },
});

/**
 * @param {any[]} seen
 * @param {string} operationName
 * @returns {any[]}
 */
const requestsFor = (seen, operationName) =>
  seen.filter((request) => request.operationName === operationName);

test("the ImportIssueComments query is github.rs issue_comments_query field for field", () => {
  const query = issueCommentsQuery();
  assert.equal(
    query,
    "query ImportIssueComments($owner: String!, $name: String!, $number: Int!, " +
      "$first: Int!, $after: String) { repository(owner: $owner, name: $name) { " +
      "issue(number: $number) { comments(first: $first, after: $after) { " +
      "pageInfo { hasNextPage endCursor } " +
      `nodes { body createdAt author { ${ACTOR_SELECTION} } } } } } }`,
  );
  // A follow-up buys no rateLimit field, exactly as github.rs's follow-ups do not.
  assert.ok(!query.includes("rateLimit"));
});

test("the ImportIssueSubIssues query is github.rs issue_sub_issues_query field for field", () => {
  assert.equal(
    issueSubIssuesQuery(),
    "query ImportIssueSubIssues($owner: String!, $name: String!, $number: Int!, " +
      "$first: Int!, $after: String) { repository(owner: $owner, name: $name) { " +
      "issue(number: $number) { subIssues(first: $first, after: $after) { " +
      "pageInfo { hasNextPage endCursor } nodes { number } } } } }",
  );
});

test("an issue past 100 comments resumes from its listing cursor, never re-reading page 1", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [
      issueNode({
        comments: conn(
          Array.from({ length: 100 }, (_, at) => commentNode(at)),
          { hasNextPage: true, endCursor: "c1" },
        ),
      }),
    ],
    () => ({ issue: { comments: conn([commentNode(100), commentNode(101)]) } }),
  );
  await withGraphQL(respond, async (base, seen) => {
    const { comments } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.equal(comments.length, 102);
    assert.deepEqual(
      comments.map((row) => row.body),
      Array.from({ length: 102 }, (_, at) => `comment ${at}`),
    );
    const followUps = requestsFor(seen, "ImportIssueComments");
    assert.equal(followUps.length, 1);
    // The cursor page 1 carried, not `null`: re-reading page 1 would double every row.
    assert.deepEqual(followUps[0].variables, {
      owner: "octocat",
      name: "hello",
      number: 7,
      first: 100,
      after: "c1",
    });
  });
  assert.equal(warned.buf, "", "a drained connection lost nothing, so it warns about nothing");
});

test("the comment walk follows every page until the connection is drained", async () => {
  /** @type {Record<string, any>} */
  const pages = {
    c1: conn([commentNode(1)], { hasNextPage: true, endCursor: "c2" }),
    c2: conn([commentNode(2)], { hasNextPage: true, endCursor: "c3" }),
    c3: conn([commentNode(3)]),
  };
  const respond = hydratingRepo(
    [issueNode({ comments: conn([commentNode(0)], { hasNextPage: true, endCursor: "c1" }) })],
    (/** @type {any} */ request) => ({ issue: { comments: pages[request.variables.after] } }),
  );
  await withGraphQL(respond, async (base, seen) => {
    const { comments } = await fetcherAt(base).fetchAll();
    assert.deepEqual(
      comments.map((row) => row.body),
      ["comment 0", "comment 1", "comment 2", "comment 3"],
    );
    assert.deepEqual(
      requestsFor(seen, "ImportIssueComments").map((request) => request.variables.after),
      ["c1", "c2", "c3"],
    );
  });
});

test("a hydrated comment carries its issue_url and drops a blank body, as page 1 does", async () => {
  const respond = hydratingRepo(
    [issueNode({ comments: conn([], { hasNextPage: true, endCursor: "c1" }) })],
    () => ({
      issue: {
        comments: conn([
          { body: "   ", createdAt: "2026-01-03T00:00:00Z", author: null },
          { body: "kept", createdAt: "2026-01-04T00:00:00Z", author: null },
        ]),
      },
    }),
  );
  await withGraphQL(respond, async (base) => {
    const { comments } = await fetcherAt(base).fetchAll();
    assert.equal(comments.length, 1);
    assert.equal(comments[0].body, "kept");
    assert.equal(comments[0].issue_url, `${base}/repos/octocat/hello/issues/7`);
    assert.deepEqual(comments[0].user, { ...GHOST_USER });
  });
});

test("a comment cursor that stops advancing fails the fetch instead of looping", async () => {
  const respond = hydratingRepo(
    [issueNode({ comments: conn([], { hasNextPage: true, endCursor: "c1" }) })],
    () => ({ issue: { comments: conn([commentNode(1)], { hasNextPage: true, endCursor: "c1" }) } }),
  );
  await withGraphQL(respond, async (base) => {
    await assert.rejects(fetcherAt(base).fetchAll(), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(err.message, /cursor stopped advancing/);
      return true;
    });
  });
});

test("a comment connection that promises more and sends no cursor warns without a request", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [issueNode({ comments: conn([commentNode(0)], { hasNextPage: true, endCursor: "" }) })],
    NEVER_ASKED,
  );
  await withGraphQL(respond, async (base, seen) => {
    const { comments } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.equal(comments.length, 1);
    assert.equal(requestsFor(seen, "ImportIssueComments").length, 0);
  });
  // Asserted whole: "are not imported" is the claim, and a reworded warning that says the
  // opposite would otherwise stay green.
  assert.equal(
    warned.buf,
    "warning: 1 issue(s) have comments this fetch could not finish reading: #7 — the rest " +
      "of those comments are not imported.\n",
  );
});

test("a null endCursor is the same no-cursor state, and is never sent back either", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [issueNode({ comments: conn([commentNode(0)], { hasNextPage: true, endCursor: null }) })],
    NEVER_ASKED,
  );
  await withGraphQL(respond, async (base, seen) => {
    await fetcherAt(base, { warn: (message) => void warned.write(message) }).fetchAll();
    assert.equal(requestsFor(seen, "ImportIssueComments").length, 0);
  });
  assert.match(warned.buf, /#7/);
});

test("a mid-walk page that promises more and sends no cursor warns and keeps what it read", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [issueNode({ comments: conn([commentNode(0)], { hasNextPage: true, endCursor: "c1" }) })],
    () => ({ issue: { comments: conn([commentNode(1)], { hasNextPage: true, endCursor: "" }) } }),
  );
  await withGraphQL(respond, async (base, seen) => {
    const { comments } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.equal(comments.length, 2);
    assert.equal(requestsFor(seen, "ImportIssueComments").length, 1);
  });
  assert.match(warned.buf, /#7/);
});

test("an issue that vanishes mid-thread fails by name, not as a missing repository", async () => {
  const respond = hydratingRepo(
    [issueNode({ comments: conn([], { hasNextPage: true, endCursor: "c1" }) })],
    () => ({ issue: null }),
  );
  await withGraphQL(respond, async (base) => {
    await assert.rejects(fetcherAt(base).fetchAll(), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.ok(!(err instanceof RepoNotFoundError));
      assert.match(err.message, /no issue #7 node while paging its comments/);
      assert.match(err.message, /re-running the import is safe/);
      return true;
    });
  });
});

test("a NOT_FOUND on a comment follow-up names the issue, not the repository", async () => {
  const respond = (/** @type {any} */ request) => {
    if (request.operationName === "ImportLabels") return labelsEnvelope([]);
    if (request.operationName === "ImportIssues") {
      return issuesEnvelope([
        issueNode({ comments: conn([], { hasNextPage: true, endCursor: "c1" }) }),
      ]);
    }
    // github.rs `name_vanished_parent`: the listing already resolved the repository.
    return { data: { repository: { issue: null } }, errors: [{ type: "NOT_FOUND", message: "x" }] };
  };
  await withGraphQL(respond, async (base) => {
    await assert.rejects(fetcherAt(base).fetchAll(), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.ok(!(err instanceof RepoNotFoundError), "a vanished issue is not a missing repo");
      assert.match(err.message, /no issue #7 node while paging its comments/);
      return true;
    });
  });
});

test("a rate-limited comment follow-up keeps its own diagnosis, not the vanished-issue one", async () => {
  const respond = (/** @type {any} */ request) => {
    if (request.operationName === "ImportLabels") return labelsEnvelope([]);
    if (request.operationName === "ImportIssues") {
      return issuesEnvelope([
        issueNode({ comments: conn([], { hasNextPage: true, endCursor: "c1" }) }),
      ]);
    }
    // Only NOT_FOUND means a vanished issue; "re-running the import is safe" is false here.
    return { data: { repository: null }, errors: [{ type: "RATE_LIMITED", message: "x" }] };
  };
  await withGraphQL(respond, async (base) => {
    await assert.rejects(fetcherAt(base).fetchAll(), (err) => {
      assert.ok(err instanceof RateLimitError);
      assert.match(err.message, /point budget is exhausted/);
      assert.ok(!/no issue #7 node/.test(err.message));
      return true;
    });
  });
});

test("a comment follow-up whose comments connection is absent or unreadable fails loudly", async () => {
  // github.rs's `#[serde(default)]` reads an absent connection as an empty page; this engine
  // refuses it, because a silent `drained: true` is the tail loss this story removes.
  for (const issue of [{}, { comments: "boom" }]) {
    const respond = hydratingRepo(
      [issueNode({ comments: conn([commentNode(0)], { hasNextPage: true, endCursor: "c1" }) })],
      () => ({ issue }),
    );
    await withGraphQL(respond, async (base) => {
      await assert.rejects(fetcherAt(base).fetchAll(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /unexpected response shape/);
        assert.match(err.message, /#7/);
        return true;
      });
    });
  }
});

test("a well-formed empty comment page is an ordinary end of walk, not a malformed one", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [issueNode({ comments: conn([commentNode(0)], { hasNextPage: true, endCursor: "c1" }) })],
    () => ({ issue: { comments: conn([]) } }),
  );
  await withGraphQL(respond, async (base) => {
    const { comments } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.equal(comments.length, 1);
  });
  assert.equal(warned.buf, "", "an empty last page drained the thread, so nothing is lost");
});

test("the comment walk takes no low cap: it drains a thread far past the sub-issue bound", async () => {
  const warned = capture();
  const pages = MAX_SUB_ISSUE_PAGES + 5;
  let issued = 0;
  const respond = hydratingRepo(
    [issueNode({ comments: conn([commentNode(0)], { hasNextPage: true, endCursor: "c1" }) })],
    () => {
      issued += 1;
      const page = issued >= pages ? {} : { hasNextPage: true, endCursor: `c${issued + 1}` };
      return { issue: { comments: conn([commentNode(issued)], page) } };
    },
  );
  await withGraphQL(respond, async (base, seen) => {
    const { comments } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.equal(comments.length, pages + 1);
    assert.equal(requestsFor(seen, "ImportIssueComments").length, pages);
  });
  assert.equal(warned.buf, "", "github.rs caps no comment thread at 2000, and neither does this");
});

test("a parent past 100 sub-issues resumes from its listing cursor and drains the rest", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [issueNode({ subIssues: conn([{ number: 8 }], { hasNextPage: true, endCursor: "s1" }) })],
    () => ({ issue: { subIssues: conn([{ number: 9 }, { number: 10 }]) } }),
  );
  await withGraphQL(respond, async (base, seen) => {
    const { subIssues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.deepEqual(subIssues.get("7"), ["8", "9", "10"]);
    const followUps = requestsFor(seen, "ImportIssueSubIssues");
    assert.equal(followUps.length, 1);
    assert.deepEqual(followUps[0].variables, {
      owner: "octocat",
      name: "hello",
      number: 7,
      first: 100,
      after: "s1",
    });
  });
  assert.equal(warned.buf, "", "a drained hierarchy lost nothing, so it warns about nothing");
});

test("hydrated sub-issues keep the REST rules: the parent is dropped, repeats collapse", async () => {
  const respond = hydratingRepo(
    [issueNode({ subIssues: conn([{ number: 8 }], { hasNextPage: true, endCursor: "s1" }) })],
    () => ({
      issue: {
        subIssues: conn([
          { number: 8 },
          { number: 7 },
          { number: 0 },
          { number: "9" },
          { number: 9 },
        ]),
      },
    }),
  );
  await withGraphQL(respond, async (base) => {
    const { subIssues } = await fetcherAt(base).fetchAll();
    assert.deepEqual(subIssues.get("7"), ["8", "9"]);
  });
});

test("the sub-issue walk stops at the page cap and says the hierarchy is short", async () => {
  const warned = capture();
  let issued = 0;
  const respond = hydratingRepo(
    [issueNode({ subIssues: conn([{ number: 1000 }], { hasNextPage: true, endCursor: "s1" }) })],
    () => {
      issued += 1;
      return {
        issue: {
          subIssues: conn([{ number: 1000 + issued }], {
            hasNextPage: true,
            endCursor: `s${issued + 1}`,
          }),
        },
      };
    },
  );
  await withGraphQL(respond, async (base, seen) => {
    const { subIssues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    // 20 pages total (github.rs MAX_SUB_ISSUE_PAGES): page 1 rode the listing node.
    assert.equal(requestsFor(seen, "ImportIssueSubIssues").length, MAX_SUB_ISSUE_PAGES - 1);
    assert.equal(subIssues.get("7")?.length, MAX_SUB_ISSUE_PAGES);
  });
  // Asserted whole: the sentence is this story's behaviour change, and the cap case must
  // name its own 2000-child bound rather than the no-cursor line's 100.
  assert.equal(
    warned.buf,
    "warning: 1 issue(s) carry more than 2000 sub-issues, the most one parent's hierarchy " +
      "may read: #7 — the rest of those sub-issues are not imported.\n",
  );
});

test("a stalled sub-issue cursor keeps what it read and warns, where the server completes", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [issueNode({ subIssues: conn([], { hasNextPage: true, endCursor: "s1" }) })],
    () => ({ issue: { subIssues: conn([{ number: 8 }], { hasNextPage: true, endCursor: "s1" }) } }),
  );
  await withGraphQL(respond, async (base, seen) => {
    // github.rs `hydrate_issue` runs no Pager: it re-reads, `push_kid` dedups and the cap
    // ends the walk, so throwing here would fail an import the server finishes.
    const { subIssues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.deepEqual(subIssues.get("7"), ["8"]);
    assert.equal(requestsFor(seen, "ImportIssueSubIssues").length, 1);
  });
  assert.match(warned.buf, /#7/);
  assert.match(warned.buf, /sub-issues/);
});

test("a NOT_FOUND on a sub-issue follow-up names the issue, and still fails the fetch", async () => {
  const respond = (/** @type {any} */ request) => {
    if (request.operationName === "ImportLabels") return labelsEnvelope([]);
    if (request.operationName === "ImportIssues") {
      return issuesEnvelope([
        issueNode({ subIssues: conn([{ number: 8 }], { hasNextPage: true, endCursor: "s1" }) }),
      ]);
    }
    return { data: { repository: { issue: null } }, errors: [{ type: "NOT_FOUND", message: "x" }] };
  };
  await withGraphQL(respond, async (base) => {
    // github.rs `hydrate_issue` propagates this error where a bare null node only breaks,
    // so the rename buys a readable message and changes no row.
    await assert.rejects(fetcherAt(base).fetchAll(), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.ok(!(err instanceof RepoNotFoundError), "a vanished issue is not a missing repo");
      assert.match(err.message, /no issue #7 node while paging its sub-issues/);
      assert.match(err.message, /re-running the import is safe/);
      return true;
    });
  });
});

test("a sub-issue connection that sends no cursor warns without a request", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [issueNode({ subIssues: conn([{ number: 8 }], { hasNextPage: true, endCursor: "" }) })],
    NEVER_ASKED,
  );
  await withGraphQL(respond, async (base, seen) => {
    const { subIssues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.deepEqual(subIssues.get("7"), ["8"]);
    assert.equal(requestsFor(seen, "ImportIssueSubIssues").length, 0);
  });
  assert.match(warned.buf, /sub-issues/);
});

test("a parent that vanishes mid-hierarchy keeps its read links and warns, never fails", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [issueNode({ subIssues: conn([{ number: 8 }], { hasNextPage: true, endCursor: "s1" }) })],
    () => ({ issue: null }),
  );
  await withGraphQL(respond, async (base) => {
    // github.rs breaks here where its comment walk fails: a lost cross-link is not a lost row.
    const { subIssues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.deepEqual(subIssues.get("7"), ["8"]);
  });
  assert.match(warned.buf, /sub-issues/);
});

test("a sub-issue follow-up whose subIssues connection is absent or unreadable fails loudly", async () => {
  for (const issue of [{}, { subIssues: "boom" }]) {
    const respond = hydratingRepo(
      [issueNode({ subIssues: conn([{ number: 8 }], { hasNextPage: true, endCursor: "s1" }) })],
      () => ({ issue }),
    );
    await withGraphQL(respond, async (base) => {
      await assert.rejects(fetcherAt(base).fetchAll(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /unexpected response shape/);
        assert.match(err.message, /#7/);
        return true;
      });
    });
  }
});

test("a well-formed empty sub-issue page is an ordinary end of walk, not a malformed one", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [issueNode({ subIssues: conn([{ number: 8 }], { hasNextPage: true, endCursor: "s1" }) })],
    () => ({ issue: { subIssues: conn([]) } }),
  );
  await withGraphQL(respond, async (base) => {
    const { subIssues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.deepEqual(subIssues.get("7"), ["8"]);
  });
  assert.equal(warned.buf, "", "an empty last page drained the hierarchy, so nothing is lost");
});

test("a hierarchy that drains exactly on the last allowed page warns about nothing", async () => {
  const warned = capture();
  let issued = 0;
  const respond = hydratingRepo(
    [issueNode({ subIssues: conn([{ number: 1000 }], { hasNextPage: true, endCursor: "s1" }) })],
    () => {
      issued += 1;
      const last = issued >= MAX_SUB_ISSUE_PAGES - 1;
      const page = last ? {} : { hasNextPage: true, endCursor: `s${issued + 1}` };
      return { issue: { subIssues: conn([{ number: 1000 + issued }], page) } };
    },
  );
  await withGraphQL(respond, async (base, seen) => {
    const { subIssues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.equal(requestsFor(seen, "ImportIssueSubIssues").length, MAX_SUB_ISSUE_PAGES - 1);
    assert.equal(subIssues.get("7")?.length, MAX_SUB_ISSUE_PAGES);
  });
  assert.equal(warned.buf, "", "page 20 closed the connection, so the cap cost nothing");
});

test("one issue overflowing both connections hydrates each of them, independently", async () => {
  const warned = capture();
  const respond = hydratingRepo(
    [
      issueNode({
        comments: conn([commentNode(0)], { hasNextPage: true, endCursor: "c1" }),
        subIssues: conn([{ number: 8 }], { hasNextPage: true, endCursor: "s1" }),
      }),
    ],
    (/** @type {any} */ request) =>
      request.operationName === "ImportIssueComments"
        ? { issue: { comments: conn([commentNode(1)]) } }
        : { issue: { subIssues: conn([{ number: 9 }]) } },
  );
  await withGraphQL(respond, async (base) => {
    const { comments, subIssues } = await fetcherAt(base, {
      warn: (message) => void warned.write(message),
    }).fetchAll();
    assert.deepEqual(
      comments.map((row) => row.body),
      ["comment 0", "comment 1"],
    );
    assert.deepEqual(subIssues.get("7"), ["8", "9"]);
  });
  assert.equal(warned.buf, "", "both connections drained, so neither is short");
});

test("the sub-issue page cap is 20, the number github.rs and the REST path both hold", () => {
  // github.rs `const MAX_SUB_ISSUE_PAGES: u32 = 20` — three definitions must agree, and an
  // assertion computed from the constant cannot see it drift.
  assert.equal(MAX_SUB_ISSUE_PAGES, 20);
  assert.equal(REST_MAX_SUB_ISSUE_PAGES, MAX_SUB_ISSUE_PAGES);
});

test("hydration runs after the listing, one issue at a time, never interleaved", async () => {
  /** @type {Record<string, any>} */
  const pages = {
    a1: conn([commentNode(1)], { hasNextPage: true, endCursor: "a2" }),
    a2: conn([commentNode(2)]),
    b1: conn([commentNode(3)], { hasNextPage: true, endCursor: "b2" }),
    b2: conn([commentNode(4)]),
  };
  const respond = hydratingRepo(
    [
      issueNode({ comments: conn([], { hasNextPage: true, endCursor: "a1" }) }),
      issueNode({ number: 8, comments: conn([], { hasNextPage: true, endCursor: "b1" }) }),
    ],
    (/** @type {any} */ request) => ({ issue: { comments: pages[request.variables.after] } }),
  );
  await withGraphQL(respond, async (base, seen) => {
    await fetcherAt(base).fetchAll();
    const operations = seen.map((request) => request.operationName);
    const listing = operations.lastIndexOf("ImportIssues");
    const firstFollowUp = operations.indexOf("ImportIssueComments");
    assert.ok(listing < firstFollowUp, "hydration may not start before the listing is complete");
    // Interleaved would read a1, b1, a2, b2 — a concurrent burst into the secondary limit.
    assert.deepEqual(
      requestsFor(seen, "ImportIssueComments").map((request) => request.variables.after),
      ["a1", "a2", "b1", "b2"],
    );
  });
});

test("an issue with no usable number is never hydrated, because nothing joins to it", async () => {
  const respond = hydratingRepo(
    [
      issueNode({
        number: "nope",
        comments: conn([], { hasNextPage: true, endCursor: "c1" }),
        subIssues: conn([], { hasNextPage: true, endCursor: "s1" }),
      }),
    ],
    () => ({ issue: { comments: conn([]), subIssues: conn([]) } }),
  );
  await withGraphQL(respond, async (base, seen) => {
    const { issues } = await fetcherAt(base, { warn: () => {} }).fetchAll();
    assert.equal(issues.length, 1);
    assert.equal(seen.length, 2);
  });
});
