import assert from "node:assert/strict";
import { test } from "node:test";

import { preflight } from "../src/preflight.js";

class FakeClient {
  /** @param {{ project?: any, hasStories?: boolean }} [options] */
  constructor({ project, hasStories = false } = {}) {
    this.project = project ?? { title: "Demo" };
    this.hasStories = hasStories;
    /** @type {unknown[]} */
    this.calls = [];
  }

  async getMeta() {
    this.calls.push("meta");
    return {};
  }

  /** @param {number} projectId */
  async getProject(projectId) {
    this.calls.push(["project", projectId]);
    return this.project;
  }

  /** @param {number} projectId */
  async projectHasStories(projectId) {
    this.calls.push(["stories", projectId]);
    return this.hasStories;
  }
}

test("preflight happy path", async () => {
  const client = new FakeClient({ project: { title: "My Board" }, hasStories: false });
  assert.deepEqual(await preflight(client, 91), {
    projectId: 91,
    projectTitle: "My Board",
    nonEmpty: false,
  });
});

test("preflight checks connectivity first", async () => {
  const client = new FakeClient();
  await preflight(client, 91);
  assert.equal(client.calls[0], "meta");
});

test("preflight reports non-empty", async () => {
  assert.equal((await preflight(new FakeClient({ hasStories: true }), 91)).nonEmpty, true);
});

test("preflight title falls back to name", async () => {
  const result = await preflight(new FakeClient({ project: { name: "Named" } }), 91);
  assert.equal(result.projectTitle, "Named");
});

test("preflight title defaults when missing", async () => {
  assert.equal((await preflight(new FakeClient({ project: {} }), 7)).projectTitle, "project 7");
});

test("preflight prefers project_title", async () => {
  const client = new FakeClient({ project: { project_title: "Real Name", title: "legacy" } });
  assert.equal((await preflight(client, 91)).projectTitle, "Real Name");
});
