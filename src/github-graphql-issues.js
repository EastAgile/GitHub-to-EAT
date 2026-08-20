/**
 * The `ImportIssues` / `ImportPullRequests` listings, the follow-ups draining an overflowing
 * connection, and the rename layer keeping REST's names for `src/mapping.js`. Not wired: CONTRACT.md.
 */

import { GITHUB_API_BASE, GitHubError, RepoNotFoundError } from "./github.js";
import { GitHubGraphQLClient, UNEXPECTED_SHAPE } from "./github-graphql.js";

const PER_PAGE = 100;

/**
 * Runaway ceiling on a paginated listing (github.rs MAX_LISTING_PAGES). Hitting it
 * fails the fetch: the server's old 200-page cap truncated an import in silence.
 */
export const MAX_LISTING_PAGES = 50_000;

/**
 * Pages one parent's sub-issue walk may read, github.rs `MAX_SUB_ISSUE_PAGES` and the REST
 * path's own bound: 2000 children is far past any real hierarchy. Exported so tests need no guess.
 */
export const MAX_SUB_ISSUE_PAGES = 20;

// A repo-wide overflow would otherwise render one line per issue.
const MAX_NAMED_OVERFLOWS = 10;

/**
 * GitHub's numeric id for the `ghost` account REST substitutes for a deleted user.
 * GraphQL returns a null actor instead, so both transports attribute the row alike.
 */
export const GHOST_USER = Object.freeze({
  id: 10137,
  login: "ghost",
  html_url: "https://github.com/ghost",
});

/**
 * Every actor selection. `databaseId` is not on the `Actor` interface, so a `User`-only
 * fragment leaves a bot or organization with no id and mapping.js re-attributes its rows.
 */
export const ACTOR_SELECTION =
  "__typename login url " +
  "... on User { databaseId } " +
  "... on Bot { databaseId } " +
  "... on Organization { databaseId } " +
  "... on Mannequin { databaseId }";

/**
 * The comment sub-selection, shared by every node type (github.rs `comments_selection`).
 *
 * @returns {string}
 */
export function commentsSelection() {
  return (
    `comments(first: ${PER_PAGE}) { pageInfo { hasNextPage endCursor } ` +
    `nodes { body createdAt author { ${ACTOR_SELECTION} } } }`
  );
}

/**
 * The fields every issue-like node shares, split where each inserts its own state detail:
 * an issue's `stateReason`, a pull request's `mergedAt` (story #57633).
 *
 * @param {string} stateDetail the node type's own state-detail field, or "" for none
 * @param {string[]} extras sub-selections this node type adds
 * @returns {string}
 */
export function nodeSelection(stateDetail, extras) {
  return [
    "number title body state",
    stateDetail,
    "createdAt closedAt url",
    `author { ${ACTOR_SELECTION} }`,
    `assignees(first: ${PER_PAGE}) { nodes { login databaseId url } }`,
    `labels(first: ${PER_PAGE}) { nodes { name color } }`,
    "milestone { title dueOn state }",
    ...extras,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The issue node, at the server's `SchemaLevel::FULL` minus `blockedBy`: no degradation
 * ladder (CONTRACT.md), and the dependency connection is story #259658.
 *
 * @returns {string}
 */
export function issueNodeSelection() {
  return nodeSelection("stateReason", [
    "issueType { name }",
    commentsSelection(),
    `subIssues(first: ${PER_PAGE}) { pageInfo { hasNextPage endCursor } nodes { number } }`,
  ]);
}

/**
 * The pull-request node (github.rs `pull_request_node_selection`). A genuinely different
 * selection, not a toggled subset: a PR has no stateReason, issueType, subIssues or blockedBy.
 *
 * @returns {string}
 */
export function pullRequestNodeSelection() {
  return nodeSelection("mergedAt", [commentsSelection()]);
}

/**
 * `rateLimit` rides every listing query because GraphQL scores nodes returned, so the
 * REST-era `x-ratelimit-remaining` header no longer describes the spend.
 *
 * @returns {string}
 */
export function issuesQuery() {
  return (
    "query ImportIssues($owner: String!, $name: String!, $first: Int!, $after: String) { " +
    "rateLimit { remaining resetAt } " +
    "repository(owner: $owner, name: $name) { " +
    "issues(first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) { " +
    `totalCount pageInfo { hasNextPage endCursor } nodes { ${issueNodeSelection()} } } } }`
  );
}

/**
 * The pull-request listing (github.rs `pull_requests_query`), sent only under `--include prs`:
 * GraphQL gives PRs their own connection where REST's `/issues` interleaved them.
 *
 * @returns {string}
 */
export function pullRequestsQuery() {
  return (
    "query ImportPullRequests($owner: String!, $name: String!, $first: Int!, $after: String) { " +
    "rateLimit { remaining resetAt } " +
    "repository(owner: $owner, name: $name) { " +
    "pullRequests(first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) { " +
    `totalCount pageInfo { hasNextPage endCursor } nodes { ${pullRequestNodeSelection()} } } } }`
  );
}

/**
 * One issue's comments past the page its listing node carried (github.rs
 * `issue_comments_query`). A follow-up buys no `rateLimit` field, as the server's does not.
 *
 * @returns {string}
 */
export function issueCommentsQuery() {
  return (
    "query ImportIssueComments($owner: String!, $name: String!, $number: Int!, " +
    "$first: Int!, $after: String) { repository(owner: $owner, name: $name) { " +
    "issue(number: $number) { comments(first: $first, after: $after) { " +
    "pageInfo { hasNextPage endCursor } " +
    `nodes { body createdAt author { ${ACTOR_SELECTION} } } } } } }`
  );
}

/**
 * One PR's comments past its listing page. A PR needs its own query (server story #55748):
 * `Repository.issue(number:)` resolves issues only, and its NOT_FOUND aborts the whole run.
 *
 * @returns {string}
 */
export function pullRequestCommentsQuery() {
  return (
    "query ImportPullRequestComments($owner: String!, $name: String!, $number: Int!, " +
    "$first: Int!, $after: String) { repository(owner: $owner, name: $name) { " +
    "pullRequest(number: $number) { comments(first: $first, after: $after) { " +
    "pageInfo { hasNextPage endCursor } " +
    `nodes { body createdAt author { ${ACTOR_SELECTION} } } } } } }`
  );
}

/**
 * @typedef {{ noun: string, field: string, operation: string, query: () => string }} CommentParent
 */

/**
 * Which node a comment thread hangs off (github.rs `CommentParent`). GraphQL resolves the two
 * by different repository fields, and asking the wrong one is fatal (server story #55748).
 *
 * @type {{ issue: CommentParent, pullRequest: CommentParent }}
 */
export const COMMENT_PARENT = Object.freeze({
  issue: Object.freeze({
    noun: "issue",
    field: "issue",
    operation: "ImportIssueComments",
    query: issueCommentsQuery,
  }),
  pullRequest: Object.freeze({
    noun: "pull request",
    field: "pullRequest",
    operation: "ImportPullRequestComments",
    query: pullRequestCommentsQuery,
  }),
});

/**
 * One issue's sub-issues past the page its listing node carried (github.rs
 * `issue_sub_issues_query`).
 *
 * @returns {string}
 */
export function issueSubIssuesQuery() {
  return (
    "query ImportIssueSubIssues($owner: String!, $name: String!, $number: Int!, " +
    "$first: Int!, $after: String) { repository(owner: $owner, name: $name) { " +
    "issue(number: $number) { subIssues(first: $first, after: $after) { " +
    "pageInfo { hasNextPage endCursor } nodes { number } } } } }"
  );
}

/**
 * The repo's own label listing, which the server has no counterpart for: only mapping.js
 * reads a repo-wide colour authority, and an unused label reaches it from nowhere else.
 *
 * @returns {string}
 */
export function labelsQuery() {
  return (
    "query ImportLabels($owner: String!, $name: String!, $first: Int!, $after: String) { " +
    "rateLimit { remaining resetAt } " +
    "repository(owner: $owner, name: $name) { " +
    "labels(first: $first, after: $after) { pageInfo { hasNextPage endCursor } " +
    "nodes { name color } } } }"
  );
}

/**
 * A connection's readable nodes. GitHub nulls a node the token cannot see, and the
 * server drops those rather than failing the page.
 *
 * @param {any} connection
 * @returns {any[]}
 */
function connectionNodes(connection) {
  const nodes = connection?.nodes;
  return Array.isArray(nodes) ? nodes.filter((node) => node != null) : [];
}

/**
 * A node's issue number as a string, or null for anything that is not a positive integer
 * (`GitHubClient`'s `issueNumberFromRow`): only digits may key a row or reach a warning.
 *
 * @param {any} value
 * @returns {string | null}
 */
function issueNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function lower(value) {
  return String(value ?? "").toLowerCase();
}

/**
 * A GraphQL `Actor` as REST's user object: `databaseId` is REST's numeric `id` (the
 * rename-proof dedup key) and `url` is REST's `html_url`.
 *
 * @param {any} actor
 * @returns {{ id: number, login: string, html_url: string | null }}
 */
export function personFromActor(actor) {
  const login = String(actor?.login ?? "");
  // REST spells a bot's login with a `[bot]` suffix and GraphQL does not. The login is
  // the member-mapping key, so the two spellings are not interchangeable.
  const suffixed =
    actor?.__typename === "Bot" && !login.endsWith("[bot]") ? `${login}[bot]` : login;
  const id = actor?.databaseId;
  return {
    id: Number.isSafeInteger(id) ? id : 0,
    login: suffixed,
    html_url: typeof actor?.url === "string" ? actor.url : null,
  };
}

/**
 * The author of an issue or comment, as REST would have reported it.
 *
 * @param {any} actor
 * @returns {{ id: number, login: string, html_url: string | null }}
 */
function authorOrGhost(actor) {
  return actor == null ? { ...GHOST_USER } : personFromActor(actor);
}

/**
 * @param {any} milestone
 * @returns {{ title: string, due_on: string | null, state: string | null } | null}
 */
function milestoneRow(milestone) {
  if (milestone == null) return null;
  return {
    title: String(milestone.title ?? ""),
    due_on: milestone.dueOn ?? null,
    // GraphQL enums are SCREAMING_CASE; mapping.js was written against REST's lowercase.
    state: milestone.state == null ? null : lower(milestone.state),
  };
}

/**
 * Where a connection resumes: null when it is complete, "" when GitHub reported rows past
 * this page but sent no cursor, else the cursor. Sending "" back re-reads the same page.
 *
 * @param {any} connection
 * @returns {string | null}
 */
function nextCursor(connection) {
  if (connection?.pageInfo?.hasNextPage !== true) return null;
  const cursor = connection.pageInfo.endCursor;
  return typeof cursor === "string" && cursor !== "" ? cursor : "";
}

/**
 * One issue node as REST's issue row. No `pull_request` key: mapping.js reads that key to
 * tell an issue from a pull request.
 *
 * @param {any} node
 * @returns {any}
 */
function issueRow(node) {
  return {
    number: node.number,
    title: String(node.title ?? ""),
    body: node.body ?? null,
    state: lower(node.state),
    state_reason: node.stateReason == null ? null : lower(node.stateReason),
    labels: connectionNodes(node.labels).map((label) => ({
      name: label.name,
      color: label.color ?? null,
    })),
    milestone: milestoneRow(node.milestone),
    created_at: node.createdAt ?? null,
    closed_at: node.closedAt ?? null,
    html_url: node.url ?? null,
    assignees: connectionNodes(node.assignees).map(personFromActor),
    // Unfiltered on purpose: github.rs filters an unusable author in `issue_to_record`,
    // which here is mapping.js `externalPerson`, not this shape layer.
    user: authorOrGhost(node.author),
    type: node.issueType == null ? null : { name: node.issueType.name ?? null },
  };
}

/**
 * One pull-request node as REST's PR stub row (github.rs `From<GqlPullRequestNode>`), the shape
 * `src/mapping.js` already folds, rejects and labels.
 *
 * @param {any} node
 * @returns {any}
 */
function pullRequestRow(node) {
  const state = lower(node.state);
  return {
    ...issueRow(node),
    // `MERGED` reads as closed to the mapper, and `mergedAt` still carries the other half:
    // GraphQL renames one side of REST's pair, it does not replace it.
    state: state === "merged" ? "closed" : state,
    state_reason: null,
    pull_request: { merged_at: node.mergedAt ?? null },
    type: null,
  };
}

/**
 * One comment connection as REST's comment rows. `issue_url` has no GraphQL counterpart —
 * GraphQL nests comments under their issue — and mapping.js joins on it.
 *
 * @param {any} connection one page of `comments`, from the listing node or a follow-up
 * @param {string} issueUrl
 * @returns {any[]}
 */
function commentRows(connection, issueUrl) {
  return connectionNodes(connection)
    .map((comment) => ({
      body: String(comment.body ?? ""),
      created_at: comment.createdAt ?? null,
      issue_url: issueUrl,
      user: authorOrGhost(comment.author),
    }))
    .filter((comment) => comment.body.trim() !== "");
}

/**
 * github.rs `push_kid`, plus this CLI's own self-reference drop: `src/mapping.js` and
 * tests/parity.test.js are pinned to the REST shape `GitHubClient#fetchSubIssues` builds.
 *
 * @param {any[]} rows
 * @param {string | null} parent
 * @param {string[]} kept
 */
function pushKids(rows, parent, kept) {
  for (const row of rows) {
    const kid = issueNumber(row.number);
    if (kid !== null && kid !== parent && !kept.includes(kid)) kept.push(kid);
  }
}

/**
 * One issue node's sub-issue numbers — the shape `GitHubClient#fetchSubIssues` builds from REST.
 *
 * @param {any} node
 * @returns {string[]}
 */
function subIssueNumbers(node) {
  /** @type {string[]} */
  const kept = [];
  pushKids(connectionNodes(node.subIssues), issueNumber(node.number), kept);
  return kept;
}

/**
 * github.rs `unresolved_parent`: the listing already resolved the repository, so a missing
 * node here means that node moved or was deleted while the import was running.
 *
 * @param {string} noun the node kind, as github.rs `CommentParent::noun` says it
 * @param {string} number
 * @param {string} kind the connection being paged, as a reader would say it
 * @returns {GitHubError}
 */
function vanishedNode(noun, number, kind) {
  return new GitHubError(
    `no ${noun} #${number} node while paging its ${kind} — it may have been deleted or moved ` +
      "while the import was running; re-running the import is safe",
  );
}

/**
 * One issue with the enrichment that used to cost a request each (github.rs `FetchedIssue`).
 * `truncated` carries each short connection's resume cursor, which story #57632 hydrates from.
 *
 * @param {any} node one `ImportIssues` node
 * @param {string} issueUrl the issue's REST API URL, for its comments' `issue_url`
 * @returns {{ issue: any, comments: any[], subIssues: string[],
 *   truncated: { comments: string | null, subIssues: string | null } }}
 */
export function fetchedIssue(node, issueUrl) {
  return {
    issue: issueRow(node),
    comments: commentRows(node.comments, issueUrl),
    subIssues: subIssueNumbers(node),
    truncated: { comments: nextCursor(node.comments), subIssues: nextCursor(node.subIssues) },
  };
}

/**
 * One pull request with the first page of its conversation comments (github.rs
 * `collect_pull_requests`). It takes no sub-issues and no blockers, ever (server story #163088).
 *
 * @param {any} node one `ImportPullRequests` node
 * @param {string} issueUrl the PR's REST issues URL, for its comments' `issue_url`
 * @returns {{ issue: any, comments: any[], truncated: { comments: string | null } }}
 */
export function fetchedPullRequest(node, issueUrl) {
  return {
    issue: pullRequestRow(node),
    comments: commentRows(node.comments, issueUrl),
    truncated: { comments: nextCursor(node.comments) },
  };
}

/**
 * The cursor walk shared by every listing (github.rs `Pager`). A repeating cursor or a
 * walk past {@link MAX_LISTING_PAGES} fails the fetch rather than truncating it silently.
 */
export class Pager {
  /** @type {string | null} */
  after = null;

  /** @type {number} */
  page = 1;

  /**
   * @param {string | null} next the connection's next cursor, or null when exhausted
   * @returns {boolean} false once the listing is exhausted
   */
  advance(next) {
    if (next === null) return false;
    if (this.after === next) {
      throw new GitHubError("GitHub's page cursor stopped advancing; refusing to re-read it");
    }
    if (this.page >= MAX_LISTING_PAGES) {
      throw new GitHubError(
        "GitHub's listing ran past every plausible repository size; refusing to follow it",
      );
    }
    this.after = next;
    this.page += 1;
    return true;
  }
}

/** The listings this fetcher does not cover yet, by the option that would ask for one. */
const UNIMPLEMENTED = /** @type {const} */ (["releases", "dependencies"]);

/** GraphQL fetcher for one repo's issues, its pull requests, their comments, labels, hierarchy. */
export class GitHubGraphQLFetcher {
  /** @type {GitHubGraphQLClient} */
  #client;

  /** @type {(message: string) => void} */
  #warn;

  /** @type {((status: any) => void) | undefined} */
  #onProgress;

  /**
   * @param {string} owner
   * @param {string} repo
   * @param {{ token?: string, timeout?: number, apiBase?: string,
   *   warn?: (message: string) => void, onProgress?: (status: any) => void }} [options]
   *   `warn` defaults to stderr, so a construction site that forgets it cannot swallow a
   *   degraded fetch; `onProgress` takes the same status doc `src/progress.js` renders
   * @throws {import("./github.js").GitHubAuthError} without a token — GraphQL has no
   *   anonymous mode
   */
  constructor(owner, repo, { token, timeout, apiBase = GITHUB_API_BASE, warn, onProgress } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.#warn = warn ?? ((message) => void process.stderr.write(message));
    this.#onProgress = onProgress;
    this.#client = new GitHubGraphQLClient(owner, repo, {
      token,
      timeout,
      apiBase,
      warn: this.#warn,
    });
  }

  /**
   * The REST API URL of one issue, which its comment rows carry as `issue_url`.
   *
   * @param {string} number a number {@link issueNumber} has already validated
   * @returns {string}
   */
  #issueUrl(number) {
    const owner = encodeURIComponent(this.owner);
    const repo = encodeURIComponent(this.repo);
    return `${this.apiBase}/repos/${owner}/${repo}/issues/${encodeURIComponent(number)}`;
  }

  /**
   * Walk one listing to its last page, concatenating the nodes.
   *
   * @param {string} operationName
   * @param {string} query
   * @param {string} label the listing's name, for the shortfall warning
   * @param {(data: Record<string, any>) => any} connectionAt
   * @param {(connection: any, page: number) => void} [onPage]
   * @returns {Promise<any[]>}
   */
  async #walk(operationName, query, label, connectionAt, onPage) {
    const pager = new Pager();
    /** @type {any[]} */
    const out = [];
    for (;;) {
      const data = await this.#client.query(operationName, query, {
        owner: this.owner,
        name: this.repo,
        first: PER_PAGE,
        after: pager.after,
      });
      const connection = connectionAt(data);
      if (connection === null || typeof connection !== "object") {
        throw new GitHubError(`${UNEXPECTED_SHAPE} (expected the repository's ${label})`);
      }
      onPage?.(connection, pager.page);
      out.push(...connectionNodes(connection));
      const cursor = nextCursor(connection);
      if (cursor === "") {
        this.#warn(
          `warning: GitHub reported another page of ${label} but sent no cursor to read it; ` +
            "the rest of that listing is not imported.\n",
        );
      }
      if (!pager.advance(cursor === "" ? null : cursor)) return out;
    }
  }

  /**
   * `fetching page X/Y`, exact because GraphQL's `totalCount` is exact where REST's
   * `rel="last"` was a hint.
   *
   * @param {any} connection
   * @param {number} page
   */
  #reportPage(connection, page) {
    if (!this.#onProgress) return;
    const total = connection.totalCount;
    // A repo that gains issues mid-walk would otherwise render `fetching 3/2`.
    const pages = Number.isFinite(total)
      ? Math.max(Math.ceil(Math.max(0, total) / PER_PAGE), page)
      : null;
    this.#onProgress({ status: "fetching", progress_current: page, progress_total: pages });
  }

  /**
   * One follow-up page for one node, or null when GitHub no longer resolves that node.
   *
   * @param {string} operationName
   * @param {string} query
   * @param {string} field the repository field resolving the node — `issue` or `pullRequest`
   * @param {string} number
   * @param {string | null} after
   * @returns {Promise<any>}
   */
  async #hydratePage(operationName, query, field, number, after) {
    const data = await this.#client.query(operationName, query, {
      owner: this.owner,
      name: this.repo,
      number: Number(number),
      first: PER_PAGE,
      after,
    });
    return data.repository?.[field] ?? null;
  }

  /**
   * One issue's or PR's comments past the page its listing node carried (github.rs
   * `hydrate_comments`).
   *
   * @param {CommentParent} parent which node the thread hangs off
   * @param {string} number
   * @param {string} issueUrl
   * @param {string} cursor the listing node's resume cursor, "" when GitHub sent none
   * @returns {Promise<{ rows: any[], drained: boolean }>} `drained` false when rows are lost
   */
  async #hydrateComments(parent, number, issueUrl, cursor) {
    /** @type {any[]} */
    const rows = [];
    // Page 1 rode the listing node, so the walk starts from its cursor; "" is no cursor
    // at all, and sending it back would only re-read that page.
    if (cursor === "") return { rows, drained: false };
    const pager = new Pager();
    pager.advance(cursor);
    for (;;) {
      let node;
      try {
        node = await this.#hydratePage(
          parent.operation,
          parent.query(),
          parent.field,
          number,
          pager.after,
        );
      } catch (err) {
        // github.rs `name_vanished_parent`: the listing already resolved this repository,
        // so a NOT_FOUND here names a vanished node, not an unreadable repo.
        if (err instanceof RepoNotFoundError) throw vanishedNode(parent.noun, number, "comments");
        throw err;
      }
      // The connection promised another page, so a missing node drops comments — say so
      // rather than truncating the thread in silence.
      if (node == null) throw vanishedNode(parent.noun, number, "comments");
      const connection = node.comments;
      if (connection === null || typeof connection !== "object") {
        throw new GitHubError(
          `${UNEXPECTED_SHAPE} (expected ${parent.noun} #${number}'s comments)`,
        );
      }
      rows.push(...commentRows(connection, issueUrl));
      const next = nextCursor(connection);
      if (next === "") return { rows, drained: false };
      if (!pager.advance(next)) return { rows, drained: true };
    }
  }

  /**
   * One parent's sub-issues past the page its listing node carried, appended to `kept`
   * (github.rs `hydrate_issue`).
   *
   * @param {string} number
   * @param {string[]} kept the numbers the listing node already yielded
   * @param {string} cursor the listing node's resume cursor, "" when GitHub sent none
   * @returns {Promise<"drained" | "short" | "capped">} how the walk ended
   */
  async #hydrateSubIssues(number, kept, cursor) {
    if (cursor === "") return "short";
    const pager = new Pager();
    pager.advance(cursor);
    for (;;) {
      let issue;
      try {
        issue = await this.#hydratePage(
          "ImportIssueSubIssues",
          issueSubIssuesQuery(),
          COMMENT_PARENT.issue.field,
          number,
          pager.after,
        );
      } catch (err) {
        // github.rs propagates this one, so it stays fatal; only the diagnosis is this
        // engine's, because the listing already resolved the repository.
        if (err instanceof RepoNotFoundError) {
          throw vanishedNode(COMMENT_PARENT.issue.noun, number, "sub-issues");
        }
        throw err;
      }
      // github.rs breaks on a vanished node here where its comment walk fails: a lost
      // cross-link costs no row.
      if (issue == null) return "short";
      const connection = issue.subIssues;
      if (connection === null || typeof connection !== "object") {
        throw new GitHubError(`${UNEXPECTED_SHAPE} (expected issue #${number}'s sub-issues)`);
      }
      pushKids(connectionNodes(connection), number, kept);
      const next = nextCursor(connection);
      if (next === "") return "short";
      if (next !== null && pager.page >= MAX_SUB_ISSUE_PAGES) return "capped";
      // github.rs runs no Pager here: it re-reads, `push_kid` dedups and the cap ends the
      // walk, so throwing would fail an import the server completes.
      if (next === pager.after) return "short";
      if (!pager.advance(next)) return "drained";
    }
  }

  /**
   * Report a connection hydration could not drain, in one line however many rows did.
   *
   * @param {string} noun the short rows' node kind, as github.rs `CommentParent::noun` says it
   * @param {string} kind the connection's name, as a reader would say it
   * @param {string} cause what stopped the walk, as the sentence's verb phrase
   * @param {string[]} numbers the rows whose connection stayed short
   */
  #warnOverflow(noun, kind, cause, numbers) {
    if (!numbers.length) return;
    const named = numbers
      .slice(0, MAX_NAMED_OVERFLOWS)
      .map((number) => `#${number}`)
      .join(", ");
    const rest = numbers.length - MAX_NAMED_OVERFLOWS;
    this.#warn(
      `warning: ${numbers.length} ${noun}(s) ${cause}: ${named}` +
        `${rest > 0 ? `, and ${rest} more` : ""} — the rest of those ${kind} are not ` +
        "imported.\n",
    );
  }

  /**
   * Fetch the repo's issues, their comments, its labels, the sub-issue hierarchy, and under
   * `pullRequests` the PR rows too.
   *
   * @param {{ pullRequests?: boolean, releases?: boolean, dependencies?: boolean }} [options]
   *   `pullRequests` (`--include prs`) adds the `pullRequests` connection; `releases` and
   *   `dependencies` are refused, because a flag that silently no-ops drops rows
   * @returns {Promise<{ issues: any[], comments: any[], labels: any[],
   *   subIssues: Map<string, string[]> }>}
   */
  async fetchAll(options = {}) {
    for (const name of UNIMPLEMENTED) {
      if (options[name]) {
        throw new GitHubError(
          `the GraphQL fetch does not list ${name} yet; it lists issues, pull requests, their ` +
            "comments, the repo's labels and the sub-issue hierarchy",
        );
      }
    }
    const [nodes, labelNodes, prNodes] = await Promise.all([
      this.#walk(
        "ImportIssues",
        issuesQuery(),
        "issues",
        (data) => data.repository?.issues,
        (connection, page) => this.#reportPage(connection, page),
      ),
      this.#walk("ImportLabels", labelsQuery(), "labels", (data) => data.repository?.labels),
      // Queried only when asked for: github.rs skips `collect_pull_requests` entirely, so a
      // default run must send no query naming the connection.
      options.pullRequests
        ? this.#walk(
            "ImportPullRequests",
            pullRequestsQuery(),
            "pull requests",
            (data) => data.repository?.pullRequests,
          )
        : [],
    ]);

    const labels = labelNodes.map((label) => ({ name: label.name, color: label.color ?? null }));
    /** @type {any[]} */
    const issues = [];
    /** @type {any[]} */
    const comments = [];
    /** @type {Map<string, string[]>} */
    const subIssues = new Map();
    /** @type {string[]} */
    const overflowedComments = [];
    /** @type {string[]} */
    const overflowedPrComments = [];
    /** @type {string[]} */
    const overflowedSubIssues = [];
    /** @type {string[]} */
    const cappedSubIssues = [];
    let unnumbered = 0;
    let unnumberedPrs = 0;
    // Sequential, and only once the listing is complete: a wide hierarchy or a long thread
    // must not burst a page per issue into GitHub's secondary rate limit.
    for (const node of nodes) {
      const number = issueNumber(node.number);
      const issueUrl = number === null ? "" : this.#issueUrl(number);
      const fetched = fetchedIssue(node, issueUrl);
      issues.push(fetched.issue);
      // The row still ships, as the REST path ships one whose number it could not read;
      // only the number-keyed stages skip it, because nothing can join to an unreadable id.
      if (number === null) {
        unnumbered += 1;
        continue;
      }
      if (fetched.truncated.comments !== null) {
        const { rows, drained } = await this.#hydrateComments(
          COMMENT_PARENT.issue,
          number,
          issueUrl,
          fetched.truncated.comments,
        );
        // Spread would pass one argument per row, and a drained thread has no 100-row
        // ceiling; past ~10^5 V8 throws a RangeError src/cli.js cannot format.
        for (const row of rows) fetched.comments.push(row);
        if (!drained) overflowedComments.push(number);
      }
      if (fetched.truncated.subIssues !== null) {
        const outcome = await this.#hydrateSubIssues(
          number,
          fetched.subIssues,
          fetched.truncated.subIssues,
        );
        if (outcome === "capped") cappedSubIssues.push(number);
        else if (outcome === "short") overflowedSubIssues.push(number);
      }
      for (const row of fetched.comments) comments.push(row);
      if (fetched.subIssues.length) subIssues.set(number, fetched.subIssues);
    }
    // After the issues, as github.rs `fetch_issue_graph` extends its list with them. The
    // writer sorts creates by `created_at`, so only the plan's listing order follows this.
    for (const node of prNodes) {
      const number = issueNumber(node.number);
      const issueUrl = number === null ? "" : this.#issueUrl(number);
      const fetched = fetchedPullRequest(node, issueUrl);
      issues.push(fetched.issue);
      if (number === null) {
        unnumberedPrs += 1;
        continue;
      }
      if (fetched.truncated.comments !== null) {
        const { rows, drained } = await this.#hydrateComments(
          COMMENT_PARENT.pullRequest,
          number,
          issueUrl,
          fetched.truncated.comments,
        );
        for (const row of rows) fetched.comments.push(row);
        if (!drained) overflowedPrComments.push(number);
      }
      for (const row of fetched.comments) comments.push(row);
    }
    if (unnumbered > 0) {
      this.#warn(
        `warning: ${unnumbered} ${COMMENT_PARENT.issue.noun}(s) arrived without a usable issue ` +
          "number — their comments and sub-issue cross-links are not imported.\n",
      );
    }
    // Its own line and its own noun: a PR has no sub-issue connection, so the issue
    // wording would name a loss it never had.
    if (unnumberedPrs > 0) {
      this.#warn(
        `warning: ${unnumberedPrs} ${COMMENT_PARENT.pullRequest.noun}(s) arrived without a ` +
          "usable number — their comments are not imported.\n",
      );
    }
    this.#warnOverflow(
      COMMENT_PARENT.issue.noun,
      "comments",
      "have comments this fetch could not finish reading",
      overflowedComments,
    );
    this.#warnOverflow(
      COMMENT_PARENT.pullRequest.noun,
      "comments",
      "have comments this fetch could not finish reading",
      overflowedPrComments,
    );
    this.#warnOverflow(
      COMMENT_PARENT.issue.noun,
      "sub-issues",
      "have sub-issues this fetch could not finish reading",
      overflowedSubIssues,
    );
    this.#warnOverflow(
      COMMENT_PARENT.issue.noun,
      "sub-issues",
      `carry more than ${MAX_SUB_ISSUE_PAGES * PER_PAGE} sub-issues, the most one parent's ` +
        "hierarchy may read",
      cappedSubIssues,
    );
    return { issues, comments, labels, subIssues };
  }
}
