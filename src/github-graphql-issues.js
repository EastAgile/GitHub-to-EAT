/**
 * The `ImportIssues` listing, the per-issue follow-ups that drain a connection one page could
 * not hold, and the REST-shape rename layer (github.rs), whose rows keep REST's field names so
 * `src/mapping.js` maps either transport. Not wired yet: CONTRACT.md.
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
 * One issue node as REST's issue row. No `pull_request` key: pull requests are story
 * #57633, and mapping.js reads that key to tell the two apart.
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
 * Append one page of sub-issue nodes to `kept`, in GitHub's own order (github.rs `push_kid`).
 * The self-reference drop is this CLI's own, mirroring `GitHubClient#fetchSubIssues` because
 * mapping.js and tests/parity.test.js are pinned to that REST shape.
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
 * node here means that issue moved or was deleted while the import was running.
 *
 * @param {string} number
 * @returns {GitHubError}
 */
function vanishedIssue(number) {
  return new GitHubError(
    `no issue #${number} node while paging its comments — it may have been deleted or moved ` +
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
const UNIMPLEMENTED = /** @type {const} */ (["pullRequests", "releases", "dependencies"]);

/** GraphQL fetcher for one repo's issues, their comments, its labels and the hierarchy. */
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
   * One follow-up page for one issue, or null when GitHub no longer resolves that node.
   *
   * @param {string} operationName
   * @param {string} query
   * @param {string} number
   * @param {string | null} after
   * @returns {Promise<any>}
   */
  async #hydratePage(operationName, query, number, after) {
    const data = await this.#client.query(operationName, query, {
      owner: this.owner,
      name: this.repo,
      number: Number(number),
      first: PER_PAGE,
      after,
    });
    return data.repository?.issue ?? null;
  }

  /**
   * One issue's comments past the page its listing node carried (github.rs `hydrate_comments`).
   *
   * @param {string} number
   * @param {string} issueUrl
   * @param {string} cursor the listing node's resume cursor, "" when GitHub sent none
   * @returns {Promise<{ rows: any[], drained: boolean }>} `drained` false when rows are lost
   */
  async #hydrateComments(number, issueUrl, cursor) {
    /** @type {any[]} */
    const rows = [];
    // Page 1 rode the listing node, so the walk starts from its cursor; "" is no cursor
    // at all, and sending it back would only re-read that page.
    if (cursor === "") return { rows, drained: false };
    const pager = new Pager();
    pager.advance(cursor);
    for (;;) {
      let issue;
      try {
        issue = await this.#hydratePage(
          "ImportIssueComments",
          issueCommentsQuery(),
          number,
          pager.after,
        );
      } catch (err) {
        // github.rs `name_vanished_parent`: the listing already resolved this repository,
        // so a NOT_FOUND here names a vanished issue, not an unreadable repo.
        if (err instanceof RepoNotFoundError) throw vanishedIssue(number);
        throw err;
      }
      // The connection promised another page, so a missing node drops comments — say so
      // rather than truncating the thread in silence.
      if (issue == null) throw vanishedIssue(number);
      const connection = issue.comments;
      if (connection === null || typeof connection !== "object") {
        throw new GitHubError(`${UNEXPECTED_SHAPE} (expected issue #${number}'s comments)`);
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
   * @returns {Promise<boolean>} false when the hierarchy stayed short
   */
  async #hydrateSubIssues(number, kept, cursor) {
    if (cursor === "") return false;
    const pager = new Pager();
    pager.advance(cursor);
    for (;;) {
      const issue = await this.#hydratePage(
        "ImportIssueSubIssues",
        issueSubIssuesQuery(),
        number,
        pager.after,
      );
      // github.rs breaks on a vanished node here where its comment walk fails: a lost
      // cross-link costs no row, and this stage never throws an imported repo away.
      if (issue == null) return false;
      const connection = issue.subIssues;
      if (connection === null || typeof connection !== "object") {
        throw new GitHubError(`${UNEXPECTED_SHAPE} (expected issue #${number}'s sub-issues)`);
      }
      pushKids(connectionNodes(connection), number, kept);
      const next = nextCursor(connection);
      if (next === "") return false;
      if (next !== null && pager.page >= MAX_SUB_ISSUE_PAGES) return false;
      if (!pager.advance(next)) return true;
    }
  }

  /**
   * Report a connection hydration could not drain, in one line however many issues did.
   *
   * @param {string} kind the connection's name, as a reader would say it
   * @param {string[]} numbers the issues whose connection stayed short
   */
  #warnOverflow(kind, numbers) {
    if (!numbers.length) return;
    const named = numbers
      .slice(0, MAX_NAMED_OVERFLOWS)
      .map((number) => `#${number}`)
      .join(", ");
    const rest = numbers.length - MAX_NAMED_OVERFLOWS;
    this.#warn(
      `warning: ${numbers.length} issue(s) carry more than ${PER_PAGE} ${kind} that this fetch ` +
        `could not read: ${named}${rest > 0 ? `, and ${rest} more` : ""} — the rest of those ` +
        `${kind} are not imported.\n`,
    );
  }

  /**
   * Fetch the repo's issues, their comments, its labels and the sub-issue hierarchy.
   *
   * @param {{ pullRequests?: boolean, releases?: boolean, dependencies?: boolean }} [options]
   *   every option is refused: those listings are separate stories, and a flag that
   *   silently no-ops would drop rows the caller asked for
   * @returns {Promise<{ issues: any[], comments: any[], labels: any[],
   *   subIssues: Map<string, string[]> }>}
   */
  async fetchAll(options = {}) {
    for (const name of UNIMPLEMENTED) {
      if (options[name]) {
        throw new GitHubError(
          `the GraphQL fetch does not list ${name} yet; it lists issues, their comments, ` +
            "the repo's labels and the sub-issue hierarchy",
        );
      }
    }
    const [nodes, labelNodes] = await Promise.all([
      this.#walk(
        "ImportIssues",
        issuesQuery(),
        "issues",
        (data) => data.repository?.issues,
        (connection, page) => this.#reportPage(connection, page),
      ),
      this.#walk("ImportLabels", labelsQuery(), "labels", (data) => data.repository?.labels),
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
    const overflowedSubIssues = [];
    let unnumbered = 0;
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
          number,
          issueUrl,
          fetched.truncated.comments,
        );
        fetched.comments.push(...rows);
        if (!drained) overflowedComments.push(number);
      }
      if (fetched.truncated.subIssues !== null) {
        const drained = await this.#hydrateSubIssues(
          number,
          fetched.subIssues,
          fetched.truncated.subIssues,
        );
        if (!drained) overflowedSubIssues.push(number);
      }
      comments.push(...fetched.comments);
      if (fetched.subIssues.length) subIssues.set(number, fetched.subIssues);
    }
    if (unnumbered > 0) {
      this.#warn(
        `warning: ${unnumbered} issue(s) arrived without a usable issue number — their ` +
          "comments and sub-issue cross-links are not imported.\n",
      );
    }
    this.#warnOverflow("comments", overflowedComments);
    this.#warnOverflow("sub-issues", overflowedSubIssues);
    return { issues, comments, labels, subIssues };
  }
}
