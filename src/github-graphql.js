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

/** Shared with the listing module, so both layers word a malformed payload alike. */
export const UNEXPECTED_SHAPE = "GitHub returned an unexpected response shape";

// GraphQL bills a 5000-point/hour budget scored on nodes returned, a separate
// bucket from the REST request budget — a run this low is about to die mid-fetch.
const LOW_POINT_BUDGET = 100;

// github.rs exempts any type on a scoped path because its ladder retries without the
// field; with no ladder, absorbing a spent budget diagnoses it as a scope problem.
const REFUSAL_TYPES = new Set(["FORBIDDEN", "INSUFFICIENT_SCOPES"]);

/**
 * Whether one error's GraphQL `path` names `field` (github.rs matches the same `path`).
 * A path that is not a list names nothing: a string one would match on any substring.
 *
 * @param {any} error
 * @param {string} field
 * @returns {boolean}
 */
function errorNames(error, field) {
  return Array.isArray(error?.path) && error.path.includes(field);
}

/**
 * Whether one error is a refusal of `field` alone — the enrichment loss the caller
 * absorbs, rather than a fatal that merely landed on the field's path.
 *
 * @param {any} error
 * @param {string} field
 * @returns {boolean}
 */
function refusesField(error, field) {
  if (!errorNames(error, field)) return false;
  // An absent or unreadable `type` is how GitHub answers most scope refusals, and it
  // is what `#classify` itself reads as "no type"; both must agree on the same test.
  const kind = typeof error?.type === "string" ? error.type : "";
  return kind === "" || REFUSAL_TYPES.has(kind.toUpperCase());
}

/**
 * What the host said when it refused the field, scrubbed for a terminal.
 *
 * @param {any[]} scoped
 * @returns {string}
 */
function refusalMessage(scoped) {
  return scrubControl(typeof scoped[0]?.message === "string" ? scoped[0].message : "");
}

/** One GraphQL POST against a repo, with the envelope classified onto GitHubError. */
export class GitHubGraphQLClient {
  /** @type {Record<string, string>} */
  #headers;

  /** @type {(message: string) => void} */
  #warn;

  /** @type {boolean} */
  #lowBudgetWarned = false;

  /**
   * @param {string} owner
   * @param {string} repo
   * @param {{ token?: string, timeout?: number, apiBase?: string,
   *   warn?: (message: string) => void }} [options]
   *   `timeout` is per-request, in seconds; `warn` defaults to stderr so a caller that
   *   forgets it cannot swallow a spent point budget in silence.
   */
  constructor(owner, repo, { token, timeout = 30, apiBase = GITHUB_API_BASE, warn } = {}) {
    // GitHub's GraphQL endpoint answers anonymous requests 401, so a tokenless
    // client can only buy a wasted round-trip: refuse it here (CONTRACT.md).
    if (!token) {
      throw new GitHubAuthError(
        "GitHub's GraphQL API has no anonymous mode — pass --token / GITHUB_TOKEN",
      );
    }
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
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Run one operation and resolve to its `data`.
   *
   * @param {string} operationName
   * @param {string} query
   * @param {Record<string, unknown>} variables
   * @param {{ enrichmentField?: string, onEnrichmentRefused?: (message: string) => void }}
   *   [enrichment] names one selection whose refusal costs that field alone, never the
   *   query — github.rs scopes `blockedBy` that way (its story #146020)
   * @returns {Promise<Record<string, any>>}
   */
  async query(operationName, query, variables, { enrichmentField, onEnrichmentRefused } = {}) {
    let response;
    try {
      response = await fetch(`${this.apiBase}${GRAPHQL_PATH}`, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify({ operationName, query, variables }),
        // A redirect target's envelope would be parsed as trusted GitHub data;
        // the REST path confines its own hops for the same reason.
        redirect: "error",
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
    // A non-array `errors` is a refusal this code cannot read; returning the
    // partial `data` as success would silently discard it.
    if ("errors" in envelope && !Array.isArray(envelope.errors)) {
      throw new GitHubError(`${UNEXPECTED_SHAPE} (the GraphQL envelope's errors were not a list)`);
    }
    /** @type {any[]} */
    const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
    // A refusal GitHub scopes to one enrichment field leaves the rest of the response
    // intact, so it must not decide the query the way a whole-response error does.
    const scoped =
      enrichmentField === undefined
        ? []
        : errors.filter((error) => refusesField(error, enrichmentField));
    // github.rs `classify_gql_errors` returns on the first scoped match, before it reads
    // `errors.first()`: a sibling never fails a query the server would have degraded.
    const classified = scoped.length > 0 ? null : this.#classify(errors);
    if (classified) throw classified;
    const data = envelope.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      // Without the host's own words the likeliest misconfiguration — a token that cannot
      // read the enrichment — reads to the user as a malformed payload.
      const said = refusalMessage(scoped);
      throw new GitHubError(
        `${UNEXPECTED_SHAPE} (the GraphQL envelope carried no data)${said ? ` — ${said}` : ""}`,
      );
    }
    if (scoped.length > 0) onEnrichmentRefused?.(refusalMessage(scoped));
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
    // Absent, null or "5" must not read as exhausted; `Number.isFinite` does not
    // coerce, so it rejects all three without a typeof guard.
    if (!Number.isFinite(remaining)) return;
    if (remaining > LOW_POINT_BUDGET) return;
    if (this.#lowBudgetWarned) return;
    this.#lowBudgetWarned = true;
    // Server text on the `\r`-redrawn progress stream: scrub and cap it, exactly
    // as the error paths do.
    const resetAt = scrubControl(rateLimit?.resetAt, 40) || "unknown";
    this.#warn(
      `warning: GitHub's GraphQL point budget is nearly exhausted — ${remaining} point(s) left, ` +
        `resets at ${resetAt}. A large repo may not finish; re-run after the reset.\n`,
    );
  }
}
