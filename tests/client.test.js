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

test("supportsProvenanceDedup true when the openapi advertises the pair", async () => {
  const mock = await startMockServer();
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsProvenanceDedup(), true);
  } finally {
    await mock.close();
  }
});

// --- backdating feature detection + comment created_at (story #32427) ----------

test("supportsBackdating is true when the spec advertises created_at, false otherwise", async () => {
  const mock = await startMockServer();
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsBackdating(), true);
  } finally {
    await mock.close();
  }
  const older = await startMockServer(makeState({ backdating: false }));
  try {
    assert.equal(await new EATClient(older.baseUrl, "tok").supportsBackdating(), false);
  } finally {
    await older.close();
  }
});

test("supportsBackdating is false when /openapi.json is absent", async () => {
  const mock = await startMockServer(makeState({ serverDryRun: false }));
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsBackdating(), false);
  } finally {
    await mock.close();
  }
});

// --- person attribution feature detection (story #33465) ----------------------

test("supportsPersonAttribution is true when the spec advertises requestor, false otherwise", async () => {
  const mock = await startMockServer();
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsPersonAttribution(), true);
  } finally {
    await mock.close();
  }
  const older = await startMockServer(makeState({ people: false }));
  try {
    assert.equal(await new EATClient(older.baseUrl, "tok").supportsPersonAttribution(), false);
  } finally {
    await older.close();
  }
});

// Neither CreateStory nor CreateComment uses deny_unknown_fields, so half-support
// would be ignored silently — with the prefix dropped, attribution would vanish.
for (const [label, overrides] of /** @type {[string, any][]} */ ([
  ["the comment create does not advertise author", { commentAuthor: false }],
  ["the story create does not advertise requestor", { people: false, commentAuthor: true }],
])) {
  test(`supportsPersonAttribution is false when ${label}`, async () => {
    const mock = await startMockServer(makeState(overrides));
    try {
      assert.equal(await new EATClient(mock.baseUrl, "tok").supportsPersonAttribution(), false);
    } finally {
      await mock.close();
    }
  });
}

test("supportsPersonAttribution is false when /openapi.json is absent", async () => {
  const mock = await startMockServer(makeState({ serverDryRun: false }));
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsPersonAttribution(), false);
  } finally {
    await mock.close();
  }
});

test("createComment sends the author only when one is passed", async () => {
  /** @type {any[]} */
  const bodies = [];
  await withServer(
    (req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        json(res, 200, {});
      });
    },
    async (base) => {
      const client = new EATClient(base, "tok");
      /** @type {import("../src/mapping.js").ExternalPerson} */
      const author = { source: "github", external_id: "5", username: "bob", display_name: "bob" };
      await client.createComment(91, 1, "hi", "k1", { author });
      await client.createComment(91, 1, "hi", "k2");
    },
  );
  assert.deepEqual(bodies[0].author, {
    source: "github",
    external_id: "5",
    username: "bob",
    display_name: "bob",
  });
  assert.equal("author" in bodies[1], false);
});

test("supportsProvenanceDedup false when the pair is absent or the spec 404s", async () => {
  const noPair = await startMockServer(makeState({ provenance: false }));
  try {
    assert.equal(await new EATClient(noPair.baseUrl, "tok").supportsProvenanceDedup(), false);
  } finally {
    await noPair.close();
  }
  const noSpec = await startMockServer(makeState({ serverDryRun: false }));
  try {
    assert.equal(await new EATClient(noSpec.baseUrl, "tok").supportsProvenanceDedup(), false);
  } finally {
    await noSpec.close();
  }
});

test("listStoryPage sends the provenance filters as query params", async () => {
  /** @type {URL | undefined} */
  let seen;
  await withServer(
    (req, res) => {
      seen = new URL(req.url ?? "/", "http://mock");
      json(res, 200, { items: [], next_cursor: null });
    },
    async (base) => {
      await new EATClient(base, "tok").listStoryPage(91, {
        importSource: "github",
        importExternalId: "42",
        fields: "story_id",
      });
    },
  );
  assert.equal(seen?.searchParams.get("import_source"), "github");
  assert.equal(seen?.searchParams.get("import_external_id"), "42");
});

test("supportsBackdating degrades to false on an unparseable spec", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("<<not json>>");
    },
    async (base) => {
      assert.equal(await new EATClient(base, "tok").supportsBackdating(), false);
    },
  );
});

test("createComment sends created_at only when a date is supplied", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const story = await client.createStory(91, { name: "s" }, "k-story");
    await client.createComment(91, story.story_id, "dated", "k-a", {
      createdAt: "2020-01-05T00:00:00Z",
    });
    await client.createComment(91, story.story_id, "plain", "k-b");
    const [dated, plain] = mock.state.stories[91][0].comments;
    assert.equal(dated.created_at, "2020-01-05T00:00:00Z");
    assert.ok(!("created_at" in plain));
  } finally {
    await mock.close();
  }
});

// --- epics (#31931) ----------------------------------------------------------

test("listEpics returns the project's epics; a non-array body reads as none", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    assert.deepEqual(await client.listEpics(91), []);
    await client.createEpic(91, { name: "V1", description: "note" }, "k1");
    const epics = await client.listEpics(91);
    assert.equal(epics.length, 1);
    assert.equal(epics[0].epic_title, "V1");
  } finally {
    await mock.close();
  }
});

// Reading an envelope as "no epics" would POST every epic, 409 it, re-read nothing and
// report every milestone blocked — a confident lie. The unexpected shape must be visible.
test("listEpics refuses a non-array 200 body instead of reading it as an empty project", async () => {
  await withServer(
    (_req, res) => json(res, 200, { epics: [], next_cursor: null }),
    async (base) => {
      await assert.rejects(new EATClient(base, "t").listEpics(91), (err) => {
        assert.ok(err instanceof EATError);
        assert.match(err.message, /answered object, not the documented bare array of epics/);
        // The real status, so the writer's retry rule treats a contract change as terminal.
        assert.equal(err.status, 200);
        return true;
      });
    },
  );
  await withServer(
    (_req, res) => json(res, 200, null),
    async (base) => {
      await assert.rejects(new EATClient(base, "t").listEpics(91), /answered null/);
    },
  );
});

test("listEpics passes a bare array through, the empty one included", async () => {
  await withServer(
    (_req, res) => json(res, 200, []),
    async (base) => {
      assert.deepEqual(await new EATClient(base, "t").listEpics(91), []);
    },
  );
});

// `detail` is typed `string | undefined` and the writer branches on its prefix, so a
// structured `error` field must be dropped rather than stored as an object.
test("a 409 whose error field is not a string leaves detail unset", async () => {
  await withServer(
    (_req, res) => json(res, 409, { code: "conflict", error: { message: "Epic 'V1' exists" } }),
    async (base) => {
      await assert.rejects(
        new EATClient(base, "t").createEpic(91, { name: "V1", description: null }, "k"),
        (err) => {
          assert.ok(err instanceof ConflictError);
          assert.equal(err.code, "conflict");
          assert.equal(err.detail, undefined);
          return true;
        },
      );
    },
  );
});

test("a duplicate epic's 409 carries the server's own Epic/Label discriminator", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createEpic(91, { name: "V1", description: null }, "k1");
    await assert.rejects(client.createEpic(91, { name: "V1", description: null }, "k2"), (err) => {
      assert.ok(err instanceof ConflictError);
      assert.equal(err.detail, "Epic 'V1' already exists in this project");
      return true;
    });
    await client.createLabel(91, { name: "plain" }, "k3");
    await assert.rejects(
      client.createEpic(91, { name: "plain", description: null }, "k4"),
      (err) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.detail, "Label 'plain' already exists in this project");
        return true;
      },
    );
  } finally {
    await mock.close();
  }
});

test("createEpic posts name + description with an Idempotency-Key", async () => {
  /** @type {any} */
  let seen = null;
  /** @type {string | string[] | undefined} */
  let key;
  await withServer(
    async (req, res) => {
      key = req.headers["idempotency-key"];
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen = { path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
      json(res, 200, { epic_id: 1 });
    },
    async (base) => {
      await new EATClient(base, "t").createEpic(91, { name: "V1", description: "n" }, "run:epic:0");
    },
  );
  assert.equal(seen.path, "/api/v1/projects/91/epics");
  assert.deepEqual(seen.body, { name: "V1", description: "n" });
  assert.equal(key, "run:epic:0");
});

test("createEpic omits a null description rather than sending it", async () => {
  /** @type {any} */
  let body = null;
  await withServer(
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
      json(res, 200, {});
    },
    async (base) => {
      await new EATClient(base, "t").createEpic(91, { name: "V1", description: null }, "k");
    },
  );
  assert.deepEqual(body, { name: "V1" });
});

test("a duplicate epic surfaces as ConflictError with the server's conflict code", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createEpic(91, { name: "V1", description: null }, "k1");
    await assert.rejects(client.createEpic(91, { name: "V1", description: null }, "k2"), (err) => {
      assert.ok(err instanceof ConflictError);
      assert.equal(err.code, "conflict");
      return true;
    });
  } finally {
    await mock.close();
  }
});
