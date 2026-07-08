/**
 * A minimal in-memory mock of the East Agile Tracker API.
 *
 * Implements only the endpoints github-to-eat uses, for tests and local runs:
 *
 *     GET  /meta
 *     GET  /projects/{id}
 *     GET  /projects/{id}/stories
 *     POST /projects/{id}/import/json
 *
 * Use in tests:
 *
 *     const mock = await startMockServer();
 *     try { ... } finally { await mock.close(); }
 *
 * Run standalone:
 *
 *     node src/mockserver.js --port 8080
 */

import { realpathSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * Configurable state and recorded requests for a mock server instance.
 *
 * `importResult`, when set, is returned verbatim from the import endpoint
 * (canned mode). When null, the result is computed from `fixture` and the
 * request's include_* flags, mirroring the real server's behaviour.
 *
 * @typedef {object} MockState
 * @property {Record<number, any>} projects
 * @property {Record<number, any[]>} stories
 * @property {any} meta
 * @property {any} importResult
 * @property {{ issues: number, prs: number, milestones: number, releases: number,
 *   labels: number }} fixture
 * @property {Record<number, string[]>} importedIds external ids already
 *   imported per project — drives skip-if-exists on re-import (computed mode)
 * @property {Array<{ project_id: number, body: any, idempotency_key: string | null }>} imports
 */

/**
 * Build a {@link MockState}, with per-field overrides.
 *
 * @param {Partial<MockState>} [overrides]
 * @returns {MockState}
 */
export function makeState(overrides = {}) {
  return {
    projects: { 91: { project_id: 91, project_title: "Mock Project" } },
    stories: {},
    meta: { story_types: ["feature", "bug", "chore", "release"] },
    importResult: null,
    fixture: { issues: 3, prs: 2, milestones: 1, releases: 1, labels: 0 },
    importedIds: {},
    imports: [],
    ...overrides,
  };
}

/**
 * Compute an import result from the fixture and the request body's flags,
 * the way the real server counts: issues always; other types only when the
 * corresponding include_* flag is set. Milestones become epics, which the
 * response does not count — they never change the story numbers.
 *
 * Mirrors the server's skip-if-exists dedup: each fixture row has a stable
 * external id per (project, source); rows already imported into the project
 * are counted in `skipped` instead of `imported`.
 *
 * @param {MockState} state
 * @param {number} projectId
 * @param {any} body
 */
function computeImportResult(state, projectId, body) {
  const ids = [];
  for (let i = 1; i <= state.fixture.issues; i += 1) ids.push(`issue-${i}`);
  if (body.include_pull_requests) {
    for (let i = 1; i <= state.fixture.prs; i += 1) ids.push(`pr-${i}`);
  }
  if (body.include_releases) {
    for (let i = 1; i <= state.fixture.releases; i += 1) ids.push(`release-${i}`);
  }
  const existing = new Set(state.importedIds[projectId] ?? []);
  const fresh = ids.filter((id) => !existing.has(id));
  state.importedIds[projectId] = [...existing, ...fresh];
  return {
    imported: { stories: fresh.length, labels: fresh.length ? state.fixture.labels : 0 },
    skipped: ids.length - fresh.length,
    errors: [],
    unmatched: {
      owners: [],
      followers: [],
      reviewers: [],
      requesters: [],
      comment_authors: [],
    },
  };
}

/**
 * @param {http.ServerResponse} res
 * @param {number} code
 * @param {unknown} [payload]
 */
function send(res, code, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * @param {MockState} state
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handle(state, req, res) {
  if (!req.headers["x-trackertoken"]) {
    send(res, 401, { error: "missing token" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://mock");
  const path = url.pathname;

  if (req.method === "GET") {
    if (path === "/meta") {
      send(res, 200, state.meta);
      return;
    }

    let m = path.match(/^\/projects\/(\d+)$/);
    if (m) {
      const project = state.projects[Number(m[1])];
      if (project) send(res, 200, project);
      else send(res, 404, { error: "not found" });
      return;
    }

    m = path.match(/^\/projects\/(\d+)\/stories$/);
    if (m) {
      const stories = state.stories[Number(m[1])] ?? [];
      // With ?limit/?cursor EAT returns a cursor page; a bare array otherwise.
      if (url.searchParams.has("limit")) {
        send(res, 200, { items: stories, next_cursor: null });
      } else {
        send(res, 200, stories);
      }
      return;
    }

    send(res, 404, { error: "unknown route" });
    return;
  }

  if (req.method === "POST") {
    const m = path.match(/^\/projects\/(\d+)\/import\/json$/);
    if (m) {
      const projectId = Number(m[1]);
      if (!(projectId in state.projects)) {
        send(res, 404, { error: "not found" });
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString() || "{}";
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        send(res, 400, { error: "invalid json" });
        return;
      }
      state.imports.push({
        project_id: projectId,
        body,
        idempotency_key: /** @type {string | undefined} */ (req.headers["idempotency-key"]) ?? null,
      });
      send(res, 200, state.importResult ?? computeImportResult(state, projectId, body));
      return;
    }
  }

  send(res, 404, { error: "unknown route" });
}

/**
 * Start a mock server on an ephemeral port.
 *
 * @param {MockState} [state]
 * @param {string} [host]
 * @returns {Promise<{ baseUrl: string, state: MockState, close(): Promise<void> }>}
 */
export async function startMockServer(state = makeState(), host = "127.0.0.1") {
  const server = http.createServer((req, res) => {
    handle(state, req, res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(undefined));
  });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    baseUrl: `http://${address.address}:${address.port}`,
    state,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      });
    },
  };
}

/**
 * @param {string[]} [argv]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8080" },
    },
  });
  const host = /** @type {string} */ (values.host);
  const port = Number(values.port);
  const state = makeState();
  const server = http.createServer((req, res) => {
    handle(state, req, res);
  });
  server.listen(port, host, () => {
    console.log(`mock EAT server on http://${host}:${port} (Ctrl-C to stop)`);
  });
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  return 0;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  process.exitCode = main();
}
