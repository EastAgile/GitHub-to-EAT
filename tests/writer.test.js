import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AuthError,
  ConflictError,
  EATClient,
  EATError,
  NotFoundError,
  RateLimitError,
} from "../src/client.js";
import { startMockServer } from "../src/mockserver.js";
import {
  BlockerWriteUnsupported,
  ROW_ERROR_CEILING,
  RowErrorCeiling,
  writePlan,
} from "../src/writer.js";
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
      errors: [],
      writtenStoryIds: ["3", "7"],
      epicsCreated: 0,
      epicsExisting: 0,
      epicsBlocked: 0,
      labelsCreated: 2,
      labelsExisting: 0,
      links: 0,
      stories: 2,
      tasks: 2,
      comments: 1,
      blockers: 0,
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
    listEpics: async () => [],
    createEpic: async () => ({}),
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
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  await writePlan(client, 91, samplePlan(), { stream: capture() });
  for (const body of bodies) {
    assert.equal("import_source" in body, false);
    assert.equal("import_external_id" in body, false);
  }
});

// --- person attribution on the write (story #33465) --------------------------

/** @returns {import("../src/writer.js").WritePlan} */
function peoplePlan() {
  /** @type {import("../src/mapping.js").ExternalPerson} */
  const alice = { source: "github", external_id: "12", username: "alice", display_name: "alice" };
  /** @type {import("../src/mapping.js").ExternalPerson} */
  const bob = { source: "github", external_id: "34", username: "bob", display_name: "bob" };
  return {
    labels: [],
    stories: [
      {
        external_id: "3",
        name: "issue",
        description: null,
        story_type: "bug",
        current_state: "unstarted",
        created_at: "2020-01-01T00:00:00Z",
        completed_at: null,
        labels: [],
        requestor: alice,
        owners: [bob],
        tasks: [],
        comments: [{ text: "looks broken", created_at: "2020-01-05T00:00:00Z", author: bob }],
      },
      {
        external_id: "4",
        name: "ghost-authored issue",
        description: null,
        story_type: "bug",
        current_state: "unstarted",
        created_at: "2020-01-02T00:00:00Z",
        completed_at: null,
        labels: [],
        requestor: null,
        owners: [],
        tasks: [],
        comments: [{ text: "orphan", created_at: "2020-01-06T00:00:00Z", author: null }],
      },
    ],
  };
}

test("sendPeople puts the requestor, the external owners and the comment author on the writes", async () => {
  const { client, stories, comments } = recordingClient();
  await writePlan(client, 91, peoplePlan(), { stream: capture(), sendPeople: true });
  assert.deepEqual(stories[0].requestor, {
    source: "github",
    external_id: "12",
    username: "alice",
    display_name: "alice",
  });
  // Owners ride as `{ external: … }` — the OwnerInput shape the create composer resolves.
  assert.deepEqual(stories[0].owners, [
    { external: { source: "github", external_id: "34", username: "bob", display_name: "bob" } },
  ]);
  assert.equal(comments[0]?.options?.author?.username, "bob");
});

test("sendPeople omits requestor/owners entirely for a ghost-authored, unassigned issue", async () => {
  const { client, stories, comments } = recordingClient();
  await writePlan(client, 91, peoplePlan(), { stream: capture(), sendPeople: true });
  assert.equal("requestor" in stories[1], false);
  assert.equal("owners" in stories[1], false);
  assert.equal(comments[1]?.options?.author, undefined);
});

test("without sendPeople no create body mentions a person", async () => {
  const { client, stories, comments } = recordingClient();
  await writePlan(client, 91, peoplePlan(), { stream: capture() });
  for (const body of stories) {
    assert.equal("requestor" in body, false);
    assert.equal("owners" in body, false);
  }
  for (const { options } of comments) assert.equal(options?.author, undefined);
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
      listEpics: async () => [],
      createEpic: async () => ({}),
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
      listEpics: async () => [],
      createEpic: async () => ({}),
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

// --- pull requests: rejected creates and story links (#31933) ------------------

// `rejected` carries no `state_rank` ("rejected stays NULL by design"), so the create's
// done-state guard 400s a `completed_at` on one — which every closed-unmerged PR has.
test("a rejected create sends no completed_at, even though the op carries one", async () => {
  const { client, stories } = recordingClient();
  const plan = datedPlan();
  plan.stories[0].current_state = "rejected";
  await writePlan(client, 91, plan, { stream: capture(), sendDates: true });

  const rejected = stories.find((s) => s.name === "closed");
  assert.equal(rejected.created_at, "2020-01-01T00:00:00Z");
  assert.ok(!("completed_at" in rejected), JSON.stringify(rejected));
});

// writePlan is a general plan executor, not a GitHub-only one: the guard is the server's
// done-state set (state_rank >= FINISHED_RANK), not the one state mapRepo happens to emit.
for (const state of ["finished", "delivered", "accepted"]) {
  test(`a ${state} create carries its completed_at`, async () => {
    const { client, stories } = recordingClient();
    const plan = datedPlan();
    plan.stories[0].current_state = /** @type {any} */ (state);
    await writePlan(client, 91, plan, { stream: capture(), sendDates: true });

    const done = stories.find((s) => s.name === "closed");
    assert.equal(done.completed_at, "2020-02-01T00:00:00Z", JSON.stringify(done));
  });
}

// --- backdated started_at for open PRs (#36700) --------------------------------

/** @returns {import("../src/writer.js").WritePlan} */
const startedPlan = () => ({
  labels: [],
  stories: [
    {
      external_id: "10",
      name: "open PR",
      description: null,
      story_type: "feature",
      current_state: "started",
      created_at: "2024-03-01T08:00:00Z",
      started_at: "2024-03-01T08:00:00Z",
      completed_at: null,
      labels: [],
      tasks: [],
      comments: [],
    },
  ],
});

test("sendStarted sends the open PR's started_at alongside its created_at", async () => {
  const { client, stories } = recordingClient();
  await writePlan(client, 91, startedPlan(), {
    stream: capture(),
    sendDates: true,
    sendStarted: true,
  });

  assert.equal(stories[0].started_at, "2024-03-01T08:00:00Z");
  assert.equal(stories[0].created_at, "2024-03-01T08:00:00Z");
});

test("without sendStarted a started create carries no started_at", async () => {
  const { client, stories } = recordingClient();
  await writePlan(client, 91, startedPlan(), { stream: capture(), sendDates: true });

  assert.equal(stories[0].created_at, "2024-03-01T08:00:00Z");
  assert.ok(!("started_at" in stories[0]), JSON.stringify(stories[0]));
});

// started_at clamps forward to created_at server-side, so a marker on a story stamped
// `now()` collapses to the import instant — the newer field rides only with the older.
test("sendStarted without sendDates sends no started_at", async () => {
  const { client, stories } = recordingClient();
  await writePlan(client, 91, startedPlan(), { stream: capture(), sendStarted: true });

  assert.ok(!("started_at" in stories[0]), JSON.stringify(stories[0]));
});

// With no created_at the row is stamped `now()` and the marker clamps forward onto that
// import instant, saying nothing — mapRepo never builds this, but writePlan is general.
test("a create with no created_at sends no started_at", async () => {
  const { client, stories } = recordingClient();
  const plan = startedPlan();
  plan.stories[0].created_at = null;
  await writePlan(client, 91, plan, { stream: capture(), sendDates: true, sendStarted: true });

  assert.ok(!("started_at" in stories[0]), JSON.stringify(stories[0]));
});

// `accepted` is the one state in both rank sets, so it is the only create that carries both
// markers — and the only one running the server's two clamp branches together.
test("an accepted create carries started_at and completed_at together", async () => {
  const mock = await startMockServer();
  try {
    const plan = startedPlan();
    plan.stories[0].current_state = "accepted";
    plan.stories[0].completed_at = "2024-03-05T12:00:00Z";
    await writePlan(new EATClient(mock.baseUrl, "ea_token"), 91, plan, {
      stream: capture(),
      sendDates: true,
      sendStarted: true,
    });

    const [story] = mock.state.stories[91];
    assert.equal(story.started_at, "2024-03-01T08:00:00Z");
    assert.equal(story.completed_at, "2024-03-05T12:00:00Z");
  } finally {
    await mock.close();
  }
});

// The create 400s a started_at below `started`; `rejected` is off the rank axis (NULL),
// so a closed-unmerged PR must never carry one however the plan was built.
for (const state of ["unstarted", "rejected"]) {
  test(`a ${state} create sends no started_at, even though the op carries one`, async () => {
    const { client, stories } = recordingClient();
    const plan = startedPlan();
    plan.stories[0].current_state = /** @type {any} */ (state);
    await writePlan(client, 91, plan, { stream: capture(), sendDates: true, sendStarted: true });

    assert.ok(!("started_at" in stories[0]), JSON.stringify(stories[0]));
  });
}

// writePlan is a general plan executor: the guard is the server's own rank >= started set,
// not the one state mapRepo happens to emit for an open PR.
for (const state of ["started", "finished", "delivered", "accepted"]) {
  test(`a ${state} create carries its started_at`, async () => {
    const { client, stories } = recordingClient();
    const plan = startedPlan();
    plan.stories[0].current_state = /** @type {any} */ (state);
    await writePlan(client, 91, plan, { stream: capture(), sendDates: true, sendStarted: true });

    assert.equal(stories[0].started_at, "2024-03-01T08:00:00Z", JSON.stringify(stories[0]));
  });
}

/**
 * @param {import("../src/mapping.js").StoryOp["links"]} links
 * @returns {import("../src/writer.js").WritePlan}
 */
const linkPlan = (links) => ({
  labels: [],
  stories: [
    {
      external_id: "10",
      name: "a PR",
      description: null,
      story_type: "feature",
      current_state: "started",
      created_at: "2024-03-01T08:00:00Z",
      completed_at: null,
      labels: ["pull-request"],
      links,
      tasks: [],
      comments: [],
    },
  ],
});

/** @returns {{ client: any, links: any[] }} */
function linkRecordingClient() {
  const recording = recordingClient();
  /** @type {any[]} */
  const links = [];
  return {
    client: {
      ...recording.client,
      createLink: async (/** @type {any} */ ..._args) => {
        links.push({ projectId: _args[0], storyId: _args[1], link: _args[2], key: _args[3] });
        return {};
      },
    },
    links,
  };
}

test("sendLinks writes one link per story link, keyed by plan position", async () => {
  const { client, links } = linkRecordingClient();
  const result = await writePlan(
    client,
    91,
    linkPlan([
      { url: "https://github.com/o/r/pull/10", link_type: "pull_request" },
      { url: "https://github.com/o/r/pull/11", link_type: "pull_request" },
    ]),
    { stream: capture(), runId: "run", sendLinks: true },
  );
  assert.equal(result.links, 2);
  assert.deepEqual(
    links.map((l) => l.link),
    [
      { url: "https://github.com/o/r/pull/10", link_type: "pull_request" },
      { url: "https://github.com/o/r/pull/11", link_type: "pull_request" },
    ],
  );
  assert.deepEqual(
    links.map((l) => l.key),
    ["run:link:10:0", "run:link:10:1"],
  );
  assert.equal(links[0].storyId, 1);
});

test("without sendLinks no link is written and the story create is untouched", async () => {
  const { client, links } = linkRecordingClient();
  const result = await writePlan(
    client,
    91,
    linkPlan([{ url: "https://github.com/o/r/pull/10", link_type: "pull_request" }]),
    { stream: capture() },
  );
  assert.equal(links.length, 0);
  assert.equal(result.links, 0);
});

// --- epics (#31931) ----------------------------------------------------------

/**
 * @param {import("../src/mapping.js").EpicOp[]} epics
 * @param {string[]} labels
 * @returns {import("../src/writer.js").WritePlan}
 */
function epicPlan(epics, labels = []) {
  return {
    epics,
    labels: [],
    stories: [
      {
        external_id: "1",
        name: "in the epic",
        description: null,
        story_type: "feature",
        current_state: "unstarted",
        created_at: "2024-01-01T00:00:00Z",
        completed_at: null,
        labels,
        tasks: [],
        comments: [],
      },
    ],
  };
}

test("epics are created before labels, so a same-named GitHub label folds into the epic", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const plan = epicPlan([{ title: "V1", description: "GitHub milestone — State: open" }], ["V1"]);
    plan.labels = [{ name: "V1", background_color_hex: "#ff0000", text_color_hex: "#ffffff" }];
    const result = await writePlan(client, 91, plan, { stream: capture() });

    assert.equal(result.epicsCreated, 1);
    assert.equal(result.epicsExisting, 0);
    // the plain create 409s against the epic's own backing label, so it is not counted
    assert.equal(result.labelsCreated, 0);
    assert.equal(result.labelsExisting, 1);
    assert.equal(mock.state.labels[91].length, 1);
    assert.equal(mock.state.epics[91][0].epic_desc, "GitHub milestone — State: open");
    assert.equal(mock.state.stories[91][0].labels[0].label_id, mock.state.epics[91][0].label_id);
  } finally {
    await mock.close();
  }
});

test("an epic the project already has is reused, not re-created", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createEpic(91, { name: "v1", description: "kept" }, "seed");
    const result = await writePlan(
      client,
      91,
      epicPlan([{ title: "V1", description: "new" }], ["V1"]),
      { stream: capture() },
    );
    assert.equal(result.epicsCreated, 0);
    assert.equal(result.epicsExisting, 1);
    assert.equal(mock.state.epics[91].length, 1);
    // epic_desc is written only on creation — a second run never refreshes it
    assert.equal(mock.state.epics[91][0].epic_desc, "kept");
  } finally {
    await mock.close();
  }
});

test("a racing 409 is settled by the body's own Epic marker, with no second read", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    // The scan says "absent", then the create loses the race to another run.
    let scans = 0;
    /** @type {import("../src/writer.js").WriterClient} */
    const racing = {
      createLabel: client.createLabel.bind(client),
      createStory: client.createStory.bind(client),
      createTask: client.createTask.bind(client),
      createComment: client.createComment.bind(client),
      createEpic: client.createEpic.bind(client),
      listEpics: async (projectId) => (scans++ === 0 ? [] : client.listEpics(projectId)),
    };
    await client.createEpic(91, { name: "V1", description: null }, "other-run");
    const out = capture();
    const result = await writePlan(
      racing,
      91,
      epicPlan([{ title: "V1", description: null }], ["V1"]),
      { stream: out },
    );
    // The server already answered `Epic 'V1' …`, so a second listing read adds nothing.
    assert.equal(scans, 1);
    assert.equal(result.epicsCreated, 0);
    assert.equal(result.epicsExisting, 1);
    assert.equal(result.epicsBlocked, 0);
    assert.ok(!out.buf.includes("warning:"), out.buf);
  } finally {
    await mock.close();
  }
});

/**
 * One epic against a stub whose create always 409s with `detail`, and whose second
 * listing read answers `rescan`.
 *
 * @param {string | undefined} detail the conflict's `error` field
 * @param {any[]} rescan
 */
async function conflictingEpicWrite(detail, rescan) {
  const err = new ConflictError(
    `conflict on /projects/91/epics: ${JSON.stringify({ code: "conflict", error: detail })}`,
  );
  err.status = 409;
  err.code = "conflict";
  if (detail !== undefined) err.detail = detail;

  let scans = 0;
  const out = capture();
  const result = await writePlan(
    {
      listEpics: async () => (scans++ === 0 ? [] : rescan),
      createEpic: async () => {
        throw err;
      },
      createLabel: async () => ({}),
      createStory: async () => ({ story_id: 1 }),
      createTask: async () => ({}),
      createComment: async () => ({}),
    },
    91,
    { labels: [], stories: [], epics: [{ title: "V1", description: null }] },
    { stream: out },
  );
  return { result, buf: out.buf, scans };
}

test("a Label 409 is trusted without a re-read and warns in the definite voice", async () => {
  // The listing would say the epic exists; the server's own answer outranks it.
  const { result, buf, scans } = await conflictingEpicWrite(
    "Label 'V1' already exists in this project",
    [{ epic_title: "V1" }],
  );
  assert.equal(scans, 1);
  assert.equal(result.epicsBlocked, 1);
  assert.equal(result.epicsExisting, 0);
  assert.match(buf, /a label of that name already exists in this project/);
});

// Only a body naming neither kind leaves the listing to arbitrate — and then the
// warning must not assert a cause nothing has established.
test("an unrecognised 409 body falls back to the re-read, then hedges the warning", async () => {
  const found = await conflictingEpicWrite(undefined, [{ epic_title: "V1" }]);
  assert.equal(found.scans, 2);
  assert.equal(found.result.epicsExisting, 1);
  assert.ok(!found.buf.includes("warning:"), found.buf);

  const missing = await conflictingEpicWrite("something a proxy wrote", []);
  assert.equal(missing.scans, 2);
  assert.equal(missing.result.epicsBlocked, 1);
  assert.match(missing.buf, /most likely holds it/);
  assert.ok(!missing.buf.includes("a label of that name already exists"), missing.buf);
});

test("a plain label blocking an epic warns loudly and leaves the story labelled", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createLabel(91, { name: "V1" }, "seed");
    const out = capture();
    const result = await writePlan(
      client,
      91,
      epicPlan([{ title: "V1", description: null }], ["V1"]),
      { stream: out },
    );
    assert.equal(result.epicsCreated, 0);
    assert.equal(result.epicsExisting, 0);
    assert.equal(result.epicsBlocked, 1);
    assert.match(out.buf, /warning: epic 'V1' was not created/);
    assert.match(out.buf, /a label of that name already exists/);
    assert.deepEqual(mock.state.epics[91] ?? [], []);
    assert.equal(mock.state.stories[91][0].labels[0].label_name, "V1");
  } finally {
    await mock.close();
  }
});

test("a hostile epic title cannot write control characters to the terminal", async () => {
  const hostile = "V\u001b[31m1";
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createLabel(91, { name: hostile }, "seed");
    const out = capture();
    await writePlan(client, 91, epicPlan([{ title: hostile, description: null }], []), {
      stream: out,
    });
    assert.ok(!out.buf.includes("\u001b"), JSON.stringify(out.buf));
    assert.match(out.buf, /epic 'V\[31m1' was not created/);
  } finally {
    await mock.close();
  }
});

test("an idempotency conflict on an epic create is not swallowed as already-exists", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createEpic(91, { name: "other", description: null }, "run:epic:0");
    await assert.rejects(
      writePlan(client, 91, epicPlan([{ title: "V1", description: null }], ["V1"]), {
        runId: "run",
        stream: capture(),
      }),
      /idempotency_conflict/,
    );
  } finally {
    await mock.close();
  }
});

test("a plan with no epics never touches the epic endpoints", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await writePlan(client, 91, epicPlan([], ["plain"]), { stream: capture() });
    assert.deepEqual(
      mock.state.requests.filter((r) => r.includes("/epics")),
      [],
    );
  } finally {
    await mock.close();
  }
});

// Production still answers `epic_title` only (`name` is a newer alias, absent from the
// tracker read 2026-07-29) and keys on LOWER(TRIM(epic_title)) — so the scan must too.
test("the epic scan reads epic_title alone, trimmed, and folds case", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    mock.state.epics[91] = [{ epic_id: 1, label_id: 2, epic_title: "  V1  " }];
    const result = await writePlan(
      client,
      91,
      epicPlan([{ title: "v1", description: null }], ["v1"]),
      { stream: capture() },
    );
    assert.equal(result.epicsCreated, 0);
    assert.equal(result.epicsExisting, 1);
    assert.deepEqual(
      mock.state.requests.filter((r) => r === "POST /projects/91/epics"),
      [],
    );
  } finally {
    await mock.close();
  }
});

// A server that publishes only the newer alias must still be read, or every epic POSTs,
// 409s, re-reads to nothing and is reported blocked while it sits in the listing.
test("the epic scan falls back to the name alias when epic_title is absent", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    mock.state.epics[91] = [{ epic_id: 1, label_id: 2, name: "V1" }];
    const result = await writePlan(
      client,
      91,
      epicPlan([{ title: "V1", description: null }], ["V1"]),
      { stream: capture() },
    );
    assert.equal(result.epicsExisting, 1);
    assert.equal(result.epicsCreated, 0);
    assert.equal(result.epicsBlocked, 0);
    assert.deepEqual(
      mock.state.requests.filter((r) => r === "POST /projects/91/epics"),
      [],
    );
  } finally {
    await mock.close();
  }
});

// `epic_title` is the field every version emits, so where the two disagree it decides —
// otherwise a renamed alias would hide an epic the scan is meant to find.
test("epic_title outranks a disagreeing name alias", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    mock.state.epics[91] = [{ epic_id: 1, label_id: 2, epic_title: "V1", name: "renamed" }];
    const matched = await writePlan(
      client,
      91,
      epicPlan([{ title: "V1", description: null }], ["V1"]),
      { stream: capture() },
    );
    assert.equal(matched.epicsExisting, 1);
    assert.equal(matched.epicsCreated, 0);

    // The alias itself matches nothing, so an epic really called "renamed" is created.
    const other = await writePlan(
      client,
      91,
      epicPlan([{ title: "renamed", description: null }], ["renamed"]),
      { stream: capture() },
    );
    assert.equal(other.epicsCreated, 1);
    assert.equal(other.epicsExisting, 0);
  } finally {
    await mock.close();
  }
});

// Both halves of the comparison must apply the server's own LOWER(TRIM(...)), not just
// the listing half: a plan title with padding would otherwise POST, 409 and be reported
// blocked while the epic sits in the listing.
test("the plan-side epic key is trimmed and case-folded, like the listing key", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    mock.state.epics[91] = [{ epic_id: 1, label_id: 2, epic_title: "V1" }];
    const result = await writePlan(
      client,
      91,
      epicPlan([{ title: "  v1 ", description: null }], ["  v1 "]),
      { stream: capture() },
    );
    assert.equal(result.epicsExisting, 1);
    assert.equal(result.epicsCreated, 0);
    assert.equal(result.epicsBlocked, 0);
    assert.deepEqual(
      mock.state.requests.filter((r) => r === "POST /projects/91/epics"),
      [],
    );
  } finally {
    await mock.close();
  }
});

// A listing row whose title is not a string must match nothing: coercing it would let
// `123` swallow an epic really named "123", and that epic would never be created.
test("a non-string epic title in the listing matches nothing", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    mock.state.epics[91] = [{ epic_id: 1, label_id: 2, epic_title: null, name: 123 }];
    const result = await writePlan(
      client,
      91,
      epicPlan([{ title: "123", description: null }], ["123"]),
      { stream: capture() },
    );
    assert.equal(result.epicsCreated, 1);
    assert.equal(result.epicsExisting, 0);
    assert.equal(mock.state.epics[91].length, 2);
  } finally {
    await mock.close();
  }
});

// The listing is the get half of get-or-create: posting anyway and leaning on the 409
// would work, but it spends a write per epic on every re-run and races for no reason.
test("an epic the listing already names is never POSTed at all", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    await client.createEpic(91, { name: "V1", description: null }, "seed");
    mock.state.requests.length = 0;
    await writePlan(client, 91, epicPlan([{ title: "V1", description: null }], ["V1"]), {
      stream: capture(),
    });
    assert.deepEqual(
      mock.state.requests.filter((r) => r.includes("/epics")),
      ["GET /projects/91/epics"],
    );
  } finally {
    await mock.close();
  }
});

// --- blockers (#31934) -------------------------------------------------------

test("writePlan creates one blocker per op, in order, after the story's tasks", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const plan = samplePlan();
    plan.stories[1].blockers = [
      { desc: "Blocked by #12 (Second)", resolved: false },
      { desc: "Blocked by #90 (Upstream fix)", resolved: false },
    ];
    const result = await writePlan(client, 91, plan, { stream: capture() });

    assert.equal(result.blockers, 2);
    const story = mock.state.stories[91].find((s) => s.title === "older closed issue");
    assert.deepEqual(
      story.blockers.map((/** @type {any} */ b) => [b.blocker_desc, b.resolved]),
      [
        ["Blocked by #12 (Second)", false],
        ["Blocked by #90 (Upstream fix)", false],
      ],
    );
    // Insertion order is what the writer controls: `POST /blockers` binds no
    // display order, so every row the public route writes keeps the column's default.
    assert.deepEqual(
      story.blockers.map((/** @type {any} */ b) => b.blocker_display_order),
      [0, 0],
    );
    assert.equal(story.blocker_count, 2);
    // The other story asked for none and got none.
    assert.deepEqual(
      mock.state.stories[91].find((s) => s.title === "newer open issue").blockers,
      [],
    );
  } finally {
    await mock.close();
  }
});

test("writePlan sends no blockers request for a plan with none", async () => {
  const mock = await startMockServer();
  try {
    const result = await writePlan(new EATClient(mock.baseUrl, "ea_token"), 91, samplePlan(), {
      stream: capture(),
    });
    assert.equal(result.blockers, 0);
    assert.deepEqual(
      mock.state.requests.filter((r) => r.endsWith("/blockers")),
      [],
    );
  } finally {
    await mock.close();
  }
});

test("a blocker write is idempotency-keyed per story and index, so a replay never doubles", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const plan = samplePlan();
    plan.stories[1].blockers = [{ desc: "Blocked by #90 (Upstream fix)", resolved: false }];
    // One runId, two passes: the ledger must replay the create, not repeat it.
    await writePlan(client, 91, plan, { stream: capture(), runId: "run-1" });
    const story = mock.state.stories[91].find((s) => s.title === "older closed issue");
    const before = story.blockers.length;
    await client.createBlocker(
      91,
      story.story_id,
      { desc: "Blocked by #90 (Upstream fix)", resolved: false },
      "run-1:blocker:3:0",
    );
    assert.equal(story.blockers.length, before, "the keyed replay wrote no second row");
  } finally {
    await mock.close();
  }
});

test("a plan carrying blockers fails typed, before any write, on a client that cannot write them", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    // A client that satisfies the type but omits the optional blocker write:
    // a bare TypeError here lands mid-plan, and an import never updates.
    const noBlockers = {
      createLabel: client.createLabel.bind(client),
      createStory: client.createStory.bind(client),
      createTask: client.createTask.bind(client),
      createComment: client.createComment.bind(client),
      listEpics: client.listEpics.bind(client),
      createEpic: client.createEpic.bind(client),
    };
    const plan = samplePlan();
    plan.stories[1].blockers = [{ desc: "Blocked by #90 (Upstream fix)", resolved: false }];
    await assert.rejects(
      writePlan(noBlockers, 91, plan, { stream: capture() }),
      (/** @type {any} */ err) => {
        assert.ok(err instanceof BlockerWriteUnsupported, `got ${err?.constructor?.name}`);
        // Inside the EAT hierarchy, so cli.main renders it as `error: …` + exit 1.
        assert.ok(err instanceof EATError);
        assert.match(err.message, /blocker/i);
        return true;
      },
    );
    assert.equal(mock.state.stories[91], undefined, "nothing was written first");
    assert.equal(mock.state.labels[91], undefined);
  } finally {
    await mock.close();
  }
});

test("a plan with no blockers still writes against a client without createBlocker", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "ea_token");
    const noBlockers = {
      createLabel: client.createLabel.bind(client),
      createStory: client.createStory.bind(client),
      createTask: client.createTask.bind(client),
      createComment: client.createComment.bind(client),
      listEpics: client.listEpics.bind(client),
      createEpic: client.createEpic.bind(client),
    };
    const result = await writePlan(noBlockers, 91, samplePlan(), { stream: capture() });
    assert.equal(result.stories, 2);
    assert.equal(result.blockers, 0);
  } finally {
    await mock.close();
  }
});

// --- per-row error containment: one rejected child write must not kill the run ---

/** @returns {import("../src/writer.js").WritePlan} */
function twoStoriesWithComments() {
  /**
   * @param {string} id @param {string[]} texts
   * @returns {import("../src/mapping.js").StoryOp}
   */
  const story = (id, texts) => ({
    external_id: id,
    name: `issue ${id}`,
    description: "d",
    story_type: "feature",
    current_state: "accepted",
    labels: [],
    tasks: [],
    blockers: [],
    created_at: null,
    completed_at: null,
    comments: texts.map((text) => ({ text, created_at: null, author: null })),
  });
  return { labels: [], epics: [], stories: [story("3", ["poison", "fine"]), story("7", ["fine"])] };
}

test("a comment the server rejects is recorded as a row error, not fatal", async () => {
  const rejected = new EATError(
    'request to /projects/91/stories/1/comments failed (400): {"code":"invalid_parameter"}',
  );
  rejected.status = 400;
  /** @type {string[]} */
  const written = [];
  const client = {
    createLabel: async () => ({}),
    /** @param {number} _p @param {any} story */
    createStory: async (_p, story) => ({ story_id: Number(story.name.split(" ")[1]) }),
    createTask: async () => ({}),
    /** @param {number} _p @param {number} _s @param {string} text */
    createComment: async (_p, _s, text) => {
      if (text === "poison") throw rejected;
      written.push(text);
      return {};
    },
    listEpics: async () => [],
    createEpic: async () => ({}),
  };

  const result = await writePlan(client, 91, twoStoriesWithComments(), {
    stream: capture(),
    retryDelayMs: 1,
  });

  assert.equal(result.stories, 2);
  assert.equal(result.comments, 2);
  assert.deepEqual(written, ["fine", "fine"]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, "3");
});

test("an auth failure mid-run is still fatal — it is not a row error", async () => {
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    createComment: async () => {
      throw new AuthError("bad key");
    },
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  await assert.rejects(
    writePlan(client, 91, twoStoriesWithComments(), { stream: capture(), retryDelayMs: 1 }),
    /bad key/,
  );
});

test("a rejected task is contained the same way a comment is", async () => {
  const rejected = new EATError('failed (400): {"code":"invalid_parameter"}');
  rejected.status = 400;
  const plan = twoStoriesWithComments();
  plan.stories[0].tasks = [
    { description: "poison", complete: false },
    { description: "fine", complete: false },
  ];
  /** @type {string[]} */
  const written = [];
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    /** @param {number} _p @param {number} _s @param {any} task */
    createTask: async (_p, _s, task) => {
      if (task.description === "poison") throw rejected;
      written.push(task.description);
      return {};
    },
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });
  assert.equal(result.stories, 2);
  assert.deepEqual(written, ["fine"]);
  assert.equal(result.tasks, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, "3");
});

test("a rejected blocker is contained the same way a comment is", async () => {
  const rejected = new EATError('failed (400): {"code":"invalid_parameter"}');
  rejected.status = 400;
  const plan = twoStoriesWithComments();
  plan.stories[0].blockers = [{ desc: "poison" }, { desc: "fine" }];
  /** @type {string[]} */
  const written = [];
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    createComment: async () => ({}),
    /** @param {number} _p @param {number} _s @param {{ desc: string }} blocker */
    createBlocker: async (_p, _s, blocker) => {
      if (blocker.desc === "poison") throw rejected;
      written.push(blocker.desc);
      return {};
    },
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });
  assert.equal(result.stories, 2);
  assert.deepEqual(written, ["fine"]);
  assert.equal(result.blockers, 1);
  assert.equal(result.errors.length, 1);
});

test("a rejected story create skips its children and continues to the next story", async () => {
  const rejected = new EATError('failed (400): {"code":"invalid_parameter"}');
  rejected.status = 400;
  let comments = 0;
  const client = {
    createLabel: async () => ({}),
    /** @param {number} _p @param {any} story */
    createStory: async (_p, story) => {
      if (story.name === "issue 3") throw rejected;
      return { story_id: 7 };
    },
    createTask: async () => ({}),
    createComment: async () => {
      comments += 1;
      return {};
    },
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  const result = await writePlan(client, 91, twoStoriesWithComments(), {
    stream: capture(),
    retryDelayMs: 1,
  });
  // A skipped story's comments are never attempted against a story that does not exist.
  assert.equal(result.stories, 1);
  assert.equal(comments, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, "3");
});

/**
 * An EATError the server would raise for one row.
 *
 * @param {number} status @param {string} [code]
 * @returns {EATError}
 */
function refusal(status, code) {
  const err = new EATError(`failed (${status})`);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * A client whose comment writes throw `err` for the text "poison".
 *
 * @param {unknown} err
 */
function clientRejectingPoison(err) {
  return {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    /** @param {number} _p @param {number} _s @param {string} text */
    createComment: async (_p, _s, text) => {
      if (text === "poison") throw err;
      return {};
    },
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
}

for (const status of [400, 413, 422]) {
  test(`a ${status} refusal of one comment is contained`, async () => {
    const result = await writePlan(
      clientRejectingPoison(refusal(status)),
      91,
      twoStoriesWithComments(),
      {
        stream: capture(),
        retryDelayMs: 1,
      },
    );
    assert.equal(result.stories, 2);
    assert.equal(result.errors.length, 1);
  });
}

// A blocklist would absorb these: they say the run is wrong (payment, proxy auth, locked
// resource, legal block), never that one comment's text is unacceptable.
for (const status of [402, 407, 423, 431, 451]) {
  test(`a ${status} refusal is fatal, not contained`, async () => {
    await assert.rejects(
      writePlan(clientRejectingPoison(refusal(status)), 91, twoStoriesWithComments(), {
        stream: capture(),
        retryDelayMs: 1,
      }),
      /failed \(\d+\)/,
    );
  });
}

test("a 429 mid-run fails the run and names the wait", async () => {
  const limit = new RateLimitError("rate limit hit (429); retry after 42s");
  limit.status = 429;
  limit.retryAfter = 42;
  await assert.rejects(
    writePlan(clientRejectingPoison(limit), 91, twoStoriesWithComments(), {
      stream: capture(),
      retryDelayMs: 1,
    }),
    /retry after 42s/,
  );
});

test("a 429 is not retried — one attempt, then the run stops", async () => {
  const limit = new RateLimitError("rate limit hit (429)");
  limit.status = 429;
  let attempts = 0;
  const client = {
    createLabel: async () => ({}),
    createStory: async () => {
      attempts += 1;
      throw limit;
    },
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  await assert.rejects(
    writePlan(client, 91, twoStoriesWithComments(), { stream: capture(), retryDelayMs: 1 }),
    RateLimitError,
  );
  assert.equal(attempts, 1);
});

test("a systemic 400 aborts once the consecutive-failure ceiling is reached", async () => {
  /** @param {string} id @returns {import("../src/mapping.js").StoryOp} */
  const story = (id) => ({
    external_id: id,
    name: `issue ${id}`,
    description: "d",
    story_type: "feature",
    current_state: "accepted",
    labels: [],
    tasks: [],
    blockers: [],
    created_at: null,
    completed_at: null,
    comments: [],
  });
  const plan = {
    labels: [],
    epics: [],
    stories: Array.from({ length: 200 }, (_, i) => story(String(i))),
  };
  let attempted = 0;
  const client = {
    createLabel: async () => ({}),
    createStory: async () => {
      attempted += 1;
      throw refusal(400, "invalid_parameter");
    },
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  await assert.rejects(
    writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 }),
    RowErrorCeiling,
  );
  // It gave up near the ceiling rather than burning all 200 rows.
  assert.ok(attempted <= ROW_ERROR_CEILING, `attempted ${attempted} rows`);
});

test("a success between refusals resets the ceiling, so a sparse failure never aborts", async () => {
  /** @param {string} id @returns {import("../src/mapping.js").StoryOp} */
  const story = (id) => ({
    external_id: id,
    name: `issue ${id}`,
    description: "d",
    story_type: "feature",
    current_state: "accepted",
    labels: [],
    tasks: [],
    blockers: [],
    created_at: null,
    completed_at: null,
    comments: [],
  });
  const plan = {
    labels: [],
    epics: [],
    stories: Array.from({ length: 200 }, (_, i) => story(String(i))),
  };
  let n = 0;
  const client = {
    createLabel: async () => ({}),
    createStory: async () => {
      n += 1;
      if (n % 2 === 0) throw refusal(400, "invalid_parameter");
      return { story_id: n };
    },
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });
  assert.equal(result.stories, 100);
  assert.equal(result.errors.length, 100);
});

/** @param {string} id @returns {import("../src/mapping.js").StoryOp} */
function bareStory(id) {
  return {
    external_id: id,
    name: `issue ${id}`,
    description: "d",
    story_type: "feature",
    current_state: "accepted",
    labels: [],
    tasks: [],
    blockers: [],
    created_at: null,
    completed_at: null,
    comments: [],
  };
}

test("a systemically refused comment aborts, though every story create succeeds", async () => {
  const plan = {
    labels: [],
    epics: [],
    stories: Array.from({ length: 500 }, (_, i) => {
      const op = bareStory(String(i));
      op.comments = ["a", "b", "c"].map((text) => ({ text, created_at: null }));
      return op;
    }),
  };
  let stories = 0;
  const client = {
    createLabel: async () => ({}),
    createStory: async () => {
      stories += 1;
      return { story_id: stories };
    },
    createTask: async () => ({}),
    createComment: async () => {
      throw refusal(400, "invalid_parameter");
    },
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  await assert.rejects(
    writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 }),
    RowErrorCeiling,
  );
  // 3 refusals per story, so it must give up inside the first handful of rows.
  assert.ok(stories <= ROW_ERROR_CEILING, `wrote ${stories} stories before giving up`);
});

test("the ceiling error carries the rows it already skipped", async () => {
  const plan = {
    labels: [],
    epics: [],
    stories: Array.from({ length: 200 }, (_, i) => bareStory(String(i))),
  };
  const client = {
    createLabel: async () => ({}),
    createStory: async () => {
      throw refusal(400, "invalid_parameter");
    },
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  await assert.rejects(
    writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 }),
    (err) => {
      assert.ok(err instanceof RowErrorCeiling);
      assert.equal(err.errors.length, ROW_ERROR_CEILING);
      assert.equal(err.errors[0].code, "invalid_parameter");
      assert.equal(err.errors[0].row, "0");
      return true;
    },
  );
});

test("the ceiling message carries no control characters from the server's body", async () => {
  const plan = {
    labels: [],
    epics: [],
    stories: Array.from({ length: 40 }, (_, i) => bareStory(`${i}\u001b[2K\r`)),
  };
  const poison = refusal(400, "invalid_parameter");
  poison.message = `refused\u001b[2K\rby a proxy ${"y".repeat(400)}`;
  const client = {
    createLabel: async () => ({}),
    createStory: async () => {
      throw poison;
    },
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  await assert.rejects(
    writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 }),
    (err) => {
      assert.ok(err instanceof RowErrorCeiling);
      assert.ok(!err.message.includes("\u001b"), JSON.stringify(err.message));
      assert.ok(!err.message.includes("\r"), JSON.stringify(err.message));
      return true;
    },
  );
});

test("a refused epic is recorded, so the run cannot exit 0 on a lost epic row", async () => {
  const plan = {
    labels: [],
    stories: [],
    epics: [{ title: "milestone one", description: "d" }],
  };
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => {
      throw refusal(400, "invalid_parameter");
    },
  };
  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });
  assert.equal(result.epicsBlocked, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "invalid_parameter");
  assert.equal(result.errors[0].row, "milestone one");
});

test("a systemic epic 400 aborts the run", async () => {
  const plan = {
    labels: [],
    stories: [],
    epics: Array.from({ length: 60 }, (_, i) => ({ title: `milestone ${i}`, description: null })),
  };
  let attempted = 0;
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => {
      attempted += 1;
      throw refusal(400, "invalid_parameter");
    },
  };
  await assert.rejects(
    writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 }),
    RowErrorCeiling,
  );
  assert.ok(attempted <= ROW_ERROR_CEILING, `attempted ${attempted} epics`);
});

test("a 409 epic stays warn-only — a label holding the name is not a row error", async () => {
  const plan = {
    labels: [],
    stories: [],
    epics: Array.from({ length: 60 }, (_, i) => ({ title: `milestone ${i}`, description: null })),
  };
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => {
      const err = new ConflictError("conflict: a label of that name already exists");
      err.status = 409;
      err.code = "conflict";
      err.detail = "a label with that name already exists";
      throw err;
    },
  };
  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });
  assert.equal(result.epicsBlocked, 60);
  assert.deepEqual(result.errors, []);
});

test("a refused epic's server code cannot rewrite the terminal, and is capped", async () => {
  const plan = { labels: [], stories: [], epics: [{ title: "milestone", description: null }] };
  const out = capture();
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => {
      throw refusal(400, `bad\u001b[2K\r${"x".repeat(5000)}`);
    },
  };
  await writePlan(client, 91, plan, { stream: out, retryDelayMs: 1 });
  assert.ok(!out.buf.includes("\u001b"), JSON.stringify(out.buf.slice(0, 200)));
  const line = out.buf.split("\n").find((l) => l.startsWith("warning: epic")) ?? "";
  assert.ok(line.length > 0 && line.length < 400, `warning line was ${line.length} chars`);
});

test("an empty server code falls back to the status, not a bare row prefix", async () => {
  const plan = { labels: [], epics: [], stories: [bareStory("3")] };
  const client = {
    createLabel: async () => ({}),
    createStory: async () => {
      throw refusal(400, "");
    },
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });
  assert.equal(result.errors[0].code, "http_400");
});

test("a rejected link is contained like a comment, and is not counted", async () => {
  const plan = twoStoriesWithComments();
  plan.stories[0].links = [
    { url: "https://x/1", link_type: "pull_request" },
    { url: "https://x/2", link_type: "pull_request" },
  ];
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    createComment: async () => ({}),
    /** @param {number} _p @param {number} _s @param {{ url: string }} link */
    createLink: async (_p, _s, link) => {
      if (link.url.endsWith("1")) throw refusal(400, "invalid_parameter");
      return {};
    },
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  const result = await writePlan(client, 91, plan, {
    stream: capture(),
    retryDelayMs: 1,
    sendLinks: true,
  });
  assert.equal(result.stories, 2);
  assert.equal(result.links, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].detail, /link 1/);
});

test("a rejected label create is contained — the story create remakes the label", async () => {
  const plan = twoStoriesWithComments();
  plan.labels = [{ name: "poison" }, { name: "fine" }];
  plan.stories[0].labels = ["poison", "fine"];
  /** @type {string[][]} */
  const attached = [];
  const client = {
    /** @param {number} _p @param {{ name: string }} label */
    createLabel: async (_p, label) => {
      if (label.name === "poison") throw refusal(400, "invalid_parameter");
      return {};
    },
    /** @param {number} _p @param {any} story */
    createStory: async (_p, story) => {
      attached.push(story.labels);
      return { story_id: 1 };
    },
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => ({}),
  };
  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });
  assert.equal(result.labelsCreated, 1);
  assert.equal(result.stories, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, "poison");
  // The refusal cost the colour, not the label: the story create get-or-creates the name.
  assert.deepEqual(attached[0], ["poison", "fine"]);
});

test("a rejected epic create is contained as blocked, with a warning", async () => {
  const plan = twoStoriesWithComments();
  plan.epics = [
    { title: "poison", description: null },
    { title: "fine", description: null },
  ];
  const out = capture();
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    /** @param {number} _p @param {{ name: string }} epic */
    createEpic: async (_p, epic) => {
      if (epic.name === "poison") throw refusal(400, "invalid_parameter");
      return {};
    },
  };
  const result = await writePlan(client, 91, plan, { stream: out, retryDelayMs: 1 });
  assert.equal(result.epicsCreated, 1);
  assert.equal(result.epicsBlocked, 1);
  assert.equal(result.stories, 2);
  assert.match(out.buf, /warning: epic 'poison' was not created/);
});

test("the reported code comes from the parsed body, not a slice of the message", async () => {
  // The real client parses `code` off the body; the message keeps only its first 200 chars.
  const err = refusal(400, "invalid_chars");
  err.message = `failed (400): ${"x".repeat(400)}`;
  const result = await writePlan(clientRejectingPoison(err), 91, twoStoriesWithComments(), {
    stream: capture(),
    retryDelayMs: 1,
  });
  assert.equal(result.errors[0].code, "invalid_chars");
});

test("a refusal with no machine code falls back to the status", async () => {
  const result = await writePlan(
    clientRejectingPoison(refusal(422)),
    91,
    twoStoriesWithComments(),
    {
      stream: capture(),
      retryDelayMs: 1,
    },
  );
  assert.equal(result.errors[0].code, "http_422");
});

// --- the epic ceiling counts refusals, so every "the server already has it" path clears ---

/**
 * 500 epics, one story. Every 20th epic is refused for good; the other 475 take
 * whichever "the server already holds this name" path the client's stub defines.
 * 25 refusals accumulate past the ceiling unless that path clears the count.
 *
 * @returns {import("../src/writer.js").WritePlan}
 */
function epicRerunPlan() {
  return {
    labels: [],
    epics: Array.from({ length: 500 }, (_, i) => ({ title: `milestone ${i}`, description: null })),
    stories: [bareStory("3")],
  };
}

/** @param {number} i */
const epicIsRefused = (i) => i % 20 === 19;

/** @param {{ name: string }} epic */
const epicIndex = (epic) => Number(epic.name.split(" ")[1]);

/** @param {string} detail @returns {ConflictError} */
function epicConflict(detail) {
  const err = new ConflictError("conflict on /projects/91/epics");
  err.status = 409;
  err.code = "conflict";
  err.detail = detail;
  return err;
}

/**
 * @param {Partial<import("../src/writer.js").WriterClient>} overrides
 * @returns {import("../src/writer.js").WriterClient}
 */
function epicClient(overrides) {
  return {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    createComment: async () => ({}),
    listEpics: async () => [],
    createEpic: async () => ({}),
    ...overrides,
  };
}

test("epics the listing already holds reset the ceiling — a re-run still writes", async () => {
  const plan = epicRerunPlan();
  const held = (plan.epics ?? [])
    .filter((_, i) => !epicIsRefused(i))
    .map((epic) => ({ epic_title: epic.title }));
  const client = epicClient({
    listEpics: async () => held,
    createEpic: async () => {
      throw refusal(400, "invalid_parameter");
    },
  });

  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });

  assert.equal(result.epicsExisting, 475);
  assert.equal(result.epicsBlocked, 25);
  assert.equal(result.errors.length, 25);
  assert.equal(result.stories, 1);
});

test("a 409 naming an epic resets the ceiling", async () => {
  const plan = epicRerunPlan();
  const client = epicClient({
    /** @param {number} _p @param {{ name: string }} epic */
    createEpic: async (_p, epic) => {
      if (epicIsRefused(epicIndex(epic))) throw refusal(400, "invalid_parameter");
      throw epicConflict(`Epic '${epic.name}' already exists in this project`);
    },
  });

  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });

  assert.equal(result.epicsExisting, 475);
  assert.equal(result.errors.length, 25);
  assert.equal(result.stories, 1);
});

test("a 409 the re-scan resolves to an epic resets the ceiling", async () => {
  const plan = epicRerunPlan();
  /** @type {string | null} */
  let pending = null;
  const client = epicClient({
    // Only the epic whose create just 409d, so the tiebreak path is the one under test.
    listEpics: async () => (pending === null ? [] : [{ epic_title: pending }]),
    /** @param {number} _p @param {{ name: string }} epic */
    createEpic: async (_p, epic) => {
      if (epicIsRefused(epicIndex(epic))) throw refusal(400, "invalid_parameter");
      pending = epic.name;
      throw epicConflict("that name is taken");
    },
  });

  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });

  assert.equal(result.epicsExisting, 475);
  assert.equal(result.errors.length, 25);
  assert.equal(result.stories, 1);
});

test("a 409 a plain label holds resets the ceiling", async () => {
  const plan = epicRerunPlan();
  const client = epicClient({
    /** @param {number} _p @param {{ name: string }} epic */
    createEpic: async (_p, epic) => {
      if (epicIsRefused(epicIndex(epic))) throw refusal(400, "invalid_parameter");
      throw epicConflict(`Label '${epic.name}' already exists in this project`);
    },
  });

  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });

  assert.equal(result.epicsBlocked, 500);
  assert.equal(result.errors.length, 25);
  assert.equal(result.stories, 1);
});

test("a written sub-resource resets its own count — alternating refusals never abort", async () => {
  // 25 refused comments, each followed by one the server takes. Without the reset on a
  // written comment they are 25 in a row, and the 20th ends a run that should finish.
  const plan = {
    labels: [],
    epics: [],
    stories: Array.from({ length: 25 }, (_, i) => ({
      ...bareStory(String(i)),
      comments: [
        { text: "poison", created_at: null, author: null },
        { text: "fine", created_at: null, author: null },
      ],
    })),
  };
  let written = 0;
  const client = {
    createLabel: async () => ({}),
    createStory: async () => ({ story_id: 1 }),
    createTask: async () => ({}),
    /** @param {number} _p @param {number} _s @param {string} text */
    createComment: async (_p, _s, text) => {
      if (text === "poison") throw refusal(400, "invalid_parameter");
      written += 1;
      return {};
    },
    listEpics: async () => [],
    createEpic: async () => ({}),
  };

  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });

  assert.equal(result.stories, 25);
  assert.equal(result.comments, 25);
  assert.equal(written, 25);
  assert.equal(result.errors.length, 25);
});

test("a NotFoundError is fatal even when it carries a row-scoped status", async () => {
  // The type decides, not the number: a 404 body wearing a 400 still means this run is
  // pointed at something that is not there, so containing it would skip every row.
  const missing = new NotFoundError("not found: /projects/91/stories/1/comments");
  missing.status = 400;
  await assert.rejects(
    writePlan(clientRejectingPoison(missing), 91, twoStoriesWithComments(), {
      stream: capture(),
      retryDelayMs: 1,
    }),
    /not found/,
  );

  const plain = new NotFoundError("not found: /projects/91/stories/1/comments");
  plain.status = 404;
  await assert.rejects(
    writePlan(clientRejectingPoison(plain), 91, twoStoriesWithComments(), {
      stream: capture(),
      retryDelayMs: 1,
    }),
    /not found/,
  );
});

test("the epic and story counts are partitioned — 15 refusals of each never abort", async () => {
  const plan = {
    labels: [],
    epics: Array.from({ length: 15 }, (_, i) => ({ title: `milestone ${i}`, description: null })),
    stories: Array.from({ length: 15 }, (_, i) => bareStory(String(i))),
  };
  const client = epicClient({
    createStory: async () => {
      throw refusal(400, "invalid_parameter");
    },
    createEpic: async () => {
      throw refusal(400, "invalid_parameter");
    },
  });

  const result = await writePlan(client, 91, plan, { stream: capture(), retryDelayMs: 1 });

  // 30 refusals, no abort: one shared count would have fired at the 20th.
  assert.equal(result.errors.length, 30);
  assert.equal(result.epicsBlocked, 15);
  assert.equal(result.stories, 0);
});
