/**
 * Client-side GitHub REST fetcher for the direct engine.
 *
 * Pulls a repo's issues, their comments, and labels from the repo-wide list
 * endpoints (`per_page=100`, `Link`-header pagination), which keeps a mid-sized flat
 * repo inside the anonymous 60 req/h budget; a token (`--token` / `GITHUB_TOKEN`)
 * lifts the ceiling to 5000/h and reaches private repos. The one per-issue call is the
 * sub-issue listing, charged only to rows that advertise one — a hierarchy-heavy repo
 * is the term that can push a run past the anonymous budget, so that stage degrades
 * rather than failing the run. Zero runtime deps: global `fetch` only.
 */

import { scrubControl } from "./progress.js";

export const GITHUB_API_BASE = "https://api.github.com";

const UNEXPECTED_PAYLOAD = "GitHub returned an unexpected payload (expected a JSON array)";

// `Link` following is otherwise unbounded, and this stage runs once per parent:
// 2000 sub-issues is far past any real hierarchy, so more means a broken server.
const MAX_SUB_ISSUE_PAGES = 20;
// The server importer's own release cap (github.rs MAX_PAGES), so no repo it
// accepts is refused here. Exported so the bound is testable without guessing.
export const MAX_RELEASE_PAGES = 200;
// A repo-wide failure would otherwise render one line per advertised parent.
const MAX_NAMED_FAILURES = 10;

/** Base class for GitHub fetcher errors (kept distinct from the EAT errors). */
export class GitHubError extends Error {}

/** The repo does not exist, or the token can't see it (HTTP 404). */
export class RepoNotFoundError extends GitHubError {}

/** A rate limit was hit (HTTP 429, or 403 from the primary/secondary limit). */
export class RateLimitError extends GitHubError {}

/** The supplied token was rejected (HTTP 401). */
export class GitHubAuthError extends GitHubError {}

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
   * Map a transport-level rejection to the right GitHubError.
   *
   * Shared by the request and the body-read phases — the abort clock stays armed
   * while the body streams, so both can fail the same way and must say the same thing.
   *
   * @param {unknown} err
   * @returns {GitHubError}
   */
  #transportError(err) {
    const e = /** @type {{ name?: string, message?: string, cause?: { message?: string } }} */ (
      err
    );
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      return new GitHubError(`GitHub request timed out after ${Math.round(this.timeout)}s`);
    }
    return new GitHubError(`could not reach GitHub: ${e?.cause?.message ?? e?.message ?? err}`);
  }

  /**
   * GET one absolute URL, mapping GitHub's error statuses to the error hierarchy.
   *
   * @param {string} url
   * @returns {Promise<Response>}
   */
  async #get(url) {
    let response;
    try {
      response = await fetch(url, {
        headers: this.#headers,
        signal: AbortSignal.timeout(this.timeout * 1000),
      });
    } catch (err) {
      throw this.#transportError(err);
    }

    if (response.status === 404) {
      throw new RepoNotFoundError(
        `repo ${this.owner}/${this.repo} not found (private, renamed, or no access with this token)`,
      );
    }
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
        resets = `resets at ${new Date(reset * 1000).toISOString()}`;
      }
      throw new RateLimitError(
        `GitHub rate limit exhausted; ${resets}. Pass --token / GITHUB_TOKEN to raise the limit (5000/h).`,
      );
    }
    if (response.status === 401) {
      throw new GitHubAuthError("GitHub token rejected (401) — check --token / GITHUB_TOKEN");
    }
    if (response.status >= 400) {
      // An unreadable or hostile error body must not upgrade a clean HTTP error
      // into a crash, nor reach the terminal with control characters intact.
      const text = await response.text().catch(() => "");
      throw new GitHubError(`GitHub request failed (${response.status}): ${scrubControl(text)}`);
    }
    return response;
  }

  /**
   * Follow `Link` pagination from `path`, concatenating every JSON array page.
   *
   * @param {string} path repo-relative path with query (e.g. `/issues?state=all`)
   * @param {number} [maxPages] refuse to follow `Link` past this many pages
   * @returns {Promise<any[]>}
   */
  async #paginate(path, maxPages = Number.POSITIVE_INFINITY) {
    /** @type {any[]} */
    const out = [];
    let pages = 0;
    let url = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`;
    while (url) {
      pages += 1;
      const response = await this.#get(url);
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
    return this.#paginate("/releases?per_page=100", MAX_RELEASE_PAGES);
  }

  /**
   * List one issue's sub-issues (`GET /issues/{n}/sub_issues`).
   *
   * @param {string} number
   * @returns {Promise<any[]>}
   */
  async #listSubIssues(number) {
    return this.#paginate(
      `/issues/${encodeURIComponent(number)}/sub_issues?per_page=100`,
      MAX_SUB_ISSUE_PAGES,
    );
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
   * Fetch issues, comments, labels, and the sub-issue hierarchy in one call.
   *
   * The repo-wide comments endpoint includes PR conversation comments; only comments on
   * kept rows survive, so PR chatter reaches mapping exactly when its PR does.
   *
   * @param {{ releases?: boolean, pullRequests?: boolean }} [options] `releases` adds the
   *   releases listing (`--include releases`); off, that endpoint is never requested.
   *   `pullRequests` (`--include prs`) keeps the PR rows the issues listing mixes in
   * @returns {Promise<{ issues: any[], comments: any[], labels: any[],
   *   subIssues: Map<string, string[]>, releases: any[] }>}
   */
  async fetchAll({ releases = false, pullRequests = false } = {}) {
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
    };
  }
}
