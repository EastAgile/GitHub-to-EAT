/**
 * GraphQL transport for the direct engine, mirroring the server's `graphql()` so both
 * engines classify a refusal identically. No SchemaLevel ladder — see CONTRACT.md.
 */

import {
  GITHUB_API_BASE,
  GitHubAuthError,
  GitHubError,
  RateLimitError,
  repoNotFound,
  statusError,
  transportError,
} from "./github.js";
import { scrubControl } from "./progress.js";

const GRAPHQL_PATH = "/graphql";

const UNEXPECTED_SHAPE = "GitHub returned an unexpected response shape";

// GraphQL bills a 5000-point/hour budget scored on nodes returned, a separate
// bucket from the REST request budget — a run this low is about to die mid-fetch.
const LOW_POINT_BUDGET = 100;

/** One GraphQL POST against a repo, with the envelope classified onto GitHubError. */
export class GitHubGraphQLClient {
  /** @type {Record<string, string>} */
  #headers;

  /** @type {(message: string) => void} */
  #warn;

  /**
   * @param {string} owner
   * @param {string} repo
   * @param {{ token?: string, timeout?: number, apiBase?: string,
   *   warn?: (message: string) => void }} [options]
   *   `timeout` is per-request, in seconds (default 30); `warn` defaults to stderr, so a
   *   construction site that forgets it cannot swallow a spent point budget in silence.
   */
  constructor(owner, repo, { token, timeout = 30, apiBase = GITHUB_API_BASE, warn } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.timeout = timeout;
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.#warn = warn ?? ((message) => void process.stderr.write(message));
    this.#headers = {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      // GitHub rejects requests without a User-Agent.
      "User-Agent": "github-to-eat",
      // The token rides this header only — never the query, the variables, an
      // error message, or a log line.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  /**
   * Run one operation and resolve to its `data`.
   *
   * @param {string} operationName
   * @param {string} query
   * @param {Record<string, unknown>} variables
   * @returns {Promise<Record<string, any>>}
   */
  async query(operationName, query, variables) {
    let response;
    try {
      response = await fetch(`${this.apiBase}${GRAPHQL_PATH}`, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify({ operationName, query, variables }),
        signal: AbortSignal.timeout(this.timeout * 1000),
      });
    } catch (err) {
      throw transportError(err, this.timeout);
    }
    const failed = await statusError(response, { owner: this.owner, repo: this.repo });
    if (failed) throw failed;

    /** @type {any} */
    let envelope;
    try {
      envelope = await response.json();
    } catch (err) {
      // Only a parse failure is a payload problem: a timeout or reset lands here
      // too, and must keep the transport wording its network hints carry.
      if (!(err instanceof SyntaxError)) throw transportError(err, this.timeout);
      throw new GitHubError(`${UNEXPECTED_SHAPE} (expected a GraphQL envelope)`, { cause: err });
    }
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new GitHubError(`${UNEXPECTED_SHAPE} (expected a GraphQL envelope)`);
    }
    const classified = this.#classify(Array.isArray(envelope.errors) ? envelope.errors : []);
    if (classified) throw classified;
    const data = envelope.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new GitHubError(`${UNEXPECTED_SHAPE} (the GraphQL envelope carried no data)`);
    }
    this.#observeRateLimit(data.rateLimit);
    // GraphQL's 404: the query itself resolved, the repository did not.
    if ("repository" in data && data.repository === null) {
      throw repoNotFound(this.owner, this.repo);
    }
    return data;
  }

  /**
   * The counterpart to the HTTP status mapping — it must produce the same typed
   * errors, since a 200 + `errors` is how GraphQL says 401/403/404/429.
   *
   * @param {any[]} errors
   * @returns {GitHubError | null}
   */
  #classify(errors) {
    const first = errors[0];
    if (first === undefined) return null;
    const kind = typeof first?.type === "string" ? first.type : "";
    const message = typeof first?.message === "string" ? first.message : "";
    switch (kind.toUpperCase()) {
      case "RATE_LIMITED":
        return new RateLimitError(
          "GitHub's GraphQL point budget is exhausted (5000 points/hour) — wait for the " +
            "window to reset (up to an hour) and re-run.",
        );
      case "NOT_FOUND":
        return repoNotFound(this.owner, this.repo);
      case "FORBIDDEN":
      case "INSUFFICIENT_SCOPES":
        return new GitHubAuthError(
          "GitHub refused the query — the token does not have permission to read issues in " +
            `${this.owner}/${this.repo}. Check the token's scopes and repository access.`,
        );
      case "UNAUTHORIZED":
      case "BAD_CREDENTIALS":
        return new GitHubAuthError("GitHub token rejected — check --token / GITHUB_TOKEN");
      default:
        // No SchemaLevel ladder here, so an `undefinedField` refusal lands in
        // this bucket rather than retrying one rung lower (CONTRACT.md).
        return new GitHubError(
          `GitHub GraphQL error: ${scrubControl(message || kind || "(no message)")}`,
        );
    }
  }

  /**
   * Warn once when the point budget is nearly spent; the REST request budget the
   * releases and dependency stages draw on is a different bucket entirely.
   *
   * @param {any} rateLimit the query's `rateLimit { remaining resetAt }`, when it asked for one
   */
  #observeRateLimit(rateLimit) {
    const remaining = rateLimit?.remaining;
    // A missing field must not read as exhausted (`Number(undefined)` is NaN, but
    // `Number(null)` is 0).
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) return;
    if (remaining > LOW_POINT_BUDGET) return;
    const resetAt = typeof rateLimit?.resetAt === "string" ? rateLimit.resetAt : "unknown";
    this.#warn(
      `warning: GitHub's GraphQL point budget is nearly exhausted — ${remaining} point(s) left, ` +
        `resets at ${resetAt}. A large repo may not finish; re-run after the reset.\n`,
    );
  }
}
