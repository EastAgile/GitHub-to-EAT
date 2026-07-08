/**
 * HTTP client for the East Agile Tracker API.
 *
 * Wraps global `fetch` with the `X-TrackerToken` header, base-URL joining, and
 * error mapping to a small exception hierarchy. Timeouts are in seconds.
 */

export const DEFAULT_IMPORT_TIMEOUT = 300;

/** Base class for East Agile Tracker client errors. */
export class EATError extends Error {}

/** Authentication or authorization failed (HTTP 401/403). */
export class AuthError extends EATError {}

/** The requested resource does not exist (HTTP 404). */
export class NotFoundError extends EATError {}

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
      throw new AuthError(
        "authentication failed — check EAT_AGENT_KEY and its access to the project",
      );
    }
    if (response.status === 404) {
      throw new NotFoundError(`not found: ${path}`);
    }
    if (response.status >= 400) {
      const text = await response.text();
      throw new EATError(`request to ${path} failed (${response.status}): ${text.slice(0, 200)}`);
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
   * Trigger a GitHub import for a project.
   *
   * With no `token` the server fetches GitHub using its platform PAT (public
   * repos). Supplying a `token` (a GitHub PAT) lets the server read a private
   * repo, or work when no platform PAT is configured. The Idempotency-Key lets a
   * retried request replay instead of double-importing.
   *
   * @param {number} projectId
   * @param {string} owner
   * @param {string} repo
   * @param {{ idempotencyKey: string, token?: string, timeout?: number,
   *   flags?: Record<string, boolean> }} options `flags` are extra boolean
   *   request fields (e.g. include_pull_requests) merged into the body
   * @returns {Promise<any>}
   */
  async importGithub(projectId, owner, repo, { idempotencyKey, token, timeout, flags }) {
    /** @type {Record<string, string | boolean>} */
    const body = { source: "github", owner, repo, ...flags };
    if (token) body.token = token;
    const response = await this.#request("POST", `/projects/${projectId}/import/json`, {
      json: body,
      headers: { "Idempotency-Key": idempotencyKey },
      timeout: timeout ?? DEFAULT_IMPORT_TIMEOUT,
    });
    return response.json();
  }
}
