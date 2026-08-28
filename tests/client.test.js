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
  RateLimitError,
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

test("createBlocker posts blocker_desc + resolved to the story's blockers route", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const story = await client.createStory(91, { name: "s" }, "k-story-b");
    const blocker = await client.createBlocker(
      91,
      story.story_id,
      { desc: "Blocked by #90 (Upstream fix)", resolved: false },
      "k-blocker",
    );
    assert.equal(blocker.blocker_desc, "Blocked by #90 (Upstream fix)");
    assert.equal(blocker.resolved, false);
    assert.equal(blocker.story_id, story.story_id);
    assert.ok(mock.state.requests.includes(`POST /projects/91/stories/${story.story_id}/blockers`));
  } finally {
    await mock.close();
  }
});

test("createBlocker on a missing story maps to NotFoundError", async () => {
  const mock = await startMockServer();
  try {
    await assert.rejects(
      new EATClient(mock.baseUrl, "ea_token").createBlocker(91, 9999, { desc: "b" }, "k-404"),
      (err) => err instanceof NotFoundError,
    );
  } finally {
    await mock.close();
  }
});

test("fieldLimits reads maxLength from the published spec, min across aliases", async () => {
  const mock = await startMockServer(
    makeState({
      maxLengths: {
        name: 60,
        description: 500,
        task_desc: 120,
        comment_text: 150,
        blocker_desc: 255,
      },
    }),
  );
  try {
    const client = new EATClient(mock.baseUrl, "key");
    assert.deepEqual(await client.fieldLimits(), {
      storyName: 60,
      storyDescription: 500,
      taskDescription: 120,
      commentText: 150,
      blockerDesc: 255,
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

// --- started_at feature detection (story #36700) ------------------------------

test("supportsStartedBackdating is true when the spec advertises started_at, false otherwise", async () => {
  const mock = await startMockServer();
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsStartedBackdating(), true);
  } finally {
    await mock.close();
  }
  const older = await startMockServer(makeState({ startedBackdating: false }));
  try {
    assert.equal(await new EATClient(older.baseUrl, "tok").supportsStartedBackdating(), false);
  } finally {
    await older.close();
  }
});

// #35489 shipped after #31425's created_at/completed_at, so a server can publish the
// older pair and not the newer field — one probe for the pair would guess wrong here.
test("supportsStartedBackdating is independent of supportsBackdating", async () => {
  const older = await startMockServer(makeState({ startedBackdating: false }));
  try {
    const client = new EATClient(older.baseUrl, "tok");
    assert.equal(await client.supportsBackdating(), true);
    assert.equal(await client.supportsStartedBackdating(), false);
  } finally {
    await older.close();
  }
});

test("supportsStartedBackdating is false when /openapi.json is absent", async () => {
  const mock = await startMockServer(makeState({ serverDryRun: false }));
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsStartedBackdating(), false);
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

// --- dependency-import feature detection (story #31934) -----------------------

test("supportsDependencyImport is true when the import body advertises the field", async () => {
  const mock = await startMockServer();
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsDependencyImport(), true);
  } finally {
    await mock.close();
  }
  // A server that predates EAT #35491: the field is absent and, since the import
  // body rejects no unknown field, sending it anyway would import zero blockers.
  const older = await startMockServer(makeState({ dependencyImport: false }));
  try {
    assert.equal(await new EATClient(older.baseUrl, "tok").supportsDependencyImport(), false);
  } finally {
    await older.close();
  }
});

// --- story links (#31933) -----------------------------------------------------

test("supportsStoryLinks is true when the spec advertises the links path, false otherwise", async () => {
  const mock = await startMockServer();
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsStoryLinks(), true);
  } finally {
    await mock.close();
  }
  const older = await startMockServer(makeState({ storyLinks: false }));
  try {
    assert.equal(await new EATClient(older.baseUrl, "tok").supportsStoryLinks(), false);
  } finally {
    await older.close();
  }
});

test("supportsDependencyImport is false when /openapi.json is absent", async () => {
  const mock = await startMockServer(makeState({ serverDryRun: false }));
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsDependencyImport(), false);
  } finally {
    await mock.close();
  }
});

// Every sibling probe requires the project scope AND inspects the POST body; a spec
// publishing a GET-only or unscoped `…/stories/{id}/links` would otherwise probe true and
// then die part-written on exactly the 404/405 the probe exists to prevent.
test("supportsStoryLinks needs a project-scoped POST that takes a url", async () => {
  /** @param {any} paths */
  const withSpec = async (paths) => {
    /** @type {boolean | undefined} */
    let answer;
    await withServer(
      (_req, res) => json(res, 200, { paths }),
      async (base) => {
        answer = await new EATClient(base, "t").supportsStoryLinks();
      },
    );
    return answer;
  };
  const body = {
    requestBody: {
      content: { "application/json": { schema: { properties: { url: { type: "string" } } } } },
    },
  };
  const scoped = "/api/v1/projects/{project_id}/stories/{story_id}/links";
  assert.equal(await withSpec({ [scoped]: { post: body } }), true);
  // GET-only: the path is published, but nothing accepts a create.
  assert.equal(await withSpec({ [scoped]: { get: {} } }), false);
  // Unscoped: a links path outside /projects/ is not the endpoint the writer posts to.
  assert.equal(await withSpec({ "/api/v1/stories/{story_id}/links": { post: body } }), false);
  // POST that takes no url: half-support, and the writer's only required field.
  assert.equal(
    await withSpec({
      [scoped]: {
        post: {
          requestBody: {
            content: { "application/json": { schema: { properties: { title: {} } } } },
          },
        },
      },
    }),
    false,
  );
});

test("supportsStoryLinks is false when /openapi.json is absent", async () => {
  const mock = await startMockServer(makeState({ serverDryRun: false }));
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsStoryLinks(), false);
  } finally {
    await mock.close();
  }
});

test("createLink posts url + link_type with an Idempotency-Key, omitting a blank title", async () => {
  /** @type {any} */
  let body = null;
  /** @type {string | string[] | undefined} */
  let key;
  /** @type {string | undefined} */
  let path;
  await withServer(
    async (req, res) => {
      path = req.url;
      key = req.headers["idempotency-key"];
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
      json(res, 200, {});
    },
    async (base) => {
      await new EATClient(base, "t").createLink(
        91,
        5,
        { url: "https://github.com/o/r/pull/10", link_type: "pull_request" },
        "k",
      );
    },
  );
  assert.ok(path?.endsWith("/projects/91/stories/5/links"), String(path));
  assert.equal(key, "k");
  assert.deepEqual(body, { url: "https://github.com/o/r/pull/10", link_type: "pull_request" });
});

test("the mock server records a created link on its story", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const story = await client.createStory(91, { name: "a PR" }, "s1");
    await client.createLink(
      91,
      story.story_id,
      { url: "https://github.com/o/r/pull/10", link_type: "pull_request" },
      "l1",
    );
    const row = mock.state.stories[91][0];
    assert.equal(row.links.length, 1);
    assert.equal(row.links[0].url, "https://github.com/o/r/pull/10");
    assert.equal(row.links[0].link_type, "pull_request");
  } finally {
    await mock.close();
  }
});

test("a link with no url is refused, like the server's required-field check", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const story = await client.createStory(91, { name: "a PR" }, "s1");
    await assert.rejects(client.createLink(91, story.story_id, { url: "  " }, "l1"), (err) => {
      assert.ok(err instanceof EATError);
      assert.equal(err.status, 400);
      return true;
    });
  } finally {
    await mock.close();
  }
});

// `link_type` is NOT free text: handlers/story_links.rs allowlists exactly these seven
// and 400s anything else, so a future link_type must fail here rather than in production.
test("the mock accepts every allowlisted link_type and refuses one that is not", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const story = await client.createStory(91, { name: "a PR" }, "s1");
    const allowed = [
      "relates_to",
      "duplicates",
      "blocks",
      "is_blocked_by",
      "pull_request",
      "branch",
      "other",
    ];
    for (const [i, link_type] of allowed.entries()) {
      const row = await client.createLink(
        91,
        story.story_id,
        { url: "https://github.com/o/r/pull/10", link_type },
        `ok${i}`,
      );
      assert.equal(row.link_type, link_type);
    }
    // A NUL rides in on the allowlist check, not the NUL check: the refusal is
    // `invalid`, the wording `url` and `title` use, never `invalid_chars`.
    await assert.rejects(
      client.createLink(
        91,
        story.story_id,
        {
          url: "https://github.com/o/r/pull/10",
          link_type: `pull_reques${String.fromCharCode(0)}t`,
        },
        "bad-nul",
      ),
      (err) => {
        assert.equal(/** @type {any} */ (err).status, 400);
        assert.match(String(err), /invalid/);
        assert.doesNotMatch(String(err), /invalid_chars/);
        return true;
      },
    );
    for (const bad of ["pull-request", "PULL_REQUEST", "commit", ""]) {
      await assert.rejects(
        client.createLink(
          91,
          story.story_id,
          { url: "https://github.com/o/r/pull/10", link_type: bad },
          `bad-${bad}`,
        ),
        (err) => {
          assert.ok(err instanceof EATError, `${bad} was accepted`);
          assert.equal(err.status, 400);
          return true;
        },
      );
    }
  } finally {
    await mock.close();
  }
});

// validate_link_url: http(s) only (any other scheme is an XSS/SSRF primitive), no null
// bytes, and the varchar widths limits::LINK_URL / LINK_TITLE.
test("the mock refuses a non-http url, a null byte, and an over-long url or title", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const story = await client.createStory(91, { name: "a PR" }, "s1");
    const refused = [
      { url: "javascript:alert(1)" },
      { url: "file:///etc/passwd" },
      { url: "ftp://example.com/x" },
      { url: "github.com/o/r/pull/10" },
      { url: `https://example.com/\0x` },
      { url: `https://example.com/${"a".repeat(1000)}` },
      { url: "https://example.com/x", title: "t".repeat(256) },
    ];
    for (const [i, link] of refused.entries()) {
      await assert.rejects(
        client.createLink(91, story.story_id, link, `refuse${i}`),
        (err) => {
          assert.ok(err instanceof EATError, `accepted ${JSON.stringify(link)}`);
          assert.equal(err.status, 400);
          return true;
        },
        JSON.stringify(link),
      );
    }
    // Case-insensitive scheme check, matching the server's to_ascii_lowercase.
    const row = await client.createLink(91, story.story_id, { url: "HTTPS://x.test/a" }, "ok");
    assert.equal(row.url, "HTTPS://x.test/a");
  } finally {
    await mock.close();
  }
});

// Omitted link_type is derived server-side by detect_link_type, never stored null.
test("the mock derives link_type from the url when the caller omits it", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const story = await client.createStory(91, { name: "a PR" }, "s1");
    const derived = async (/** @type {string} */ url, /** @type {string} */ key) =>
      (await client.createLink(91, story.story_id, { url }, key)).link_type;
    assert.equal(await derived("https://github.com/o/r/pull/10", "d1"), "pull_request");
    assert.equal(await derived("https://github.com/o/r/tree/main", "d2"), "branch");
    assert.equal(await derived("https://example.com/x", "d3"), "other");
  } finally {
    await mock.close();
  }
});

// `rejected` carries no state_rank, so the create's done-state guard refuses a
// completed_at on one — the mock must refuse it too, or the writer's omission is untested.
test("a completed_at on a non-done create is refused", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await assert.rejects(
      client.createStory(
        91,
        {
          name: "abandoned PR",
          current_state: "rejected",
          created_at: "2024-03-01T00:00:00Z",
          completed_at: "2024-03-05T00:00:00Z",
        },
        "s1",
      ),
      (err) => {
        assert.ok(err instanceof EATError);
        assert.equal(err.status, 400);
        return true;
      },
    );
  } finally {
    await mock.close();
  }
});

test("a 4xx body's machine code lands on the error, past the message slice", async () => {
  await withServer(
    (_req, res) =>
      json(res, 400, {
        // The code sits past the 200 characters the message keeps, so only a parsed
        // body can recover it.
        error: "x".repeat(400),
        code: "invalid_chars",
      }),
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getMeta(), (err) => {
        assert.ok(err instanceof EATError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "invalid_chars");
        return true;
      });
    },
  );
});

test("a 4xx body that is not JSON leaves the code unset", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(400);
      res.end("<html>gateway said no</html>");
    },
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getMeta(), (err) => {
        assert.ok(err instanceof EATError);
        assert.equal(err.code, undefined);
        return true;
      });
    },
  );
});

test("429 maps to RateLimitError and names the advertised wait", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(429, { "Retry-After": "42" });
      res.end("slow down");
    },
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getMeta(), (err) => {
        assert.ok(err instanceof RateLimitError);
        assert.ok(err instanceof EATError);
        assert.equal(err.status, 429);
        assert.match(err.message, /42s/);
        // pollImport shares this path and the server keeps importing past a 429, so the
        // transport states the wait only; the caller that knows the engine advises.
        assert.doesNotMatch(err.message, /rerun it|The run stopped/);
        return true;
      });
    },
  );
});

test("a non-numeric Retry-After is discarded, not coerced into a wait", async () => {
  // `Number()` reads "" and "  " as 0 and "0x10" as 16, and keeps "-5"'s sign; an
  // HTTP-date Retry-After is legal and is none of those.
  for (const header of ["", "  ", "-5", "0x10", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
    await withServer(
      (_req, res) => {
        res.writeHead(429, { "Retry-After": header });
        res.end("slow down");
      },
      async (base) => {
        await assert.rejects(new EATClient(base, "tok").getMeta(), (err) => {
          assert.ok(err instanceof RateLimitError);
          assert.equal(err.retryAfter, undefined, `header ${JSON.stringify(header)}`);
          assert.match(err.message, /retry later/);
          assert.doesNotMatch(err.message, /retry after/);
          return true;
        });
      },
    );
  }
});

test("an all-digit Retry-After too large to be a number is discarded", async () => {
  // `/^\\d+$/` passes it and `Number()` reads it as Infinity — "retry after Infinitys"
  // is not a wait anyone can act on.
  await withServer(
    (_req, res) => {
      res.writeHead(429, { "Retry-After": "9".repeat(400) });
      res.end("slow down");
    },
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getMeta(), (err) => {
        assert.ok(err instanceof RateLimitError);
        assert.equal(err.retryAfter, undefined);
        assert.match(err.message, /retry later/);
        assert.doesNotMatch(err.message, /Infinity/);
        return true;
      });
    },
  );
});

test("429 without Retry-After still raises RateLimitError", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(429);
      res.end("slow down");
    },
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getMeta(), (err) => {
        assert.ok(err instanceof RateLimitError);
        assert.doesNotMatch(err.message, /NaN/);
        return true;
      });
    },
  );
});

test("a 200 whose body is not JSON fails every write as a terminal EATError, not a SyntaxError", async () => {
  // A proxy answering 200 text/html: `response.json()` throws a bare SyntaxError, which
  // the writer neither contains nor reports — the run dies with a raw Node stack.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>gateway</html>");
    },
    async (base) => {
      const client = new EATClient(base, "tok");
      /** @type {[string, () => Promise<unknown>][]} */
      const calls = [
        ["listStoryPage", () => client.listStoryPage(91)],
        ["createLabel", () => client.createLabel(91, { name: "bug" }, "k")],
        ["createEpic", () => client.createEpic(91, { name: "Sprint 4" }, "k")],
        ["createStory", () => client.createStory(91, { name: "issue" }, "k")],
        ["createTask", () => client.createTask(91, 1, { description: "t" }, "k")],
        ["createComment", () => client.createComment(91, 1, "hi", "k")],
        ["createBlocker", () => client.createBlocker(91, 1, { desc: "b" }, "k")],
        ["createLink", () => client.createLink(91, 1, { url: "https://x/1" }, "k")],
      ];
      for (const [name, call] of calls) {
        await assert.rejects(call(), (err) => {
          assert.ok(err instanceof EATError, `${name}: ${err}`);
          assert.ok(!(err instanceof SyntaxError), `${name} leaked a SyntaxError`);
          // Terminal on both writer rules: outside the >= 500 retry band and outside
          // ROW_SCOPED_STATUSES, so it is neither replayed nor skipped as one bad row.
          assert.equal(err.status, 200, `${name} status`);
          return true;
        });
      }
    },
  );
});

test("an over-long machine code is capped at the source, on the error itself", async () => {
  // Both of today's consumers cap it again, so only the error can pin the source bound.
  await withServer(
    (_req, res) => {
      json(res, 400, { code: "c".repeat(500), error: "nope" });
    },
    async (base) => {
      await assert.rejects(
        new EATClient(base, "tok").createStory(91, { name: "n" }, "k"),
        (err) => {
          assert.equal(/** @type {any} */ (err).code.length, 100);
          return true;
        },
      );
    },
  );
});

test("a Retry-After past 2^53 is discarded — isFinite alone would accept it", async () => {
  // 9007199254740993 parses to a finite double, but not the integer the header sent:
  // `Number.isFinite` passes it, and the CLI would advertise a wait that is off by one.
  await withServer(
    (_req, res) => {
      res.writeHead(429, { "Retry-After": "9007199254740993" });
      res.end("slow down");
    },
    async (base) => {
      await assert.rejects(new EATClient(base, "tok").getMeta(), (err) => {
        assert.ok(err instanceof RateLimitError);
        assert.equal(err.retryAfter, undefined);
        assert.match(err.message, /retry later/);
        assert.doesNotMatch(err.message, /9007199254740992/);
        return true;
      });
    },
  );
});
