import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  GitHubAuthError,
  GitHubClient,
  GitHubError,
  MAX_RELEASE_PAGES,
  RateLimitError,
  RepoNotFoundError,
} from "../src/github.js";

/**
 * Run `fn` against a throwaway local HTTP server standing in for api.github.com;
 * always tears it down. The server's base URL is passed as the client's apiBase.
 *
 * @param {http.RequestListener} handler
 * @param {(base: string) => Promise<void>} fn
 */
async function withGitHub(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

/**
 * @param {http.ServerResponse} res
 * @param {number} code
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 */
function json(res, code, payload, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

test("listIssues requests state=all with per_page=100", async () => {
  /** @type {URL | undefined} */
  let url;
  await withGitHub(
    (req, res) => {
      url = new URL(req.url ?? "", "http://x");
      json(res, 200, []);
    },
    async (base) => {
      await new GitHubClient("octocat", "hello-world", { apiBase: base }).listIssues();
    },
  );
  assert.equal(url?.pathname, "/repos/octocat/hello-world/issues");
  assert.equal(url?.searchParams.get("state"), "all");
  assert.equal(url?.searchParams.get("per_page"), "100");
});

test("owner and repo are URL-encoded, so metacharacters cannot mangle the request", async () => {
  /** @type {URL | undefined} */
  let url;
  await withGitHub(
    (req, res) => {
      url = new URL(req.url ?? "", "http://x");
      json(res, 200, []);
    },
    async (base) => {
      await new GitHubClient("o", "name?x=1", { apiBase: base }).listIssues();
    },
  );
  assert.equal(url?.pathname, "/repos/o/name%3Fx%3D1/issues");
  assert.equal(url?.searchParams.get("x"), null);
  assert.equal(url?.searchParams.get("state"), "all");
});

test("listIssues drops pull requests from the issues list", async () => {
  await withGitHub(
    (_req, res) =>
      json(res, 200, [
        { number: 1, title: "a bug" },
        { number: 2, title: "a PR", pull_request: { url: "https://api.github.com/pulls/2" } },
        { number: 3, title: "another issue" },
      ]),
    async (base) => {
      const issues = await new GitHubClient("o", "r", { apiBase: base }).listIssues();
      assert.deepEqual(
        issues.map((i) => i.number),
        [1, 3],
      );
    },
  );
});

test("pagination follows the Link rel=next header across pages", async () => {
  await withGitHub(
    (req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      const page = url.searchParams.get("page") ?? "1";
      if (page === "1") {
        const next = `${url.protocol}//${req.headers.host}${url.pathname}?page=2`;
        json(res, 200, [{ number: 1 }], { Link: `<${next}>; rel="next"` });
      } else {
        json(res, 200, [{ number: 2 }]);
      }
    },
    async (base) => {
      const issues = await new GitHubClient("o", "r", { apiBase: base }).listIssues();
      assert.deepEqual(
        issues.map((i) => i.number),
        [1, 2],
      );
    },
  );
});

test("pagination picks rel=next out of a multi-rel Link header", async () => {
  await withGitHub(
    (req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      const here = `${url.protocol}//${req.headers.host}${url.pathname}`;
      const page = url.searchParams.get("page") ?? "1";
      if (page === "1") {
        json(res, 200, [{ number: 1 }], {
          Link: `<${here}?page=1>; rel="prev", <${here}?page=2>; rel="next", <${here}?page=2>; rel="last"`,
        });
      } else {
        json(res, 200, [{ number: 2 }], {
          Link: `<${here}?page=1>; rel="prev", <${here}?page=1>; rel="first"`,
        });
      }
    },
    async (base) => {
      const issues = await new GitHubClient("o", "r", { apiBase: base }).listIssues();
      assert.deepEqual(
        issues.map((i) => i.number),
        [1, 2],
      );
    },
  );
});

test("pagination follows a rel=next URL whose query string contains a comma", async () => {
  /** @type {(string | null)[]} */
  const seenFields = [];
  await withGitHub(
    (req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      seenFields.push(url.searchParams.get("fields"));
      const here = `${url.protocol}//${req.headers.host}${url.pathname}`;
      if (url.searchParams.get("page") === null) {
        // The shape GitHub emits once a comma-bearing param paginates: every
        // target carries the comma, so a bare-comma split shreds all of them.
        json(res, 200, [{ number: 1 }], {
          Link: `<${here}?fields=a,b&page=1>; rel="prev", <${here}?fields=a,b&page=2>; rel="next", <${here}?fields=a,b&page=9>; rel="last"`,
        });
      } else {
        json(res, 200, [{ number: 2 }]);
      }
    },
    async (base) => {
      const issues = await new GitHubClient("o", "r", { apiBase: base }).listIssues();
      assert.deepEqual(
        issues.map((i) => i.number),
        [1, 2],
      );
    },
  );
  assert.deepEqual(seenFields, [null, "a,b"]);
});

test("pagination is unaffected by a comma inside a non-next target", async () => {
  let requests = 0;
  await withGitHub(
    (req, res) => {
      requests += 1;
      const url = new URL(req.url ?? "", "http://x");
      const here = `${url.protocol}//${req.headers.host}${url.pathname}`;
      if (url.searchParams.get("page") === null) {
        json(res, 200, [{ number: 1 }], {
          Link: `<${here}?fields=a,b&page=1>; rel="prev", <${here}?page=2>; rel="next"`,
        });
      } else {
        json(res, 200, [{ number: 2 }]);
      }
    },
    async (base) => {
      const issues = await new GitHubClient("o", "r", { apiBase: base }).listIssues();
      assert.deepEqual(
        issues.map((i) => i.number),
        [1, 2],
      );
    },
  );
  assert.equal(requests, 2);
});

test("a Link header without a rel=next ends pagination", async () => {
  let requests = 0;
  await withGitHub(
    (req, res) => {
      requests += 1;
      const url = new URL(req.url ?? "", "http://x");
      const here = `${url.protocol}//${req.headers.host}${url.pathname}`;
      // Bounded on purpose: #paginate has no cycle guard, so an unbounded
      // self-referential header would hang the run instead of failing it.
      if (requests > 1) {
        json(res, 200, []);
        return;
      }
      json(res, 200, [{ number: 1 }], {
        Link: `<${here}?page=1>; rel="prev", <${here}?page=1>; rel="first"`,
      });
    },
    async (base) => {
      const issues = await new GitHubClient("o", "r", { apiBase: base }).listIssues();
      assert.deepEqual(
        issues.map((i) => i.number),
        [1],
      );
    },
  );
  assert.equal(requests, 1);
});

test("a request that outlives the timeout maps to GitHubError naming the timeout", async () => {
  await withGitHub(
    () => {
      /* never respond */
    },
    async (base) => {
      await assert.rejects(
        new GitHubClient("o", "r", { apiBase: base, timeout: 0.05 }).listIssues(),
        (err) => {
          assert.ok(err instanceof GitHubError);
          assert.match(err.message, /timed out/);
          return true;
        },
      );
    },
  );
});

test("an unmapped >=400 status maps to GitHubError carrying status and body", async () => {
  await withGitHub(
    (_req, res) => json(res, 500, { message: "boom" }),
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /\(500\)/);
        assert.match(err.message, /boom/);
        return true;
      });
    },
  );
});

test("a Link rel=next pointing off the API origin is refused, keeping the token home", async () => {
  await withGitHub(
    (_req, res) =>
      json(res, 200, [{ number: 1 }], { Link: '<http://evil.invalid/steal>; rel="next"' }),
    async (base) => {
      await assert.rejects(
        new GitHubClient("o", "r", { apiBase: base, token: "ghp_secret" }).listIssues(),
        (err) => {
          assert.ok(err instanceof GitHubError);
          assert.match(err.message, /origin/);
          return true;
        },
      );
    },
  );
});

test("a non-array 200 body throws GitHubError instead of reading as an empty page", async () => {
  await withGitHub(
    (_req, res) => json(res, 200, { message: "unexpected object" }),
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /expected a JSON array/);
        return true;
      });
    },
  );
});

test("a 200 body that is not JSON at all throws GitHubError, not a raw SyntaxError", async () => {
  await withGitHub(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Corporate proxy: request blocked</body></html>");
    },
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.ok(!(err instanceof SyntaxError));
        assert.match(err.message, /expected a JSON array/);
        return true;
      });
    },
  );
});

test("a body that stalls past the timeout reports the timeout, not an unexpected payload", async () => {
  await withGitHub(
    (_req, res) => {
      // Headers land, then the body never arrives: the abort clock fires mid-stream.
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "64" });
      res.write("[{");
    },
    async (base) => {
      await assert.rejects(
        new GitHubClient("o", "r", { apiBase: base, timeout: 0.05 }).listIssues(),
        (err) => {
          assert.ok(err instanceof GitHubError);
          assert.match(err.message, /timed out/);
          assert.doesNotMatch(err.message, /unexpected payload/);
          return true;
        },
      );
    },
  );
});

test("a socket reset mid-body reports a reachability failure, not an unexpected payload", async () => {
  await withGitHub(
    (_req, res) => {
      // Headers first (fetch resolves on them), then kill the socket while the
      // body is still streaming — otherwise the request phase catches it.
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "64" });
      res.write("[{");
      setTimeout(() => res.socket?.destroy(), 50);
    },
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /could not reach GitHub/);
        assert.doesNotMatch(err.message, /unexpected payload/);
        return true;
      });
    },
  );
});

test("a >=400 body cut off mid-read still surfaces the status as GitHubError", async () => {
  await withGitHub(
    (_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain", "Content-Length": "64" });
      res.write("boom");
      setTimeout(() => res.socket?.destroy(), 50);
    },
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /\(500\)/);
        return true;
      });
    },
  );
});

test("terminal escapes in a >=400 body are stripped before the message reaches the user", async () => {
  await withGitHub(
    (_req, res) => {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("\x1b[2J\x1b[Hbad gateway\r\n\x1b]0;pwned\x07");
    },
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /\(502\)/);
        assert.match(err.message, /bad gateway/);
        assert.doesNotMatch(err.message, /\p{Cc}/u);
        return true;
      });
    },
  );
});

test("listComments hits the repo-wide issue comments endpoint", async () => {
  /** @type {string | undefined} */
  let path;
  await withGitHub(
    (req, res) => {
      path = new URL(req.url ?? "", "http://x").pathname;
      json(res, 200, [{ id: 10, body: "hi" }]);
    },
    async (base) => {
      const comments = await new GitHubClient("o", "r", { apiBase: base }).listComments();
      assert.equal(comments.length, 1);
    },
  );
  assert.equal(path, "/repos/o/r/issues/comments");
});

test("listLabels hits the labels endpoint", async () => {
  /** @type {string | undefined} */
  let path;
  await withGitHub(
    (req, res) => {
      path = new URL(req.url ?? "", "http://x").pathname;
      json(res, 200, [{ name: "bug" }]);
    },
    async (base) => {
      const labels = await new GitHubClient("o", "r", { apiBase: base }).listLabels();
      assert.equal(labels[0].name, "bug");
    },
  );
  assert.equal(path, "/repos/o/r/labels");
});

test("a token is sent as an Authorization header", async () => {
  /** @type {string | undefined} */
  let auth;
  await withGitHub(
    (req, res) => {
      auth = /** @type {string} */ (req.headers.authorization);
      json(res, 200, []);
    },
    async (base) => {
      await new GitHubClient("o", "r", { apiBase: base, token: "ghp_xyz" }).listIssues();
    },
  );
  assert.equal(auth, "Bearer ghp_xyz");
});

test("no Authorization header without a token", async () => {
  /** @type {string | undefined} */
  let auth = "sentinel";
  await withGitHub(
    (req, res) => {
      auth = req.headers.authorization;
      json(res, 200, []);
    },
    async (base) => {
      await new GitHubClient("o", "r", { apiBase: base }).listIssues();
    },
  );
  assert.equal(auth, undefined);
});

test("a User-Agent header is always sent (GitHub rejects requests without one)", async () => {
  /** @type {string | undefined} */
  let ua;
  await withGitHub(
    (req, res) => {
      ua = /** @type {string} */ (req.headers["user-agent"]);
      json(res, 200, []);
    },
    async (base) => {
      await new GitHubClient("o", "r", { apiBase: base }).listIssues();
    },
  );
  assert.ok(ua && ua.length > 0);
});

test("404 maps to RepoNotFoundError naming the repo", async () => {
  await withGitHub(
    (_req, res) => json(res, 404, { message: "Not Found" }),
    async (base) => {
      await assert.rejects(
        new GitHubClient("ghost", "nope", { apiBase: base }).listIssues(),
        (err) => {
          assert.ok(err instanceof RepoNotFoundError);
          assert.match(err.message, /ghost\/nope/);
          return true;
        },
      );
    },
  );
});

test("a malformed Link rel=next URL throws GitHubError, not a raw TypeError", async () => {
  await withGitHub(
    (_req, res) => json(res, 200, [{ number: 1 }], { Link: '</issues?page=2>; rel="next"' }),
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /rel=next/);
        return true;
      });
    },
  );
});

test("retry-after wins over x-ratelimit-reset when a secondary limit sends both", async () => {
  await withGitHub(
    (_req, res) =>
      json(
        res,
        403,
        { message: "You have exceeded a secondary rate limit" },
        {
          "retry-after": "60",
          "x-ratelimit-remaining": "1",
          "x-ratelimit-reset": "1893456000",
        },
      ),
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof RateLimitError);
        assert.match(err.message, /resets in 60s/);
        assert.doesNotMatch(err.message, /2030/);
        return true;
      });
    },
  );
});

test("403 with a zeroed rate-limit maps to RateLimitError with the reset time", async () => {
  const reset = 1893456000; // 2030-01-01T00:00:00Z — stable, readable in the message
  await withGitHub(
    (_req, res) =>
      json(
        res,
        403,
        { message: "API rate limit exceeded" },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      ),
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof RateLimitError);
        assert.match(err.message, /2030/);
        return true;
      });
    },
  );
});

test("429 maps to RateLimitError with the reset time and the --token hint", async () => {
  const reset = 1893456000; // 2030-01-01T00:00:00Z
  await withGitHub(
    (_req, res) =>
      json(res, 429, { message: "too many requests" }, { "x-ratelimit-reset": String(reset) }),
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof RateLimitError);
        assert.match(err.message, /2030/);
        assert.match(err.message, /--token/);
        return true;
      });
    },
  );
});

test("403 with retry-after maps to RateLimitError even with remaining budget", async () => {
  await withGitHub(
    (_req, res) =>
      json(
        res,
        403,
        { message: "You have exceeded a secondary rate limit" },
        { "retry-after": "60", "x-ratelimit-remaining": "1" },
      ),
    async (base) => {
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).listIssues(), (err) => {
        assert.ok(err instanceof RateLimitError);
        assert.match(err.message, /60s/);
        assert.match(err.message, /--token/);
        return true;
      });
    },
  );
});

test("401 maps to GitHubAuthError", async () => {
  await withGitHub(
    (_req, res) => json(res, 401, { message: "Bad credentials" }),
    async (base) => {
      await assert.rejects(
        new GitHubClient("o", "r", { apiBase: base, token: "bad" }).listIssues(),
        GitHubAuthError,
      );
    },
  );
});

test("fetchAll returns issues, comments, and labels together", async () => {
  await withGitHub(
    (req, res) => {
      const path = new URL(req.url ?? "", "http://x").pathname;
      if (path.endsWith("/issues")) {
        json(res, 200, [{ number: 1 }, { number: 2, pull_request: {} }]);
      } else if (path.endsWith("/issues/comments")) {
        json(res, 200, [{ id: 5, issue_url: "https://api.github.com/repos/o/r/issues/1" }]);
      } else if (path.endsWith("/labels")) {
        json(res, 200, [{ name: "bug" }, { name: "wontfix" }]);
      } else {
        json(res, 404, { message: "Not Found" });
      }
    },
    async (base) => {
      const repo = await new GitHubClient("o", "r", { apiBase: base }).fetchAll();
      assert.equal(repo.issues.length, 1); // PR filtered out
      assert.equal(repo.comments.length, 1);
      assert.equal(repo.labels.length, 2);
    },
  );
});

test("fetchAll drops comments whose issue_url points at a PR or unknown issue", async () => {
  await withGitHub(
    (req, res) => {
      const path = new URL(req.url ?? "", "http://x").pathname;
      if (path.endsWith("/issues")) {
        json(res, 200, [{ number: 1 }, { number: 2, pull_request: {} }]);
      } else if (path.endsWith("/issues/comments")) {
        json(res, 200, [
          { id: 10, issue_url: "https://api.github.com/repos/o/r/issues/1" },
          { id: 11, issue_url: "https://api.github.com/repos/o/r/issues/2" }, // PR conversation
          { id: 12, issue_url: "https://api.github.com/repos/o/r/issues/99" }, // unknown
          { id: 13 }, // no issue_url at all
        ]);
      } else {
        json(res, 200, []);
      }
    },
    async (base) => {
      const repo = await new GitHubClient("o", "r", { apiBase: base }).fetchAll();
      assert.deepEqual(
        repo.comments.map((c) => c.id),
        [10],
      );
    },
  );
});

// --- sub-issue listings (#31928) ---------------------------------------------

/**
 * A GitHub stand-in serving `issues` on the list endpoint and `subIssues[n]` on
 * each `/issues/{n}/sub_issues`, recording every path it was asked for.
 *
 * @param {{ issues: any[], subIssues?: Record<string, any[]>,
 *   subIssueStatus?: Record<string, number> }} repo
 */
function subIssueHandler({ issues, subIssues = {}, subIssueStatus = {} }) {
  /** @type {string[]} */
  const paths = [];
  /** @type {import("node:http").RequestListener} */
  const handler = (req, res) => {
    const { pathname } = new URL(req.url ?? "", "http://x");
    paths.push(pathname);
    const sub = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/sub_issues$/);
    if (sub) {
      const status = subIssueStatus[sub[1]];
      if (status) return json(res, status, { message: "nope" }, { "x-ratelimit-remaining": "42" });
      return json(res, 200, subIssues[sub[1]] ?? []);
    }
    if (pathname === "/repos/o/r/issues") return json(res, 200, issues);
    json(res, 200, []);
  };
  return { paths, handler };
}

const summary = (/** @type {number} */ total) => ({
  sub_issues_summary: { total, completed: 0, percent_completed: 0 },
});

test("fetchAll lists sub-issues only for rows whose sub_issues_summary.total is positive", async () => {
  const { paths, handler } = subIssueHandler({
    issues: [
      { number: 7, ...summary(2) },
      { number: 12, ...summary(0) },
      { number: 14 },
      { number: 20, sub_issues_summary: null },
      { number: 21, sub_issues_summary: { total: "3" } },
    ],
    subIssues: { 7: [{ number: 12 }, { number: 14 }] },
  });
  await withGitHub(handler, async (base) => {
    const fetched = await new GitHubClient("o", "r", { apiBase: base }).fetchAll();
    assert.deepEqual([...fetched.subIssues], [["7", ["12", "14"]]]);
  });
  assert.deepEqual(
    paths.filter((p) => p.endsWith("/sub_issues")),
    ["/repos/o/r/issues/7/sub_issues"],
  );
});

test("a sub-issue listing sends per_page=100 and follows its Link pagination", async () => {
  /** @type {string[]} */
  const seen = [];
  let base = "";
  await withGitHub(
    (req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      if (url.pathname === "/repos/o/r/issues") {
        return json(res, 200, [{ number: 7, ...summary(3) }]);
      }
      if (url.pathname !== "/repos/o/r/issues/7/sub_issues") return json(res, 200, []);
      seen.push(url.search);
      if (url.searchParams.get("page") === "2") return json(res, 200, [{ number: 14 }]);
      json(res, 200, [{ number: 12 }], {
        link: `<${base}/repos/o/r/issues/7/sub_issues?per_page=100&page=2>; rel="next"`,
      });
    },
    async (started) => {
      base = started;
      const fetched = await new GitHubClient("o", "r", { apiBase: base }).fetchAll();
      assert.deepEqual(fetched.subIssues.get("7"), ["12", "14"]);
    },
  );
  assert.ok(seen[0].includes("per_page=100"), `first page asked for per_page=100, got ${seen[0]}`);
  assert.equal(seen.length, 2);
});

test("sub-issue rows that are not positive integers, or the parent itself, are dropped", async () => {
  const { handler } = subIssueHandler({
    issues: [{ number: 7, ...summary(9) }],
    subIssues: {
      7: [
        { number: 7 },
        { number: "12" },
        { number: 12.5 },
        { number: 0 },
        { number: -3 },
        {},
        null,
        { number: 14 },
        { number: 14 },
      ],
    },
  });
  await withGitHub(handler, async (base) => {
    const fetched = await new GitHubClient("o", "r", { apiBase: base }).fetchAll();
    assert.deepEqual(fetched.subIssues.get("7"), ["14"]);
  });
});

test("a parent whose sub-issue listing is 404 warns and contributes no links, run continues", async () => {
  const { handler } = subIssueHandler({
    issues: [
      { number: 7, ...summary(1) },
      { number: 9, ...summary(1) },
    ],
    subIssues: { 9: [{ number: 14 }] },
    subIssueStatus: { 7: 404 },
  });
  /** @type {string[]} */
  const warnings = [];
  await withGitHub(handler, async (base) => {
    const fetched = await new GitHubClient("o", "r", {
      apiBase: base,
      warn: (m) => warnings.push(m),
    }).fetchAll();
    assert.deepEqual([...fetched.subIssues], [["9", ["14"]]]);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /warning: .*#7.*sub-issues/);
});

test("a 404 warning names the children that lose their parent line, not just the parent", async () => {
  const { handler } = subIssueHandler({
    issues: [{ number: 7, ...summary(1) }],
    subIssueStatus: { 7: 404 },
  });
  /** @type {string[]} */
  const warnings = [];
  await withGitHub(handler, async (base) => {
    await new GitHubClient("o", "r", { apiBase: base, warn: (m) => warnings.push(m) }).fetchAll();
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Sub-issues:/);
  assert.match(warnings[0], /Sub-issue of #7/);
});

test("many failed parents are summarised in one warning, not one line each", async () => {
  const issues = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, ...summary(1) }));
  const { handler } = subIssueHandler({
    issues,
    subIssueStatus: Object.fromEntries(issues.map((i) => [i.number, 404])),
  });
  /** @type {string[]} */
  const warnings = [];
  await withGitHub(handler, async (base) => {
    const fetched = await new GitHubClient("o", "r", {
      apiBase: base,
      warn: (m) => warnings.push(m),
    }).fetchAll();
    assert.equal(fetched.subIssues.size, 0);
  });
  assert.equal(warnings.length, 1, `one aggregated warning, got ${warnings.length}`);
  assert.match(warnings[0], /30 issues/);
  // The list of numbers is capped, so 200 failures cannot render a 4000-char line.
  assert.match(warnings[0], /and 20 more/);
  assert.equal((warnings[0].match(/#\d+/g) ?? []).length, 10);
});

test("the sub-issue stage degrades on a rate limit instead of throwing away the fetch", async () => {
  const { handler } = subIssueHandler({
    issues: [
      { number: 7, ...summary(1) },
      { number: 9, ...summary(1) },
    ],
    subIssues: { 7: [{ number: 12 }] },
    subIssueStatus: { 9: 429 },
  });
  /** @type {string[]} */
  const warnings = [];
  await withGitHub(handler, async (base) => {
    const fetched = await new GitHubClient("o", "r", {
      apiBase: base,
      warn: (m) => warnings.push(m),
    }).fetchAll();
    // Everything gathered before the limit survives; the issues themselves are intact.
    assert.deepEqual([...fetched.subIssues], [["7", ["12"]]]);
    assert.equal(fetched.issues.length, 2);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rate limit/i);
  assert.match(warnings[0], /--token/);
});

test("a rate limit anywhere but the sub-issue stage still fails the whole fetch", async () => {
  for (const limited of ["/repos/o/r/issues", "/repos/o/r/issues/comments", "/repos/o/r/labels"]) {
    await withGitHub(
      (req, res) => {
        const { pathname } = new URL(req.url ?? "", "http://x");
        if (pathname === limited) return json(res, 429, { message: "slow down" });
        if (pathname === "/repos/o/r/issues") return json(res, 200, [{ number: 7, ...summary(1) }]);
        json(res, 200, []);
      },
      async (base) => {
        await assert.rejects(
          new GitHubClient("o", "r", { apiBase: base }).fetchAll(),
          (err) => err instanceof RateLimitError,
          `a 429 on ${limited} must fail the run`,
        );
      },
    );
  }
});

test("one parent's sub-issue pagination is bounded, so an endless rel=next cannot spin", async () => {
  let pages = 0;
  let base = "";
  await withGitHub(
    (req, res) => {
      const { pathname } = new URL(req.url ?? "", "http://x");
      if (pathname === "/repos/o/r/issues") return json(res, 200, [{ number: 7, ...summary(1) }]);
      if (pathname !== "/repos/o/r/issues/7/sub_issues") return json(res, 200, []);
      pages += 1;
      json(res, 200, [{ number: 1000 + pages }], {
        link: `<${base}/repos/o/r/issues/7/sub_issues?per_page=100&page=${pages + 1}>; rel="next"`,
      });
    },
    async (started) => {
      base = started;
      await assert.rejects(new GitHubClient("o", "r", { apiBase: base }).fetchAll(), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.match(err.message, /pages/);
        return true;
      });
    },
  );
  assert.ok(pages <= 25, `pagination stopped early, got ${pages} pages`);
});

test("a parent whose whole listing is dropped contributes no entry at all", async () => {
  const { handler } = subIssueHandler({
    issues: [{ number: 7, ...summary(3) }],
    subIssues: { 7: [{ number: 7 }, { number: "12" }, {}] },
  });
  await withGitHub(handler, async (base) => {
    const fetched = await new GitHubClient("o", "r", { apiBase: base }).fetchAll();
    assert.equal(fetched.subIssues.has("7"), false);
    assert.equal(fetched.subIssues.size, 0);
  });
});

test("a client built without a warn sink still reports a failed listing, on stderr", async () => {
  const { handler } = subIssueHandler({
    issues: [{ number: 7, ...summary(1) }],
    subIssueStatus: { 7: 404 },
  });
  /** @type {string[]} */
  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = /** @type {any} */ (
    (/** @type {any} */ chunk) => {
      written.push(String(chunk));
      return true;
    }
  );
  try {
    await withGitHub(handler, async (base) => {
      await new GitHubClient("o", "r", { apiBase: base }).fetchAll();
    });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(written.length, 1);
  assert.match(written[0], /#7/);
});

// --- releases (#31932) -------------------------------------------------------

test("fetchAll makes no releases request unless asked, and reports an empty list", async () => {
  /** @type {string[]} */
  const paths = [];
  await withGitHub(
    (req, res) => {
      paths.push(new URL(req.url ?? "", "http://x").pathname);
      json(res, 200, []);
    },
    async (base) => {
      const fetched = await new GitHubClient("o", "r", { apiBase: base }).fetchAll();
      assert.deepEqual(fetched.releases, []);
    },
  );
  assert.ok(!paths.includes("/repos/o/r/releases"), `no releases fetch, got ${paths.join(", ")}`);
  assert.equal(paths.length, 3);
});

test("fetchAll({ releases: true }) lists the repo's releases with per_page=100", async () => {
  /** @type {URL | undefined} */
  let url;
  await withGitHub(
    (req, res) => {
      const parsed = new URL(req.url ?? "", "http://x");
      if (parsed.pathname === "/repos/o/r/releases") {
        url = parsed;
        return json(res, 200, [{ id: 100, tag_name: "v2.0.0", draft: false }]);
      }
      json(res, 200, []);
    },
    async (base) => {
      const fetched = await new GitHubClient("o", "r", { apiBase: base }).fetchAll({
        releases: true,
      });
      assert.deepEqual(fetched.releases, [{ id: 100, tag_name: "v2.0.0", draft: false }]);
    },
  );
  assert.equal(url?.pathname, "/repos/o/r/releases");
  assert.equal(url?.searchParams.get("per_page"), "100");
});

test("the releases listing follows its Link rel=next across pages", async () => {
  let base = "";
  await withGitHub(
    (req, res) => {
      const parsed = new URL(req.url ?? "", "http://x");
      if (parsed.pathname !== "/repos/o/r/releases") return json(res, 200, []);
      if (parsed.searchParams.get("page") === "2") return json(res, 200, [{ id: 2 }]);
      json(res, 200, [{ id: 1 }], {
        Link: `<${base}/repos/o/r/releases?per_page=100&page=2>; rel="next"`,
      });
    },
    async (started) => {
      base = started;
      const fetched = await new GitHubClient("o", "r", { apiBase: base }).fetchAll({
        releases: true,
      });
      assert.deepEqual(
        fetched.releases.map((r) => r.id),
        [1, 2],
      );
    },
  );
});

test("the releases listing is page-bounded, so an endless rel=next cannot spin", async () => {
  let pages = 0;
  let base = "";
  await withGitHub(
    (req, res) => {
      const parsed = new URL(req.url ?? "", "http://x");
      if (parsed.pathname !== "/repos/o/r/releases") return json(res, 200, []);
      pages += 1;
      json(res, 200, [{ id: pages }], {
        link: `<${base}/repos/o/r/releases?per_page=100&page=${pages + 1}>; rel="next"`,
      });
    },
    async (started) => {
      base = started;
      await assert.rejects(
        new GitHubClient("o", "r", { apiBase: base }).fetchAll({ releases: true }),
        (err) => {
          assert.ok(err instanceof GitHubError);
          assert.match(err.message, /\/releases past \d+ pages/);
          return true;
        },
      );
    },
  );
  assert.equal(pages, MAX_RELEASE_PAGES);
});

// --- milestones (#31931) -----------------------------------------------------

// Every issue row embeds the milestone the mapper reads (title, state, due_on), so
// milestone→epic costs no request of its own — worth pinning, since the anonymous
// budget is 60/h and a listing endpoint would be a silent regression.
test("no --include selection makes fetchAll request the milestones listing", async () => {
  /** @type {string[]} */
  const paths = [];
  await withGitHub(
    (req, res) => {
      const parsed = new URL(req.url ?? "", "http://x");
      paths.push(parsed.pathname);
      if (parsed.pathname === "/repos/o/r/issues") {
        return json(res, 200, [
          {
            number: 1,
            milestone: { title: "v1.0", state: "open", due_on: "2024-12-01T00:00:00Z" },
          },
        ]);
      }
      json(res, 200, []);
    },
    async (base) => {
      const client = new GitHubClient("o", "r", { apiBase: base });
      const plain = await client.fetchAll();
      const withReleases = await client.fetchAll({ releases: true });
      // the mapper's three fields ride on the issue row itself
      assert.deepEqual(plain.issues[0].milestone, {
        title: "v1.0",
        state: "open",
        due_on: "2024-12-01T00:00:00Z",
      });
      assert.deepEqual(withReleases.issues[0].milestone, plain.issues[0].milestone);
    },
  );
  assert.ok(
    !paths.some((p) => p.includes("/milestones")),
    `no milestones fetch, got ${paths.join(", ")}`,
  );
});

// The mechanism above is pinned against the constant; the documented *value* is
// the server importer's own `MAX_PAGES` (github.rs:76), so drift would start
// refusing repos the server accepts.
test("the release page cap is the server importer's MAX_PAGES", () => {
  assert.equal(MAX_RELEASE_PAGES, 200);
});
