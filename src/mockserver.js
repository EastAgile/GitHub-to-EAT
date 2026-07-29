/**
 * A minimal in-memory mock of the East Agile Tracker API.
 *
 * Implements only the endpoints github-to-eat uses, for tests and local runs:
 *
 *     GET  /meta
 *     GET  /projects/{id}
 *     GET  /projects/{id}/stories          (cursor mode + fields= projection)
 *     GET  /projects/{id}/imports/{id}     (async import job status; --async)
 *     POST /projects/{id}/import/json      (202 async accept under --async)
 *     GET  /projects/{id}/epics
 *     POST /projects/{id}/epics             (409 on a duplicate epic OR label name)
 *     POST /projects/{id}/labels
 *     POST /projects/{id}/stories
 *     POST /projects/{id}/stories/{id}/tasks
 *     POST /projects/{id}/stories/{id}/comments
 *
 * Every POST honours Idempotency-Key like the real server (verified 2026-07-16):
 * same key + same body replays; same key + different body → 409 idempotency_conflict.
 *
 * Use in tests:
 *
 *     const mock = await startMockServer();
 *     try { ... } finally { await mock.close(); }
 *
 * Run standalone:
 *
 *     node src/mockserver.js --port 8080 [--async]
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
 * @property {Record<number, any[]>} labels
 * @property {Record<number, any[]>} epics
 * @property {string[]} requests `"<METHOD> <path>"` per request, in order — lets a
 *   test prove a call never happened, not just that its side effect is absent
 * @property {any} meta
 * @property {any} importResult
 * @property {{ issues: number, prs: number, milestones: number, releases: number,
 *   labels: number, assignees?: string[] }} fixture `assignees` become
 *   `external_members_created` on first import (computed mode)
 * @property {Record<number, string[]>} importedIds external ids already
 *   imported per project — drives skip-if-exists on re-import (computed mode)
 * @property {Record<number, string[]>} externalMembers logins whose
 *   external-member rows already exist per project — a re-import creates none
 * @property {boolean} serverDryRun when true (default), GET /openapi.json
 *   advertises the import dry_run field and dry_run requests are honoured;
 *   false simulates an older server (openapi 404s)
 * @property {boolean} provenance when true (default), the openapi advertises
 *   the re-import pair on POST /stories, create validates + persists it, and
 *   GET /stories honours the `import_source`/`import_external_id` list filters
 *   (EAT #31427); false simulates an older server that ignores the pair
 * @property {boolean} backdating when true (default, mirroring prod), the
 *   openapi advertises `created_at`/`completed_at` on story creates and
 *   `created_at` on comment creates, and the handlers persist them; false
 *   simulates a server that predates backdating (fields absent + ignored)
 * @property {boolean} asyncImport when true, POST /import/json answers the v2
 *   async accept — 202 `{ import_id, status:"pending" }` plus a pollable job at
 *   GET /imports/{import_id}; false (default) keeps today's synchronous 200
 * @property {boolean} asyncFail when true (with asyncImport), the job ends in
 *   `failed` with an error/error_code instead of `done`
 * @property {Record<string, { phases: any[], idx: number }>} jobs async import
 *   jobs by import_id; each GET serves the current phase then advances
 * @property {{ name?: number, description?: number, task_desc?: number,
 *   comment_text?: number }} maxLengths per-field write limits — when set,
 *   over-long values are rejected `400 too_long` and the limits are published
 *   as `maxLength` in /openapi.json (default: none, so the fallback path stays covered —
 *   production does publish them)
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
    epics: {},
    requests: [],
    // Mirrors the real /meta (probed 2026-07-29): `auth` + `hint` + `transitions`, and no
    // story-type list — `transitions` is the only place the response names the types at all.
    meta: {
      auth: { kind: "AgentKey", key_id: 1, agent_id: 1, project_id: null },
      hint: { id: "discovery", text: "Full API spec: GET /api/v1/openapi.json." },
      transitions: {
        feature: {
          unstarted: ["started"],
          started: ["finished"],
          finished: ["delivered"],
          delivered: ["accepted", "rejected"],
          rejected: [],
        },
        bug: {
          unstarted: ["started"],
          started: ["finished"],
          finished: ["delivered"],
          delivered: ["accepted", "rejected"],
          rejected: [],
        },
        chore: { unstarted: ["started"], started: ["accepted"] },
        release: { unstarted: ["accepted"] },
      },
    },
    importResult: null,
    fixture: { issues: 3, prs: 2, milestones: 1, releases: 1, labels: 0, assignees: [] },
    importedIds: {},
    externalMembers: {},
    serverDryRun: true,
    provenance: true,
    backdating: true,
    asyncImport: false,
    asyncFail: false,
    jobs: {},
    maxLengths: {},
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
  "import_source",
  "import_external_id",
]);

/**
 * The minimal OpenAPI slice the client's feature detections read: the import
 * dry_run field, plus the write paths with `maxLength` only where configured
 * (today's real server publishes the paths but no limits).
 *
 * @param {MockState} state
 */
function openapiDoc(state) {
  const ml = state.maxLengths ?? {};
  // Backdated instants — advertised only when the server supports backdating.
  const dateTime = { type: ["string", "null"], format: "date-time" };
  /** @param {Record<string, number | undefined>} fields @param {Record<string, any>} [extra] */
  const post = (fields, extra = {}) => ({
    post: {
      requestBody: {
        content: {
          "application/json": {
            schema: {
              properties: {
                ...Object.fromEntries(
                  Object.entries(fields).map(([name, max]) => [
                    name,
                    max ? { type: "string", maxLength: max } : { type: "string" },
                  ]),
                ),
                ...extra,
              },
            },
          },
        },
      },
    },
  });
  // When async, advertise the 202 accept (as a response on the import path) and
  // the pollable status path — not an invented `import/json:202` path key.
  const asyncPaths = state.asyncImport
    ? {
        "/api/v1/projects/{project_id}/imports/{import_id}": {
          get: { responses: { 200: { description: "import status" } } },
        },
      }
    : {};
  return {
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
          ...(state.asyncImport
            ? { responses: { 202: { description: "import accepted; poll for status" } } }
            : {}),
        },
      },
      ...asyncPaths,
      "/api/v1/projects/{project_id}/stories": post(
        {
          name: ml.name,
          description: ml.description,
          ...(state.provenance ? { import_source: undefined, import_external_id: undefined } : {}),
        },
        {
          // A scale *label*, not a number (probed 2026-07-29). Advertised because the writer
          // must be seen never to send it; a numeric type here would invite the wrong guess.
          estimate: { type: ["string", "null"] },
          ...(state.backdating ? { created_at: dateTime, completed_at: dateTime } : {}),
        },
      ),
      "/api/v1/projects/{project_id}/stories/{story_id}/tasks": post({
        description: ml.task_desc,
        task_desc: ml.task_desc,
      }),
      "/api/v1/projects/{project_id}/stories/{story_id}/comments": post(
        { text: ml.comment_text, comment_text: ml.comment_text },
        state.backdating ? { created_at: dateTime } : {},
      ),
    },
  };
}

/**
 * The real server's `too_long` rejection (observed 2026-07-17), or null when
 * the value fits (or no limit is configured).
 *
 * @param {MockState} state
 * @param {"name" | "description" | "task_desc" | "comment_text"} field
 * @param {string} value
 * @returns {MockResponse | null}
 */
function tooLong(state, field, value) {
  const max = (state.maxLengths ?? {})[field];
  if (!max || value.length <= max) return null;
  return {
    status: 400,
    payload: {
      code: "invalid_parameter",
      details: { constraint: "too_long", fields: [field] },
      error: "This value is too long.",
    },
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
  const dryRun = state.serverDryRun && body.dry_run === true;
  const existing = new Set(state.importedIds[projectId] ?? []);
  const fresh = ids.filter((id) => !existing.has(id));
  const knownMembers = new Set(state.externalMembers[projectId] ?? []);
  const createdMembers = (state.fixture.assignees ?? []).filter(
    (login) => !knownMembers.has(login),
  );
  if (!dryRun) {
    state.importedIds[projectId] = [...existing, ...fresh];
    state.externalMembers[projectId] = [...knownMembers, ...createdMembers];
  }
  return {
    dry_run: dryRun,
    imported: { stories: fresh.length, labels: fresh.length ? state.fixture.labels : 0 },
    skipped: ids.length - fresh.length,
    errors: [],
    external_members_created: createdMembers,
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
 * Build a pollable async import job whose phases walk
 * `pending → fetching X/N → writing → done|failed`. `result` (the already
 * computed sync ImportResult) is revealed only on the terminal `done` phase,
 * byte-identical to what the synchronous 200 returns.
 *
 * @param {MockState} state
 * @param {number} projectId
 * @param {string} importId
 * @param {any} result
 * @returns {{ phases: any[], idx: number }}
 */
function buildImportJob(state, projectId, importId, result) {
  const total = (result.imported?.stories ?? 0) + (result.skipped ?? 0) || 1;
  /** @type {Record<string, any>} */
  const base = {
    import_id: importId,
    project_id: projectId,
    source: "github",
    created: new Date().toISOString(),
    error: null,
    error_code: null,
    result: null,
  };
  /** @type {any[]} */
  const phases = [{ ...base, status: "pending", progress_current: null, progress_total: null }];
  for (let i = 1; i <= total; i += 1) {
    phases.push({ ...base, status: "fetching", progress_current: i, progress_total: total });
  }
  phases.push({ ...base, status: "writing", progress_current: total, progress_total: total });
  if (state.asyncFail) {
    phases.push({
      ...base,
      status: "failed",
      progress_current: null,
      progress_total: null,
      error: "import failed on the tracker",
      error_code: "import_error",
    });
  } else {
    phases.push({
      ...base,
      status: "done",
      progress_current: total,
      progress_total: total,
      result,
    });
  }
  return { phases, idx: 0 };
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
  state.requests.push(`${req.method} ${path}`);

  if (req.method === "GET") {
    if (path === "/meta") {
      send(res, 200, state.meta);
      return;
    }

    if (path === "/openapi.json") {
      if (state.serverDryRun) send(res, 200, openapiDoc(state));
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
      let stories = state.stories[Number(m[1])] ?? [];
      // EAT #31427 provenance list filters — only on a server that advertises the pair.
      if (state.provenance) {
        const src = url.searchParams.get("import_source");
        if (src !== null) stories = stories.filter((row) => row.import_source === src);
        const ext = url.searchParams.get("import_external_id");
        if (ext !== null)
          stories = stories.filter((row) => String(row.import_external_id ?? "") === ext);
      }
      /** @type {(rows: any[]) => any[]} */
      let applyFields = (rows) => rows;
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
        applyFields = (rows) =>
          rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k))));
      }
      // The real server 400s any pagination garbage (probed 2026-07-16) — a silently
      // non-advancing page would hang the direct engine's prescan loop forever.
      const limitParam = url.searchParams.get("limit");
      if (limitParam !== null && !(/^\d+$/.test(limitParam) && Number(limitParam) >= 1)) {
        send(res, 400, {
          code: "validation_failed",
          details: { fields: ["limit"] },
          error: "limit must be ≥ 1",
        });
        return;
      }
      // A valid cursor is one this mock could have issued: 1 ≤ n < row count. The real
      // server rejects even out-of-range cursors, not just unparseable ones.
      const cursorParam = url.searchParams.get("cursor");
      if (
        cursorParam !== null &&
        !(
          /^\d+$/.test(cursorParam) &&
          Number(cursorParam) >= 1 &&
          Number(cursorParam) < stories.length
        )
      ) {
        send(res, 400, {
          code: "validation_failed",
          details: { fields: ["cursor"] },
          error: "invalid cursor",
        });
        return;
      }
      // With ?limit/?cursor EAT returns a cursor page; a bare array otherwise.
      if (limitParam !== null || cursorParam !== null) {
        const offset = Number(cursorParam ?? 0);
        const limit = limitParam !== null ? Number(limitParam) : 50;
        const items = stories.slice(offset, offset + limit).map(toStoryPayload);
        const end = offset + items.length;
        send(res, 200, {
          items: applyFields(items),
          next_cursor: end < stories.length ? String(end) : null,
        });
      } else {
        send(res, 200, applyFields(stories.map(toStoryPayload)));
      }
      return;
    }

    m = path.match(/^\/projects\/(\d+)\/epics$/);
    if (m) {
      const projectId = Number(m[1]);
      if (!(projectId in state.projects)) {
        send(res, 404, { error: "not found" });
        return;
      }
      send(res, 200, state.epics[projectId] ?? []);
      return;
    }

    m = path.match(/^\/projects\/(\d+)\/imports\/([^/]+)$/);
    if (m) {
      const job = state.jobs[m[2]];
      if (!job) {
        send(res, 404, { error: "not found" });
        return;
      }
      const doc = job.phases[job.idx];
      // Advance toward the terminal phase so a poller sees real progression.
      if (job.idx < job.phases.length - 1) job.idx += 1;
      send(res, 200, doc);
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
    // `null` and primitives parse as valid JSON but would blow up property access.
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      send(res, 400, { code: "validation_failed", error: "body must be a JSON object" });
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
      // Snapshot, or the "stored" payload would alias live rows and mutate under replays.
      state.idempotency[key] = {
        bodyHash,
        status: result.status,
        payload: structuredClone(result.payload),
      };
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

/** Colors the real server assigns when a label is created without any (observed 2026-07-16). */
const LABEL_DEFAULT_BACKGROUND = "#3498db";
const LABEL_DEFAULT_TEXT = "#ffffff";

/**
 * `comments` on a story row is bookkeeping for tests — the real read shape
 * never carries it (it isn't in the fields= allowlist either).
 *
 * @param {any} row
 * @returns {any}
 */
function toStoryPayload(row) {
  const { comments, ...payload } = row;
  return payload;
}

/**
 * Runs only for POSTs the idempotency layer did not short-circuit, so handlers
 * execute at most once per key.
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
    // Dedup bookkeeping (computeImportResult) must run exactly once per import;
    // async mode computes it now and reveals it only on the job's `done` phase.
    const result = state.importResult ?? computeImportResult(state, projectId, body);
    if (state.asyncImport) {
      const importId = `imp-${state.nextId++}`;
      state.jobs[importId] = buildImportJob(state, projectId, importId, result);
      return { status: 202, payload: { import_id: importId, status: "pending" } };
    }
    return { status: 200, payload: result };
  }

  m = path.match(/^\/projects\/(\d+)\/epics$/);
  if (m) return createEpic(state, Number(m[1]), body);

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
  if (!name) {
    return {
      status: 400,
      payload: {
        code: "invalid_parameter",
        details: { constraint: "required", fields: ["label_name"] },
        error: "This field is required.",
      },
    };
  }
  state.labels[projectId] ??= [];
  const duplicate = state.labels[projectId].some(
    (l) => l.label_name.toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    return {
      status: 409,
      payload: { code: "conflict", error: `Label '${name}' already exists in this project` },
    };
  }
  const label = {
    label_id: state.nextId++,
    label_name: name,
    project_id: projectId,
    background_color_hex: body.background_color_hex ?? LABEL_DEFAULT_BACKGROUND,
    text_color_hex: body.text_color_hex ?? LABEL_DEFAULT_TEXT,
  };
  state.labels[projectId].push(label);
  return { status: 200, payload: label };
}

/**
 * Get-or-create is NOT what the public endpoint does: it pre-checks the project's label
 * names and 409s on a hit, naming `Epic` when that label already backs one and `Label`
 * otherwise (handlers/epics.rs) — so a plain label of the same name blocks the epic.
 * Deviation: titles are trimmed before keying and storing; the real handler stores them
 * verbatim, which no caller of this mock sends.
 *
 * @param {MockState} state
 * @param {number} projectId
 * @param {any} body
 * @returns {MockResponse}
 */
function createEpic(state, projectId, body) {
  if (!(projectId in state.projects)) return NOT_FOUND;
  const raw = body.epic_title ?? body.name;
  if (raw == null) {
    return { status: 400, payload: { error: "name or epic_title is required" } };
  }
  const title = String(raw).trim();
  if (!title) {
    return {
      status: 400,
      payload: {
        code: "invalid_parameter",
        details: { constraint: "required", fields: ["name"] },
        error: "This field is required.",
      },
    };
  }
  state.epics[projectId] ??= [];
  state.labels[projectId] ??= [];
  const key = title.toLowerCase();
  const clash = state.labels[projectId].find((l) => l.label_name.toLowerCase() === key);
  if (clash) {
    const kind = state.epics[projectId].some((e) => e.label_id === clash.label_id)
      ? "Epic"
      : "Label";
    return {
      status: 409,
      payload: { code: "conflict", error: `${kind} '${title}' already exists in this project` },
    };
  }
  // The backing label is auto-created in the same transaction, with a colour derived
  // from the title — the real handler's `deterministic_label_colors`.
  const hash = createHash("sha256").update(title).digest("hex");
  const label = {
    label_id: state.nextId++,
    label_name: title,
    project_id: projectId,
    background_color_hex: `#${hash.slice(0, 6)}`,
    text_color_hex: LABEL_DEFAULT_TEXT,
  };
  state.labels[projectId].push(label);
  const now = new Date().toISOString();
  const description = body.description == null ? null : String(body.description);
  const epic = {
    epic_id: state.nextId++,
    project_id: projectId,
    label_id: label.label_id,
    epic_title: title,
    name: title,
    epic_desc: description,
    description,
    epic_code: null,
    epic_url: null,
    created: now,
    updated_at: now,
    label,
  };
  state.epics[projectId].push(epic);
  return { status: 200, payload: epic };
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
  if (!name) {
    return {
      status: 400,
      payload: {
        code: "validation_failed",
        details: { fields: ["name"] },
        error: "Some of the submitted data was invalid. Please check your input and try again.",
      },
    };
  }
  const overLong =
    tooLong(state, "name", name) ?? tooLong(state, "description", String(body.description ?? ""));
  if (overLong) return overLong;

  if (body.labels != null && !Array.isArray(body.labels)) {
    return {
      status: 400,
      payload: {
        code: "validation_failed",
        details: { fields: ["labels"] },
        error: "labels must be an array",
      },
    };
  }

  // EAT #31427 owner-gates the pair and rejects a lone field (probed 2026-07-24).
  if (state.provenance) {
    const hasSource = body.import_source != null;
    const hasExternal = body.import_external_id != null;
    if (hasSource !== hasExternal) {
      return {
        status: 400,
        payload: {
          code: "validation_failed",
          details: { fields: ["import_source", "import_external_id"] },
          error: "import_source and import_external_id are required as a pair",
        },
      };
    }
  }

  state.labels[projectId] ??= [];
  const projectLabels = state.labels[projectId];
  const labels = [];
  for (const input of body.labels ?? []) {
    const labelName = String(typeof input === "string" ? input : (input?.name ?? "")).trim();
    if (!labelName) continue;
    // Unlike POST /labels (409 on duplicates), the story payload get-or-creates
    // labels by name, with default colors — probed 2026-07-16.
    let label = projectLabels.find((l) => l.label_name.toLowerCase() === labelName.toLowerCase());
    if (!label) {
      label = {
        label_id: state.nextId++,
        label_name: labelName,
        project_id: projectId,
        background_color_hex: LABEL_DEFAULT_BACKGROUND,
        text_color_hex: LABEL_DEFAULT_TEXT,
      };
      projectLabels.push(label);
    }
    labels.push(label);
  }

  const now = new Date().toISOString();
  /** @type {Record<string, any>} */
  const story = {
    story_id: state.nextId++,
    project_id: projectId,
    title: name,
    description: body.description ?? null,
    story_type: body.story_type ?? "feature",
    current_state: body.current_state ?? "unstarted",
    // Echoed only when sent, so a test can still prove the writer never sends it.
    ...(body.estimate != null ? { estimate: body.estimate } : {}),
    icebox: body.icebox ?? false,
    ...(state.provenance
      ? {
          import_source: body.import_source ?? null,
          import_external_id: body.import_external_id ?? null,
        }
      : {}),
    labels,
    tasks: [],
    tasks_count: 0,
    comments: [],
    comment_count: 0,
    created: now,
    updated_at: now,
  };
  if (state.backdating && body.created_at != null) {
    story.created_at = body.created_at;
    story.created = body.created_at;
    // completed_at is valid only on a done-state create and clamps forward to
    // created_at (a completion before creation stores as the creation instant).
    if (body.completed_at != null && story.current_state === "accepted") {
      story.completed_at =
        body.completed_at < body.created_at ? body.created_at : body.completed_at;
    }
  }
  state.stories[projectId] ??= [];
  state.stories[projectId].push(story);
  return { status: 200, payload: toStoryPayload(story) };
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
  // `description`/`task_desc` are both real request fields (openapi + probe).
  const description = String(body.description ?? body.task_desc ?? "");
  if (!description.trim()) {
    return { status: 400, payload: { code: "invalid_parameter", error: "task_desc is required" } };
  }
  const overLong = tooLong(state, "task_desc", description);
  if (overLong) return overLong;
  const task = {
    task_id: state.nextId++,
    story_id: storyId,
    task_desc: description,
    complete: body.complete === true,
    task_order: body.task_order ?? story.tasks.length,
    created: new Date().toISOString(),
  };
  story.tasks.push(task);
  story.tasks_count = story.tasks.length;
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
  // `text`/`comment_text` are both real request fields (openapi + probe).
  const text = String(body.text ?? body.comment_text ?? "");
  if (!text.trim()) {
    return {
      status: 400,
      payload: { code: "invalid_parameter", error: "comment must have text or emoji" },
    };
  }
  const overLong = tooLong(state, "comment_text", text);
  if (overLong) return overLong;
  // The real server returns the same value for both ids (probed 2026-07-16).
  const id = state.nextId++;
  /** @type {Record<string, any>} */
  const comment = {
    comment_id: id,
    story_comment_id: id,
    story_id: storyId,
    comment_text: text,
    created: new Date().toISOString(),
  };
  if (state.backdating && body.created_at != null) {
    comment.created_at = body.created_at;
    comment.created = body.created_at;
  }
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
    // An unhandled rejection would leave the socket open forever (client hangs).
    handle(state, req, res).catch(() => send(res, 500, { error: "internal" }));
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
      async: { type: "boolean", default: false },
    },
  });
  const host = /** @type {string} */ (values.host);
  const port = Number(values.port);
  const state = makeState({ asyncImport: Boolean(values.async) });
  const server = http.createServer((req, res) => {
    handle(state, req, res).catch(() => send(res, 500, { error: "internal" }));
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
