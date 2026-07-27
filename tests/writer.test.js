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
        comments: [
          { text: "@alice on 2020-01-05:\n\nlooks broken", created_at: "2020-01-05T00:00:00Z" },
        ],
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

// --- backdating: created_at / completed_at on the writes (story #32427) --------

/**
 * A writer client that records every createStory / createComment body.
 *
 * @returns {{ client: import("../src/writer.js").WriterClient,
 *   stories: any[], comments: any[] }}
 */
function recordingClient() {
  /** @type {any[]} */
  const stories = [];
  /** @type {any[]} */
  const comments = [];
  return {
    client: {
      createLabel: async () => ({}),
      createStory: async (_p, story) => {
        stories.push(story);
        return { story_id: stories.length };
      },
      createTask: async () => ({}),
      createComment: async (_p, _s, text, _k, options) => {
        comments.push({ text, options });
        return {};
      },
    },
    stories,
    comments,
  };
}

/** @returns {import("../src/writer.js").WritePlan} */
function datedPlan() {
  return {
    labels: [],
    stories: [
      {
        external_id: "3",
        name: "closed",
        description: null,
        story_type: "bug",
        current_state: "accepted",
        created_at: "2020-01-01T00:00:00Z",
        completed_at: "2020-02-01T00:00:00Z",
        labels: [],
        tasks: [],
        comments: [{ text: "@a:\n\nhi", created_at: "2020-01-05T00:00:00Z" }],
      },
      {
        external_id: "7",
        name: "open",
        description: null,
        story_type: "feature",
        current_state: "unstarted",
        created_at: "2024-05-01T00:00:00Z",
        completed_at: null,
        labels: [],
        tasks: [],
        comments: [],
      },
    ],
  };
}

test("sendDates sends created_at on every story, completed_at only on accepted creates", async () => {
  const { client, stories, comments } = recordingClient();
  await writePlan(client, 91, datedPlan(), { stream: capture(), sendDates: true });

  const closed = stories.find((s) => s.name === "closed");
  const open = stories.find((s) => s.name === "open");
  assert.equal(closed.created_at, "2020-01-01T00:00:00Z");
  assert.equal(closed.completed_at, "2020-02-01T00:00:00Z");
  assert.equal(open.created_at, "2024-05-01T00:00:00Z");
  // Open issues carry no completion — the key must be absent, not null.
  assert.ok(!("completed_at" in open));

  assert.deepEqual(comments[0].options, { createdAt: "2020-01-05T00:00:00Z" });
});

test("without sendDates the story/comment bodies stay byte-identical to v3", async () => {
  const { client, stories, comments } = recordingClient();
  await writePlan(client, 91, datedPlan(), { stream: capture() });

  for (const story of stories) {
    assert.deepEqual(Object.keys(story), [
      "name",
      "description",
      "story_type",
      "current_state",
      "labels",
    ]);
  }
  assert.equal(comments[0].options, undefined);
});
