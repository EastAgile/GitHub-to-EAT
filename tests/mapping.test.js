import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLOSED_REASON_LABELS,
  clampPlan,
  contrastTextColor,
  customizationFlagsGiven,
  DEFAULT_CUSTOMIZATION,
  describeFilters,
  FALLBACK_LIMITS,
  ISSUE_TYPE_STORY_TYPES,
  ISSUES_LEGEND,
  inferStoryType,
  issuesLegend,
  mapRepo,
  matchesMilestones,
  normalizeHexColor,
  parseChecklist,
  parseCustomization,
  storyTypeFromIssueType,
  TRUNCATION_NOTICE,
} from "../src/mapping.js";
import { MAPPINGS, renderLegend } from "../src/mappings.js";

// --- inferStoryType — mirrors the server's common.rs rules -------------------

for (const [labels, title, expected] of /** @type {[string[], string, string][]} */ ([
  [["bug"], "Crash on load", "bug"],
  [["needs-fix"], "Something", "bug"], // label CONTAINS fix
  [["defect"], "Something", "bug"],
  [["Bug: UI"], "Something", "bug"], // case-insensitive
  [[], "Fix the parser", "bug"], // title starts with fix
  [[], "bug in pagination", "bug"], // title starts with bug
  [["chore"], "Something", "chore"],
  [["maintenance"], "Something", "chore"],
  [["devops"], "Something", "chore"],
  [["infra-team"], "Something", "chore"], // label CONTAINS infra
  [["bug", "chore"], "Something", "bug"], // bug wins over chore
  [["chore"], "Fix the CI", "bug"], // bug rule checked first, title hits it
  [["enhancement"], "Add a thing", "feature"],
  [[], "Add a thing", "feature"],
])) {
  test(`inferStoryType(${JSON.stringify(labels)}, ${JSON.stringify(title)}) -> ${expected}`, () => {
    assert.equal(inferStoryType(labels, title), expected);
  });
}

// --- normalizeHexColor -------------------------------------------------------

for (const [raw, expected] of /** @type {[string, string | null][]} */ ([
  ["d73a4a", "#d73a4a"],
  ["#D73A4A", "#d73a4a"],
  ["  0e8a16 ", "#0e8a16"],
  ["zzz", null],
  ["fff", null], // 3-digit shorthand is not accepted (server rule)
  ["##d73a4a", "#d73a4a"], // server strips every leading '#'
  ["", null],
])) {
  test(`normalizeHexColor(${JSON.stringify(raw)}) -> ${expected}`, () => {
    assert.equal(normalizeHexColor(raw), expected);
  });
}

// --- contrastTextColor -------------------------------------------------------

test("contrastTextColor: black on light, white on dark, black on malformed", () => {
  assert.equal(contrastTextColor("#ffffff"), "#000000");
  assert.equal(contrastTextColor("#fef2c0"), "#000000");
  assert.equal(contrastTextColor("#000000"), "#ffffff");
  assert.equal(contrastTextColor("#0e8a16"), "#ffffff");
  assert.equal(contrastTextColor("nope"), "#000000");
});

// --- parseChecklist — mirrors the server's parse_checklist_items -------------

test("parseChecklist parses -,*,+ markers with [ ]/[x]/[X], keeps body order", () => {
  const body = [
    "Intro prose",
    "- [ ] first",
    "* [x] second",
    "+ [X] third",
    "  - [ ] nested flattens",
    "- [] not a checkbox",
    "-[ ] no space after marker",
    "- [ ]   ",
    "- plain bullet",
  ].join("\n");
  assert.deepEqual(parseChecklist(body), [
    { description: "first", complete: false },
    { description: "second", complete: true },
    { description: "third", complete: true },
    { description: "nested flattens", complete: false },
  ]);
});

test("parseChecklist on empty body -> []", () => {
  assert.deepEqual(parseChecklist(""), []);
});

test("parseChecklist handles CRLF bodies (the GitHub web-UI default)", () => {
  assert.deepEqual(parseChecklist("- [ ] first\r\n- [x] second\r\n"), [
    { description: "first", complete: false },
    { description: "second", complete: true },
  ]);
});

// --- mapRepo — fetchAll shape in, write-op plan out ---------------------------

/** Minimal GitHub issue fixture. */
function ghIssue(overrides = {}) {
  return {
    number: 7,
    title: "Add a widget",
    body: "Widget body",
    state: "open",
    labels: [],
    user: { id: 12, login: "alice" },
    created_at: "2026-01-02T03:04:05Z",
    closed_at: null,
    ...overrides,
  };
}

test("open issue maps to an unstarted story with external_id and description", () => {
  const plan = mapRepo({ issues: [ghIssue()], comments: [], labels: [] });
  assert.equal(plan.stories.length, 1);
  const s = plan.stories[0];
  assert.equal(s.name, "Add a widget");
  assert.equal(s.current_state, "unstarted");
  assert.equal(s.story_type, "feature");
  assert.equal(s.external_id, "7");
  assert.equal(s.description, "Widget body");
  assert.equal(s.completed_at, null);
});

test("closed issue maps to accepted and keeps the closed date", () => {
  const plan = mapRepo({
    issues: [ghIssue({ state: "closed", closed_at: "2026-02-03T04:05:06Z" })],
    comments: [],
    labels: [],
  });
  const s = plan.stories[0];
  assert.equal(s.current_state, "accepted");
  assert.equal(s.completed_at, "2026-02-03T04:05:06Z");
});

test("empty body -> no description; whitespace body trims away", () => {
  const plan = mapRepo({
    issues: [ghIssue({ number: 1, body: null }), ghIssue({ number: 2, body: "  \n " })],
    comments: [],
    labels: [],
  });
  assert.equal(plan.stories[0].description, null);
  assert.equal(plan.stories[1].description, null);
});

test("issue labels land on the story and in the plan's label ops with colors", () => {
  const plan = mapRepo({
    issues: [
      ghIssue({
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "  ", color: "ffffff" }, // blank name dropped
          { name: "docs", color: "zz" }, // bad color -> label kept, no color
        ],
      }),
    ],
    comments: [],
    labels: [],
  });
  const s = plan.stories[0];
  assert.deepEqual(s.labels, ["bug", "docs"]);
  assert.equal(s.story_type, "bug"); // inferred from its own label
  assert.deepEqual(plan.labels, [
    { name: "bug", background_color_hex: "#d73a4a", text_color_hex: "#ffffff" },
    { name: "docs" },
  ]);
});

test("repo label list fills a color the issue payload lacks; unused repo labels are not created", () => {
  const plan = mapRepo({
    issues: [ghIssue({ labels: [{ name: "docs" }] })],
    comments: [],
    labels: [
      { name: "docs", color: "0075ca" },
      { name: "wontfix", color: "ffffff" }, // on no kept issue -> not in the plan
    ],
  });
  assert.deepEqual(plan.labels, [
    { name: "docs", background_color_hex: "#0075ca", text_color_hex: "#ffffff" },
  ]);
});

test("a label shared by two issues appears once in the plan", () => {
  const plan = mapRepo({
    issues: [
      ghIssue({ number: 1, labels: [{ name: "docs", color: "0075ca" }] }),
      ghIssue({ number: 2, labels: [{ name: "docs", color: "0075ca" }] }),
    ],
    comments: [],
    labels: [],
  });
  assert.equal(plan.labels.length, 1);
});

test("label dedup is case-insensitive with first-seen casing, like the server", () => {
  const plan = mapRepo({
    issues: [
      ghIssue({ number: 1, labels: [{ name: "Bug", color: "d73a4a" }] }),
      ghIssue({ number: 2, labels: [{ name: "bug", color: "d73a4a" }] }),
    ],
    comments: [],
    labels: [],
  });
  assert.deepEqual(
    plan.labels.map((l) => l.name),
    ["Bug"],
  );
});

test("duplicate names on one issue collapse case-insensitively, first spelling winning", () => {
  const plan = mapRepo({
    issues: [ghIssue({ labels: [{ name: "Bug" }, { name: "bug" }, { name: "BUG" }] })],
    comments: [],
    labels: [],
  });
  assert.deepEqual(plan.stories[0].labels, ["Bug"]);
  assert.deepEqual(plan.labels, [{ name: "Bug" }]);
});

test("repo-list color fill matches label names case-insensitively", () => {
  const plan = mapRepo({
    issues: [ghIssue({ labels: [{ name: "Docs" }] })],
    comments: [],
    labels: [{ name: "docs", color: "0075ca" }],
  });
  assert.deepEqual(plan.labels, [
    { name: "Docs", background_color_hex: "#0075ca", text_color_hex: "#ffffff" },
  ]);
});

test("a null title maps without throwing", () => {
  const plan = mapRepo({ issues: [ghIssue({ title: null })], comments: [], labels: [] });
  assert.equal(plan.stories[0].name, "");
  assert.equal(plan.stories[0].story_type, "feature");
});

test("issue-body checklists become the story's tasks; the body keeps the lines", () => {
  const body = "Prose\n- [ ] one\n- [x] two";
  const plan = mapRepo({ issues: [ghIssue({ body })], comments: [], labels: [] });
  const s = plan.stories[0];
  assert.deepEqual(s.tasks, [
    { description: "one", complete: false },
    { description: "two", complete: true },
  ]);
  assert.equal(s.description, body);
});

test("comments join to their issue by issue_url with the @user-on-date prefix", () => {
  const plan = mapRepo({
    issues: [ghIssue({ number: 7 })],
    comments: [
      {
        issue_url: "https://api.github.com/repos/o/r/issues/7",
        user: { id: 5, login: "bob" },
        created_at: "2026-03-04T05:06:07Z",
        body: "Looks good",
      },
    ],
    labels: [],
  });
  assert.deepEqual(plan.stories[0].comments, [
    { text: "@bob on 2026-03-04:\n\nLooks good", created_at: "2026-03-04T05:06:07Z" },
  ]);
});

test("PR-conversation comments (issue_url of a dropped PR) do not leak into any story", () => {
  const plan = mapRepo({
    issues: [ghIssue({ number: 7 })],
    comments: [
      {
        issue_url: "https://api.github.com/repos/o/r/issues/99", // a PR's number
        user: { id: 5, login: "bob" },
        created_at: "2026-03-04T05:06:07Z",
        body: "PR chatter",
      },
    ],
    labels: [],
  });
  assert.deepEqual(plan.stories[0].comments, []);
});

test("empty comment bodies are skipped; deleted users prefix as @ghost", () => {
  const plan = mapRepo({
    issues: [ghIssue({ number: 7 })],
    comments: [
      {
        issue_url: "https://api.github.com/repos/o/r/issues/7",
        user: null,
        created_at: "2026-03-04T05:06:07Z",
        body: "Orphaned",
      },
      {
        issue_url: "https://api.github.com/repos/o/r/issues/7",
        user: { id: 5, login: "bob" },
        created_at: "2026-03-04T05:06:07Z",
        body: "   ",
      },
    ],
    labels: [],
  });
  assert.deepEqual(plan.stories[0].comments, [
    { text: "@ghost on 2026-03-04:\n\nOrphaned", created_at: "2026-03-04T05:06:07Z" },
  ]);
});

test("a stray pull_request row in the input is dropped, not mapped", () => {
  const plan = mapRepo({
    issues: [ghIssue(), ghIssue({ number: 8, pull_request: {} })],
    comments: [],
    labels: [],
  });
  assert.equal(plan.stories.length, 1);
  assert.equal(plan.stories[0].external_id, "7");
});

// --- closed-reason labels (#31930) -------------------------------------------

/** A closed issue with the given `state_reason`. */
const closedWith = (/** @type {object} */ overrides) =>
  ghIssue({ state: "closed", closed_at: "2026-02-03T04:05:06Z", ...overrides });

for (const [reason, label] of /** @type {[string, string][]} */ ([
  ["not_planned", "not-planned"],
  ["duplicate", "duplicate"],
])) {
  test(`closed as ${reason} stays accepted and earns the '${label}' label`, () => {
    const plan = mapRepo({
      issues: [closedWith({ state_reason: reason })],
      comments: [],
      labels: [],
    });
    const s = plan.stories[0];
    assert.equal(s.current_state, "accepted");
    assert.equal(s.completed_at, "2026-02-03T04:05:06Z");
    assert.deepEqual(s.labels, [label]);
    assert.deepEqual(plan.labels, [{ name: label }]);
  });
}

for (const reason of [undefined, null, "completed", "reopened", "some_future_reason"]) {
  test(`state_reason ${JSON.stringify(reason)} earns no label, mapping as if it were absent`, () => {
    const withReason = mapRepo({
      issues: [closedWith({ state_reason: reason })],
      comments: [],
      labels: [],
    });
    const noReason = mapRepo({ issues: [closedWith({})], comments: [], labels: [] });
    assert.deepEqual(withReason, noReason);
    assert.deepEqual(withReason.stories[0].labels, []);
    assert.deepEqual(withReason.labels, []);
  });
}

// Only GitHub's exact lowercase spelling maps: a cased or non-string reason is
// not a reason GitHub sends, so it must not be coerced into one.
for (const reason of ["NOT_PLANNED", " not_planned ", ["not_planned"], 7]) {
  test(`state_reason ${JSON.stringify(reason)} is not GitHub's spelling and adds no label`, () => {
    const plan = mapRepo({
      issues: [closedWith({ state_reason: reason })],
      comments: [],
      labels: [],
    });
    assert.deepEqual(plan.stories[0].labels, []);
    assert.deepEqual(plan.labels, []);
  });
}

test("the closed-reason table is exactly the two reasons CONTRACT.md documents", () => {
  assert.deepEqual(
    [...CLOSED_REASON_LABELS],
    [
      ["not_planned", "not-planned"],
      ["duplicate", "duplicate"],
    ],
  );
});

test("a reason label is our classification, so it never feeds story-type inference", () => {
  CLOSED_REASON_LABELS.set("wontfix", "known-defect");
  try {
    const plan = mapRepo({
      issues: [closedWith({ state_reason: "wontfix" })],
      comments: [],
      labels: [],
    });
    assert.deepEqual(plan.stories[0].labels, ["known-defect"]);
    assert.equal(plan.stories[0].story_type, "feature");
  } finally {
    CLOSED_REASON_LABELS.delete("wontfix");
  }
});

test("state_reason on an open issue is not a close reason and adds no label", () => {
  const plan = mapRepo({
    issues: [ghIssue({ state: "open", state_reason: "not_planned" })],
    comments: [],
    labels: [],
  });
  assert.equal(plan.stories[0].current_state, "unstarted");
  assert.deepEqual(plan.stories[0].labels, []);
  assert.deepEqual(plan.labels, []);
});

test("a reason label dedups case-insensitively against the issue's own repo label", () => {
  const plan = mapRepo({
    issues: [
      closedWith({ state_reason: "duplicate", labels: [{ name: "Duplicate", color: "cfd3d7" }] }),
    ],
    comments: [],
    labels: [],
  });
  assert.deepEqual(plan.stories[0].labels, ["Duplicate"]);
  assert.deepEqual(plan.labels, [
    { name: "Duplicate", background_color_hex: "#cfd3d7", text_color_hex: "#000000" },
  ]);
});

test("a reason label takes the repo list's color for that name — none is hard-coded", () => {
  const plan = mapRepo({
    issues: [closedWith({ state_reason: "not_planned" })],
    comments: [],
    labels: [{ name: "Not-Planned", color: "ffffff" }],
  });
  assert.deepEqual(plan.stories[0].labels, ["not-planned"]);
  assert.deepEqual(plan.labels, [
    { name: "not-planned", background_color_hex: "#ffffff", text_color_hex: "#000000" },
  ]);
});

test("one reason label is created once across issues, first-seen casing winning", () => {
  const plan = mapRepo({
    issues: [
      closedWith({ number: 1, state_reason: "duplicate", labels: [{ name: "Duplicate" }] }),
      closedWith({ number: 2, state_reason: "duplicate" }),
    ],
    comments: [],
    labels: [],
  });
  assert.deepEqual(
    plan.labels.map((l) => l.name),
    ["Duplicate"],
  );
  assert.deepEqual(plan.stories[1].labels, ["duplicate"]);
});

// --- org-defined issue types (#31927) ----------------------------------------

for (const [name, expected] of /** @type {[string, string][]} */ ([
  ["Bug", "bug"],
  ["Feature", "feature"],
  ["Enhancement", "feature"],
  ["Task", "feature"],
  ["Chore", "chore"],
])) {
  test(`issue type '${name}' maps to a ${expected} story with no matching label or title`, () => {
    const plan = mapRepo({
      issues: [ghIssue({ title: "Add a widget", labels: [], type: { name } })],
      comments: [],
      labels: [],
    });
    assert.equal(plan.stories[0].story_type, expected);
    assert.deepEqual(plan.stories[0].labels, []);
  });
}

// Task lands on feature, not chore: GitHub seeds every org with Bug/Feature/Task,
// so Task is ordinary product work and belongs inside velocity (see CONTRACT.md).
test("the issue-type table classifies exactly these five names", () => {
  assert.deepEqual(
    [...ISSUE_TYPE_STORY_TYPES],
    [
      ["bug", "bug"],
      ["feature", "feature"],
      ["enhancement", "feature"],
      ["task", "feature"],
      ["chore", "chore"],
    ],
  );
});

// GitHub issue-type names are org-authored free text, so the match is
// case-insensitive on the trimmed name.
for (const name of ["bug", "BUG", "bUg", "  Bug  "]) {
  test(`issue type ${JSON.stringify(name)} matches case-insensitively, surrounding space ignored`, () => {
    const plan = mapRepo({
      issues: [ghIssue({ title: "Add a widget", type: { name } })],
      comments: [],
      labels: [],
    });
    assert.equal(plan.stories[0].story_type, "bug");
  });
}

test("issue type wins over a label/title heuristic that says otherwise", () => {
  const plan = mapRepo({
    issues: [
      ghIssue({
        title: "Fix the parser",
        labels: [{ name: "bug" }],
        type: { name: "Feature" },
      }),
    ],
    comments: [],
    labels: [],
  });
  assert.equal(plan.stories[0].story_type, "feature");
  assert.deepEqual(plan.stories[0].labels, ["bug"]); // the label still rides along
});

for (const type of [undefined, null, {}, { name: null }, { name: "" }]) {
  test(`type ${JSON.stringify(type)} keeps the label/title inference, plan unchanged`, () => {
    const withType = mapRepo({
      issues: [ghIssue({ title: "Fix the parser", type })],
      comments: [],
      labels: [],
    });
    const noTypeKey = mapRepo({
      issues: [ghIssue({ title: "Fix the parser" })],
      comments: [],
      labels: [],
    });
    assert.deepEqual(withType, noTypeKey);
    assert.equal(withType.stories[0].story_type, "bug");
  });
}

// An org may name a type anything; only the documented names classify, and a
// non-object / non-string `type` must never be coerced into one.
for (const type of [
  { name: "Spike" },
  { name: "Bug Report" },
  { name: ["Bug"] },
  { name: 7 },
  "Bug",
  7,
]) {
  test(`type ${JSON.stringify(type)} is not a known type name and falls through`, () => {
    const plan = mapRepo({
      issues: [ghIssue({ title: "Add a widget", labels: [{ name: "chore" }], type })],
      comments: [],
      labels: [],
    });
    assert.equal(plan.stories[0].story_type, "chore");
  });
}

test("an unknown issue-type name never reaches the plan, control chars included", () => {
  const plan = mapRepo({
    issues: [ghIssue({ type: { name: "Sp[31mike" } })],
    comments: [],
    labels: [],
  });
  // Deep-equality against a no-`type` control, not a fragment match: nothing the
  // name contains can survive, whatever the fixture's other text happens to be.
  const noType = mapRepo({ issues: [ghIssue({})], comments: [], labels: [] });
  assert.ok(!JSON.stringify(plan).includes("\\u001b"));
  assert.deepEqual(plan, noType);
});

test("--story-type overrides the issue type, exactly as it overrides the heuristic", () => {
  const plan = mapRepo(
    { issues: [ghIssue({ type: { name: "Feature" } })], comments: [], labels: [] },
    { ...DEFAULT_CUSTOMIZATION, storyType: "bug" },
  );
  assert.equal(plan.stories[0].story_type, "bug");
});

// The type must NOT classify here, or the heuristic never runs and the ordering
// this test exists to pin becomes unobservable.
test("a closed-reason label is added after typing, so it cannot become the type", () => {
  CLOSED_REASON_LABELS.set("wontfix", "known-defect");
  try {
    const plan = mapRepo({
      issues: [closedWith({ state_reason: "wontfix", type: { name: "Spike" } })],
      comments: [],
      labels: [],
    });
    assert.deepEqual(plan.stories[0].labels, ["known-defect"]);
    assert.equal(plan.stories[0].story_type, "feature");
  } finally {
    CLOSED_REASON_LABELS.delete("wontfix");
  }
});

test("storyTypeFromIssueType returns null for anything it does not classify", () => {
  assert.equal(storyTypeFromIssueType({ name: "Bug" }), "bug");
  assert.equal(storyTypeFromIssueType(null), null);
  assert.equal(storyTypeFromIssueType(undefined), null);
  assert.equal(storyTypeFromIssueType({ name: "Spike" }), null);
});

// --- MAPPINGS registry integration (AC: legend renders from the same table) --

test("MAPPINGS issues legend is the mapping module's own table, byte-identical", () => {
  assert.equal(MAPPINGS.issues.legend, ISSUES_LEGEND);
  assert.deepEqual(ISSUES_LEGEND, [
    "open issue → story (unstarted); closed issue → story (accepted, keeps the closed date)",
    "labels → labels (with colors); issue-body checklists → story tasks",
    "comments → comments (body only)",
  ]);
});

test("the registry entry is the renderer's own output, not a parallel copy of it", () => {
  assert.deepEqual(ISSUES_LEGEND, issuesLegend());
  assert.deepEqual(ISSUES_LEGEND, issuesLegend("server", DEFAULT_CUSTOMIZATION));
  for (const row of MAPPINGS.issues.legend) {
    assert.ok(renderLegend(["issues"], "server").includes(`    - ${row}`));
  }
});

// --- clampPlan — server length limits -----------------------------------------

/** @param {Partial<import("../src/mapping.js").StoryOp>} [overrides] */
function storyOp(overrides = {}) {
  return {
    external_id: "7",
    name: "t",
    description: "",
    story_type: /** @type {const} */ ("feature"),
    current_state: /** @type {const} */ ("unstarted"),
    created_at: "2024-01-01T00:00:00Z",
    completed_at: null,
    labels: [],
    tasks: [],
    comments: [],
    ...overrides,
  };
}

test("clampPlan truncates an over-long comment to fit the limit, notice included", () => {
  /** @type {string[]} */
  const warnings = [];
  const op = storyOp({ comments: [{ text: "x".repeat(500), created_at: null }] });
  const { stories } = clampPlan(
    { labels: [], stories: [op] },
    { ...FALLBACK_LIMITS, commentText: 200 },
    { warn: (m) => warnings.push(m) },
  );
  const text = stories[0].comments[0].text;
  assert.ok(text.length <= 200);
  assert.ok(text.endsWith(TRUNCATION_NOTICE));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /issue #7: comment 1/);
  assert.equal(op.comments[0].text.length, 500); // the input plan is untouched
});

test("clampPlan reserves description room for the dedup marker", () => {
  const op = storyOp({ description: "d".repeat(300) });
  const { stories } = clampPlan(
    { labels: [], stories: [op] },
    { ...FALLBACK_LIMITS, storyDescription: 200 },
    { reserveDescription: () => 50 },
  );
  assert.ok(stories[0].description !== null);
  assert.ok(String(stories[0].description).length <= 150);
  assert.ok(String(stories[0].description).endsWith(TRUNCATION_NOTICE));
});

test("clampPlan clamps name and task text, warning for each", () => {
  /** @type {string[]} */
  const warnings = [];
  const op = storyOp({
    name: "n".repeat(300),
    tasks: [{ description: "t".repeat(300), complete: false }],
  });
  const { stories } = clampPlan(
    { labels: [], stories: [op] },
    { ...FALLBACK_LIMITS, storyName: 255, taskDescription: 200 },
    { warn: (m) => warnings.push(m) },
  );
  // Byte-measured now: the 3-byte ellipsis comes out of the 255-byte budget,
  // so an all-ASCII name keeps 252 chars + "…" (the old assertion of 255 JS
  // units was 257 bytes — over the server's limit).
  assert.equal(Buffer.byteLength(stories[0].name, "utf8"), 255);
  assert.ok(stories[0].tasks[0].description.length <= 200);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /issue #7: name/);
  assert.match(warnings[1], /issue #7: task 1/);
});

const bytes = (/** @type {string} */ s) => Buffer.byteLength(s, "utf8");

test("clampPlan clamps to the limit in UTF-8 bytes, not JS units", () => {
  // The server measures with Rust str::len() (bytes). Curly quotes cost 3 bytes
  // each, so a value "within" the limit in JS units blows the byte budget.
  const op = storyOp({ description: "’".repeat(20000) });
  const { stories } = clampPlan(
    { labels: [], stories: [op] },
    { ...FALLBACK_LIMITS, storyDescription: 20000 },
    { reserveDescription: () => 63 },
  );
  const desc = String(stories[0].description);
  // The 63-byte dedup marker is appended after clamping, so the clamped value
  // must leave room for it inside the server's 20000-byte budget.
  assert.ok(bytes(desc) + 63 <= 20000, `clamped to ${bytes(desc)} bytes + 63 reserve`);
  assert.ok(desc.endsWith(TRUNCATION_NOTICE));
});

test("clampPlan never splits a character when truncating (astral emoji)", () => {
  const op = storyOp({ description: "\u{1F600}".repeat(5000) });
  const { stories } = clampPlan(
    { labels: [], stories: [op] },
    { ...FALLBACK_LIMITS, storyDescription: 1000 },
  );
  const desc = String(stories[0].description);
  assert.ok(bytes(desc) <= 1000, `clamped to ${bytes(desc)} bytes`);
  // A lone surrogate would encode to U+FFFD, so the round-trip would differ.
  assert.equal(desc, Buffer.from(desc, "utf8").toString("utf8"));
});

test("clampPlan clamps the name in bytes, counting the ellipsis it appends", () => {
  const op = storyOp({ name: "n".repeat(300) });
  const { stories } = clampPlan(
    { labels: [], stories: [op] },
    { ...FALLBACK_LIMITS, storyName: 255 },
  );
  assert.ok(bytes(stories[0].name) <= 255, `name is ${bytes(stories[0].name)} bytes`);
  assert.ok(stories[0].name.endsWith("…"));
});

test("clampPlan clamps multi-byte task and comment text in bytes too", () => {
  const op = storyOp({
    tasks: [{ description: "你好".repeat(500), complete: false }],
    comments: [{ text: "→".repeat(500), created_at: null }],
  });
  const { stories } = clampPlan(
    { labels: [], stories: [op] },
    { ...FALLBACK_LIMITS, taskDescription: 300, commentText: 300 },
  );
  assert.ok(bytes(stories[0].tasks[0].description) <= 300);
  assert.ok(bytes(stories[0].comments[0].text) <= 300);
});

test("clampPlan leaves under-limit text untouched and silent", () => {
  const op = storyOp({
    name: "short",
    description: "fine",
    comments: [{ text: "ok", created_at: null }],
  });
  /** @type {string[]} */
  const warnings = [];
  const { stories } = clampPlan({ labels: [], stories: [op] }, FALLBACK_LIMITS, {
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(stories[0], op);
  assert.equal(warnings.length, 0);
});

// --- Customization (V3 --customize plumbing) ---------------------------------

test("DEFAULT_CUSTOMIZATION reproduces today's mapping settings exactly", () => {
  assert.deepEqual(DEFAULT_CUSTOMIZATION, {
    states: "all",
    milestones: null,
    storyType: "infer",
    comments: true,
    tasks: true,
  });
});

test("mapRepo with the default customization is byte-identical to no customization", () => {
  const repo = {
    issues: [
      {
        number: 1,
        title: "fix crash",
        body: "steps\n\n- [ ] repro",
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        labels: [{ name: "bug", color: "ff0000" }],
      },
      {
        number: 2,
        title: "closed milestoned issue",
        body: "done",
        state: "closed",
        closed_at: "2024-02-01T00:00:00Z",
        created_at: "2024-01-15T00:00:00Z",
        milestone: { title: "V1" },
        labels: [],
      },
    ],
    comments: [
      {
        issue_url: "https://api.github.com/repos/o/r/issues/1",
        user: { login: "alice" },
        created_at: "2024-01-02T00:00:00Z",
        body: "same here",
      },
    ],
    labels: [{ name: "bug", color: "ff0000" }],
  };
  assert.deepEqual(mapRepo(repo, DEFAULT_CUSTOMIZATION), mapRepo(repo));
  assert.equal(mapRepo(repo).stories.length, 2);
});

// --- Customization-aware mapping (filters + overrides) -----------------------

/** @param {Partial<import("../src/mapping.js").Customization>} overrides */
function custom(overrides) {
  return { ...DEFAULT_CUSTOMIZATION, ...overrides };
}

test('states: "open" keeps only open issues; a dropped issue leaves no labels or comments', () => {
  const plan = mapRepo(
    {
      issues: [
        ghIssue({ number: 1, state: "open", labels: [{ name: "kept", color: "d73a4a" }] }),
        ghIssue({
          number: 2,
          state: "closed",
          closed_at: "2026-02-03T04:05:06Z",
          labels: [{ name: "dropped-with-issue", color: "0075ca" }],
        }),
      ],
      comments: [
        {
          issue_url: "https://api.github.com/repos/o/r/issues/2",
          user: { login: "bob" },
          created_at: "2026-03-04T05:06:07Z",
          body: "on the dropped issue",
        },
      ],
      labels: [],
    },
    custom({ states: "open" }),
  );
  assert.deepEqual(
    plan.stories.map((s) => s.external_id),
    ["1"],
  );
  assert.deepEqual(
    plan.labels.map((l) => l.name),
    ["kept"],
  );
  assert.deepEqual(plan.stories[0].comments, []);
});

test('states: "closed" keeps only closed issues', () => {
  const plan = mapRepo(
    {
      issues: [
        ghIssue({ number: 1, state: "open" }),
        ghIssue({ number: 2, state: "closed", closed_at: "2026-02-03T04:05:06Z" }),
      ],
      comments: [],
      labels: [],
    },
    custom({ states: "closed" }),
  );
  assert.deepEqual(
    plan.stories.map((s) => s.external_id),
    ["2"],
  );
  assert.equal(plan.stories[0].current_state, "accepted");
});

test("the milestone filter keeps exact milestone.title matches only; unmilestoned issues drop", () => {
  const repo = {
    issues: [
      ghIssue({ number: 1, milestone: { title: "V1" } }),
      ghIssue({ number: 2, milestone: { title: "V2" } }),
      ghIssue({ number: 3 }), // no milestone
    ],
    comments: [],
    labels: [],
  };
  const plan = mapRepo(repo, custom({ milestones: ["V1"] }));
  assert.deepEqual(
    plan.stories.map((s) => s.external_id),
    ["1"],
  );
  // exact means case-sensitive: "v1" matches nothing
  assert.deepEqual(mapRepo(repo, custom({ milestones: ["v1"] })).stories, []);
  // null disables the filter entirely
  assert.equal(mapRepo(repo, custom({ milestones: null })).stories.length, 3);
});

test("an empty milestones allowlist imports every issue, exactly like null", () => {
  const repo = {
    issues: [
      ghIssue({ number: 1, milestone: { title: "V1" } }),
      ghIssue({ number: 2, milestone: { title: "V2" } }),
      ghIssue({ number: 3 }), // no milestone
    ],
    comments: [],
    labels: [],
  };
  assert.deepEqual(
    mapRepo(repo, custom({ milestones: [] })),
    mapRepo(repo, custom({ milestones: null })),
  );
  assert.equal(mapRepo(repo, custom({ milestones: [] })).stories.length, 3);
  assert.equal(matchesMilestones(ghIssue({ number: 4 }), []), true);
});

test("describeFilters renders a milestones line only when an allowlist is in force", () => {
  assert.deepEqual(describeFilters({ states: "all", milestones: ["V1"] }), ["milestones: V1"]);
  // the legend half of the invariant matchesMilestones relies on: [] is "all", like null
  assert.deepEqual(describeFilters({ states: "all", milestones: [] }), []);
  assert.deepEqual(describeFilters({ states: "all", milestones: null }), []);
  assert.deepEqual(describeFilters({ states: "open", milestones: [] }), [
    "issue states: open only",
  ]);
});

test("a fixed storyType overrides inference on every mapped story", () => {
  const plan = mapRepo(
    {
      issues: [
        ghIssue({ number: 1, title: "fix crash", labels: [{ name: "bug", color: "d73a4a" }] }),
        ghIssue({ number: 2, title: "Add a thing" }),
      ],
      comments: [],
      labels: [],
    },
    custom({ storyType: "chore" }),
  );
  assert.deepEqual(
    plan.stories.map((s) => s.story_type),
    ["chore", "chore"],
  );
  assert.deepEqual(plan.stories[0].labels, ["bug"]); // labels still map, only the type is fixed
});

test("comments: false produces no comment ops", () => {
  const plan = mapRepo(
    {
      issues: [ghIssue({ number: 7 })],
      comments: [
        {
          issue_url: "https://api.github.com/repos/o/r/issues/7",
          user: { login: "bob" },
          created_at: "2026-03-04T05:06:07Z",
          body: "Looks good",
        },
      ],
      labels: [],
    },
    custom({ comments: false }),
  );
  assert.deepEqual(plan.stories[0].comments, []);
});

test("tasks: false produces no task ops; the checklist lines stay in the description", () => {
  const body = "Prose\n- [ ] one\n- [x] two";
  const plan = mapRepo(
    { issues: [ghIssue({ body })], comments: [], labels: [] },
    custom({ tasks: false }),
  );
  assert.deepEqual(plan.stories[0].tasks, []);
  assert.equal(plan.stories[0].description, body);
});

// --- backdating: comment prefix + created_at carry (story #32427) --------------

test("sendDates=true carries the comment date and collapses the prefix to @login:", () => {
  const plan = mapRepo(
    {
      issues: [ghIssue({ number: 7 })],
      comments: [
        {
          issue_url: "https://api.github.com/repos/o/r/issues/7",
          user: { id: 5, login: "bob" },
          created_at: "2026-03-04T05:06:07Z",
          body: "Looks good",
        },
      ],
      labels: [],
    },
    DEFAULT_CUSTOMIZATION,
    true,
  );
  assert.deepEqual(plan.stories[0].comments, [
    { text: "@bob:\n\nLooks good", created_at: "2026-03-04T05:06:07Z" },
  ]);
});

test("sendDates defaults to the older-server output (dated prefix) byte-for-byte", () => {
  const repo = {
    issues: [ghIssue({ number: 7 })],
    comments: [
      {
        issue_url: "https://api.github.com/repos/o/r/issues/7",
        user: { id: 5, login: "bob" },
        created_at: "2026-03-04T05:06:07Z",
        body: "Looks good",
      },
    ],
    labels: [],
  };
  const dflt = mapRepo(repo, DEFAULT_CUSTOMIZATION);
  const explicit = mapRepo(repo, DEFAULT_CUSTOMIZATION, false);
  assert.deepEqual(dflt.stories[0].comments, [
    { text: "@bob on 2026-03-04:\n\nLooks good", created_at: "2026-03-04T05:06:07Z" },
  ]);
  assert.deepEqual(dflt, explicit);
});

test("clampPlan preserves created_at on an over-limit comment", () => {
  const op = storyOp({ comments: [{ text: "x".repeat(500), created_at: "2020-01-05T00:00:00Z" }] });
  const { stories } = clampPlan(
    { labels: [], stories: [op] },
    {
      ...FALLBACK_LIMITS,
      commentText: 200,
    },
  );
  assert.equal(stories[0].comments[0].created_at, "2020-01-05T00:00:00Z");
  assert.ok(stories[0].comments[0].text.endsWith(TRUNCATION_NOTICE));
});

// --- parseCustomization — the declarative flags (#32499) ---------------------

test("no customization flags yield DEFAULT_CUSTOMIZATION", () => {
  assert.deepEqual(parseCustomization({}), DEFAULT_CUSTOMIZATION);
});

for (const value of ["all", "open", "closed"]) {
  test(`--states ${value} sets the states field`, () => {
    assert.equal(parseCustomization({ states: value }).states, value);
  });
}

for (const value of ["infer", "feature", "bug", "chore"]) {
  test(`--story-type ${value} sets the storyType field`, () => {
    assert.equal(parseCustomization({ "story-type": value }).storyType, value);
  });
}

test("--milestones is an exact-title allowlist, trimmed and deduplicated in order", () => {
  assert.deepEqual(parseCustomization({ milestones: " v1.0 , v2.0 ,v1.0" }).milestones, [
    "v1.0",
    "v2.0",
  ]);
});

test("--milestones can be repeated: every occurrence flattens into one allowlist", () => {
  assert.deepEqual(parseCustomization({ milestones: ["v1.0,v2.0", " v3.0 ", "v1.0"] }).milestones, [
    "v1.0",
    "v2.0",
    "v3.0",
  ]);
});

test("a backslash-escaped comma keeps a comma-bearing milestone title in one piece", () => {
  assert.deepEqual(parseCustomization({ milestones: ["v1.0\\, beta,v2.0"] }).milestones, [
    "v1.0, beta",
    "v2.0",
  ]);
});

test("--no-comments and --no-tasks turn their field off", () => {
  assert.equal(parseCustomization({ "no-comments": true }).comments, false);
  assert.equal(parseCustomization({ "no-tasks": true }).tasks, false);
});

test("combined flags build the expected object; omitted fields keep their defaults", () => {
  assert.deepEqual(
    parseCustomization({ states: "open", milestones: "v1.0", "no-comments": true }),
    { states: "open", milestones: ["v1.0"], storyType: "infer", comments: false, tasks: true },
  );
});

test("an unknown --states value names the flag and its allowed values", () => {
  assert.throws(
    () => parseCustomization({ states: "sideways" }),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /--states/);
      assert.match(err.message, /sideways/);
      assert.match(err.message, /all, open, closed/);
      return true;
    },
  );
});

test("an unknown --story-type value names the flag and its allowed values", () => {
  assert.throws(
    () => parseCustomization({ "story-type": "epic" }),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /--story-type/);
      assert.match(err.message, /epic/);
      assert.match(err.message, /infer, feature, bug, chore/);
      return true;
    },
  );
});

test("an invalid value is stripped of control characters before it is reported", () => {
  assert.throws(
    () => parseCustomization({ states: "x[2Jy" }),
    (/** @type {Error} */ err) => {
      assert.ok(!err.message.includes(""), err.message);
      assert.match(err.message, /x\[2Jy/);
      return true;
    },
  );
});

test("--milestones with no titles is an error, not an empty allowlist", () => {
  assert.throws(() => parseCustomization({ milestones: " , " }), /--milestones/);
});

test("customizationFlagsGiven names only the customization flags that were passed", () => {
  assert.deepEqual(customizationFlagsGiven({ project: "91", engine: "direct" }), []);
  assert.deepEqual(customizationFlagsGiven({ states: "open", "no-tasks": true, yes: true }), [
    "--states",
    "--no-tasks",
  ]);
});
