import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthError, ConflictError, EATClient, EATError } from "../src/client.js";
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
      epicsCreated: 0,
      epicsExisting: 0,
      epicsBlocked: 0,
      labelsCreated: 2,
      labelsExisting: 0,
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
    assert.deepEqual(
      story.blockers.map((/** @type {any} */ b) => b.blocker_display_order),
      [0, 1],
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
