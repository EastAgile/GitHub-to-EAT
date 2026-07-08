import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { AuthError, EATClient, EATError, EATTimeout, NotFoundError } from "../src/client.js";

/**
 * Run `fn` against a throwaway local HTTP server; always tears it down.
 *
 * @param {http.RequestListener} handler
 * @param {(base: string) => Promise<void>} fn
 */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    await fn(`http://127.0.0.1:${address.port}/api/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

/**
 * @param {http.ServerResponse} res
 * @param {number} code
 * @param {unknown} payload
 */
function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

test("getMeta ok and sends the token", async () => {
  /** @type {string | string[] | undefined} */
  let token;
  await withServer(
    (req, res) => {
      token = req.headers["x-trackertoken"];
      json(res, 200, { ok: true });
    },
    async (base) => {
      assert.deepEqual(await new EATClient(base, "tok").getMeta(), { ok: true });
    },
  );
  assert.equal(token, "tok");
});

test("401 maps to AuthError", async () => {
  await withServer(
    (_req, res) => json(res, 401, { error: "no" }),
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getMeta(), AuthError);
    },
  );
});

test("403 maps to AuthError", async () => {
  await withServer(
    (_req, res) => json(res, 403, { error: "no" }),
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getProject(91), AuthError);
    },
  );
});

test("getProject ok", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/api/v1/projects/91");
      json(res, 200, { id: 91, title: "Demo" });
    },
    async (base) => {
      const project = await new EATClient(base, "tok").getProject(91);
      assert.equal(project.title, "Demo");
    },
  );
});

test("404 maps to NotFoundError", async () => {
  await withServer(
    (_req, res) => json(res, 404, { error: "not found" }),
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getProject(999), NotFoundError);
    },
  );
});

test("server error raises EATError", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    },
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getMeta(), EATError);
    },
  );
});

test("timeout maps to EATTimeout", async () => {
  await withServer(
    () => {
      // never respond; the client's timeout has to fire
    },
    async (base) => {
      const client = new EATClient(base, "tok", { timeout: 0.05 });
      await assert.rejects(client.getMeta(), EATTimeout);
    },
  );
});

test("unreachable host raises EATError", async () => {
  // Port 9 (discard) on localhost is almost certainly closed.
  const client = new EATClient("http://127.0.0.1:9/api/v1", "tok", { timeout: 2 });
  await assert.rejects(client.getMeta(), EATError);
});

test("projectHasStories true on a bare list", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/api/v1/projects/91/stories?limit=1");
      json(res, 200, [{ id: 1 }]);
    },
    async (base) => {
      assert.equal(await new EATClient(base, "tok").projectHasStories(91), true);
    },
  );
});

test("projectHasStories false on an empty list", async () => {
  await withServer(
    (_req, res) => json(res, 200, []),
    async (base) => {
      assert.equal(await new EATClient(base, "tok").projectHasStories(91), false);
    },
  );
});

test("projectHasStories true when wrapped in stories", async () => {
  await withServer(
    (_req, res) => json(res, 200, { stories: [{ id: 1 }] }),
    async (base) => {
      assert.equal(await new EATClient(base, "tok").projectHasStories(91), true);
    },
  );
});

test("projectHasStories true on a cursor page", async () => {
  await withServer(
    (_req, res) => json(res, 200, { items: [{ id: 1 }], next_cursor: null }),
    async (base) => {
      assert.equal(await new EATClient(base, "tok").projectHasStories(91), true);
    },
  );
});

test("projectHasStories false on an empty cursor page", async () => {
  await withServer(
    (_req, res) => json(res, 200, { items: [], next_cursor: null }),
    async (base) => {
      assert.equal(await new EATClient(base, "tok").projectHasStories(91), false);
    },
  );
});
