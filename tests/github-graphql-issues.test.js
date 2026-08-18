import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { GitHubAuthError, GitHubError, RepoNotFoundError } from "../src/github.js";
import {
  ACTOR_SELECTION,
  commentsSelection,
  fetchedIssue,
  GHOST_USER,
  GitHubGraphQLFetcher,
  issueNodeSelection,
  issuesQuery,
  labelsQuery,
  MAX_LISTING_PAGES,
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(respond(request)));
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

test("a connection with a further page is reported as truncated", () => {
  const { truncated } = fetchedIssue(
    issueNode({
      comments: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [] },
      subIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    }),
    ISSUE_URL,
  );
  assert.deepEqual(truncated, { comments: true, subIssues: false });
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

test("an issue whose comments overflow one page warns rather than truncating in silence", async () => {
  const warned = capture();
  const respond = oneRepo([
    issueNode({
      comments: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [] },
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

test("an issue whose sub-issues overflow one page warns too", async () => {
  const warned = capture();
  const respond = oneRepo([
    issueNode({
      subIssues: { pageInfo: { hasNextPage: true, endCursor: "s1" }, nodes: [{ number: 8 }] },
    }),
  ]);
  await withGraphQL(respond, async (base) => {
    await fetcherAt(base, { warn: (message) => void warned.write(message) }).fetchAll();
  });
  assert.match(warned.buf, /sub-issues/);
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

test("fetchAll refuses the listings it does not implement yet", async () => {
  await withGraphQL(oneRepo([]), async (base) => {
    for (const option of ["pullRequests", "releases", "dependencies"]) {
      await assert.rejects(fetcherAt(base).fetchAll({ [option]: true }), new RegExp(option));
    }
  });
});
