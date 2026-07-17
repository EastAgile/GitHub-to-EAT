import assert from "node:assert/strict";
import { test } from "node:test";

import { EATClient, NotFoundError } from "../src/client.js";
import { makeState, startMockServer } from "../src/mockserver.js";

test("meta and project via the client", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    assert.ok("story_types" in (await client.getMeta()));
    assert.equal((await client.getProject(91)).project_title, "Mock Project");
  } finally {
    await mock.close();
  }
});

test("missing project returns 404", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await assert.rejects(client.getProject(999), NotFoundError);
  } finally {
    await mock.close();
  }
});

test("hasStories reflects the state", async () => {
  const mock = await startMockServer(makeState({ stories: { 91: [{ id: 1 }] } }));
  try {
    assert.equal(await new EATClient(mock.baseUrl, "ea_token").projectHasStories(91), true);
  } finally {
    await mock.close();
  }
});

test("an empty project has no stories", async () => {
  const mock = await startMockServer();
  try {
    assert.equal(await new EATClient(mock.baseUrl, "ea_token").projectHasStories(91), false);
  } finally {
    await mock.close();
  }
});

test("missing token returns 401", async () => {
  const mock = await startMockServer();
  try {
    const response = await fetch(`${mock.baseUrl}/meta`);
    assert.equal(response.status, 401);
  } finally {
    await mock.close();
  }
});

test("import records the body and idempotency key", async () => {
  const result = { imported: { stories: 5, labels: 0 }, skipped: 1, errors: [] };
  const mock = await startMockServer(makeState({ importResult: result }));
  try {
    const response = await fetch(`${mock.baseUrl}/projects/91/import/json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TrackerToken": "ea_token",
        "Idempotency-Key": "abc",
      },
      body: JSON.stringify({ source: "github", owner: "o", repo: "r" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.equal(mock.state.imports[0].idempotency_key, "abc");
    assert.equal(mock.state.imports[0].body.source, "github");
  } finally {
    await mock.close();
  }
});

test("import to a missing project returns 404", async () => {
  const mock = await startMockServer();
  try {
    const response = await fetch(`${mock.baseUrl}/projects/999/import/json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TrackerToken": "ea_token" },
      body: JSON.stringify({ source: "github", owner: "o", repo: "r" }),
    });
    assert.equal(response.status, 404);
  } finally {
    await mock.close();
  }
});

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {unknown} body
 * @param {string} [key]
 */
function post(baseUrl, path, body, key) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TrackerToken": "ea_token",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("POST labels creates a label with the real-server response shape", async () => {
  const mock = await startMockServer();
  try {
    const response = await post(mock.baseUrl, "/projects/91/labels", {
      name: "bug",
      background_color_hex: "#ff0000",
      text_color_hex: "#ffffff",
    });
    assert.equal(response.status, 200);
    const label = await response.json();
    assert.equal(typeof label.label_id, "number");
    assert.equal(label.label_name, "bug");
    assert.equal(label.project_id, 91);
    assert.equal(label.background_color_hex, "#ff0000");
    assert.equal(label.text_color_hex, "#ffffff");
  } finally {
    await mock.close();
  }
});

test("POST labels to a missing project returns 404", async () => {
  const mock = await startMockServer();
  try {
    assert.equal((await post(mock.baseUrl, "/projects/999/labels", { name: "x" })).status, 404);
  } finally {
    await mock.close();
  }
});

test("same Idempotency-Key + same body replays without duplicating", async () => {
  const mock = await startMockServer();
  try {
    const body = { name: "bug", background_color_hex: "#ff0000" };
    const first = await (await post(mock.baseUrl, "/projects/91/labels", body, "k1")).json();
    const replay = await post(mock.baseUrl, "/projects/91/labels", body, "k1");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), first);
    assert.equal(mock.state.labels[91].length, 1);
  } finally {
    await mock.close();
  }
});

test("same Idempotency-Key + different body returns 409 idempotency_conflict", async () => {
  const mock = await startMockServer();
  try {
    await post(mock.baseUrl, "/projects/91/labels", { name: "bug" }, "k1");
    const conflict = await post(mock.baseUrl, "/projects/91/labels", { name: "other" }, "k1");
    assert.equal(conflict.status, 409);
    const payload = await conflict.json();
    assert.equal(payload.code, "idempotency_conflict");
    assert.match(payload.details.new_body_hash, /^[0-9a-f]{64}$/);
    assert.match(payload.details.original_body_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(payload.details.new_body_hash, payload.details.original_body_hash);
  } finally {
    await mock.close();
  }
});

test("POST stories creates a story, attaching labels by name", async () => {
  const mock = await startMockServer();
  try {
    const label = await (
      await post(mock.baseUrl, "/projects/91/labels", {
        name: "bug",
        background_color_hex: "#ff0000",
      })
    ).json();
    const response = await post(mock.baseUrl, "/projects/91/stories", {
      name: "Crash on save",
      description: "steps",
      story_type: "bug",
      labels: ["bug"],
    });
    assert.equal(response.status, 200);
    const story = await response.json();
    assert.equal(typeof story.story_id, "number");
    assert.equal(story.title, "Crash on save");
    assert.equal(story.description, "steps");
    assert.equal(story.story_type, "bug");
    assert.equal(story.current_state, "unstarted");
    assert.deepEqual(story.labels, [label]);
    assert.equal(mock.state.stories[91].length, 1);
  } finally {
    await mock.close();
  }
});

test("POST stories accepts current_state accepted (no estimate guard, like the real server)", async () => {
  const mock = await startMockServer();
  try {
    const response = await post(mock.baseUrl, "/projects/91/stories", {
      name: "Closed upstream",
      story_type: "feature",
      current_state: "accepted",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).current_state, "accepted");
  } finally {
    await mock.close();
  }
});

test("POST stories without a name returns 400 validation_failed", async () => {
  const mock = await startMockServer();
  try {
    const response = await post(mock.baseUrl, "/projects/91/stories", { description: "x" });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.code, "validation_failed");
    assert.deepEqual(payload.details.fields, ["name"]);
  } finally {
    await mock.close();
  }
});

test("duplicate label name returns 409 conflict, case-insensitive", async () => {
  const mock = await startMockServer();
  try {
    assert.equal((await post(mock.baseUrl, "/projects/91/labels", { name: "Dup" })).status, 200);
    const conflict = await post(mock.baseUrl, "/projects/91/labels", { name: "dup" });
    assert.equal(conflict.status, 409);
    const payload = await conflict.json();
    assert.equal(payload.code, "conflict");
    assert.equal(mock.state.labels[91].length, 1);
  } finally {
    await mock.close();
  }
});

test("omitted label colors get the server's defaults", async () => {
  const mock = await startMockServer();
  try {
    const label = await (await post(mock.baseUrl, "/projects/91/labels", { name: "plain" })).json();
    assert.equal(label.background_color_hex, "#3498db");
    assert.equal(label.text_color_hex, "#ffffff");
  } finally {
    await mock.close();
  }
});

test("story create get-or-creates unknown labels with default colors", async () => {
  const mock = await startMockServer();
  try {
    const story = await (
      await post(mock.baseUrl, "/projects/91/stories", { name: "s", labels: ["brand-new"] })
    ).json();
    assert.equal(story.labels[0].label_name, "brand-new");
    assert.equal(story.labels[0].background_color_hex, "#3498db");
    assert.equal(mock.state.labels[91].length, 1);
  } finally {
    await mock.close();
  }
});

test("empty label/task/comment bodies return 400 invalid_parameter", async () => {
  const mock = await startMockServer();
  try {
    const story = await (await post(mock.baseUrl, "/projects/91/stories", { name: "s" })).json();
    const label = await post(mock.baseUrl, "/projects/91/labels", {});
    assert.equal(label.status, 400);
    assert.equal((await label.json()).code, "invalid_parameter");
    const task = await post(mock.baseUrl, `/projects/91/stories/${story.story_id}/tasks`, {});
    assert.equal(task.status, 400);
    assert.equal((await task.json()).code, "invalid_parameter");
    const comment = await post(mock.baseUrl, `/projects/91/stories/${story.story_id}/comments`, {});
    assert.equal(comment.status, 400);
    assert.equal((await comment.json()).code, "invalid_parameter");
  } finally {
    await mock.close();
  }
});

test("task and comment request-field aliases are accepted like the real server", async () => {
  const mock = await startMockServer();
  try {
    const story = await (await post(mock.baseUrl, "/projects/91/stories", { name: "s" })).json();
    const task = await (
      await post(mock.baseUrl, `/projects/91/stories/${story.story_id}/tasks`, {
        task_desc: "via alias",
      })
    ).json();
    assert.equal(task.task_desc, "via alias");
    const comment = await (
      await post(mock.baseUrl, `/projects/91/stories/${story.story_id}/comments`, {
        comment_text: "via alias",
      })
    ).json();
    assert.equal(comment.comment_text, "via alias");
  } finally {
    await mock.close();
  }
});

test("POST tasks and comments append to the story", async () => {
  const mock = await startMockServer();
  try {
    const story = await (
      await post(mock.baseUrl, "/projects/91/stories", { name: "with subresources" })
    ).json();
    const task = await post(mock.baseUrl, `/projects/91/stories/${story.story_id}/tasks`, {
      description: "step one",
      complete: true,
    });
    assert.equal(task.status, 200);
    const taskBody = await task.json();
    assert.equal(typeof taskBody.task_id, "number");
    assert.equal(taskBody.task_desc, "step one");
    assert.equal(taskBody.complete, true);
    assert.equal(taskBody.story_id, story.story_id);

    const comment = await post(mock.baseUrl, `/projects/91/stories/${story.story_id}/comments`, {
      text: "@ghost on 2020-01-01:\n\nhello",
    });
    assert.equal(comment.status, 200);
    const commentBody = await comment.json();
    assert.equal(typeof commentBody.comment_id, "number");
    assert.equal(commentBody.comment_text, "@ghost on 2020-01-01:\n\nhello");
    assert.equal(commentBody.story_id, story.story_id);

    const row = mock.state.stories[91][0];
    assert.equal(row.tasks.length, 1);
    assert.equal(row.comments.length, 1);

    // `comments` is state-only — not a read-side field, so no HTTP payload carries it.
    assert.ok(!("comments" in story));
    const listed = await (
      await fetch(`${mock.baseUrl}/projects/91/stories`, {
        headers: { "X-TrackerToken": "ea_token" },
      })
    ).json();
    assert.ok(!("comments" in listed[0]));
    assert.equal(listed[0].comment_count, 1);
  } finally {
    await mock.close();
  }
});

test("POST tasks and comments to a missing story return 404", async () => {
  const mock = await startMockServer();
  try {
    const task = await post(mock.baseUrl, "/projects/91/stories/999/tasks", { description: "x" });
    assert.equal(task.status, 404);
    const comment = await post(mock.baseUrl, "/projects/91/stories/999/comments", { text: "x" });
    assert.equal(comment.status, 404);
  } finally {
    await mock.close();
  }
});

test("stories list pages in cursor mode with limit and cursor", async () => {
  const mock = await startMockServer();
  try {
    for (const name of ["one", "two", "three"]) {
      await post(mock.baseUrl, "/projects/91/stories", { name });
    }
    const headers = { "X-TrackerToken": "ea_token" };
    const first = await (
      await fetch(`${mock.baseUrl}/projects/91/stories?limit=2`, { headers })
    ).json();
    assert.equal(first.items.length, 2);
    assert.equal(typeof first.next_cursor, "string");
    const second = await (
      await fetch(`${mock.baseUrl}/projects/91/stories?limit=2&cursor=${first.next_cursor}`, {
        headers,
      })
    ).json();
    assert.equal(second.items.length, 1);
    assert.equal(second.next_cursor, null);
    assert.equal(second.items[0].title, "three");
  } finally {
    await mock.close();
  }
});

test("fields= projects the sparse fieldset, story_id always included", async () => {
  const mock = await startMockServer();
  try {
    await post(mock.baseUrl, "/projects/91/stories", { name: "sparse", description: "body" });
    const headers = { "X-TrackerToken": "ea_token" };
    const page = await (
      await fetch(`${mock.baseUrl}/projects/91/stories?limit=10&fields=description`, { headers })
    ).json();
    assert.deepEqual(Object.keys(page.items[0]).sort(), ["description", "story_id"]);
    // fields= alone (no limit/cursor) stays plain mode: a bare, projected array.
    const plain = await (
      await fetch(`${mock.baseUrl}/projects/91/stories?fields=description`, { headers })
    ).json();
    assert.ok(Array.isArray(plain));
    assert.deepEqual(Object.keys(plain[0]).sort(), ["description", "story_id"]);
  } finally {
    await mock.close();
  }
});

test("unknown fields= values return 400 validation_failed", async () => {
  const mock = await startMockServer();
  try {
    const response = await fetch(`${mock.baseUrl}/projects/91/stories?fields=story_id,bogus`, {
      headers: { "X-TrackerToken": "ea_token" },
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.code, "validation_failed");
    assert.deepEqual(payload.details.fields, ["bogus"]);
  } finally {
    await mock.close();
  }
});

test("invalid limit or cursor returns 400 validation_failed", async () => {
  const mock = await startMockServer();
  try {
    for (const name of ["one", "two"]) await post(mock.baseUrl, "/projects/91/stories", { name });
    const headers = { "X-TrackerToken": "ea_token" };
    for (const [query, field] of [
      ["limit=abc", "limit"],
      ["limit=0", "limit"],
      ["limit=-5", "limit"],
      ["cursor=abc&limit=2", "cursor"],
      ["cursor=-1&limit=2", "cursor"],
      ["cursor=999&limit=2", "cursor"],
    ]) {
      const response = await fetch(`${mock.baseUrl}/projects/91/stories?${query}`, { headers });
      assert.equal(response.status, 400, query);
      const payload = await response.json();
      assert.equal(payload.code, "validation_failed", query);
      assert.deepEqual(payload.details.fields, [field], query);
    }
  } finally {
    await mock.close();
  }
});

test("idempotency ledger is global: same key + same body replays across endpoints", async () => {
  const mock = await startMockServer();
  try {
    const body = { name: "xpath" };
    const label = await (await post(mock.baseUrl, "/projects/91/labels", body, "k1")).json();
    // Verified on the real server 2026-07-16: the stories endpoint replays the label payload.
    const replay = await post(mock.baseUrl, "/projects/91/stories", body, "k1");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), label);
    assert.equal(mock.state.stories[91], undefined);
  } finally {
    await mock.close();
  }
});

test("garbage POST bodies get a 400, not a crash", async () => {
  const mock = await startMockServer();
  try {
    // JSON `null` parses fine but is not an object — property access on it threw
    // an unhandled rejection that killed the whole process before the guard.
    const nullBody = await post(mock.baseUrl, "/projects/91/labels", null);
    assert.equal(nullBody.status, 400);
    const nonArrayLabels = await post(mock.baseUrl, "/projects/91/stories", {
      name: "s",
      labels: 5,
    });
    assert.equal(nonArrayLabels.status, 400);
    // Strings are iterable — without the array check this created labels b, u, g.
    const stringLabels = await post(mock.baseUrl, "/projects/91/stories", {
      name: "s",
      labels: "bug",
    });
    assert.equal(stringLabels.status, 400);
    assert.equal(mock.state.labels[91], undefined);
    // The server must still be alive and serving.
    const ok = await post(mock.baseUrl, "/projects/91/labels", { name: "alive" });
    assert.equal(ok.status, 200);
  } finally {
    await mock.close();
  }
});

test("replayed responses are snapshots, not live state", async () => {
  const mock = await startMockServer();
  try {
    const created = await (
      await post(mock.baseUrl, "/projects/91/stories", { name: "snap" }, "k1")
    ).json();
    assert.deepEqual(created.tasks, []);
    await post(mock.baseUrl, `/projects/91/stories/${created.story_id}/tasks`, {
      description: "later",
    });
    const replay = await (
      await post(mock.baseUrl, "/projects/91/stories", { name: "snap" }, "k1")
    ).json();
    assert.deepEqual(replay, created);
  } finally {
    await mock.close();
  }
});

test("failed responses are keyed and replay too", async () => {
  const mock = await startMockServer();
  try {
    const first = await post(mock.baseUrl, "/projects/91/labels", {}, "e1");
    assert.equal(first.status, 400);
    const replay = await post(mock.baseUrl, "/projects/91/labels", {}, "e1");
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), await first.json());
    assert.equal(mock.state.labels[91], undefined);
  } finally {
    await mock.close();
  }
});

test("import honors Idempotency-Key replay and conflict", async () => {
  const mock = await startMockServer();
  try {
    const body = { source: "github", owner: "o", repo: "r" };
    const first = await (await post(mock.baseUrl, "/projects/91/import/json", body, "i1")).json();
    assert.equal(first.imported.stories, 3);
    // A replay returns the stored result — a recompute would report skipped: 3.
    const replay = await (await post(mock.baseUrl, "/projects/91/import/json", body, "i1")).json();
    assert.deepEqual(replay, first);
    assert.equal(mock.state.imports.length, 1);
    const conflict = await post(
      mock.baseUrl,
      "/projects/91/import/json",
      { ...body, repo: "other" },
      "i1",
    );
    assert.equal(conflict.status, 409);
  } finally {
    await mock.close();
  }
});

test("comment_text over the configured maxLength returns 400 too_long", async () => {
  const mock = await startMockServer(makeState({ maxLengths: { comment_text: 50 } }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const story = await client.createStory(91, { name: "s" }, "k-story");
    await assert.rejects(
      client.createComment(91, story.story_id, "x".repeat(51), "k-long"),
      (err) => {
        assert.match(String(err), /too_long/);
        return true;
      },
    );
    const ok = await client.createComment(91, story.story_id, "y".repeat(50), "k-fits");
    assert.equal(ok.comment_text.length, 50);
  } finally {
    await mock.close();
  }
});

test("story name and task_desc over their maxLength are rejected too_long", async () => {
  const mock = await startMockServer(makeState({ maxLengths: { name: 10, task_desc: 10 } }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await assert.rejects(client.createStory(91, { name: "n".repeat(11) }, "k-n"), /too_long/);
    const story = await client.createStory(91, { name: "short" }, "k-s");
    await assert.rejects(
      client.createTask(91, story.story_id, { description: "t".repeat(11) }, "k-t"),
      /too_long/,
    );
  } finally {
    await mock.close();
  }
});
