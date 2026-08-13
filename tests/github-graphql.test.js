import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import { test } from "node:test";
import {
  GitHubAuthError,
  GitHubError,
  GitHubTransportError,
  RateLimitError,
  RepoNotFoundError,
} from "../src/github.js";
import { GitHubGraphQLClient } from "../src/github-graphql.js";
import { capture } from "./helpers.js";

const QUERY = "query ImportIssues($owner: String!) { repository(owner: $owner) { id } }";

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

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Answer every request with one envelope, and hand back what was received.
 *
 * @param {unknown} payload
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function envelope(payload, status = 200, headers = {}) {
  /** @type {{ url?: string, method?: string, body?: string,
   *   headers?: http.IncomingHttpHeaders }} */
  const seen = {};
  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  const handler = async (req, res) => {
    seen.url = req.url;
    seen.method = req.method;
    seen.headers = req.headers;
    seen.body = await readBody(req);
    json(res, status, payload, headers);
  };
  return { handler, seen };
}

/**
 * A client wired to `base`, with a recording warn sink.
 *
 * @param {string} base
 * @param {{ token?: string, owner?: string, repo?: string, timeout?: number }} [options]
 */
function clientAt(base, { token = "ghp_secret", owner = "octocat", repo = "hello", timeout } = {}) {
  const warned = capture();
  const client = new GitHubGraphQLClient(owner, repo, {
    apiBase: base,
    token,
    timeout,
    warn: (message) => void warned.write(message),
  });
  return { client, warned };
}

// --- the request -------------------------------------------------------------

test("the transport POSTs operationName, query and variables to {apiBase}/graphql", async () => {
  const { handler, seen } = envelope({ data: { ok: true } });
  await withGitHub(handler, async (base) => {
    await clientAt(base).client.query("ImportIssues", QUERY, { owner: "octocat", first: 100 });
  });
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/graphql");
  assert.deepEqual(JSON.parse(seen.body ?? ""), {
    operationName: "ImportIssues",
    query: QUERY,
    variables: { owner: "octocat", first: 100 },
  });
});

test("the GraphQL request sends GitHub's Accept header and a User-Agent", async () => {
  const { handler, seen } = envelope({ data: {} });
  await withGitHub(handler, async (base) => {
    await clientAt(base).client.query("Op", QUERY, {});
  });
  assert.equal(seen.headers?.accept, "application/vnd.github+json");
  assert.ok((seen.headers?.["user-agent"] ?? "").length > 0);
});

test("a token rides the Authorization header as a Bearer credential", async () => {
  const { handler, seen } = envelope({ data: {} });
  await withGitHub(handler, async (base) => {
    await clientAt(base, { token: "ghp_xyz" }).client.query("Op", QUERY, {});
  });
  assert.equal(seen.headers?.authorization, "Bearer ghp_xyz");
});

test("the token never reaches the request body, the query string, or an error message", async () => {
  const token = "ghp_secret_do_not_leak";
  const { handler, seen } = envelope({ errors: [{ type: "FORBIDDEN", message: "nope" }] }, 200);
  await withGitHub(handler, async (base) => {
    const { client } = clientAt(base, { token });
    await assert.rejects(client.query("Op", QUERY, { owner: "octocat" }), (err) => {
      const text = `${String(err)}\n${/** @type {Error} */ (err).stack ?? ""}`;
      assert.ok(!text.includes(token), "the token leaked into the error");
      return true;
    });
  });
  // The header must still carry it, so the assertions above cannot pass vacuously.
  assert.equal(seen.headers?.authorization, `Bearer ${token}`);
  assert.ok(!(seen.url ?? "").includes(token));
  assert.ok(!(seen.body ?? "").includes(token));
});

// --- the envelope ------------------------------------------------------------

test("a well-formed envelope resolves to its data", async () => {
  const { handler } = envelope({ data: { repository: { id: "R_1" } } });
  await withGitHub(handler, async (base) => {
    const data = await clientAt(base).client.query("Op", QUERY, {});
    assert.deepEqual(data, { repository: { id: "R_1" } });
  });
});

test("a 200 that is a JSON array, not a GraphQL envelope, maps to GitHubError", async () => {
  const { handler } = envelope([{ number: 1 }]);
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(/** @type {Error} */ (err).message, /unexpected response shape/);
      // The tail separates this from the no-data branch, which is a different fault.
      assert.match(/** @type {Error} */ (err).message, /expected a GraphQL envelope/);
      return true;
    });
  });
});

test("a 200 body of literal null maps to GitHubError, not a raw TypeError", async () => {
  const { handler } = envelope(null);
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(/** @type {Error} */ (err).message, /expected a GraphQL envelope/);
      return true;
    });
  });
});

test("an envelope carrying neither data nor errors maps to GitHubError", async () => {
  const { handler } = envelope({ data: null, errors: [] });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(/** @type {Error} */ (err).message, /unexpected response shape/);
      assert.match(/** @type {Error} */ (err).message, /carried no data/);
      return true;
    });
  });
});

test("a 200 body that is not JSON at all maps to GitHubError, not a raw SyntaxError", async () => {
  await withGitHub(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Corporate proxy: request blocked</body></html>");
    },
    async (base) => {
      await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
        assert.ok(err instanceof GitHubError);
        assert.ok(!(err instanceof SyntaxError));
        assert.match(/** @type {Error} */ (err).message, /unexpected response shape/);
        return true;
      });
    },
  );
});

// --- errors classification ---------------------------------------------------

test("a RATE_LIMITED error maps to RateLimitError", async () => {
  const { handler } = envelope({ errors: [{ type: "RATE_LIMITED", message: "slow down" }] });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), RateLimitError);
  });
});

test("a NOT_FOUND error maps to RepoNotFoundError naming the repo", async () => {
  const { handler } = envelope({ errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] });
  await withGitHub(handler, async (base) => {
    await assert.rejects(
      clientAt(base, { owner: "ghost", repo: "nope" }).client.query("Op", QUERY, {}),
      (err) => {
        assert.ok(err instanceof RepoNotFoundError);
        assert.match(/** @type {Error} */ (err).message, /ghost\/nope/);
        return true;
      },
    );
  });
});

test("a repository: null payload is GraphQL's 404 and maps to RepoNotFoundError", async () => {
  const { handler } = envelope({ data: { repository: null } });
  await withGitHub(handler, async (base) => {
    await assert.rejects(
      clientAt(base, { owner: "ghost", repo: "nope" }).client.query("Op", QUERY, {}),
      (err) => {
        assert.ok(err instanceof RepoNotFoundError);
        assert.match(/** @type {Error} */ (err).message, /ghost\/nope/);
        return true;
      },
    );
  });
});

for (const type of ["FORBIDDEN", "INSUFFICIENT_SCOPES", "UNAUTHORIZED", "BAD_CREDENTIALS"]) {
  test(`a ${type} error maps to GitHubAuthError`, async () => {
    const { handler } = envelope({ errors: [{ type, message: "denied" }] });
    await withGitHub(handler, async (base) => {
      await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), GitHubAuthError);
    });
  });
}

test("an error type is classified case-insensitively, like the server's", async () => {
  const { handler } = envelope({ errors: [{ type: "not_found", message: "gone" }] });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), RepoNotFoundError);
  });
});

test("an unclassified GraphQL error maps to GitHubError quoting its message", async () => {
  const { handler } = envelope({ errors: [{ type: "SERVICE_UNAVAILABLE", message: "boom" }] });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(/** @type {Error} */ (err).message, /boom/);
      return true;
    });
  });
});

test("an error with no message falls back to its type in the GitHubError text", async () => {
  const { handler } = envelope({ errors: [{ type: "SOMETHING_ODD" }] });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(/** @type {Error} */ (err).message, /SOMETHING_ODD/);
      return true;
    });
  });
});

test("errors decide the outcome even when the envelope also carries partial data", async () => {
  const { handler } = envelope({
    data: { repository: { id: "R_1" } },
    errors: [{ type: "RATE_LIMITED", message: "slow down" }],
  });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), RateLimitError);
  });
});

test("the first error in the array decides the classification, as on the server", async () => {
  const { handler } = envelope({
    errors: [
      { type: "NOT_FOUND", message: "gone" },
      { type: "RATE_LIMITED", message: "slow down" },
    ],
  });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), RepoNotFoundError);
  });
});

test("terminal escapes in a GraphQL error message are stripped before it reaches the user", async () => {
  const { handler } = envelope({
    errors: [{ type: "ODD", message: "\x1b[2Jbad news\r\n\x1b]0;pwned\x07" }],
  });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(/** @type {Error} */ (err).message, /bad news/);
      assert.doesNotMatch(/** @type {Error} */ (err).message, /\p{Cc}/u);
      return true;
    });
  });
});

test("no SchemaLevel ladder: an undefinedField error falls to the generic GitHubError", async () => {
  const { handler } = envelope({
    errors: [
      { type: "undefinedField", message: "Field 'subIssues' doesn't exist on type 'Issue'" },
    ],
  });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.ok(!(err instanceof RepoNotFoundError));
      assert.ok(!(err instanceof GitHubAuthError));
      assert.ok(!(err instanceof RateLimitError));
      assert.match(/** @type {Error} */ (err).message, /subIssues/);
      return true;
    });
  });
});

// --- HTTP statuses (the REST mapping, reused) --------------------------------

test("an HTTP 404 maps to RepoNotFoundError naming the repo", async () => {
  const { handler } = envelope({ message: "Not Found" }, 404);
  await withGitHub(handler, async (base) => {
    await assert.rejects(
      clientAt(base, { owner: "ghost", repo: "nope" }).client.query("Op", QUERY, {}),
      (err) => {
        assert.ok(err instanceof RepoNotFoundError);
        assert.match(/** @type {Error} */ (err).message, /ghost\/nope/);
        return true;
      },
    );
  });
});

test("an HTTP 401 maps to GitHubAuthError", async () => {
  const { handler } = envelope({ message: "Bad credentials" }, 401);
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), GitHubAuthError);
  });
});

test("an HTTP 429 maps to RateLimitError with the reset time", async () => {
  const { handler } = envelope({ message: "too many requests" }, 429, {
    "x-ratelimit-reset": "1893456000",
  });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof RateLimitError);
      assert.match(/** @type {Error} */ (err).message, /2030/);
      return true;
    });
  });
});

test("an HTTP 403 with a zeroed budget maps to RateLimitError", async () => {
  const { handler } = envelope({ message: "API rate limit exceeded" }, 403, {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": "1893456000",
  });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof RateLimitError);
      assert.match(/** @type {Error} */ (err).message, /2030/);
      return true;
    });
  });
});

test("an HTTP 403 carrying retry-after prefers it over x-ratelimit-reset", async () => {
  const { handler } = envelope({ message: "secondary rate limit" }, 403, {
    "retry-after": "60",
    "x-ratelimit-remaining": "1",
    "x-ratelimit-reset": "1893456000",
  });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof RateLimitError);
      assert.match(/** @type {Error} */ (err).message, /resets in 60s/);
      assert.doesNotMatch(/** @type {Error} */ (err).message, /2030/);
      return true;
    });
  });
});

test("an HTTP 403 with budget left and no retry-after stays a plain GitHubError", async () => {
  const { handler } = envelope({ message: "forbidden" }, 403, { "x-ratelimit-remaining": "42" });
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.ok(!(err instanceof RateLimitError));
      assert.match(/** @type {Error} */ (err).message, /\(403\)/);
      return true;
    });
  });
});

test("an HTTP 500 maps to GitHubError carrying status and body", async () => {
  const { handler } = envelope({ message: "boom" }, 500);
  await withGitHub(handler, async (base) => {
    await assert.rejects(clientAt(base).client.query("Op", QUERY, {}), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(/** @type {Error} */ (err).message, /\(500\)/);
      assert.match(/** @type {Error} */ (err).message, /boom/);
      return true;
    });
  });
});

test("a request that outlives the timeout maps to GitHubTransportError naming the timeout", async () => {
  await withGitHub(
    () => {
      /* never respond */
    },
    async (base) => {
      await assert.rejects(
        clientAt(base, { timeout: 0.05 }).client.query("Op", QUERY, {}),
        (err) => {
          assert.ok(err instanceof GitHubTransportError);
          assert.match(/** @type {Error} */ (err).message, /timed out/);
          return true;
        },
      );
    },
  );
});

// --- the point budget --------------------------------------------------------

test("a rateLimit at or below 100 points warns on stderr with the reset time", async () => {
  const { handler } = envelope({
    data: { rateLimit: { remaining: 100, resetAt: "2030-01-01T00:00:00Z" }, repository: {} },
  });
  await withGitHub(handler, async (base) => {
    const { client, warned } = clientAt(base);
    await client.query("Op", QUERY, {});
    assert.match(warned.buf, /100/);
    assert.match(warned.buf, /2030-01-01T00:00:00Z/);
    assert.match(warned.buf, /point/i);
  });
});

test("a rateLimit above 100 points warns about nothing", async () => {
  const { handler } = envelope({
    data: { rateLimit: { remaining: 4999, resetAt: "2030-01-01T00:00:00Z" }, repository: {} },
  });
  await withGitHub(handler, async (base) => {
    const { client, warned } = clientAt(base);
    await client.query("Op", QUERY, {});
    assert.equal(warned.buf, "");
  });
});

test("a payload without rateLimit is not a warning", async () => {
  const { handler } = envelope({ data: { repository: {} } });
  await withGitHub(handler, async (base) => {
    const { client, warned } = clientAt(base);
    await client.query("Op", QUERY, {});
    assert.equal(warned.buf, "");
  });
});

test("a rateLimit with a non-numeric remaining is ignored rather than read as exhausted", async () => {
  const { handler } = envelope({ data: { rateLimit: { resetAt: null }, repository: {} } });
  await withGitHub(handler, async (base) => {
    const { client, warned } = clientAt(base);
    await client.query("Op", QUERY, {});
    assert.equal(warned.buf, "");
  });
});

test("a client built without a warn sink reports the point budget on stderr", async () => {
  const { handler } = envelope({
    data: { rateLimit: { remaining: 3, resetAt: "2030-01-01T00:00:00Z" }, repository: {} },
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
      await new GitHubGraphQLClient("o", "r", { apiBase: base, token: "t" }).query("Op", QUERY, {});
    });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(written.length, 1);
  assert.match(written[0], /3/);
});

test("a trailing slash on the API base does not double up the /graphql path", async () => {
  const { handler, seen } = envelope({ data: {} });
  await withGitHub(handler, async (base) => {
    const client = new GitHubGraphQLClient("o", "r", { apiBase: `${base}/`, token: "t" });
    await client.query("Op", QUERY, {});
  });
  assert.equal(seen.url, "/graphql");
});

// --- the wiring CONTRACT.md promises has not happened yet --------------------

test("no fetch stage imports the transport yet, as CONTRACT.md claims", async () => {
  const dir = new URL("../src/", import.meta.url);
  /** @type {string[]} */
  const importers = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".js") || name === "github-graphql.js") continue;
    const source = await readFile(new URL(name, dir), "utf8");
    if (/from\s+["']\.\/github-graphql\.js["']/.test(source)) importers.push(name);
  }
  // Wiring it (story #57630) must land with CONTRACT.md's "not yet wired" truthed up.
  assert.deepEqual(importers, []);
});
