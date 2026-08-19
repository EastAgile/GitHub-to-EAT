/**
 * Dual-fetcher equivalence (story #57631). One canonical repo, served in both renderings by
 * one throwaway server: REST is the oracle, so a rename drift fails CI here, not on a board.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { GitHubClient } from "../src/github.js";
import { GitHubGraphQLFetcher } from "../src/github-graphql-issues.js";

const OWNER = "octocat";
const REPO = "hello";
const TOKEN = "ghp_fixture";
const PREFIX = `/repos/${OWNER}/${REPO}`;

// --- the canonical dataset ---------------------------------------------------
// One repo, described once. Each renderer below turns it into what its transport would
// have sent, so a difference in the fetched rows is the fetchers' doing, not the fixture's.

/** @typedef {{ kind: "User" | "Bot", login: string, id: number, url: string }} Person */

/** @type {Person} */
const HUMAN = { kind: "User", login: "octocat", id: 583231, url: "https://github.com/octocat" };
/** @type {Person} */
const MAINTAINER = { kind: "User", login: "hubot", id: 8112, url: "https://github.com/hubot" };
/** @type {Person} */
const DEPENDABOT = {
  kind: "Bot",
  login: "dependabot",
  id: 49699333,
  url: "https://github.com/apps/dependabot",
};
/**
 * The Copilot coding agent, which REST reports as an assignee and GraphQL's `assignees`
 * connection cannot carry. Pinned, never equalized — see the divergence tests below.
 *
 * @type {Person}
 */
const COPILOT = {
  kind: "Bot",
  login: "copilot-swe-agent",
  id: 198982749,
  url: "https://github.com/apps/copilot-swe-agent",
};

/**
 * REST's own ghost account, which it substitutes for a deleted user.
 *
 * @type {Person}
 */
const GHOST = { kind: "User", login: "ghost", id: 10137, url: "https://github.com/ghost" };

const LABELS = [
  { name: "bug", color: "d73a4a" },
  { name: "enhancement", color: "a2eeef" },
  { name: "junk color", color: "not-a-hex" },
  { name: "blank color", color: "" },
  { name: "null color", color: null },
  // Carried by no issue: the repo listing is the only place a colour for it exists.
  { name: "unused", color: "0e8a16" },
];

const MILESTONES = {
  openDue: { title: "v1.0", state: "open", due_on: "2026-03-01T00:00:00Z" },
  openNoDue: { title: "backlog", state: "open", due_on: null },
  closedDue: { title: "v0.9", state: "closed", due_on: "2025-12-01T00:00:00Z" },
  closedNoDue: { title: "v0.1", state: "closed", due_on: null },
};

/**
 * Every comment in the repo. `created_at` deliberately does not follow the issue order:
 * REST lists comments repo-wide by date, GraphQL nests them under their issue.
 */
const COMMENTS = [
  {
    id: 9001,
    issue: 43,
    body: "reproduced on main",
    created_at: "2026-01-05T09:00:00Z",
    author: HUMAN,
  },
  {
    id: 9002,
    issue: 47,
    body: "first pass pushed",
    created_at: "2026-01-06T09:00:00Z",
    author: MAINTAINER,
  },
  {
    id: 9003,
    issue: 46,
    body: "bumping the lockfile",
    created_at: "2026-01-07T09:00:00Z",
    author: DEPENDABOT,
  },
  { id: 9004, issue: 46, body: "", created_at: "2026-01-08T09:00:00Z", author: HUMAN },
  { id: 9005, issue: 47, body: " \n\t ", created_at: "2026-01-09T09:00:00Z", author: HUMAN },
  {
    id: 9006,
    issue: 45,
    body: "closing, nobody wants this",
    created_at: "2026-01-10T09:00:00Z",
    author: null,
  },
  { id: 9007, issue: 47, body: "shipped", created_at: "2026-01-11T09:00:00Z", author: HUMAN },
];

/** The repo's issues, newest first — the order both transports are asked for. */
const ISSUES = [
  {
    number: 47,
    title: "Rework the widget pipeline",
    body: "the parent issue",
    state: "open",
    state_reason: null,
    created_at: "2026-01-04T09:00:00Z",
    closed_at: null,
    author: HUMAN,
    // COPILOT is REST-only by GraphQL's schema, not by this fixture's choice.
    assignees: [MAINTAINER, COPILOT],
    labels: ["bug", "junk color"],
    milestone: MILESTONES.openDue,
    issueType: "Bug",
    // A repeat and a self-reference: both fetchers drop them, and must drop them alike.
    subIssues: [45, 44, 45, 47],
  },
  {
    number: 46,
    title: "Bump widget-lib from 1.0 to 1.1",
    body: "opened by a bot",
    state: "open",
    state_reason: null,
    created_at: "2026-01-03T09:00:00Z",
    closed_at: null,
    author: DEPENDABOT,
    assignees: [],
    labels: ["enhancement"],
    milestone: MILESTONES.openNoDue,
    issueType: "Feature",
    subIssues: [],
  },
  {
    number: 45,
    title: "Add a dark mode",
    body: null,
    state: "closed",
    state_reason: "not_planned",
    created_at: "2026-01-02T09:00:00Z",
    closed_at: "2026-01-20T09:00:00Z",
    author: null,
    assignees: [],
    labels: ["null color"],
    milestone: MILESTONES.closedDue,
    issueType: null,
    subIssues: [],
  },
  {
    number: 44,
    title: "Add a dark theme",
    body: "same as #45",
    state: "closed",
    state_reason: "duplicate",
    created_at: "2026-01-01T09:00:00Z",
    closed_at: "2026-01-21T09:00:00Z",
    author: MAINTAINER,
    assignees: [HUMAN],
    labels: ["blank color"],
    milestone: MILESTONES.closedNoDue,
    issueType: "Task",
    subIssues: [],
  },
  {
    number: 43,
    title: "Crash on an empty config",
    body: "stack trace attached",
    state: "closed",
    state_reason: "completed",
    created_at: "2025-12-31T09:00:00Z",
    closed_at: "2026-01-22T09:00:00Z",
    author: HUMAN,
    assignees: [],
    labels: [],
    milestone: null,
    issueType: null,
    subIssues: [],
  },
];

// --- the REST rendering ------------------------------------------------------

/**
 * @param {Person} person
 * @returns {any}
 */
function restPerson(person) {
  return {
    login: person.kind === "Bot" ? `${person.login}[bot]` : person.login,
    id: person.id,
    node_id: `MDQ6VXNlcg${person.id}`,
    avatar_url: `${person.url}.png`,
    html_url: person.url,
    type: person.kind,
    site_admin: false,
  };
}

/**
 * @param {string} name
 * @returns {any}
 */
function restLabel(name) {
  const label = LABELS.find((row) => row.name === name);
  assert.ok(label, `the fixture has no label named ${name}`);
  return {
    id: 2000 + LABELS.indexOf(label),
    node_id: `LA_${name}`,
    url: `https://api.github.com/repos/${OWNER}/${REPO}/labels/${encodeURIComponent(name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: `the ${name} label`,
  };
}

/**
 * @param {any} milestone
 * @returns {any}
 */
function restMilestone(milestone) {
  if (milestone === null) return null;
  return {
    url: `https://api.github.com/repos/${OWNER}/${REPO}/milestones/1`,
    html_url: `https://github.com/${OWNER}/${REPO}/milestone/1`,
    id: 3001,
    number: 1,
    title: milestone.title,
    description: "a milestone",
    creator: restPerson(MAINTAINER),
    open_issues: 1,
    closed_issues: 0,
    state: milestone.state,
    created_at: "2025-11-01T09:00:00Z",
    updated_at: "2025-11-02T09:00:00Z",
    due_on: milestone.due_on,
    closed_at: null,
  };
}

/**
 * @param {any} issue
 * @param {string} base
 * @returns {any}
 */
function restIssue(issue, base) {
  const rollup = issue.subIssues.length;
  return {
    id: 5000 + issue.number,
    node_id: `I_${issue.number}`,
    url: `${base}${PREFIX}/issues/${issue.number}`,
    repository_url: `${base}${PREFIX}`,
    comments_url: `${base}${PREFIX}/issues/${issue.number}/comments`,
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: restPerson(issue.author ?? GHOST),
    labels: issue.labels.map(restLabel),
    state: issue.state,
    state_reason: issue.state_reason,
    locked: false,
    assignee: issue.assignees.length ? restPerson(issue.assignees[0]) : null,
    assignees: issue.assignees.map(restPerson),
    milestone: restMilestone(issue.milestone),
    comments: COMMENTS.filter((row) => row.issue === issue.number).length,
    created_at: issue.created_at,
    updated_at: "2026-02-01T09:00:00Z",
    closed_at: issue.closed_at,
    author_association: "OWNER",
    body: issue.body,
    type:
      issue.issueType === null
        ? null
        : {
            id: 4001,
            node_id: `IT_${issue.issueType}`,
            name: issue.issueType,
            description: `the ${issue.issueType} type`,
            color: "red",
            is_enabled: true,
          },
    sub_issues_summary: { total: rollup, completed: 0, percent_completed: 0 },
    reactions: { url: `${base}${PREFIX}/issues/${issue.number}/reactions`, total_count: 0 },
  };
}

/**
 * @param {string} base
 * @returns {any[]}
 */
function restComments(base) {
  return COMMENTS.map((comment) => ({
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `${base}${PREFIX}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${comment.issue}#issuecomment-${comment.id}`,
    // Built from the same base both fetchers are pointed at: the GraphQL side rebuilds
    // this string, and a hard-coded api.github.com here would fail for that reason alone.
    issue_url: `${base}${PREFIX}/issues/${comment.issue}`,
    user: restPerson(comment.author ?? GHOST),
    created_at: comment.created_at,
    updated_at: comment.created_at,
    author_association: "MEMBER",
    body: comment.body,
  }));
}

/**
 * @param {number} number
 * @param {string} base
 * @returns {any[]}
 */
function restSubIssues(number, base) {
  const parent = ISSUES.find((issue) => issue.number === number);
  return (parent?.subIssues ?? []).map((child) => {
    const row = ISSUES.find((issue) => issue.number === child) ?? parent;
    return restIssue(row, base);
  });
}

// --- the GraphQL rendering ---------------------------------------------------

/**
 * @param {Person | null} person
 * @returns {any}
 */
function gqlActor(person) {
  // GraphQL answers a deleted account with a null actor where REST names `ghost`.
  if (person === null) return null;
  return {
    __typename: person.kind,
    login: person.login,
    databaseId: person.id,
    url: person.url,
  };
}

/** @param {any[]} nodes */
const connection = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

/**
 * @param {any} issue
 * @returns {any}
 */
function gqlIssueNode(issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    stateReason: issue.state_reason === null ? null : issue.state_reason.toUpperCase(),
    createdAt: issue.created_at,
    closedAt: issue.closed_at,
    url: `https://github.com/${OWNER}/${REPO}/issues/${issue.number}`,
    author: gqlActor(issue.author),
    // `Issue.assignees` is a UserConnection, so a Bot assignee cannot appear in it.
    assignees: {
      nodes: issue.assignees
        .filter((/** @type {Person} */ person) => person.kind === "User")
        .map((/** @type {Person} */ person) => ({
          login: person.login,
          databaseId: person.id,
          url: person.url,
        })),
    },
    labels: {
      nodes: issue.labels.map((/** @type {string} */ name) => {
        const label = LABELS.find((row) => row.name === name);
        return { name: label?.name, color: label?.color };
      }),
    },
    milestone:
      issue.milestone === null
        ? null
        : {
            title: issue.milestone.title,
            dueOn: issue.milestone.due_on,
            state: issue.milestone.state.toUpperCase(),
          },
    issueType: issue.issueType === null ? null : { name: issue.issueType },
    comments: connection(
      COMMENTS.filter((row) => row.issue === issue.number).map((row) => ({
        body: row.body,
        createdAt: row.created_at,
        author: gqlActor(row.author),
      })),
    ),
    subIssues: connection(
      issue.subIssues.map((/** @type {number} */ child) => ({ number: child })),
    ),
  };
}

/**
 * @param {{ operationName: string }} request
 * @returns {any}
 */
function graphqlResponse(request) {
  const rateLimit = { remaining: 4998, resetAt: "2030-01-01T00:00:00Z" };
  if (request.operationName === "ImportLabels") {
    return {
      data: {
        rateLimit,
        repository: {
          labels: connection(LABELS.map((label) => ({ name: label.name, color: label.color }))),
        },
      },
    };
  }
  const nodes = ISSUES.map(gqlIssueNode);
  return {
    data: {
      rateLimit,
      repository: { issues: { totalCount: nodes.length, ...connection(nodes) } },
    },
  };
}

// --- the fixture server ------------------------------------------------------

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
 * @typedef {{ rest: any, graphql: any, restPaths: string[], graphqlRequests: any[],
 *   warnings: string[] }} BothFetchers
 */

/**
 * Serve the dataset in both renderings from one origin, then run both fetchers over it.
 *
 * @returns {Promise<BothFetchers>}
 */
async function runBothFetchers() {
  /** @type {string[]} */
  const restPaths = [];
  /** @type {any[]} */
  const graphqlRequests = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string} */
  let base = "";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "", "http://fixture");
    /** @type {unknown} */
    let payload;
    if (url.pathname === "/graphql") {
      const request = JSON.parse(await readBody(req));
      graphqlRequests.push(request);
      payload = graphqlResponse(request);
    } else {
      restPaths.push(url.pathname);
      const subIssues = url.pathname.match(new RegExp(`^${PREFIX}/issues/(\\d+)/sub_issues$`));
      if (url.pathname === `${PREFIX}/issues`) payload = ISSUES.map((i) => restIssue(i, base));
      else if (url.pathname === `${PREFIX}/issues/comments`) payload = restComments(base);
      else if (url.pathname === `${PREFIX}/labels`) payload = LABELS.map((l) => restLabel(l.name));
      else if (subIssues) payload = restSubIssues(Number(subIssues[1]), base);
      else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `the fixture serves no ${url.pathname}` }));
        return;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  base = `http://127.0.0.1:${address.port}`;
  /** @param {string} message */
  const warn = (message) => void warnings.push(message);
  try {
    // A token both fetchers accept: the REST client ignores it, and the GraphQL one
    // refuses to be built without one.
    const rest = await new GitHubClient(OWNER, REPO, {
      apiBase: base,
      token: TOKEN,
      warn,
    }).fetchAll();
    const graphql = await new GitHubGraphQLFetcher(OWNER, REPO, {
      apiBase: base,
      token: TOKEN,
      warn,
    }).fetchAll();
    return { rest, graphql, restPaths, graphqlRequests, warnings };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

/** @type {Promise<BothFetchers> | null} */
let fetched = null;
// One fetch for the whole file: the promise is memoized, not its value, so a
// concurrent runner cannot start two servers.
const fetchBoth = () => (fetched ??= runBothFetchers());

// --- normalization -----------------------------------------------------------
// The rename layer's own field list. Every one is compared; a row that grows, loses or
// renames a field fails the shape guard below rather than slipping past the deep-equal.

const ISSUE_FIELDS = [
  "assignees",
  "body",
  "closed_at",
  "created_at",
  "html_url",
  "labels",
  "milestone",
  "number",
  "state",
  "state_reason",
  "title",
  "type",
  "user",
];
const COMMENT_FIELDS = ["body", "created_at", "issue_url", "user"];
const LABEL_FIELDS = ["color", "name"];

/**
 * @param {any} row
 * @returns {any}
 */
const personOf = (row) => ({ id: row.id, login: row.login, html_url: row.html_url ?? null });

/**
 * @param {any} row
 * @returns {any}
 */
const labelOf = (row) => ({ name: row.name, color: row.color ?? null });

/**
 * @param {any} row
 * @returns {any}
 */
function issueOf(row) {
  return {
    number: row.number,
    title: row.title,
    body: row.body ?? null,
    state: row.state,
    state_reason: row.state_reason ?? null,
    labels: (row.labels ?? []).map(labelOf),
    milestone:
      row.milestone == null
        ? null
        : {
            title: row.milestone.title,
            due_on: row.milestone.due_on ?? null,
            state: row.milestone.state ?? null,
          },
    created_at: row.created_at ?? null,
    closed_at: row.closed_at ?? null,
    html_url: row.html_url ?? null,
    assignees: (row.assignees ?? []).map(personOf),
    user: personOf(row.user),
    type: row.type == null ? null : { name: row.type.name ?? null },
  };
}

/**
 * @param {any} row
 * @returns {any}
 */
const commentOf = (row) => ({
  body: row.body,
  created_at: row.created_at ?? null,
  issue_url: row.issue_url,
  user: personOf(row.user),
});

/**
 * The two transports order comments differently and neither is wrong: REST lists them
 * repo-wide by date, GraphQL nests them under their issue. Sort before comparing.
 *
 * @param {any} a
 * @param {any} b
 * @returns {number}
 */
const byComment = (a, b) =>
  a.issue_url.localeCompare(b.issue_url) || a.created_at.localeCompare(b.created_at);

/**
 * Both transports' `{ issues, comments, labels }` in one shape. A blank comment body is
 * dropped here because GraphQL drops it at fetch and REST in `src/mapping.js`: same output.
 *
 * @param {any} fetchedRepo
 * @returns {{ issues: any[], comments: any[], labels: any[] }}
 */
function normalized(fetchedRepo) {
  return {
    issues: fetchedRepo.issues.map(issueOf),
    comments: fetchedRepo.comments
      .filter((/** @type {any} */ row) => String(row.body ?? "").trim() !== "")
      .map(commentOf)
      .sort(byComment),
    labels: fetchedRepo.labels.map(labelOf),
  };
}

/**
 * @param {Map<string, string[]>} subIssues
 * @returns {[string, string[]][]}
 */
const hierarchy = (subIssues) => [...subIssues].sort(([a], [b]) => a.localeCompare(b));

// --- the pinned divergence ---------------------------------------------------
// `Issue.assignees` is a UserConnection; only `Issue.assignedActors` could carry a bot. The
// CLI selects the narrow field because the server does, so REST sees an assignee GraphQL cannot.

/** The bot assignees REST reports and GraphQL structurally cannot. Server ask #330833. */
const REST_ONLY_ASSIGNEES = [{ number: 47, login: "copilot-swe-agent[bot]", id: 198982749 }];

const WHY_PINNED =
  "the CLI selects Issue.assignees (a UserConnection) because the server importer selects it; " +
  "widening to Issue.assignedActors here would diverge from the server — server ask #330833";

/**
 * Lift the REST-only assignees out of the REST rows, and report which ones were lifted, so
 * an empty dataset cannot pass the pin off as agreement.
 *
 * @param {any[]} issues
 * @returns {{ issues: any[], lifted: any[] }}
 */
function withoutRestOnlyAssignees(issues) {
  /** @type {any[]} */
  const lifted = [];
  const kept = issues.map((row) => ({
    ...row,
    assignees: (row.assignees ?? []).filter((/** @type {any} */ person) => {
      if (person.type === "User") return true;
      lifted.push({ number: row.number, login: person.login, id: person.id });
      return false;
    }),
  }));
  return { issues: kept, lifted };
}

// --- the oracle --------------------------------------------------------------

/**
 * REST is the oracle: every assertion reads GraphQL as the actual and REST as the expected.
 * Taken as a value so the mutation checks below can drive it with a broken rename layer.
 *
 * @param {any} rest
 * @param {any} graphql
 */
function assertEquivalent(rest, graphql) {
  for (const row of graphql.issues) assert.deepEqual(Object.keys(row).sort(), ISSUE_FIELDS);
  for (const row of graphql.comments) assert.deepEqual(Object.keys(row).sort(), COMMENT_FIELDS);
  for (const row of graphql.labels) assert.deepEqual(Object.keys(row).sort(), LABEL_FIELDS);

  const { issues, lifted } = withoutRestOnlyAssignees(rest.issues);
  assert.deepEqual(lifted, REST_ONLY_ASSIGNEES, "the REST rows must still carry a bot assignee");
  for (const row of graphql.issues) {
    for (const person of row.assignees) {
      assert.ok(
        !REST_ONLY_ASSIGNEES.some((pinned) => pinned.login === person.login),
        `${person.login} reached the GraphQL assignees of issue #${row.number}: ${WHY_PINNED}`,
      );
    }
  }

  const oracle = normalized({ ...rest, issues });
  const actual = normalized(graphql);
  assert.deepEqual(
    actual.issues.map((row) => row.number),
    oracle.issues.map((row) => row.number),
  );
  // Row by row: a whole-listing diff is unreadable, and the number list above already
  // proved the two sides line up.
  for (const [at, row] of oracle.issues.entries()) assert.deepEqual(actual.issues[at], row);
  assert.deepEqual(actual.comments, oracle.comments);
  assert.deepEqual(actual.labels, oracle.labels);
  assert.deepEqual(hierarchy(graphql.subIssues), hierarchy(rest.subIssues));
}

// --- the harness -------------------------------------------------------------

test("both fetchers read the whole fixture repo in one page, without a warning", async () => {
  const { restPaths, graphqlRequests, warnings } = await fetchBoth();
  assert.deepEqual(warnings, [], "a degraded fetch would make the comparison below meaningless");
  assert.deepEqual(
    graphqlRequests.map((request) => request.operationName),
    ["ImportIssues", "ImportLabels"],
    "one page each — overflow hydration is story #57632, not this dataset",
  );
  assert.deepEqual(restPaths.toSorted(), [
    `${PREFIX}/issues`,
    `${PREFIX}/issues/47/sub_issues`,
    `${PREFIX}/issues/comments`,
    `${PREFIX}/labels`,
  ]);
});

test("the fixture repo covers every case the equivalence claim rests on", async () => {
  const { rest } = await fetchBoth();
  /** @param {(row: any) => boolean} predicate */
  const some = (predicate) => rest.issues.some(predicate);

  assert.equal(rest.issues.length, ISSUES.length, "a shrunken listing would compare nothing");
  assert.ok(
    some((row) => row.user.login === "dependabot[bot]"),
    "a bot author",
  );
  assert.ok(
    some((row) => row.user.login === "ghost"),
    "a ghost author",
  );
  assert.ok(
    some((row) => row.state_reason === "not_planned"),
    "a not_planned close",
  );
  assert.ok(
    some((row) => row.state_reason === "duplicate"),
    "a duplicate close",
  );
  assert.ok(
    some((row) => row.type?.name === "Bug"),
    "an issue type",
  );
  assert.ok(
    some((row) => row.assignees.some((/** @type {any} */ p) => p.type === "Bot")),
    "a bot assignee",
  );
  for (const [state, due] of [
    ["open", true],
    ["open", false],
    ["closed", true],
    ["closed", false],
  ]) {
    assert.ok(
      some((row) => row.milestone?.state === state && (row.milestone.due_on !== null) === due),
      `a ${state} milestone ${due ? "with" : "without"} a due date`,
    );
  }
  assert.deepEqual(
    rest.labels.map((/** @type {any} */ row) => row.color).toSorted(),
    ["", "0e8a16", "a2eeef", "d73a4a", "not-a-hex", null].toSorted(),
    "well-formed and junk label colours both reach the fetchers",
  );
  assert.equal(
    rest.comments.filter((/** @type {any} */ row) => row.body.trim() === "").length,
    2,
    "an empty and a whitespace-only comment body, which only the REST fetch keeps",
  );
  assert.deepEqual(hierarchy(rest.subIssues), [["47", ["45", "44"]]], "a sub-issue rollup");
});

test("the raw comment rows differ exactly where normalization is allowed to intervene", async () => {
  const { rest, graphql } = await fetchBoth();
  /** @param {any[]} rows */
  const blank = (rows) => rows.filter((row) => String(row.body ?? "").trim() === "").length;
  assert.equal(blank(rest.comments), 2, "REST leaves the empty bodies to src/mapping.js");
  assert.equal(blank(graphql.comments), 0, "the listing drops them at fetch, as github.rs does");

  /** @param {any[]} rows */
  const urls = (rows) =>
    rows.filter((row) => String(row.body ?? "").trim() !== "").map((row) => row.issue_url);
  // The same comments in a different order. Neither order is wrong, so the normalizer sorts;
  // asserted here because a later reader would otherwise read that sort as decoration.
  assert.deepEqual(urls(graphql.comments).toSorted(), urls(rest.comments).toSorted());
  assert.notDeepEqual(
    urls(graphql.comments),
    urls(rest.comments),
    "REST lists comments repo-wide by date, GraphQL nests them under their issue",
  );
});

test("the REST and GraphQL fetchers read the same repo", async () => {
  const { rest, graphql } = await fetchBoth();
  assertEquivalent(rest, graphql);
});

// --- the mutation check ------------------------------------------------------
// A harness that cannot fail certifies nothing. Each break below is what a regression in
// the rename layer would look like, applied to the fetched rows rather than to `src/`.

/**
 * @param {any} row
 * @param {string} key
 * @returns {any}
 */
const withoutKey = (row, key) =>
  Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));

/**
 * @param {any} graphql
 * @param {(person: any) => any} rename
 * @returns {any}
 */
const everyPerson = (graphql, rename) => ({
  ...graphql,
  issues: graphql.issues.map((/** @type {any} */ row) => ({ ...row, user: rename(row.user) })),
  comments: graphql.comments.map((/** @type {any} */ row) => ({ ...row, user: rename(row.user) })),
});

/**
 * @param {any} graphql
 * @param {(row: any) => any} rename
 * @returns {any}
 */
const everyIssue = (graphql, rename) => ({ ...graphql, issues: graphql.issues.map(rename) });

const MUTATIONS = [
  {
    name: "the [bot] login suffix is not restored",
    evidence: /dependabot/,
    break: (/** @type {any} */ g) =>
      everyPerson(g, (person) => ({ ...person, login: person.login.replace(/\[bot\]$/, "") })),
  },
  {
    name: "the ghost account gets the wrong id",
    evidence: /10137/,
    break: (/** @type {any} */ g) =>
      everyPerson(g, (person) => (person.login === "ghost" ? { ...person, id: 1 } : person)),
  },
  {
    name: "an enum is left in SCREAMING_CASE",
    evidence: /OPEN/,
    break: (/** @type {any} */ g) =>
      everyIssue(g, (row) => ({
        ...row,
        state: row.state.toUpperCase(),
        state_reason: row.state_reason === null ? null : row.state_reason.toUpperCase(),
      })),
  },
  {
    name: "a renamed field is dropped",
    evidence: /state_reason/,
    break: (/** @type {any} */ g) => everyIssue(g, (row) => withoutKey(row, "state_reason")),
  },
  {
    name: "a nested renamed field is dropped",
    evidence: /due_on/,
    break: (/** @type {any} */ g) =>
      everyIssue(g, (row) => ({
        ...row,
        milestone: row.milestone === null ? null : withoutKey(row.milestone, "due_on"),
      })),
  },
  {
    name: "a comment loses the issue_url the GraphQL path rebuilds",
    evidence: /issue_url/,
    break: (/** @type {any} */ g) => ({
      ...g,
      comments: g.comments.map((/** @type {any} */ row) => withoutKey(row, "issue_url")),
    }),
  },
  {
    name: "the sub-issue rollup drops a child",
    evidence: /45/,
    break: (/** @type {any} */ g) => ({ ...g, subIssues: new Map([["47", ["44"]]]) }),
  },
  {
    // The pin, driven from the other side: this is what selecting `assignedActors` would do.
    name: "a bot assignee reaches the GraphQL rows",
    evidence: /copilot-swe-agent/,
    break: (/** @type {any} */ g) =>
      everyIssue(g, (row) =>
        row.number === 47
          ? {
              ...row,
              assignees: [
                ...row.assignees,
                {
                  id: 198982749,
                  login: "copilot-swe-agent[bot]",
                  html_url: "https://github.com/apps/copilot-swe-agent",
                },
              ],
            }
          : row,
      ),
  },
];

for (const mutation of MUTATIONS) {
  test(`mutation check: the harness fails when ${mutation.name}`, async () => {
    const { rest, graphql } = await fetchBoth();
    assert.throws(
      () => assertEquivalent(rest, mutation.break(graphql)),
      (/** @type {any} */ err) =>
        err instanceof assert.AssertionError && mutation.evidence.test(err.message),
      `the harness stayed green with a broken rename layer (${mutation.name})`,
    );
  });
}

// --- the divergence, pinned in the query and in the docs ---------------------

test("the ImportIssues query selects Issue.assignees, never Issue.assignedActors", async () => {
  const { graphqlRequests } = await fetchBoth();
  const query = graphqlRequests.find((r) => r.operationName === "ImportIssues")?.query ?? "";
  assert.match(query, /assignees\(first: 100\)/, "the assignee selection is still there to check");
  assert.ok(!query.includes("assignedActors"), WHY_PINNED);
});

test("CONTRACT.md names the bot-assignee divergence and its companion story", () => {
  const lines = readFileSync(new URL("../CONTRACT.md", import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith("#### The `ImportIssues` listing"));
  assert.notEqual(start, -1, "CONTRACT.md still has the ImportIssues row-shape section");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6} /.test(line));
  const section = (end === -1 ? rest : rest.slice(0, end)).join(" ");

  assert.ok(section.includes("assignedActors"), "the section names the field it does not select");
  assert.ok(
    section.includes("UserConnection"),
    "and why that field is the one that could carry a bot",
  );
  assert.match(section, /#330833/, "no companion server ask beside the divergence");
  assert.ok(
    section.includes("tests/dual-fetcher-parity.test.js"),
    "the section points at the harness that pins the divergence",
  );
});
