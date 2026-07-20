/**
 * Client-side GitHub REST fetcher for the direct engine.
 *
 * Pulls a repo's issues, their comments, and labels from the repo-wide list
 * endpoints (`per_page=100`, `Link`-header pagination) so a mid-sized repo stays
 * inside the anonymous 60 req/h budget; a token (`--token` / `GITHUB_TOKEN`)
 * lifts the ceiling to 5000/h and reaches private repos. Zero runtime deps:
 * global `fetch` only.
 */

export const GITHUB_API_BASE = "https://api.github.com";

/** Base class for GitHub fetcher errors (kept distinct from the EAT errors). */
export class GitHubError extends Error {}

/** The repo does not exist, or the token can't see it (HTTP 404). */
export class RepoNotFoundError extends GitHubError {}

/** The request's rate-limit budget is exhausted (HTTP 403, remaining 0). */
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
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/** Fetcher for one GitHub repo's issues, comments, and labels. */
export class GitHubClient {
  /** @type {Record<string, string>} */
  #headers;

  /**
   * @param {string} owner
   * @param {string} repo
   * @param {{ token?: string, timeout?: number, apiBase?: string }} [options]
   *   `timeout` is per-request, in seconds (default 30).
   */
  constructor(owner, repo, { token, timeout = 30, apiBase = GITHUB_API_BASE } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.timeout = timeout;
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
      const e = /** @type {{ name?: string, message?: string, cause?: { message?: string } }} */ (
        err
      );
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new GitHubError(`GitHub request timed out after ${Math.round(this.timeout)}s`);
      }
      throw new GitHubError(`could not reach GitHub: ${e?.cause?.message ?? e?.message ?? err}`);
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
      if (Number.isFinite(reset) && reset > 0) {
        resets = `resets at ${new Date(reset * 1000).toISOString()}`;
      } else if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
        resets = `resets in ${Number(retryAfter)}s`;
      }
      throw new RateLimitError(
        `GitHub rate limit exhausted; ${resets}. Pass --token / GITHUB_TOKEN to raise the limit (5000/h).`,
      );
    }
    if (response.status === 401) {
      throw new GitHubAuthError("GitHub token rejected (401) — check --token / GITHUB_TOKEN");
    }
    if (response.status >= 400) {
      const text = await response.text();
      throw new GitHubError(`GitHub request failed (${response.status}): ${text.slice(0, 200)}`);
    }
    return response;
  }

  /**
   * Follow `Link` pagination from `path`, concatenating every JSON array page.
   *
   * @param {string} path repo-relative path with query (e.g. `/issues?state=all`)
   * @returns {Promise<any[]>}
   */
  async #paginate(path) {
    /** @type {any[]} */
    const out = [];
    let url = `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`;
    while (url) {
      const response = await this.#get(url);
      const page = await response.json();
      if (!Array.isArray(page)) {
        throw new GitHubError(`GitHub returned an unexpected payload (expected a JSON array)`);
      }
      out.push(...page);
      const next = nextLink(response.headers.get("link"));
      // The Authorization header rides along on every request — never follow
      // a rel=next off the API origin.
      if (next && new URL(next).origin !== new URL(this.apiBase).origin) {
        throw new GitHubError(
          `GitHub pagination pointed off the API origin (${new URL(next).origin}); refusing to follow it`,
        );
      }
      url = next ?? "";
    }
    return out;
  }

  /**
   * List the repo's issues (`state=all`), dropping pull requests — the GitHub
   * `/issues` endpoint mixes PRs in, tagged with a `pull_request` key.
   *
   * @returns {Promise<any[]>}
   */
  async listIssues() {
    const issues = await this.#paginate("/issues?state=all&per_page=100");
    return issues.filter((item) => !item.pull_request);
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
   * Fetch issues, comments, and labels in one call.
   *
   * The repo-wide comments endpoint includes PR conversation comments; only
   * comments on kept issues survive, so mapping never sees PR chatter.
   *
   * @returns {Promise<{ issues: any[], comments: any[], labels: any[] }>}
   */
  async fetchAll() {
    const [issues, comments, labels] = await Promise.all([
      this.listIssues(),
      this.listComments(),
      this.listLabels(),
    ]);
    const kept = new Set(issues.map((issue) => String(issue.number)));
    return {
      issues,
      comments: comments.filter((comment) => {
        const match = (comment.issue_url ?? "").match(/\/issues\/(\d+)$/);
        return match !== null && kept.has(match[1]);
      }),
      labels,
    };
  }
}
