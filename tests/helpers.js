/** Shared test utilities (not picked up as a test file by the runner). */

import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * A writable sink that records everything written to it.
 *
 * @returns {{ buf: string, isTTY: boolean, write(chunk: string): boolean }}
 */
export function capture() {
  return {
    buf: "",
    isTTY: false,
    write(chunk) {
      this.buf += chunk;
      return true;
    },
  };
}

/**
 * Run `fn` with the working directory set to a fresh temp dir; restore after.
 *
 * @template T
 * @param {(dir: string) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function inTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gh2eat-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(prev);
  }
}

/**
 * Run `fn` with env vars overridden (undefined deletes); restore after.
 *
 * @template T
 * @param {Record<string, string | undefined>} overrides
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withEnv(overrides, fn) {
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string>}
 */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One `ImportIssues` node, overridable field by field.
 *
 * @param {object} [over]
 */
export const issueNode = (over = {}) => ({
  number: 7,
  title: "Add a widget",
  body: "hello",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-01-02T03:04:05Z",
  closedAt: null,
  url: "https://github.com/o/r/issues/7",
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

/** One published release, shaped like the live REST row. */
export const releaseRow = () => ({
  id: 100,
  tag_name: "v2.0.0",
  name: "Two point oh",
  body: "notes",
  draft: false,
  published_at: "2026-03-01T00:00:00Z",
  html_url: "https://github.com/o/r/releases/tag/v2.0.0",
});

/**
 * A local stand-in for api.github.com serving `POST /graphql`, the `GET /rate_limit` probe
 * and the REST release listing. Every other path 404s, so a drifted listing fails loudly.
 *
 * @param {{ issues?: any[], pullRequests?: any[], labels?: any[], releases?: any[],
 *   budget?: unknown, graphql?: (request: any) => unknown }} fixture
 *   `budget` is the whole `GET /rate_limit` body; `graphql` replaces the envelope builder
 * @param {(context: { base: string,
 *   seen: { method: string, path: string, operationName?: string,
 *     authorization?: string }[] }) => Promise<void>} fn
 */
export async function withGitHubStub(fixture, fn) {
  const {
    issues = [],
    pullRequests = [],
    labels = [],
    releases = [],
    budget = { resources: { core: { remaining: 5000 }, graphql: { remaining: 5000 } } },
    graphql,
  } = fixture ?? {};
  /** @type {{ method: string, path: string, operationName?: string,
   *    authorization?: string }[]} */
  const seen = [];
  const page = { pageInfo: { hasNextPage: false, endCursor: null } };
  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? "", "http://x");
    if (req.method === "POST" && pathname === "/graphql") {
      const request = JSON.parse(await readBody(req));
      seen.push({
        method: "POST",
        path: pathname,
        operationName: request.operationName,
        authorization: req.headers.authorization,
      });
      /** @type {Record<string, unknown>} */
      const connections = {
        ImportIssues: { issues: { totalCount: issues.length, ...page, nodes: issues } },
        ImportLabels: { labels: { ...page, nodes: labels } },
        ImportPullRequests: {
          pullRequests: { totalCount: pullRequests.length, ...page, nodes: pullRequests },
        },
      };
      const body = graphql
        ? graphql(request)
        : {
            data: {
              rateLimit: { remaining: 4999, resetAt: "2030-01-01T00:00:00Z" },
              repository: connections[request.operationName] ?? {},
            },
          };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    seen.push({
      method: req.method ?? "GET",
      path: pathname,
      authorization: req.headers.authorization,
    });
    const body =
      pathname === "/rate_limit" ? budget : pathname === "/repos/o/r/releases" ? releases : null;
    res.writeHead(body === null ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body ?? { message: `no stub route for ${req.method} ${pathname}` }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    await fn({ base: `http://127.0.0.1:${address.port}`, seen });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}
