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
      await post(mock.baseUrl, "/projects/91/labels", { name: "bug", background_color_hex: "#ff0000" })
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

test("POST stories without a name returns 400", async () => {
  const mock = await startMockServer();
  try {
    const response = await post(mock.baseUrl, "/projects/91/stories", { description: "x" });
    assert.equal(response.status, 400);
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
