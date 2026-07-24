import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthError, EATClient, EATError } from "../src/client.js";
import { startMockServer } from "../src/mockserver.js";
import { writePlan } from "../src/writer.js";
import { capture } from "./helpers.js";

/** @returns {import("../src/writer.js").WritePlan} */
function samplePlan() {
  return {
    labels: [
      { name: "bug", background_color_hex: "#ff0000", text_color_hex: "#ffffff" },
      { name: "docs" },
    ],
    // Newest first on purpose — the writer must create oldest-first.
    stories: [
      {
        external_id: "7",
        name: "newer open issue",
        description: "body B",
        story_type: "feature",
        current_state: "unstarted",
        created_at: "2024-05-01T00:00:00Z",
        completed_at: null,
        labels: ["docs"],
        tasks: [],
        comments: [],
      },
      {
        external_id: "3",
        name: "older closed issue",
        description: "body A",
        story_type: "bug",
        current_state: "accepted",
        created_at: "2020-01-01T00:00:00Z",
        completed_at: "2020-02-01T00:00:00Z",
        labels: ["bug"],
        tasks: [
          { description: "step one", complete: true },
          { description: "step two", complete: false },
        ],
        comments: [{ text: "@alice on 2020-01-05:\n\nlooks broken" }],
      },
    ],
  };
}

test("writePlan writes labels, then stories oldest-first with their subresources", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const out = capture();
    const result = await writePlan(client, 91, samplePlan(), { stream: out });

    assert.deepEqual(result, {
      labelsCreated: 2,
      labelsExisting: 0,
      stories: 2,
      tasks: 2,
      comments: 1,
    });

    const labels = mock.state.labels[91];
    assert.deepEqual(
      labels.map((l) => [l.label_name, l.background_color_hex]),
      [
        ["bug", "#ff0000"],
        ["docs", "#3498db"],
      ],
    );

    const stories = mock.state.stories[91];
    assert.deepEqual(
      stories.map((s) => s.title),
      ["older closed issue", "newer open issue"],
    );
    assert.equal(stories[0].current_state, "accepted");
    assert.equal(stories[0].labels[0].label_name, "bug");
    assert.deepEqual(
      stories[0].tasks.map((/** @type {any} */ t) => [t.task_desc, t.complete]),
      [
        ["step one", true],
        ["step two", false],
      ],
    );
    assert.equal(stories[0].comments[0].comment_text, "@alice on 2020-01-05:\n\nlooks broken");
    assert.equal(stories[1].comments.length, 0);

    // One unique Idempotency-Key per write: 2 labels + 2 stories + 2 tasks + 1 comment.
    assert.equal(Object.keys(mock.state.idempotency).length, 7);
    assert.match(out.buf, /2 labels/);
    assert.match(out.buf, /2 stories/);
  } finally {
    await mock.close();
  }
});

test("sendProvenance stamps the full pair on every create, never half of it", async () => {
  /** @type {any[]} */
  const bodies = [];
  const client = {
    createLabel: async () => ({}),
    /** @param {number} _p @param {any} story */
    createStory: async (_p, story) => {
      bodies.push(story);
      return { story_id: bodies.length };
    },
    createTask: async () => ({}),
    createComment: async () => ({}),
  };
  await writePlan(client, 91, samplePlan(), { stream: capture(), sendProvenance: true });
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    const hasSource = "import_source" in body;
    const hasExternal = "import_external_id" in body;
    // Both or neither — a lone field would 400 against the owner-gated pair.
    assert.equal(hasSource, hasExternal);
    assert.equal(hasSource, true);
    assert.equal(body.import_source, "github");
  }
  // Created oldest-first: #3 then #7.
  assert.deepEqual(
    bodies.map((b) => b.import_external_id),
    ["3", "7"],
  );
});

test("without sendProvenance the create body carries no pair", async () => {
  /** @type {any[]} */
  const bodies = [];
  const client = {
    createLabel: async () => ({}),
    /** @param {number} _p @param {any} story */
    createStory: async (_p, story) => {
      bodies.push(story);
      return { story_id: bodies.length };
    },
    createTask: async () => ({}),
    createComment: async () => ({}),
  };
  await writePlan(client, 91, samplePlan(), { stream: capture() });
  for (const body of bodies) {
    assert.equal("import_source" in body, false);
    assert.equal("import_external_id" in body, false);
  }
});

test("emoji and CJK label names survive the idempotency-key path", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const result = await writePlan(
      client,
      91,
      { labels: [{ name: "🐛 bug" }, { name: "機能" }], stories: [] },
      { stream: capture() },
    );
    assert.equal(result.labelsCreated, 2);
    assert.deepEqual(
      mock.state.labels[91].map((/** @type {any} */ l) => l.label_name),
      ["🐛 bug", "機能"],
    );
  } finally {
    await mock.close();
  }
});

test("a label that already exists counts as existing, not an error", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createLabel(91, { name: "BUG" }, "pre-existing");
    const result = await writePlan(client, 91, samplePlan(), { stream: capture() });
    assert.equal(result.labelsCreated, 1);
    assert.equal(result.labelsExisting, 1);
    assert.equal(mock.state.labels[91].length, 2);
  } finally {
    await mock.close();
  }
});

/**
 * @param {(calls: number) => Promise<any>} createLabel
 * @returns {{ client: import("../src/writer.js").WriterClient, calls: () => number }}
 */
function stubClient(createLabel) {
  let calls = 0;
  return {
    client: {
      createLabel: () => {
        calls += 1;
        return createLabel(calls);
      },
      createStory: async () => ({ story_id: 1 }),
      createTask: async () => ({}),
      createComment: async () => ({}),
    },
    calls: () => calls,
  };
}

const onlyLabelPlan = () => ({
  labels: [{ name: "flaky" }],
  stories: [],
});

test("transient failures are retried with backoff, then succeed", async () => {
  const err = new EATError("boom (503)");
  err.status = 503;
  const { client, calls } = stubClient(async (n) => {
    if (n < 3) throw err;
    return {};
  });
  const result = await writePlan(client, 91, onlyLabelPlan(), {
    stream: capture(),
    retryDelayMs: 1,
  });
  assert.equal(calls(), 3);
  assert.equal(result.labelsCreated, 1);
});

test("retries are bounded — a persistent failure propagates", async () => {
  const err = new EATError("boom (503)");
  err.status = 503;
  const { client, calls } = stubClient(async () => {
    throw err;
  });
  await assert.rejects(
    writePlan(client, 91, onlyLabelPlan(), { stream: capture(), retryDelayMs: 1 }),
    /boom/,
  );
  assert.equal(calls(), 3);
});

test("non-retryable errors fail immediately", async () => {
  const { client, calls } = stubClient(async () => {
    throw new AuthError("bad key");
  });
  await assert.rejects(
    writePlan(client, 91, onlyLabelPlan(), { stream: capture(), retryDelayMs: 1 }),
    AuthError,
  );
  assert.equal(calls(), 1);
});
