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
