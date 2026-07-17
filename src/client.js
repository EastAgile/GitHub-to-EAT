/**
 * HTTP client for the East Agile Tracker API.
 *
 * Wraps global `fetch` with the `X-TrackerToken` header, base-URL joining, and
 * error mapping to a small exception hierarchy. Timeouts are in seconds.
 */

export const DEFAULT_IMPORT_TIMEOUT = 300;

/** Base class for East Agile Tracker client errors. */
export class EATError extends Error {
  /** @type {number | undefined} HTTP status when the error came from a response */
  status;
}

/** Authentication or authorization failed (HTTP 401/403). */
export class AuthError extends EATError {}

/** The requested resource does not exist (HTTP 404). */
export class NotFoundError extends EATError {}

/**
 * HTTP 409 — a domain conflict (`code: "conflict"`, e.g. duplicate label name) or
 * an Idempotency-Key replay (`code: "idempotency_conflict"`); callers branch on `code`.
 */
export class ConflictError extends EATError {
  /** @type {string | undefined} the server's error `code` field */
  code;
}

/** The request exceeded its timeout. */
export class EATTimeout extends EATError {}

/** Thin client for the subset of EAT endpoints this tool uses. */
export class EATClient {
  /** @type {Record<string, string>} */
  #headers;

  /**
   * @param {string} apiBase
   * @param {string} agentKey
   * @param {{ timeout?: number }} [options] timeout in seconds (default 30)
   */
  constructor(apiBase, agentKey, { timeout = 30 } = {}) {
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.timeout = timeout;
    this.#headers = { "X-TrackerToken": agentKey, Accept: "application/json" };
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ timeout?: number, headers?: Record<string, string>, json?: unknown }} [options]
   * @returns {Promise<Response>}
   */
  async #request(method, path, { timeout, headers, json } = {}) {
    const url = `${this.apiBase}${path}`;
    const seconds = timeout ?? this.timeout;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...this.#headers,
          ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: json !== undefined ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(seconds * 1000),
      });
    } catch (err) {
      const e = /** @type {{ name?: string, message?: string, cause?: { message?: string } }} */ (
        err
      );
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new EATTimeout(`request to ${path} timed out after ${Math.round(seconds)}s`);
      }
      throw new EATError(`could not reach ${url}: ${e?.cause?.message ?? e?.message ?? err}`);
    }

    if (response.status === 401 || response.status === 403) {
      const error = new AuthError(
        "authentication failed — check EAT_AGENT_KEY and its access to the project",
      );
      error.status = response.status;
      throw error;
    }
    if (response.status === 404) {
      const error = new NotFoundError(`not found: ${path}`);
      error.status = 404;
      throw error;
    }
    if (response.status === 409) {
      const text = await response.text();
      const error = new ConflictError(`conflict on ${path}: ${text.slice(0, 200)}`);
      error.status = 409;
      try {
        error.code = JSON.parse(text)?.code;
      } catch {}
      throw error;
    }
    if (response.status >= 400) {
      const text = await response.text();
      const error = new EATError(
        `request to ${path} failed (${response.status}): ${text.slice(0, 200)}`,
      );
      error.status = response.status;
      throw error;
    }
    return response;
  }

  /**
   * Fetch `/meta` — used to confirm reachability and a valid token.
   *
   * @returns {Promise<any>}
   */
  async getMeta() {
    return (await this.#request("GET", "/meta")).json();
  }

  /**
   * Fetch a project by id.
   *
   * @param {number} projectId
   * @returns {Promise<any>}
   */
  async getProject(projectId) {
    return (await this.#request("GET", `/projects/${projectId}`)).json();
  }

  /**
   * Return true if the project already contains at least one story.
   *
   * @param {number} projectId
   * @returns {Promise<boolean>}
   */
  async projectHasStories(projectId) {
    const response = await this.#request("GET", `/projects/${projectId}/stories?limit=1`);
    const data = await response.json();
    // With ?limit, EAT returns a cursor page {"items": [...], "next_cursor": ...};
    // a bare array (no query) is also tolerated.
    const items = Array.isArray(data) ? data : (data.items ?? data.stories ?? []);
    return items.length > 0;
  }

  /**
   * True when the server's import endpoint accepts a `dry_run` field.
   *
   * Feature-detected from the server's published OpenAPI spec — the pinned
   * schemas live at `GET /openapi.json` under the API base. Servers without
   * the spec (or without the field) predate server-side dry-run; sending
   * `dry_run` to them could trigger a real import, so callers must check
   * first. Any error (404, auth, parse) counts as "not supported".
   *
   * @returns {Promise<boolean>}
   */
  async supportsServerDryRun() {
    let spec;
    try {
      spec = await (await this.#request("GET", "/openapi.json")).json();
    } catch {
      return false;
    }
    /** @param {any} node */
    const resolve = (node) => {
      while (node && typeof node === "object" && "$ref" in node) {
        node = String(node.$ref)
          .split("/")
          .slice(1)
          .reduce((acc, part) => acc?.[part], spec);
      }
      return node;
    };
    for (const [path, ops] of Object.entries(spec?.paths ?? {})) {
      if (!path.endsWith("/import/json")) continue;
      const schema = resolve(
        resolve(ops?.post?.requestBody)?.content?.["application/json"]?.schema,
      );
      if (schema?.properties && "dry_run" in schema.properties) return true;
    }
    return false;
  }

  /**
   * Fetch one cursor page of a project's stories (direct-engine prescan).
   * `limit`/`cursor` put the endpoint in cursor mode (`{ items, next_cursor }`);
   * `fields` is the server's sparse-fieldset allowlist.
   *
   * @param {number} projectId
   * @param {{ limit?: number, cursor?: string, fields?: string }} [options]
   * @returns {Promise<{ items: any[], next_cursor: string | null }>}
   */
  async listStoryPage(projectId, { limit = 200, cursor, fields } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    if (fields) params.set("fields", fields);
    const response = await this.#request("GET", `/projects/${projectId}/stories?${params}`);
    return response.json();
  }

  /**
   * Create a label in a project (direct engine). A name that already exists
   * — case-insensitive — raises {@link ConflictError} with `code: "conflict"`.
   *
   * @param {number} projectId
   * @param {{ name: string, background_color_hex?: string, text_color_hex?: string }} label
   * @param {string} idempotencyKey
   * @returns {Promise<any>}
   */
  async createLabel(projectId, label, idempotencyKey) {
    const response = await this.#request("POST", `/projects/${projectId}/labels`, {
      json: label,
      headers: { "Idempotency-Key": idempotencyKey },
    });
    return response.json();
  }

  /**
   * Create a story (direct engine). Payload labels are attached get-or-create;
   * `current_state: "accepted"` works at create time (no estimate guard) — see CONTRACT.md.
   *
   * @param {number} projectId
   * @param {Record<string, unknown>} story create body (`name` required)
   * @param {string} idempotencyKey
   * @returns {Promise<any>}
   */
  async createStory(projectId, story, idempotencyKey) {
    const response = await this.#request("POST", `/projects/${projectId}/stories`, {
      json: story,
      headers: { "Idempotency-Key": idempotencyKey },
    });
    return response.json();
  }

  /**
   * Create a task on a story (direct engine).
   *
   * @param {number} projectId
   * @param {number} storyId
   * @param {{ description: string, complete?: boolean }} task
   * @param {string} idempotencyKey
   * @returns {Promise<any>}
   */
  async createTask(projectId, storyId, task, idempotencyKey) {
    const response = await this.#request(
      "POST",
      `/projects/${projectId}/stories/${storyId}/tasks`,
      {
        json: task,
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
    return response.json();
  }

  /**
   * Create a comment on a story (direct engine).
   *
   * @param {number} projectId
   * @param {number} storyId
   * @param {string} text
   * @param {string} idempotencyKey
   * @returns {Promise<any>}
   */
  async createComment(projectId, storyId, text, idempotencyKey) {
    const response = await this.#request(
      "POST",
      `/projects/${projectId}/stories/${storyId}/comments`,
      { json: { text }, headers: { "Idempotency-Key": idempotencyKey } },
    );
    return response.json();
  }

  /**
   * Trigger a GitHub import for a project.
   *
   * With no `token` the server fetches GitHub using its platform PAT (public
   * repos). Supplying a `token` (a GitHub PAT) lets the server read a private
   * repo, or work when no platform PAT is configured. The Idempotency-Key lets a
   * retried request replay instead of double-importing. With `dryRun`, the
   * server computes the dedup-aware plan without writing — only send it after
   * {@link supportsServerDryRun} says yes.
   *
   * @param {number} projectId
   * @param {string} owner
   * @param {string} repo
   * @param {{ idempotencyKey: string, token?: string, timeout?: number,
   *   flags?: Record<string, boolean>, dryRun?: boolean }} options `flags` are
   *   extra boolean request fields (e.g. include_pull_requests) merged into
   *   the body
   * @returns {Promise<any>}
   */
  async importGithub(projectId, owner, repo, { idempotencyKey, token, timeout, flags, dryRun }) {
    /** @type {Record<string, string | boolean>} */
    const body = { source: "github", owner, repo, ...flags };
    if (dryRun) body.dry_run = true;
    if (token) body.token = token;
    const response = await this.#request("POST", `/projects/${projectId}/import/json`, {
      json: body,
      headers: { "Idempotency-Key": idempotencyKey },
      timeout: timeout ?? DEFAULT_IMPORT_TIMEOUT,
    });
    return response.json();
  }
}
