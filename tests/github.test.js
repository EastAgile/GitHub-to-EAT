import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  GitHubAuthError,
  GitHubClient,
  GitHubError,
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
