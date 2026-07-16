/**
 * A minimal in-memory mock of the East Agile Tracker API.
 *
 * Implements only the endpoints github-to-eat uses, for tests and local runs:
 *
 *     GET  /meta
 *     GET  /projects/{id}
 *     GET  /projects/{id}/stories          (cursor mode + fields= projection)
 *     POST /projects/{id}/import/json
 *     POST /projects/{id}/labels
 *     POST /projects/{id}/stories
 *     POST /projects/{id}/stories/{id}/tasks
 *     POST /projects/{id}/stories/{id}/comments
 *
 * Every POST honours Idempotency-Key the way the real server does (verified
 * 2026-07-16): same key + same body replays the stored response; same key +
 * different body is a 409 idempotency_conflict.
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

import { createHash } from "node:crypto";
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
 * @property {Record<number, any[]>} labels labels created per project
 * @property {any} meta
 * @property {any} importResult
 * @property {{ issues: number, prs: number, milestones: number, releases: number,
 *   labels: number }} fixture
 * @property {Record<number, string[]>} importedIds external ids already
 *   imported per project — drives skip-if-exists on re-import (computed mode)
 * @property {boolean} serverDryRun when true (default), GET /openapi.json
 *   advertises the import dry_run field and dry_run requests are honoured;
 *   false simulates an older server (openapi 404s)
 * @property {Array<{ project_id: number, body: any, idempotency_key: string | null }>} imports
 * @property {Record<string, { bodyHash: string, status: number, payload: any }>} idempotency
 *   stored first responses per Idempotency-Key — drives replay/409
 * @property {number} nextId shared id counter for labels/stories/tasks/comments
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
    labels: {},
    meta: { story_types: ["feature", "bug", "chore", "release"] },
    importResult: null,
    fixture: { issues: 3, prs: 2, milestones: 1, releases: 1, labels: 0 },
    importedIds: {},
    serverDryRun: true,
    imports: [],
    idempotency: {},
    nextId: 1,
    ...overrides,
  };
}

/** The `fields=` allowlist published by the real server's openapi.json. */
const STORY_FIELDS = new Set([
  "story_id",
  "story_ref",
  "project_id",
  "title",
  "description",
  "story_type",
  "current_state",
  "estimate",
  "position",
  "icebox",
  "labels",
  "owners",
  "started",
  "created",
  "updated_at",
  "blocker_count",
  "comment_count",
  "tasks_count",
  "tasks_complete_count",
  "tasks",
  "blockers",
]);

/** The minimal OpenAPI slice the client's dry-run feature detection reads. */
const OPENAPI_SLICE = {
  paths: {
    "/api/v1/projects/{project_id}/import/json": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { properties: { dry_run: { type: ["boolean", "null"] } } },
            },
          },
        },
      },
    },
  },
};

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
  const dryRun = state.serverDryRun && body.dry_run === true;
  const existing = new Set(state.importedIds[projectId] ?? []);
  const fresh = ids.filter((id) => !existing.has(id));
  if (!dryRun) {
    state.importedIds[projectId] = [...existing, ...fresh];
  }
  return {
    dry_run: dryRun,
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

    if (path === "/openapi.json") {
      if (state.serverDryRun) send(res, 200, OPENAPI_SLICE);
      else send(res, 404, { error: "not found" });
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
      /** @type {(rows: any[]) => any[]} */
      let project = (rows) => rows;
      const fieldsParam = url.searchParams.get("fields");
      if (fieldsParam !== null) {
        const requested = fieldsParam
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean);
        const unknown = requested.filter((f) => !STORY_FIELDS.has(f));
        if (unknown.length) {
          send(res, 400, {
            code: "validation_failed",
            details: { fields: unknown },
            error: `unknown field(s): ${unknown.join(", ")}`,
          });
          return;
        }
        const keep = new Set(["story_id", ...requested]);
        project = (rows) =>
          rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k))));
      }
      // Cursor mode when ?limit/?cursor is present; a bare (projected) array otherwise.
      if (url.searchParams.has("limit") || url.searchParams.has("cursor")) {
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
        const items = stories.slice(offset, offset + limit);
        const end = offset + items.length;
        send(res, 200, {
          items: project(items),
          next_cursor: end < stories.length ? String(end) : null,
        });
      } else {
        send(res, 200, project(stories));
      }
      return;
    }

    send(res, 404, { error: "unknown route" });
    return;
  }

  if (req.method === "POST") {
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

    const key = /** @type {string | undefined} */ (req.headers["idempotency-key"]);
    if (key) {
      const bodyHash = createHash("sha256").update(raw).digest("hex");
      const stored = state.idempotency[key];
      if (stored) {
        if (stored.bodyHash === bodyHash) {
          send(res, stored.status, stored.payload);
        } else {
          send(res, 409, {
            code: "idempotency_conflict",
            details: { new_body_hash: bodyHash, original_body_hash: stored.bodyHash },
            error: "Idempotency-Key reused with a different request body",
          });
        }
        return;
      }
      const result = routePost(state, path, body, key);
      state.idempotency[key] = { bodyHash, ...result };
      send(res, result.status, result.payload);
      return;
    }

    const result = routePost(state, path, body, null);
    send(res, result.status, result.payload);
    return;
  }

  send(res, 404, { error: "unknown route" });
}

/** @typedef {{ status: number, payload: any }} MockResponse */

/** @type {MockResponse} */
const NOT_FOUND = { status: 404, payload: { error: "not found" } };

/**
 * Dispatch a parsed POST to its endpoint handler. Runs only for requests the
 * idempotency layer did not short-circuit, so handlers always execute at most
 * once per key.
 *
 * @param {MockState} state
 * @param {string} path
 * @param {any} body
 * @param {string | null} idempotencyKey
 * @returns {MockResponse}
 */
function routePost(state, path, body, idempotencyKey) {
  let m = path.match(/^\/projects\/(\d+)\/import\/json$/);
  if (m) {
    const projectId = Number(m[1]);
    if (!(projectId in state.projects)) return NOT_FOUND;
    state.imports.push({ project_id: projectId, body, idempotency_key: idempotencyKey });
    return {
      status: 200,
      payload: state.importResult ?? computeImportResult(state, projectId, body),
    };
  }

  m = path.match(/^\/projects\/(\d+)\/labels$/);
  if (m) return createLabel(state, Number(m[1]), body);

  m = path.match(/^\/projects\/(\d+)\/stories$/);
  if (m) return createStory(state, Number(m[1]), body);

  m = path.match(/^\/projects\/(\d+)\/stories\/(\d+)\/tasks$/);
  if (m) return createTask(state, Number(m[1]), Number(m[2]), body);

  m = path.match(/^\/projects\/(\d+)\/stories\/(\d+)\/comments$/);
  if (m) return createComment(state, Number(m[1]), Number(m[2]), body);

  return { status: 404, payload: { error: "unknown route" } };
}

/**
 * @param {MockState} state
 * @param {number} projectId
 * @param {any} body
 * @returns {MockResponse}
 */
function createLabel(state, projectId, body) {
  if (!(projectId in state.projects)) return NOT_FOUND;
  const name = String(body.name ?? body.label_name ?? "").trim();
  if (!name)
    return { status: 400, payload: { code: "validation_failed", error: "name is required" } };
  const label = {
    label_id: state.nextId++,
    label_name: name,
    project_id: projectId,
    background_color_hex: body.background_color_hex ?? null,
    text_color_hex: body.text_color_hex ?? null,
  };
  state.labels[projectId] ??= [];
  state.labels[projectId].push(label);
  return { status: 200, payload: label };
}

/**
 * @param {MockState} state
 * @param {number} projectId
 * @param {any} body
 * @returns {MockResponse}
 */
function createStory(state, projectId, body) {
  if (!(projectId in state.projects)) return NOT_FOUND;
  const name = String(body.name ?? "").trim();
  if (!name)
    return { status: 400, payload: { code: "validation_failed", error: "name is required" } };

  state.labels[projectId] ??= [];
  const projectLabels = state.labels[projectId];
  const labels = [];
  for (const input of body.labels ?? []) {
    const labelName = String(typeof input === "string" ? input : (input?.name ?? "")).trim();
    if (!labelName) continue;
    // The real server get-or-creates labels named on the story payload.
    let label = projectLabels.find((l) => l.label_name.toLowerCase() === labelName.toLowerCase());
    if (!label) {
      label = {
        label_id: state.nextId++,
        label_name: labelName,
        project_id: projectId,
        background_color_hex: null,
        text_color_hex: null,
      };
      projectLabels.push(label);
    }
    labels.push(label);
  }

  const now = new Date().toISOString();
  const story = {
    story_id: state.nextId++,
    project_id: projectId,
    title: name,
    description: body.description ?? null,
    story_type: body.story_type ?? "feature",
    current_state: body.current_state ?? "unstarted",
    icebox: body.icebox ?? false,
    labels,
    tasks: [],
    comments: [],
    comment_count: 0,
    created: now,
    updated_at: now,
  };
  state.stories[projectId] ??= [];
  state.stories[projectId].push(story);
  return { status: 200, payload: story };
}

/**
 * @param {MockState} state
 * @param {number} projectId
 * @param {number} storyId
 * @returns {any | undefined}
 */
function findStory(state, projectId, storyId) {
  return (state.stories[projectId] ?? []).find((row) => row.story_id === storyId);
}

/**
 * @param {MockState} state
 * @param {number} projectId
 * @param {number} storyId
 * @param {any} body
 * @returns {MockResponse}
 */
function createTask(state, projectId, storyId, body) {
  const story = findStory(state, projectId, storyId);
  if (!story) return NOT_FOUND;
  const task = {
    task_id: state.nextId++,
    story_id: storyId,
    task_desc: String(body.description ?? body.task_desc ?? ""),
    complete: body.complete === true,
    task_order: body.task_order ?? story.tasks.length,
    created: new Date().toISOString(),
  };
  story.tasks.push(task);
  return { status: 200, payload: task };
}

/**
 * @param {MockState} state
 * @param {number} projectId
 * @param {number} storyId
 * @param {any} body
 * @returns {MockResponse}
 */
function createComment(state, projectId, storyId, body) {
  const story = findStory(state, projectId, storyId);
  if (!story) return NOT_FOUND;
  const comment = {
    comment_id: state.nextId,
    story_comment_id: state.nextId++,
    story_id: storyId,
    comment_text: String(body.text ?? body.comment_text ?? ""),
    created: new Date().toISOString(),
  };
  story.comments.push(comment);
  story.comment_count = story.comments.length;
  return { status: 200, payload: comment };
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
