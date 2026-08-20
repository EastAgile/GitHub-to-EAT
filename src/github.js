/**
 * Client-side GitHub REST fetcher for the direct engine.
 *
 * Pulls a repo's issues, their comments, and labels from the repo-wide list
 * endpoints (`per_page=100`, `Link`-header pagination), which keeps a mid-sized flat
 * repo inside the anonymous 60 req/h budget; a token (`--token` / `GITHUB_TOKEN`)
 * lifts the ceiling to 5000/h and reaches private repos. Two stages are per-issue: the
 * sub-issue listing, charged only to rows that advertise one, and — under
 * `--include deps` — the dependency listing, which has no rollup to gate on and so
 * bills every issue, making it the dominant budget term. Both degrade rather than
 * failing the run; the dependency stage refuses up front when the observed budget
 * cannot cover it. Zero runtime deps: global `fetch` only.
 */

import { scrubControl } from "./progress.js";

export const GITHUB_API_BASE = "https://api.github.com";

const UNEXPECTED_PAYLOAD = "GitHub returned an unexpected payload (expected a JSON array)";

// `Link` following is otherwise unbounded, and this stage runs once per parent:
// 2000 sub-issues is far past any real hierarchy, so more means a broken server.
export const MAX_SUB_ISSUE_PAGES = 20;
// The server importer's own release cap (github.rs MAX_PAGES), so no repo it
// accepts is refused here. Exported so the bound is testable without guessing.
export const MAX_RELEASE_PAGES = 200;
// github.rs MAX_DEPENDENCY_PAGES, for the same reason as the sub-issue bound.
export const MAX_DEPENDENCY_PAGES = 20;
// The issue-dependencies routes ship under their own REST API version and 415
// under the 2022-11-28 default the rest of this surface sends (github.rs).
export const DEPENDENCIES_API_VERSION = "2026-03-10";
// A repo-wide failure would otherwise render one line per advertised parent.
const MAX_NAMED_FAILURES = 10;
// A partition would otherwise cost one doomed request per issue, each armed with
// the full per-request timeout — hours under a spinner on a large repo.
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 3;

/** Base class for GitHub fetcher errors (kept distinct from the EAT errors). */
export class GitHubError extends Error {
  /** @type {number | undefined} the HTTP status behind it, when a response caused it */
  status;
}

/** A request never reached a response: connection failure, reset, or timeout. */
export class GitHubTransportError extends GitHubError {}

/** The repo does not exist, or the token can't see it (HTTP 404). */
export class RepoNotFoundError extends GitHubError {}

/** A rate limit was hit (HTTP 429, or 403 from the primary/secondary limit). */
export class RateLimitError extends GitHubError {}

/** The supplied token was rejected (HTTP 401). */
export class GitHubAuthError extends GitHubError {}

/** An anonymous run cannot afford an opt-in per-issue stage (`--include deps`). */
export class RateBudgetError extends GitHubError {}

/**
 * The repo-not-found error, worded once: both transports must name a missing
 * repo identically, and GraphQL reaches it without an HTTP 404.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {RepoNotFoundError}
 */
export function repoNotFound(owner, repo) {
  const notFound = new RepoNotFoundError(
    `repo ${owner}/${repo} not found (private, renamed, or no access with this token)`,
  );
  // Callers branch on `.status === 404` (see #listBlockedBy's route detection), so
  // the shape must not depend on whether an HTTP 404 or a GraphQL error raised it.
  notFound.status = 404;
  return notFound;
}

/**
 * Map a transport-level rejection to the right GitHubError. The abort clock stays armed
 * while the body streams, so the request and body-read phases must say the same thing.
 *
 * @param {unknown} err
 * @param {number} timeout per-request timeout in seconds, for the message
 * @returns {GitHubError}
 */
export function transportError(err, timeout) {
  const e = /** @type {{ name?: string, message?: string, cause?: { message?: string } }} */ (err);
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return new GitHubTransportError(`GitHub request timed out after ${Math.round(timeout)}s`);
  }
  return new GitHubTransportError(
    `could not reach GitHub: ${e?.cause?.message ?? e?.message ?? err}`,
  );
}

/**
 * GitHub's error statuses → the typed hierarchy, shared by the REST and GraphQL
 * transports so a 404 or a limit reads the same however it was requested.
 *
 * @param {Response} response
 * @param {{ owner: string, repo: string }} target
 * @returns {Promise<GitHubError | null>} null when the status is not an error
 */
export async function statusError(response, { owner, repo }) {
  if (response.status === 404) return repoNotFound(owner, repo);
  // Rate limits arrive as 429, primary-limit 403 (remaining 0), or
  // secondary-limit 403 (retry-after with budget left).
  const retryAfter = response.headers.get("retry-after");
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" || retryAfter !== null))
  ) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    let resets = "resets later";
    // retry-after is the authoritative wait when present (secondary limits);
    // x-ratelimit-reset only describes the primary hourly window.
    if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
      resets = `resets in ${Number(retryAfter)}s`;
    } else if (Number.isFinite(reset) && reset > 0) {
      // An absurd reset is past Date's range, where toISOString throws: keep the
      // typed RateLimitError rather than crashing on a header.
      const at = new Date(reset * 1000);
      if (!Number.isNaN(at.getTime())) resets = `resets at ${at.toISOString()}`;
    }
    return new RateLimitError(
      `GitHub rate limit exhausted; ${resets}. Pass --token / GITHUB_TOKEN to raise the limit (5000/h).`,
    );
  }
  if (response.status === 401) {
    return new GitHubAuthError("GitHub token rejected (401) — check --token / GITHUB_TOKEN");
  }
  if (response.status >= 400) {
    // An unreadable or hostile error body must not upgrade a clean HTTP error
    // into a crash, nor reach the terminal with control characters intact.
    const text = await response.text().catch(() => "");
    const failed = new GitHubError(
      `GitHub request failed (${response.status}): ${scrubControl(text)}`,
    );
    failed.status = response.status;
    return failed;
  }
  return null;
}

/**
 * Extract the `rel="next"` URL from a `Link` response header, if present.
 *
 * @param {string | null} link
 * @returns {string | null}
 */
function nextLink(link) {
  if (!link) return null;
  // RFC 8288 link targets may carry commas inside <…>; only a comma that
  // precedes the next `<` actually separates two link-values.
  for (const part of link.split(/,\s*(?=<)/)) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Whether a listing row advertises sub-issues. Only a positive numeric total earns
 * the extra request, so a flat repo pays nothing.
 *
 * @param {any} issue
 * @returns {boolean}
 */
function hasSubIssues(issue) {
  const total = issue?.sub_issues_summary?.total;
  return typeof total === "number" && total > 0;
}

/**
 * A row's issue number as an external id, or null for anything that is not a
 * positive integer — only digits ever reach a story description.
 *
 * @param {any} row
 * @returns {string | null}
 */
function issueNumberFromRow(row) {
  const value = row?.number;
  return Number.isInteger(value) && value > 0 ? String(value) : null;
}

/** Fetcher for one GitHub repo's issues, comments, labels, and sub-issue links. */
export class GitHubClient {
  /** @type {Record<string, string>} */
  #headers;

  /** @type {(message: string) => void} */
  #warn;

  /** @type {boolean} a token was supplied, so the budget is 5000/h, not 60/h */
  #authenticated;

  /** @type {number | null} `x-ratelimit-remaining` from the newest response */
  #remaining = null;

  /** @type {number} dependency requests issued this run (reported by the dry run) */
  #dependencyRequests = 0;

  /**
   * @param {string} owner
   * @param {string} repo
   * @param {{ token?: string, timeout?: number, apiBase?: string,
   *   warn?: (message: string) => void }} [options]
   *   `timeout` is per-request, in seconds (default 30); `warn` defaults to stderr, so a
   *   construction site that forgets it cannot swallow a degraded fetch in silence.
   */
  constructor(owner, repo, { token, timeout = 30, apiBase = GITHUB_API_BASE, warn } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.timeout = timeout;
    this.#warn = warn ?? ((message) => void process.stderr.write(message));
    this.#authenticated = Boolean(token);
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.#headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects requests without a User-Agent.
      "User-Agent": "github-to-eat",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  /**
   * @param {unknown} err
   * @returns {GitHubError}
   */
  #transportError(err) {
    return transportError(err, this.timeout);
  }

  /**
   * GET one absolute URL, mapping GitHub's error statuses to the error hierarchy.
   *
   * @param {string} url
   * @param {Record<string, string>} [extraHeaders] per-request header overrides
   * @returns {Promise<Response>}
   */
  async #get(url, extraHeaders) {
    let response;
    try {
      response = await fetch(url, {
        headers: extraHeaders ? { ...this.#headers, ...extraHeaders } : this.#headers,
        signal: AbortSignal.timeout(this.timeout * 1000),
      });
    } catch (err) {
      throw this.#transportError(err);
    }
    // Tracked so an opt-in per-issue stage can price itself before spending. The
    // null guard matters: `Number(null)` is 0, i.e. a missing header reads as exhausted.
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining !== null && Number.isFinite(Number(remaining))) {
      this.#remaining = Number(remaining);
    }

    const failed = await statusError(response, { owner: this.owner, repo: this.repo });
    if (failed) throw failed;
    return response;
  }

  /**
   * Follow `Link` pagination from `path`, concatenating every JSON array page.
   *
   * @param {string} path repo-relative path with query (e.g. `/issues?state=all`)
   * @param {{ maxPages?: number, headers?: Record<string, string>, onPage?: () => void,
   *   truncateAtCap?: boolean }} [options] `maxPages` refuses to follow `Link` past that
   *   many pages; `onPage` is called once per request, so a stage can price itself;
   *   `truncateAtCap` returns the pages already collected instead of throwing there
   * @returns {Promise<any[]>}
   */
  async #paginate(
    path,
    { maxPages = Number.POSITIVE_INFINITY, headers, onPage, truncateAtCap = false } = {},
  ) {
    /** @type {any[]} */
    const out = [];
    let pages = 0;
    let url = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`;
    while (url) {
      pages += 1;
      onPage?.();
      const response = await this.#get(url, headers);
      /** @type {unknown} */
      let page;
      try {
        page = await response.json();
      } catch (err) {
        // Only a parse failure is a payload problem: a timeout or reset lands here
        // too, and must keep the transport wording its --token/network hints carry.
        if (!(err instanceof SyntaxError)) throw this.#transportError(err);
        throw new GitHubError(UNEXPECTED_PAYLOAD, { cause: err });
      }
      if (!Array.isArray(page)) {
        throw new GitHubError(UNEXPECTED_PAYLOAD);
      }
      out.push(...page);
      const next = nextLink(response.headers.get("link"));
      if (next && !URL.canParse(next)) {
        throw new GitHubError(
          "GitHub pagination sent an unparseable rel=next URL; refusing to follow it",
        );
      }
      // The Authorization header rides along on every request — never follow
      // a rel=next off the API origin.
      if (next && new URL(next).origin !== new URL(this.apiBase).origin) {
        throw new GitHubError(
          `GitHub pagination pointed off the API origin (${new URL(next).origin}); refusing to follow it`,
        );
      }
      if (next && pages >= maxPages) {
        if (truncateAtCap) break;
        throw new GitHubError(
          `GitHub kept paginating ${path.split("?")[0]} past ${maxPages} pages; refusing to follow further`,
        );
      }
      url = next ?? "";
    }
    return out;
  }

  /**
   * List the repo's issues (`state=all`). The `/issues` endpoint mixes PRs in, tagged with a
   * `pull_request` key whose `merged_at` means no per-PR fetch is ever needed to read merge state.
   *
   * @param {{ pullRequests?: boolean }} [options]
   * @returns {Promise<any[]>}
   */
  async listIssues({ pullRequests = false } = {}) {
    const issues = await this.#paginate("/issues?state=all&per_page=100");
    return pullRequests ? issues : issues.filter((item) => !item.pull_request);
  }

  /**
   * List every issue comment in the repo (repo-wide endpoint).
   *
   * @returns {Promise<any[]>}
   */
  async listComments() {
    return this.#paginate("/issues/comments?per_page=100");
  }

  /**
   * List the repo's labels.
   *
   * @returns {Promise<any[]>}
   */
  async listLabels() {
    return this.#paginate("/labels?per_page=100");
  }

  /**
   * List the repo's releases (`GET /releases`), drafts included.
   *
   * @returns {Promise<any[]>}
   */
  async listReleases() {
    return this.#paginate("/releases?per_page=100", { maxPages: MAX_RELEASE_PAGES });
  }

  /**
   * List one issue's sub-issues (`GET /issues/{n}/sub_issues`).
   *
   * @param {string} number
   * @returns {Promise<any[]>}
   */
  async #listSubIssues(number) {
    return this.#paginate(`/issues/${encodeURIComponent(number)}/sub_issues?per_page=100`, {
      maxPages: MAX_SUB_ISSUE_PAGES,
    });
  }

  /**
   * Report what a degraded sub-issue stage cost, in one line however many parents failed.
   *
   * @param {string[]} failed parents whose listing 404d
   * @param {RateLimitError | null} limited the limit that stopped the stage, if any
   */
  #warnSubIssueLoss(failed, limited) {
    if (failed.length === 1) {
      this.#warn(
        `warning: could not list issue #${failed[0]}'s sub-issues (404) — issue #${failed[0]} is ` +
          `imported without its 'Sub-issues:' line, and every sub-issue of it without its ` +
          `'Sub-issue of #${failed[0]}' line.\n`,
      );
    } else if (failed.length > 1) {
      const named = failed
        .slice(0, MAX_NAMED_FAILURES)
        .map((n) => `#${n}`)
        .join(", ");
      const rest = failed.length - MAX_NAMED_FAILURES;
      this.#warn(
        `warning: could not list sub-issues for ${failed.length} issues (404): ${named}` +
          `${rest > 0 ? `, and ${rest} more` : ""} — those stories are imported without their ` +
          "'Sub-issues:' line, and their sub-issues without a 'Sub-issue of #n' line. " +
          "A failure this wide usually means the host or org has sub-issues turned off.\n",
      );
    }
    if (limited) {
      this.#warn(
        `warning: ${limited.message} Sub-issue cross-links stop here; the rest of the import ` +
          "continues without them, and an import never updates a story it already created.\n",
      );
    }
  }

  /**
   * Parent issue number → its sub-issues' numbers, in GitHub's own order. Sequential and
   * total-gated: one request per parent, none on a flat repo, no secondary-limit burst.
   *
   * @param {any[]} issues
   * @returns {Promise<Map<string, string[]>>}
   */
  async #fetchSubIssues(issues) {
    /** @type {Map<string, string[]>} */
    const subIssues = new Map();
    /** @type {string[]} */
    const failed = [];
    /** @type {RateLimitError | null} */
    let limited = null;
    for (const issue of issues) {
      const parent = hasSubIssues(issue) ? issueNumberFromRow(issue) : null;
      if (parent === null) continue;
      /** @type {any[]} */
      let rows;
      try {
        rows = await this.#listSubIssues(parent);
      } catch (err) {
        // Optional stage, running last with the whole import in memory: neither a mid-fetch
        // deletion nor a limit it provoked itself may throw that away. Other errors still do.
        if (err instanceof RateLimitError) {
          limited = err;
          break;
        }
        if (!(err instanceof RepoNotFoundError)) throw err;
        failed.push(parent);
        continue;
      }
      /** @type {string[]} */
      const kept = [];
      for (const row of rows) {
        const kid = issueNumberFromRow(row);
        if (kid !== null && kid !== parent && !kept.includes(kid)) kept.push(kid);
      }
      if (kept.length) subIssues.set(parent, kept);
    }
    this.#warnSubIssueLoss(failed, limited);
    return subIssues;
  }

  /**
   * List one issue's blockers (`GET /issues/{n}/dependencies/blocked_by`).
   *
   * @param {string} number
   * @returns {Promise<any[]>}
   */
  async #listBlockedBy(number) {
    return this.#paginate(
      `/issues/${encodeURIComponent(number)}/dependencies/blocked_by?per_page=100`,
      {
        maxPages: MAX_DEPENDENCY_PAGES,
        headers: { "X-GitHub-Api-Version": DEPENDENCIES_API_VERSION },
        // Counted per page, not per issue: an issue past 100 dependencies costs
        // more than one request, and the dry run must not understate the budget.
        onPage: () => {
          this.#dependencyRequests += 1;
        },
        // github.rs `list_blocked_by` breaks at the cap and keeps the rows it has;
        // throwing here would cost that issue every blocker already fetched.
        truncateAtCap: true,
      },
    );
  }

  /**
   * Refuse the stage before it spends a request, rather than dying partway with half a
   * repo's blockers written. Gated on the budget actually observed, not on auth: a
   * near-ceiling PAT is exactly the case this exists to catch. A headerless host cannot be gated.
   *
   * @param {number} cost a lower bound — one request per issue, more where a listing paginates
   */
  #assertBudgetFor(cost) {
    if (this.#remaining === null || this.#remaining >= cost) return;
    throw new RateBudgetError(
      `--include deps needs at least ${cost} more GitHub request(s) (at least one per issue) ` +
        `and this run has ${this.#remaining} left of GitHub's rate limit. ` +
        (this.#authenticated
          ? "Wait for the limit to reset, or drop deps from --include."
          : "Pass --token / GITHUB_TOKEN to raise the limit (5000/h), or drop deps from --include."),
    );
  }

  /**
   * Issue number → its `blocked_by` rows, in GitHub's own order. Enrichment-only, like
   * github.rs `fetch_blocked_by_for_issues`: a failure costs that issue its blockers, never the run.
   *
   * @param {any[]} issues
   * @returns {Promise<Map<string, any[]>>}
   */
  async #fetchBlockedBy(issues) {
    const numbers = /** @type {string[]} */ (
      issues.map(issueNumberFromRow).filter((n) => n !== null)
    );
    this.#assertBudgetFor(numbers.length);
    /** @type {Map<string, any[]>} */
    const blockedBy = new Map();
    /** @type {string[]} */
    const failed = [];
    /** @type {GitHubError | null} */
    let firstFailure = null;
    // Only a route-level refusal is evidence about the route; anything else must not
    // be reported as one.
    let allRouteRefusals = true;
    /** @type {GitHubError | null} */
    let stopped = null;
    let consecutiveTransport = 0;
    for (const number of numbers) {
      /** @type {any[]} */
      let rows;
      try {
        rows = await this.#listBlockedBy(number);
      } catch (err) {
        // A revoked token is not a degraded stage: every later write would fail too,
        // and reporting it as a missing route would send the reader after the wrong thing.
        if (err instanceof GitHubAuthError) throw err;
        if (!(err instanceof GitHubError)) throw err;
        // A limit stops the stage — every remaining listing would fail the same way.
        if (err instanceof RateLimitError) {
          stopped = err;
          break;
        }
        failed.push(number);
        firstFailure ??= err;
        if (err.status !== 404 && err.status !== 415) allRouteRefusals = false;
        if (err instanceof GitHubTransportError) {
          consecutiveTransport += 1;
          if (consecutiveTransport >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
            stopped = err;
            break;
          }
        } else {
          consecutiveTransport = 0;
        }
        continue;
      }
      consecutiveTransport = 0;
      if (rows.length) blockedBy.set(number, rows);
    }
    this.#warnBlockedByLoss(failed, { firstFailure, allRouteRefusals, stopped });
    return blockedBy;
  }

  /**
   * Report what a degraded dependency stage cost, in one line however many issues failed.
   *
   * @param {string[]} failed issues whose listing could not be read
   * @param {{ firstFailure: GitHubError | null, allRouteRefusals: boolean,
   *   stopped: GitHubError | null }} context `stopped` is the limit or outage that ended
   *   the stage early; the API-version hint rides only on `allRouteRefusals`
   */
  #warnBlockedByLoss(failed, { firstFailure, allRouteRefusals, stopped }) {
    const cause = firstFailure ? ` (${firstFailure.message})` : "";
    if (failed.length === 1) {
      this.#warn(
        `warning: could not list issue #${failed[0]}'s dependencies${cause} — issue #${failed[0]} ` +
          "is imported without its 'Blocked by #n' blockers.\n",
      );
    } else if (failed.length > 1) {
      const named = failed
        .slice(0, MAX_NAMED_FAILURES)
        .map((n) => `#${n}`)
        .join(", ");
      const rest = failed.length - MAX_NAMED_FAILURES;
      this.#warn(
        `warning: could not list dependencies for ${failed.length} issues: ${named}` +
          `${rest > 0 ? `, and ${rest} more` : ""} — those stories are imported without their ` +
          `'Blocked by #n' blockers. First failure${cause || ": unknown"}.` +
          (allRouteRefusals
            ? " A failure this wide usually means the host does not serve the " +
              `issue-dependencies API (version ${DEPENDENCIES_API_VERSION}).`
            : "") +
          "\n",
      );
    }
    if (stopped) {
      this.#warn(
        `warning: ${stopped.message} Dependency blockers stop here; the rest of the import ` +
          "continues without them, and an import never updates a story it already created.\n",
      );
    }
  }

  /**
   * Fetch issues, comments, labels and the sub-issue hierarchy in one call, plus the
   * releases (`--include releases`) and each issue's blockers (`--include deps`).
   *
   * The repo-wide comments endpoint includes PR conversation comments; only comments on
   * kept rows survive, so PR chatter reaches mapping exactly when its PR does.
   *
   * @param {{ releases?: boolean, pullRequests?: boolean, dependencies?: boolean }} [options]
   *   `releases` adds the releases listing (`--include releases`) and `dependencies` the
   *   per-issue `blocked_by` listings (`--include deps`); off, neither endpoint is
   *   requested. `pullRequests` (`--include prs`) keeps the PR rows the issues listing
   *   mixes in
   * @returns {Promise<{ issues: any[], comments: any[], labels: any[],
   *   subIssues: Map<string, string[]>, releases: any[],
   *   blockedBy: Map<string, any[]>, dependencyRequests: number }>}
   */
  async fetchAll({ releases = false, pullRequests = false, dependencies = false } = {}) {
    const [issues, comments, labels, releaseRows] = await Promise.all([
      this.listIssues({ pullRequests }),
      this.listComments(),
      this.listLabels(),
      releases ? this.listReleases() : [],
    ]);
    const kept = new Set(issues.map((issue) => String(issue.number)));
    return {
      issues,
      comments: comments.filter((comment) => {
        const match = (comment.issue_url ?? "").match(/\/issues\/(\d+)$/);
        return match !== null && kept.has(match[1]);
      }),
      labels,
      subIssues: await this.#fetchSubIssues(issues),
      releases: releaseRows,
      blockedBy: dependencies ? await this.#fetchBlockedBy(issues) : new Map(),
      dependencyRequests: this.#dependencyRequests,
    };
  }
}
