import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  AuthError,
  ConflictError,
  EATClient,
  EATError,
  EATTimeout,
  NotFoundError,
} from "../src/client.js";
import { makeState, startMockServer } from "../src/mockserver.js";

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

test("write methods create against the mock and 409 maps to ConflictError", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const label = await client.createLabel(
      91,
      { name: "bug", background_color_hex: "#ff0000" },
      "k-label",
    );
    assert.equal(label.label_name, "bug");
    await assert.rejects(
      client.createLabel(91, { name: "Bug" }, "k-label-dup"),
      (err) => err instanceof ConflictError && err.code === "conflict",
    );

    const story = await client.createStory(91, { name: "s", current_state: "accepted" }, "k-story");
    assert.equal(typeof story.story_id, "number");
    assert.equal(story.current_state, "accepted");

    const task = await client.createTask(
      91,
      story.story_id,
      { description: "t", complete: true },
      "k-task",
    );
    assert.equal(task.task_desc, "t");

    const comment = await client.createComment(91, story.story_id, "hello", "k-comment");
    assert.equal(comment.comment_text, "hello");
  } finally {
    await mock.close();
  }
});

test("fieldLimits reads maxLength from the published spec, min across aliases", async () => {
  const mock = await startMockServer(
    makeState({ maxLengths: { name: 60, description: 500, task_desc: 120, comment_text: 150 } }),
  );
  try {
    const client = new EATClient(mock.baseUrl, "key");
    assert.deepEqual(await client.fieldLimits(), {
      storyName: 60,
      storyDescription: 500,
      taskDescription: 120,
      commentText: 150,
    });
  } finally {
    await mock.close();
  }
});

test("fieldLimits is empty when the spec publishes no maxLength", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "key");
    assert.deepEqual(await client.fieldLimits(), {});
  } finally {
    await mock.close();
  }
});

test("fieldLimits is empty for servers without an openapi spec", async () => {
  const mock = await startMockServer(makeState({ serverDryRun: false }));
  try {
    const client = new EATClient(mock.baseUrl, "key");
    assert.deepEqual(await client.fieldLimits(), {});
  } finally {
    await mock.close();
  }
});
