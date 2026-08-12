import assert from "node:assert/strict";
import { test } from "node:test";

import { EATClient, NotFoundError } from "../src/client.js";
import { EPIC_TITLE_LIMIT, milestoneEpicTitle } from "../src/mapping.js";
import { makeState, startMockServer } from "../src/mockserver.js";

test("meta and project via the client", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const meta = await client.getMeta();
    assert.ok("auth" in meta && "transitions" in meta);
    assert.equal("story_types" in meta, false);
    assert.equal((await client.getProject(91)).project_title, "Mock Project");
  } finally {
    await mock.close();
  }
});

// The create advertises `estimate` (a scale label, probed 2026-07-29), so the mock has to
// round-trip it — otherwise "the writer never sends it" is proved against a mock that
// could not have stored it either way.
test("the story create round-trips an estimate, and omits it when unsent", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const withEstimate = await client.createStory(91, { name: "sized", estimate: "3" }, "k1");
    assert.equal(withEstimate.estimate, "3");
    const without = await client.createStory(91, { name: "unsized" }, "k2");
    assert.equal("estimate" in without, false);
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

test("computed import emits external_members_created once per project", async () => {
  const mock = await startMockServer(
    makeState({
      fixture: { issues: 2, prs: 0, milestones: 0, releases: 0, labels: 0, assignees: ["alice"] },
    }),
  );
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const first = await client.importGithub(91, "o", "r", { idempotencyKey: "k1" });
    assert.deepEqual(first.external_members_created, ["alice"]);
    const second = await client.importGithub(91, "o", "r", { idempotencyKey: "k2" });
    assert.deepEqual(second.external_members_created, []);
  } finally {
    await mock.close();
  }
});

// The GitHub connector never fills the actor cells `unmatched` is built from, so every
// list stays empty; what the CLI renders from non-empty lists lives in import.test.js.
test("a computed import carries the server's full result shape", async () => {
  const mock = await startMockServer(
    makeState({
      fixture: { issues: 1, prs: 0, milestones: 0, releases: 0, labels: 0, assignees: [] },
    }),
  );
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const result = await client.importGithub(91, "o", "r", { idempotencyKey: "k1" });
    assert.deepEqual(Object.keys(result).sort(), [
      "dry_run",
      "errors",
      "external_members_created",
      "imported",
      "skipped",
      "unmatched",
      "warnings",
    ]);
    assert.deepEqual(Object.keys(result.unmatched).sort(), [
      "comment_authors",
      "followers",
      "owners",
      "requesters",
      "reviewers",
    ]);
    assert.ok(Object.values(result.unmatched).every((list) => Array.isArray(list) && !list.length));
    assert.ok(Array.isArray(result.warnings) && !result.warnings.length);
  } finally {
    await mock.close();
  }
});

test("a dry-run import does not persist external members", async () => {
  const mock = await startMockServer(
    makeState({
      fixture: { issues: 2, prs: 0, milestones: 0, releases: 0, labels: 0, assignees: ["alice"] },
    }),
  );
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const plan = await client.importGithub(91, "o", "r", { idempotencyKey: "k1", dryRun: true });
    assert.deepEqual(plan.external_members_created, ["alice"]);
    const real = await client.importGithub(91, "o", "r", { idempotencyKey: "k2" });
    assert.deepEqual(real.external_members_created, ["alice"]);
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
    // `links` is the same kind of bookkeeping and is absent from STORY_FIELDS, so no
    // read shape may carry it either — the real list returns links from its own endpoint.
    assert.ok(!("links" in story));
    assert.ok(!("links" in listed[0]));
    const paged = await (
      await fetch(`${mock.baseUrl}/projects/91/stories?limit=50`, {
        headers: { "X-TrackerToken": "ea_token" },
      })
    ).json();
    assert.ok(!("links" in paged.items[0]));
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

test("POST stories persists the provenance pair and reads it back via the filter", async () => {
  const mock = await startMockServer();
  try {
    await post(mock.baseUrl, "/projects/91/stories", {
      name: "with provenance",
      import_source: "github",
      import_external_id: "42",
    });
    await post(mock.baseUrl, "/projects/91/stories", { name: "no provenance" });
    const headers = { "X-TrackerToken": "ea_token" };
    const filtered = await (
      await fetch(
        `${mock.baseUrl}/projects/91/stories?limit=50&import_source=github&fields=story_id,import_external_id`,
        { headers },
      )
    ).json();
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].import_external_id, "42");
  } finally {
    await mock.close();
  }
});

test("half a provenance pair is rejected 400 naming both fields", async () => {
  const mock = await startMockServer();
  try {
    const res = await post(mock.baseUrl, "/projects/91/stories", {
      name: "lonely source",
      import_source: "github",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "validation_failed");
    assert.deepEqual(body.details.fields.sort(), ["import_external_id", "import_source"]);
  } finally {
    await mock.close();
  }
});

test("an old server ignores the pair and never advertises the filter", async () => {
  const mock = await startMockServer(makeState({ provenance: false }));
  try {
    // A lone field is accepted (no pair validation) and simply not persisted.
    const res = await post(mock.baseUrl, "/projects/91/stories", {
      name: "s",
      import_source: "github",
    });
    assert.equal(res.status, 200);
    const story = await res.json();
    assert.equal("import_source" in story, false);
  } finally {
    await mock.close();
  }
});

test("backdated story create persists created_at; accepted completed_at clamps forward", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    // completed_at before created_at must clamp forward to created_at.
    await client.createStory(
      91,
      {
        name: "done",
        current_state: "accepted",
        created_at: "2020-06-01T00:00:00Z",
        completed_at: "2020-01-01T00:00:00Z",
      },
      "k-clamp",
    );
    // completed_at on a non-done create is ignored.
    await client.createStory(
      91,
      { name: "open", current_state: "unstarted", created_at: "2021-01-01T00:00:00Z" },
      "k-open",
    );
    const [done, open] = mock.state.stories[91];
    assert.equal(done.created_at, "2020-06-01T00:00:00Z");
    assert.equal(done.completed_at, "2020-06-01T00:00:00Z");
    assert.equal(open.created_at, "2021-01-01T00:00:00Z");
    assert.ok(!("completed_at" in open));
  } finally {
    await mock.close();
  }
});

test("a started create persists started_at, clamping it forward to created_at", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createStory(
      91,
      {
        name: "open PR",
        current_state: "started",
        created_at: "2024-03-01T08:00:00Z",
        started_at: "2024-03-01T08:00:00Z",
      },
      "k-started",
    );
    await client.createStory(
      91,
      {
        name: "out of order",
        current_state: "started",
        created_at: "2024-03-01T08:00:00Z",
        started_at: "2020-01-01T00:00:00Z",
      },
      "k-clamp-start",
    );
    const [pr, clamped] = mock.state.stories[91];
    assert.equal(pr.started_at, "2024-03-01T08:00:00Z");
    assert.equal(clamped.started_at, "2024-03-01T08:00:00Z");
  } finally {
    await mock.close();
  }
});

// The server's one shared chain clamps against the row's creation instant whether that was
// backdated or defaulted, so an unbackdated create cannot store a start before it exists.
test("a started create with no created_at clamps started_at to the creation instant", async () => {
  const mock = await startMockServer();
  try {
    await new EATClient(mock.baseUrl, "ea_token").createStory(
      91,
      { name: "open PR", current_state: "started", started_at: "2020-01-01T00:00:00Z" },
      "k-no-created",
    );
    const [story] = mock.state.stories[91];
    assert.equal(story.started_at, story.created);
  } finally {
    await mock.close();
  }
});

// `started` is in the fields= allowlist, so a marker that never reaches it reads back as
// never started — the same pairing the backdating branch does for `created_at`/`created`.
test("a persisted started_at rides the `started` read alias", async () => {
  const mock = await startMockServer();
  try {
    await new EATClient(mock.baseUrl, "ea_token").createStory(
      91,
      {
        name: "open PR",
        current_state: "started",
        created_at: "2024-03-01T08:00:00Z",
        started_at: "2024-03-01T08:00:00Z",
      },
      "k-alias",
    );
    const res = await fetch(`${mock.baseUrl}/projects/91/stories?fields=started`, {
      headers: { "X-TrackerToken": "ea_token" },
    });
    const [row] = await res.json();
    assert.equal(row.started, "2024-03-01T08:00:00Z");
  } finally {
    await mock.close();
  }
});

// #35489 shipped strictly after #31425, so no server publishes started_at without the
// created_at pair — the older-server state must model one that has neither.
test("a server without backdating neither advertises started_at nor persists it", async () => {
  const mock = await startMockServer(makeState({ backdating: false }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    assert.equal(await client.supportsStartedBackdating(), false);
    await client.createStory(
      91,
      {
        name: "open PR",
        current_state: "started",
        created_at: "2024-03-01T08:00:00Z",
        started_at: "2024-03-01T08:00:00Z",
      },
      "k",
    );
    const [story] = mock.state.stories[91];
    assert.ok(!("started_at" in story), JSON.stringify(story));
  } finally {
    await mock.close();
  }
});

// stories.rs: `lands_started = state_rank >= STARTED_RANK`, and `rejected` is NULL-ranked.
for (const state of ["unstarted", "rejected"]) {
  test(`a started_at on a ${state} create is 400 invalid`, async () => {
    const mock = await startMockServer();
    try {
      await assert.rejects(
        new EATClient(mock.baseUrl, "ea_token").createStory(
          91,
          { name: "s", current_state: state, started_at: "2024-03-01T08:00:00Z" },
          "k",
        ),
        /** @param {any} err */ (err) => err.status === 400,
      );
    } finally {
      await mock.close();
    }
  });
}

// No deny_unknown_fields server-side, so an older server drops the key silently — a run
// against it must still import, just without the marker.
test("a server without #35489 ignores started_at instead of rejecting it", async () => {
  const mock = await startMockServer(makeState({ startedBackdating: false }));
  try {
    await new EATClient(mock.baseUrl, "ea_token").createStory(
      91,
      {
        name: "open PR",
        current_state: "started",
        created_at: "2024-03-01T08:00:00Z",
        started_at: "2024-03-01T08:00:00Z",
      },
      "k",
    );
    const [story] = mock.state.stories[91];
    assert.equal(story.created_at, "2024-03-01T08:00:00Z");
    assert.ok(!("started_at" in story), JSON.stringify(story));
  } finally {
    await mock.close();
  }
});

test("async import returns 202 then a job that progresses to done with a result", async () => {
  const mock = await startMockServer(makeState({ asyncImport: true }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const accept = await client.importGithub(91, "o", "r", { idempotencyKey: "k" });
    assert.equal(accept.status, "pending");
    assert.ok(accept.import_id);
    assert.equal(accept.imported, undefined); // async accept carries no result

    // Drive the job to its terminal phase; the mock advances one phase per GET.
    const seen = [];
    let status;
    for (let i = 0; i < 50; i += 1) {
      status = await client.getImport(91, accept.import_id);
      seen.push(status.status);
      if (status.status === "done" || status.status === "failed") break;
    }
    assert.equal(status.status, "done");
    assert.equal(seen[0], "pending");
    assert.ok(seen.includes("fetching"));
    assert.ok(seen.includes("writing"));
    // The done result equals the synchronous computed result.
    assert.deepEqual(status.result.imported, { stories: 3, labels: 0 });
    assert.equal(status.result.skipped, 0);
    assert.equal(status.project_id, 91);
    assert.equal(status.source, "github");
  } finally {
    await mock.close();
  }
});

test("a person-attributing server persists the requestor, the external owners and the author", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    /** @type {import("../src/mapping.js").ExternalPerson} */
    const bob = { source: "github", external_id: "34", username: "bob", display_name: "bob" };
    const story = await client.createStory(
      91,
      { name: "s", requestor: bob, owners: [{ external: bob }] },
      "k",
    );
    await client.createComment(91, story.story_id, "hi", "k2", { author: bob });
    const row = mock.state.stories[91][0];
    assert.deepEqual(row.people.requestor, bob);
    assert.deepEqual(row.people.owners, [bob]);
    assert.deepEqual(row.comments[0].author, bob);
    // The real read side returns polymorphic actor blocks; the mock does not model
    // them, so it must not echo the input shape back and imply it does.
    assert.equal("requestor" in story, false);
    assert.equal("owners" in story, false);
  } finally {
    await mock.close();
  }
});

test("a server with no person support 400s an external owner and ignores requestor / author", async () => {
  const mock = await startMockServer(makeState({ people: false }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    /** @type {import("../src/mapping.js").ExternalPerson} */
    const bob = { source: "github", external_id: "34", username: "bob", display_name: "bob" };
    // Pre-#32773 OwnerInput has no `external` (and no deny_unknown_fields), so
    // serde drops it and `as_target()` rejects the now-empty owner.
    await assert.rejects(
      () => client.createStory(91, { name: "s", owners: [{ external: bob }] }, "k0"),
      /exactly one of member_id \/ agent_id/,
    );
    const story = await client.createStory(91, { name: "s", requestor: bob }, "k");
    await client.createComment(91, story.story_id, "hi", "k2", { author: bob });
    const row = mock.state.stories[91][0];
    assert.ok(!("people" in row));
    assert.ok(!("author" in row.comments[0]));
  } finally {
    await mock.close();
  }
});

test("owners on story create predate person support — always advertised, unlike requestor", async () => {
  const mock = await startMockServer(makeState({ people: false }));
  try {
    const res = await fetch(`${mock.baseUrl}/openapi.json`, {
      headers: { "x-trackertoken": "ea_token" },
    });
    const spec = /** @type {any} */ (await res.json());
    const props =
      spec.paths["/api/v1/projects/{project_id}/stories"].post.requestBody.content[
        "application/json"
      ].schema.properties;
    // Story #199, not #32773: an older server still takes member/agent owners.
    assert.ok("owners" in props);
    assert.ok(!("requestor" in props));
  } finally {
    await mock.close();
  }
});

test("a non-backdating server ignores created_at on story creates", async () => {
  const mock = await startMockServer(makeState({ backdating: false }));
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createStory(91, { name: "s", created_at: "2020-01-01T00:00:00Z" }, "k");
    assert.ok(!("created_at" in mock.state.stories[91][0]));
  } finally {
    await mock.close();
  }
});

test("getImport 404s an unknown import id", async () => {
  const mock = await startMockServer(makeState({ asyncImport: true }));
  try {
    await assert.rejects(
      new EATClient(mock.baseUrl, "ea_token").getImport(91, "nope"),
      NotFoundError,
    );
  } finally {
    await mock.close();
  }
});

test("async openapi folds 202 into the import path, no invented ':202' key", async () => {
  const mock = await startMockServer(makeState({ asyncImport: true }));
  try {
    const spec = await (
      await fetch(`${mock.baseUrl}/openapi.json`, { headers: { "X-TrackerToken": "t" } })
    ).json();
    const paths = Object.keys(spec.paths);
    assert.ok(!paths.some((p) => p.includes(":202"))); // not a valid path key
    const importPath = spec.paths["/api/v1/projects/{project_id}/import/json"];
    assert.equal(importPath.post.responses["202"].description, "import accepted; poll for status");
    assert.ok("/api/v1/projects/{project_id}/imports/{import_id}" in spec.paths);
    // Feature-detection still reads the dry_run field off the same POST.
    assert.equal(await new EATClient(mock.baseUrl, "t").supportsServerDryRun(), true);
  } finally {
    await mock.close();
  }
});

// --- epics (#31931) ----------------------------------------------------------

/** @param {string} baseUrl @param {string} path */
function get(baseUrl, path) {
  return fetch(`${baseUrl}${path}`, { headers: { "X-TrackerToken": "ea_token" } });
}

test("GET epics is a bare array; an unknown project 404s", async () => {
  const mock = await startMockServer();
  try {
    const empty = await get(mock.baseUrl, "/projects/91/epics");
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), []);
    assert.equal((await get(mock.baseUrl, "/projects/999/epics")).status, 404);
  } finally {
    await mock.close();
  }
});

test("POST epics creates the epic and its backing label in one call", async () => {
  const mock = await startMockServer();
  try {
    const epic = await (
      await post(mock.baseUrl, "/projects/91/epics", { name: "V1", description: "note" })
    ).json();
    assert.equal(epic.epic_title, "V1");
    assert.equal(epic.name, "V1");
    assert.equal(epic.epic_desc, "note");
    assert.equal(epic.project_id, 91);
    assert.equal(epic.label.label_name, "V1");
    assert.equal(epic.label_id, epic.label.label_id);
    // the backing label is a real project label: a plain create of that name now conflicts
    assert.equal(mock.state.labels[91].length, 1);
    assert.equal((await post(mock.baseUrl, "/projects/91/labels", { name: "v1" })).status, 409);
    assert.deepEqual((await (await get(mock.baseUrl, "/projects/91/epics")).json())[0], epic);
  } finally {
    await mock.close();
  }
});

test("epic_title is an accepted alias for name; neither is a 400", async () => {
  const mock = await startMockServer();
  try {
    const epic = await (
      await post(mock.baseUrl, "/projects/91/epics", { epic_title: "V2" })
    ).json();
    assert.equal(epic.epic_title, "V2");
    assert.equal(epic.epic_desc, null);
    const missing = await post(mock.baseUrl, "/projects/91/epics", { description: "x" });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /name or epic_title is required/);
    assert.equal((await post(mock.baseUrl, "/projects/91/epics", { name: "  " })).status, 400);
  } finally {
    await mock.close();
  }
});

test("a duplicate epic title is a 409 conflict naming the epic, case-insensitively", async () => {
  const mock = await startMockServer();
  try {
    assert.equal((await post(mock.baseUrl, "/projects/91/epics", { name: "V1" })).status, 200);
    const conflict = await post(mock.baseUrl, "/projects/91/epics", { name: " v1 " });
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.code, "conflict");
    assert.equal(body.error, "Epic 'v1' already exists in this project");
    assert.equal(mock.state.epics[91].length, 1);
  } finally {
    await mock.close();
  }
});

test("a plain label of the same name blocks the epic with a Label conflict", async () => {
  const mock = await startMockServer();
  try {
    await post(mock.baseUrl, "/projects/91/labels", { name: "V1" });
    const conflict = await post(mock.baseUrl, "/projects/91/epics", { name: "v1" });
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.code, "conflict");
    assert.equal(body.error, "Label 'v1' already exists in this project");
    assert.deepEqual(mock.state.epics[91] ?? [], []);
  } finally {
    await mock.close();
  }
});

// Without this the mapper's truncation is never tested against a server that enforces
// the column, so a regression that stopped truncating would pass and 400 in production.
test("the epic create enforces both documented limits, in UTF-8 bytes", async () => {
  const mock = await startMockServer(
    makeState({ maxLengths: { name: EPIC_TITLE_LIMIT, description: 40 } }),
  );
  try {
    const at = milestoneEpicTitle({ title: "v".repeat(EPIC_TITLE_LIMIT + 50) });
    assert.equal(Buffer.byteLength(at, "utf8"), EPIC_TITLE_LIMIT);
    assert.equal((await post(mock.baseUrl, "/projects/91/epics", { name: at })).status, 200);

    const over = await post(mock.baseUrl, "/projects/91/epics", { name: `${at}x` });
    assert.equal(over.status, 400);
    assert.deepEqual((await over.json()).details, {
      constraint: "too_long",
      fields: ["name"],
    });

    // Bytes, not UTF-16 units: 128 × é is 256 bytes inside a 255-byte column.
    const multibyte = await post(mock.baseUrl, "/projects/91/epics", { name: "é".repeat(128) });
    assert.equal(multibyte.status, 400);
    assert.equal(
      (await post(mock.baseUrl, "/projects/91/epics", { name: "é".repeat(127) })).status,
      200,
    );

    const longDesc = await post(mock.baseUrl, "/projects/91/epics", {
      name: "bounded",
      description: "d".repeat(41),
    });
    assert.equal(longDesc.status, 400);
    assert.deepEqual((await longDesc.json()).details.fields, ["description"]);
  } finally {
    await mock.close();
  }
});

test("POST epics to a missing project 404s and honours Idempotency-Key", async () => {
  const mock = await startMockServer();
  try {
    assert.equal((await post(mock.baseUrl, "/projects/999/epics", { name: "x" })).status, 404);
    const first = await (
      await post(mock.baseUrl, "/projects/91/epics", { name: "V1" }, "e1")
    ).json();
    const replay = await post(mock.baseUrl, "/projects/91/epics", { name: "V1" }, "e1");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), first);
    assert.equal(mock.state.epics[91].length, 1);
    const reused = await post(mock.baseUrl, "/projects/91/epics", { name: "V2" }, "e1");
    assert.equal(reused.status, 409);
    assert.equal((await reused.json()).code, "idempotency_conflict");
  } finally {
    await mock.close();
  }
});

test("the mock records every request path, so a test can prove one never happened", async () => {
  const mock = await startMockServer();
  try {
    await get(mock.baseUrl, "/projects/91/epics");
    await post(mock.baseUrl, "/projects/91/labels", { name: "x" });
    assert.deepEqual(mock.state.requests, ["GET /projects/91/epics", "POST /projects/91/labels"]);
  } finally {
    await mock.close();
  }
});

// --- read-side aliases and list visibility, per CONTRACT ---------------------

test("the story read row carries both title and its name alias", async () => {
  const mock = await startMockServer();
  try {
    await post(mock.baseUrl, "/projects/91/stories", { name: "aliased" });
    const headers = { "X-TrackerToken": "ea_token" };
    const [listed] = await (await fetch(`${mock.baseUrl}/projects/91/stories`, { headers })).json();

    assert.equal(listed.title, "aliased");
    assert.equal(listed.name, "aliased");
  } finally {
    await mock.close();
  }
});

test("fields=name is in the allowlist, so it projects instead of 400ing", async () => {
  const mock = await startMockServer();
  try {
    await post(mock.baseUrl, "/projects/91/stories", { name: "aliased" });
    const response = await fetch(`${mock.baseUrl}/projects/91/stories?fields=name`, {
      headers: { "X-TrackerToken": "ea_token" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ story_id: 1, name: "aliased" }]);
  } finally {
    await mock.close();
  }
});

test("archived stories are hidden by default and admitted by include_archived", async () => {
  const mock = await startMockServer();
  try {
    for (const name of ["live", "filed"]) {
      await post(mock.baseUrl, "/projects/91/stories", { name });
    }
    mock.state.stories[91][1].archived_at = "2026-07-01T00:00:00Z";
    const headers = { "X-TrackerToken": "ea_token" };
    /** @param {string} query */
    const titles = async (query) =>
      (await (await fetch(`${mock.baseUrl}/projects/91/stories?${query}`, { headers })).json()).map(
        (/** @type {any} */ r) => r.title,
      );

    assert.deepEqual(await titles(""), ["live"]);
    assert.deepEqual(await titles("include_archived=true"), ["live", "filed"]);
    assert.deepEqual(await titles("archived=include"), ["live", "filed"]);
    assert.deepEqual(await titles("archived=only"), ["filed"]);
    assert.deepEqual(await titles("archived=exclude"), ["live"]);
  } finally {
    await mock.close();
  }
});

test("an archived value outside exclude|include|only is 400 validation_failed", async () => {
  const mock = await startMockServer();
  try {
    const response = await fetch(`${mock.baseUrl}/projects/91/stories?archived=maybe`, {
      headers: { "X-TrackerToken": "ea_token" },
    });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.code, "validation_failed");
    assert.deepEqual(payload.details.fields, ["archived"]);
  } finally {
    await mock.close();
  }
});

test("Done-panel stories are hidden by default and admitted by include_done", async () => {
  const mock = await startMockServer();
  try {
    for (const name of ["current", "done", "iceboxed"]) {
      await post(mock.baseUrl, "/projects/91/stories", { name });
    }
    // The real filter reads iteration placement; the mock has no calendar, so a row
    // carrying an iteration at all stands for one frozen on a past iteration.
    mock.state.stories[91][1].iteration_id = 7;
    Object.assign(mock.state.stories[91][2], { iteration_id: 7, icebox: true });
    const headers = { "X-TrackerToken": "ea_token" };
    /** @param {string} query */
    const titles = async (query) =>
      (await (await fetch(`${mock.baseUrl}/projects/91/stories?${query}`, { headers })).json()).map(
        (/** @type {any} */ r) => r.title,
      );

    assert.deepEqual(await titles(""), ["current", "iceboxed"]);
    assert.deepEqual(await titles("include_done=true"), ["current", "done", "iceboxed"]);
  } finally {
    await mock.close();
  }
});

test("the tri-state archived wins over include_archived when both are sent", async () => {
  const mock = await startMockServer();
  try {
    for (const name of ["live", "filed"]) {
      await post(mock.baseUrl, "/projects/91/stories", { name });
    }
    mock.state.stories[91][1].archived_at = "2026-07-01T00:00:00Z";
    const headers = { "X-TrackerToken": "ea_token" };
    /** @param {string} query */
    const titles = async (query) =>
      (await (await fetch(`${mock.baseUrl}/projects/91/stories?${query}`, { headers })).json()).map(
        (/** @type {any} */ r) => r.title,
      );

    assert.deepEqual(await titles("archived=exclude&include_archived=true"), ["live"]);
    assert.deepEqual(await titles("archived=only&include_archived=true"), ["filed"]);
  } finally {
    await mock.close();
  }
});

test("a boolean list param outside true|false is 400, the way Option<bool> rejects it", async () => {
  const mock = await startMockServer();
  try {
    for (const query of ["include_archived=yes", "include_done=1", "include_archived=TRUE"]) {
      const response = await fetch(`${mock.baseUrl}/projects/91/stories?${query}`, {
        headers: { "X-TrackerToken": "ea_token" },
      });

      assert.equal(response.status, 400, query);
      const payload = await response.json();
      assert.equal(payload.code, "validation_failed", query);
      assert.deepEqual(payload.details.fields, []);
    }
  } finally {
    await mock.close();
  }
});

test("false is a spelling Option<bool> takes, so it reads as the default", async () => {
  const mock = await startMockServer();
  try {
    await post(mock.baseUrl, "/projects/91/stories", { name: "filed" });
    mock.state.stories[91][0].archived_at = "2026-07-01T00:00:00Z";
    const response = await fetch(
      `${mock.baseUrl}/projects/91/stories?include_archived=false&include_done=false`,
      { headers: { "X-TrackerToken": "ea_token" } },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  } finally {
    await mock.close();
  }
});
