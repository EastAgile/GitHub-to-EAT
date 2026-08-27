import assert from "node:assert/strict";
import { test } from "node:test";

import { markerExternalId, markerFor, withMarker } from "../src/dedup.js";
import {
  CLOSED_REASON_LABELS,
  clampPlan,
  contrastTextColor,
  customizationFlagsGiven,
  DEFAULT_CUSTOMIZATION,
  describeFilters,
  describeOp,
  FALLBACK_LIMITS,
  ISSUE_TYPE_STORY_TYPES,
  ISSUES_LEGEND,
  inferStoryType,
  issuesLegend,
  mappableRelease,
  mapRepo,
  matchesMilestones,
  normalizeHexColor,
  parseChecklist,
  parseCustomization,
  releaseExternalId,
  storyTypeFromIssueType,
  stripControls,
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

test("the repo label listing's order cannot reach the plan", () => {
  // CONTRACT.md calls the listing order irrelevant. It is only irrelevant while `repoColors`
  // stays a by-name lookup and `labelOps` is fed from `issue.labels`; this fails if either moves.
  const labels = [
    { name: "docs", color: "0075ca" },
    { name: "bug", color: "d73a4a" },
    { name: "never-used", color: "00ff00" },
  ];
  const args = { issues: [ghIssue({ labels: [{ name: "docs" }, { name: "bug" }] })], comments: [] };
  assert.deepEqual(
    mapRepo({ ...args, labels }).labels,
    mapRepo({ ...args, labels: [...labels].reverse() }).labels,
  );
});

test("two repo labels differing only in case collapse last-wins, the one order-sensitive case", () => {
  const listing = [
    { name: "Bug", color: "111111" },
    { name: "bug", color: "222222" },
  ];
  const args = { issues: [ghIssue({ labels: [{ name: "bug" }] })], comments: [] };
  assert.equal(mapRepo({ ...args, labels: listing }).labels[0].background_color_hex, "#222222");
  assert.equal(
    mapRepo({ ...args, labels: [...listing].reverse() }).labels[0].background_color_hex,
    "#111111",
  );
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
    { text: "@bob on 2026-03-04:\n\nLooks good", created_at: "2026-03-04T05:06:07Z", author: null },
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
    { text: "@ghost on 2026-03-04:\n\nOrphaned", created_at: "2026-03-04T05:06:07Z", author: null },
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

// Abandoned work, not delivered work. `accepted` carries `done_state = 1` and counts
// toward velocity; `rejected` carries `0` and does not — so billing a wontfix as
// accepted credits the team for work nobody did. This mirrors the tracker's own
// cross-connector rule (agile-tracker `import/common.rs` `map_status`, story #29516,
// where `wontfix` and `duplicate` both map to `rejected`).
for (const [reason, label] of /** @type {[string, string][]} */ ([
  ["not_planned", "not-planned"],
  ["duplicate", "duplicate"],
])) {
  test(`closed as ${reason} maps to rejected and earns the '${label}' label`, () => {
    const plan = mapRepo({
      issues: [closedWith({ state_reason: reason })],
      comments: [],
      labels: [],
    });
    const s = plan.stories[0];
    assert.equal(s.current_state, "rejected");
    assert.equal(s.completed_at, "2026-02-03T04:05:06Z");
    assert.deepEqual(s.labels, [label]);
    assert.deepEqual(plan.labels, [{ name: label }]);
  });
}

test("a bug closed as duplicate is rejected, like a feature", () => {
  const plan = mapRepo({
    issues: [closedWith({ state_reason: "duplicate", labels: [{ name: "bug" }] })],
    comments: [],
    labels: [],
  });
  assert.equal(plan.stories[0].story_type, "bug");
  assert.equal(plan.stories[0].current_state, "rejected");
});

// `rejected` is not in a chore's state set (agile-tracker `handlers/stories.rs`
// `valid_states_for_type`: chores are unstarted/started/accepted only), so a chore
// keeps `accepted` and the label carries the reason on its own.
test("a chore closed as not_planned stays accepted — chores have no rejected state", () => {
  const plan = mapRepo({
    issues: [closedWith({ state_reason: "not_planned", labels: [{ name: "chore" }] })],
    comments: [],
    labels: [],
  });
  const s = plan.stories[0];
  assert.equal(s.story_type, "chore");
  assert.equal(s.current_state, "accepted");
  assert.ok(s.labels.includes("not-planned"), "the reason label still lands");
});

test("--story-type chore forces the accepted fallback on a would-be feature", () => {
  const plan = mapRepo(
    { issues: [closedWith({ state_reason: "not_planned" })], comments: [], labels: [] },
    { ...DEFAULT_CUSTOMIZATION, storyType: "chore" },
  );
  assert.equal(plan.stories[0].story_type, "chore");
  assert.equal(plan.stories[0].current_state, "accepted");
});

// The org's issue type now decides the type, so it also decides whether an abandoned
// close can reject at all — the two rules meet here and nowhere else.
for (const [typeName, storyType, state] of /** @type {[string, string, string][]} */ ([
  ["Task", "feature", "rejected"],
  ["Bug", "bug", "rejected"],
  ["Chore", "chore", "accepted"],
])) {
  test(`an issue typed ${typeName} closed as not_planned is ${storyType} and lands ${state}`, () => {
    const plan = mapRepo({
      issues: [closedWith({ state_reason: "not_planned", type: { name: typeName } })],
      comments: [],
      labels: [],
    });
    assert.equal(plan.stories[0].story_type, storyType);
    assert.equal(plan.stories[0].current_state, state);
    assert.ok(plan.stories[0].labels.includes("not-planned"));
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
    blockers: [],
    ...overrides,
  };
}

test("clampPlan cuts a blocker to blockerDesc, plainly — no truncation notice", () => {
  /** @type {string[]} */
  const warnings = [];
  // github.rs's writer just truncates (`chars().take(255)`); a 76-byte notice
  // inside a 255-byte one-liner would eat the text it is annotating.
  const op = storyOp({
    blockers: [{ desc: `Blocked by #90 (${"x".repeat(400)})`, resolved: false }],
  });
  const { stories } = clampPlan({ labels: [], stories: [op] }, FALLBACK_LIMITS, {
    warn: (m) => warnings.push(m),
  });
  const { desc } = (stories[0].blockers ?? [])[0];
  assert.equal(Buffer.byteLength(desc, "utf8"), 255);
  assert.ok(desc.startsWith("Blocked by #90 (xxx"));
  assert.ok(!desc.includes(TRUNCATION_NOTICE));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /issue #7: blocker 1 truncated to 255 bytes/);
  assert.equal(op.blockers[0].desc.length, 417); // the input plan is untouched
});

test("clampPlan clamps a blocker in UTF-8 bytes, never splitting a character", () => {
  // The public POST /blockers validates with Rust's str::len() (bytes), so a
  // multi-byte title that "fits" in JS units would 400 the write.
  const op = storyOp({ blockers: [{ desc: "😀".repeat(100), resolved: false }] });
  const { stories } = clampPlan({ labels: [], stories: [op] }, FALLBACK_LIMITS);
  const { desc } = (stories[0].blockers ?? [])[0];
  assert.ok(Buffer.byteLength(desc, "utf8") <= 255);
  assert.equal(desc, "😀".repeat(63));
});

test("clampPlan leaves a blocker inside the limit untouched and silent", () => {
  /** @type {string[]} */
  const warnings = [];
  const op = storyOp({ blockers: [{ desc: "Blocked by #90 (Upstream fix)", resolved: false }] });
  const { stories } = clampPlan({ labels: [], stories: [op] }, FALLBACK_LIMITS, {
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(stories[0].blockers, op.blockers);
  assert.deepEqual(warnings, []);
});

test("the blocker fallback limit is the server's BLOCKER_DESC column width", () => {
  assert.equal(FALLBACK_LIMITS.blockerDesc, 255);
});

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

// --- person attribution (story #33465) ---------------------------------------

const withPeople = (/** @type {any} */ repo) =>
  mapRepo(repo, DEFAULT_CUSTOMIZATION, { sendDates: true, sendPeople: true });

test("sendPeople maps the issue author to requestor and the assignees to owners", () => {
  const plan = withPeople({
    issues: [
      ghIssue({
        user: { id: 12, login: "alice", html_url: "https://github.com/alice" },
        assignees: [
          { id: 34, login: "bob", html_url: "https://github.com/bob" },
          { id: 56, login: "carol" },
        ],
      }),
    ],
    comments: [],
    labels: [],
  });
  assert.deepEqual(plan.stories[0].requestor, {
    source: "github",
    external_id: "12",
    username: "alice",
    display_name: "alice",
    html_url: "https://github.com/alice",
  });
  assert.deepEqual(plan.stories[0].owners, [
    {
      source: "github",
      external_id: "34",
      username: "bob",
      display_name: "bob",
      html_url: "https://github.com/bob",
    },
    { source: "github", external_id: "56", username: "carol", display_name: "carol" },
  ]);
});

test("sendPeople authors each comment and leaves the body verbatim — no @login prefix", () => {
  const plan = withPeople({
    issues: [ghIssue({ number: 7 })],
    comments: [
      {
        issue_url: "https://api.github.com/repos/o/r/issues/7",
        user: { id: 5, login: "bob", html_url: "https://github.com/bob" },
        created_at: "2026-03-04T05:06:07Z",
        body: "  Looks good  ",
      },
    ],
    labels: [],
  });
  assert.deepEqual(plan.stories[0].comments, [
    {
      text: "Looks good",
      created_at: "2026-03-04T05:06:07Z",
      author: {
        source: "github",
        external_id: "5",
        username: "bob",
        display_name: "bob",
        html_url: "https://github.com/bob",
      },
    },
  ]);
});

test("sendPeople without sendDates keeps the dated prefix — the date has nowhere else to ride", () => {
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
    { sendPeople: true, sendDates: false },
  );
  assert.equal(plan.stories[0].comments[0].text, "@bob on 2026-03-04:\n\nLooks good");
  // The author still rides structurally — only the date needs the prefix.
  assert.equal(plan.stories[0].comments[0].author?.username, "bob");
});

// github.rs `valid_gh_user`: both the numeric id and the login must be present.
for (const [label, user] of /** @type {[string, any][]} */ ([
  ["a null user (deleted account)", null],
  ["a user with no id", { login: "ghosty" }],
  ["a user whose id is 0", { id: 0, login: "ghosty" }],
  ["a user with a blank login", { id: 9, login: "   " }],
  ["a user with a non-numeric id", { id: "9", login: "ghosty" }],
  // JS-only divergence from valid_gh_user: past 2^53 two ids stringify to one
  // external_id, so the direct engine drops rather than merge two people.
  ["a user whose id is past 2^53", { id: 2 ** 53, login: "ghosty" }],
])) {
  test(`ghost: ${label} is omitted entirely, never partially`, () => {
    const plan = withPeople({
      issues: [ghIssue({ number: 7, user, assignees: [user, { id: 4, login: "real" }] })],
      comments: [
        {
          issue_url: "https://api.github.com/repos/o/r/issues/7",
          user,
          created_at: "2026-03-04T05:06:07Z",
          body: "Orphaned",
        },
      ],
      labels: [],
    });
    const story = plan.stories[0];
    assert.equal(story.requestor, null);
    // The ghost assignee simply disappears; the real one still becomes an owner.
    assert.deepEqual(story.owners, [
      { source: "github", external_id: "4", username: "real", display_name: "real" },
    ]);
    assert.deepEqual(story.comments, [
      { text: "Orphaned", created_at: "2026-03-04T05:06:07Z", author: null },
    ]);
  });
}

test("sendPeople trims the login, and drops a blank html_url rather than sending it", () => {
  const plan = withPeople({
    issues: [ghIssue({ user: { id: 12, login: " alice ", html_url: "   " } })],
    comments: [],
    labels: [],
  });
  assert.deepEqual(plan.stories[0].requestor, {
    source: "github",
    external_id: "12",
    username: "alice",
    display_name: "alice",
  });
});

test("a release carries no people — the server's release_to_record maps none either", () => {
  const plan = mapRepo(
    {
      issues: [],
      comments: [],
      labels: [],
      releases: [{ id: 900, tag_name: "v1.0", draft: false, published_at: "2024-03-02T00:00:00Z" }],
    },
    DEFAULT_CUSTOMIZATION,
    { sendPeople: true },
  );
  assert.equal(plan.stories[0].requestor, null);
  assert.deepEqual(plan.stories[0].owners, []);
});

test("sendPeople off keeps the @login prefix and maps nobody (older-server payloads)", () => {
  const repo = {
    issues: [
      ghIssue({
        number: 7,
        user: { id: 12, login: "alice" },
        assignees: [{ id: 4, login: "bob" }],
      }),
    ],
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
  const plan = mapRepo(repo, DEFAULT_CUSTOMIZATION);
  assert.equal(plan.stories[0].requestor, null);
  assert.deepEqual(plan.stories[0].owners, []);
  assert.deepEqual(plan.stories[0].comments, [
    { text: "@bob on 2026-03-04:\n\nLooks good", created_at: "2026-03-04T05:06:07Z", author: null },
  ]);
  assert.deepEqual(mapRepo(repo, DEFAULT_CUSTOMIZATION, { sendPeople: false }), plan);
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
    { sendDates: true },
  );
  assert.deepEqual(plan.stories[0].comments, [
    { text: "@bob:\n\nLooks good", created_at: "2026-03-04T05:06:07Z", author: null },
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
  const explicit = mapRepo(repo, DEFAULT_CUSTOMIZATION, { sendDates: false });
  assert.deepEqual(dflt.stories[0].comments, [
    { text: "@bob on 2026-03-04:\n\nLooks good", created_at: "2026-03-04T05:06:07Z", author: null },
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

// The epic warning is the first path that renders *remote* author-controlled text, so
// bidi controls matter as much as C0: U+202E alone can visually reverse the warning line.
test("stripControls removes format characters, not only control characters", () => {
  const format = [
    "\u202a", // LEFT-TO-RIGHT EMBEDDING
    "\u202b",
    "\u202c",
    "\u202d",
    "\u202e", // RIGHT-TO-LEFT OVERRIDE — reverses what follows it on screen
    "\u2066", // the four isolates
    "\u2067",
    "\u2068",
    "\u2069",
    "\u200b", // ZERO WIDTH SPACE
    "\u200c",
    "\u200d",
    "\u200e", // LEFT-TO-RIGHT MARK
    "\u200f",
    "\u00ad", // SOFT HYPHEN
    "\ufeff", // ZERO WIDTH NO-BREAK SPACE
  ];
  for (const ch of format) {
    const hex = ch.codePointAt(0)?.toString(16).toUpperCase();
    assert.equal(stripControls(`a${ch}b`), "ab", `U+${hex} survived`);
  }
  // C0/C1/DEL still go, and printable text is untouched.
  assert.equal(stripControls("a\u001b[2Jb\u007fc"), "a[2Jbc");
  assert.equal(
    stripControls("v1.0 \u2014 release \u2713 \u00e9"),
    "v1.0 \u2014 release \u2713 \u00e9",
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

// --- sub-issue cross-links (#31928) ------------------------------------------

/** A fetched repo (fetchAll's shape) whose #7 parents #12 and #14. */
function subIssueRepo() {
  return {
    issues: [
      { number: 7, title: "parent", body: "the parent body", state: "open", labels: [] },
      { number: 12, title: "child one", body: "first child", state: "open", labels: [] },
      { number: 14, title: "child two", body: "", state: "open", labels: [] },
    ],
    comments: [],
    labels: [],
    subIssues: new Map([["7", ["12", "14"]]]),
  };
}

/** @param {{ stories: import("../src/mapping.js").StoryOp[] }} plan @param {string} id */
function storyFor(plan, id) {
  const op = plan.stories.find((s) => s.external_id === id);
  assert.ok(op, `plan has a story for #${id}`);
  return op;
}

test("mapRepo ends a parent's description with its sub-issue numbers", () => {
  const plan = mapRepo(subIssueRepo());
  assert.equal(storyFor(plan, "7").description, "the parent body\n\nSub-issues: #12, #14");
});

test("mapRepo ends each child's description with its parent's number", () => {
  const plan = mapRepo(subIssueRepo());
  assert.equal(storyFor(plan, "12").description, "first child\n\nSub-issue of #7");
  // An empty body leaves the cross-link block as the whole description.
  assert.equal(storyFor(plan, "14").description, "Sub-issue of #7");
});

test("an issue in no sub-issue relation keeps its description the body alone", () => {
  const repo = subIssueRepo();
  repo.issues.push({ number: 20, title: "flat", body: "plain", state: "open", labels: [] });
  assert.equal(storyFor(mapRepo(repo), "20").description, "plain");
});

test("a row that is both a parent and a child names its parent first, then its children", () => {
  const repo = subIssueRepo();
  repo.subIssues = new Map([
    ["7", ["12"]],
    ["12", ["14"]],
  ]);
  assert.equal(
    storyFor(mapRepo(repo), "12").description,
    "first child\n\nSub-issue of #7\nSub-issues: #14",
  );
});

test("cross-links name sub-issues the run's filters excluded, so the text ignores the selection", () => {
  const repo = subIssueRepo();
  repo.issues[1].state = "closed";
  const plan = mapRepo(repo, { ...DEFAULT_CUSTOMIZATION, states: "open" });
  assert.deepEqual(
    plan.stories.map((s) => s.external_id),
    ["7", "14"],
  );
  assert.equal(storyFor(plan, "7").description, "the parent body\n\nSub-issues: #12, #14");
});

test("a child reported under two parents names only the first, never two parent lines", () => {
  const repo = subIssueRepo();
  repo.subIssues = new Map([
    ["7", ["12"]],
    ["14", ["12"]],
  ]);
  const plan = mapRepo(repo);
  assert.equal(storyFor(plan, "12").description, "first child\n\nSub-issue of #7");
  // The losing parent must drop the claim too, or the two directions contradict.
  assert.equal(storyFor(plan, "7").description, "the parent body\n\nSub-issues: #12");
  assert.equal(storyFor(plan, "14").description, null);
});

test("a self-referencing sub-issue entry is dropped from both directions", () => {
  const repo = subIssueRepo();
  repo.subIssues = new Map([["7", ["7", "12"]]]);
  assert.equal(storyFor(mapRepo(repo), "7").description, "the parent body\n\nSub-issues: #12");
});

test("a repeated sub-issue number is rendered once", () => {
  const repo = subIssueRepo();
  repo.subIssues = new Map([["7", ["12", "12", "14"]]]);
  assert.equal(storyFor(mapRepo(repo), "7").description, "the parent body\n\nSub-issues: #12, #14");
});

test("only digit-string sub-issue entries render, so no remote text reaches a description", () => {
  const esc = String.fromCharCode(27);
  const repo = subIssueRepo();
  repo.subIssues = /** @type {any} */ (
    new Map([["7", ["12", `1${esc}[2J`, 14, null, "", "  ", "#9"]]])
  );
  const description = String(storyFor(mapRepo(repo), "7").description);
  assert.equal(description, "the parent body\n\nSub-issues: #12");
  assert.ok(!description.includes(esc));
});

test("a repo fetched without a subIssues map maps byte-identically to before the feature", () => {
  const { subIssues: _dropped, ...withoutMap } = subIssueRepo();
  const bare = mapRepo(withoutMap);
  assert.equal(storyFor(bare, "7").description, "the parent body");
  assert.equal(storyFor(bare, "12").description, "first child");
  assert.equal(storyFor(bare, "14").description, null);
});

test("the dedup marker still parses as the last line once a cross-link block precedes it", () => {
  for (const op of mapRepo(subIssueRepo()).stories) {
    const stamped = withMarker(op.description, markerFor("o", "r", op.external_id));
    assert.equal(markerExternalId(stamped, "o", "r"), op.external_id);
  }
});

test("a parent key that is not a digit string is dropped, so no remote text reaches a child", () => {
  const esc = String.fromCharCode(27);
  const repo = subIssueRepo();
  repo.subIssues = /** @type {any} */ (
    new Map(
      /** @type {any[]} */ ([
        [`1${esc}[2J`, ["12"]],
        ["#9", ["14"]],
        [7, ["14"]],
      ]),
    )
  );
  const plan = mapRepo(repo);
  assert.equal(storyFor(plan, "12").description, "first child");
  assert.equal(storyFor(plan, "14").description, null);
  assert.ok(!JSON.stringify(plan).includes(esc));
});

test("a sub-issue value that is not an array is dropped rather than iterated per character", () => {
  const repo = subIssueRepo();
  repo.subIssues = /** @type {any} */ (
    new Map([
      ["7", "12"],
      ["14", null],
    ])
  );
  const plan = mapRepo(repo);
  assert.equal(storyFor(plan, "7").description, "the parent body");
  assert.equal(storyFor(plan, "14").description, null);
});

test("a subIssues value that is not a Map is ignored, not thrown on", () => {
  const repo = subIssueRepo();
  // A JSON round-trip turns a Map into {}; everything downstream is defensive.
  repo.subIssues = /** @type {any} */ (JSON.parse(JSON.stringify(new Map([["7", ["12"]]]))));
  assert.equal(storyFor(mapRepo(repo), "7").description, "the parent body");
  repo.subIssues = /** @type {any} */ ("7,12");
  assert.equal(storyFor(mapRepo(repo), "7").description, "the parent body");
});

test("a parent whose whole listing is dropped renders no dangling 'Sub-issues:' label", () => {
  const repo = subIssueRepo();
  repo.subIssues = /** @type {any} */ (new Map([["7", ["7", "#9", null]]]));
  const description = String(storyFor(mapRepo(repo), "7").description);
  assert.equal(description, "the parent body");
  assert.ok(!description.includes("Sub-issues:"));
});

test("clampPlan cuts the body around the cross-link block, never the block itself", () => {
  const repo = subIssueRepo();
  repo.issues[0].body = "x".repeat(FALLBACK_LIMITS.storyDescription + 50);
  /** @type {string[]} */
  const warnings = [];
  const clamped = clampPlan(mapRepo(repo), FALLBACK_LIMITS, { warn: (m) => warnings.push(m) });
  const description = String(storyFor(clamped, "7").description);

  assert.ok(
    description.endsWith("\n\nSub-issues: #12, #14"),
    `block survives the clamp, got: ${JSON.stringify(description.slice(-60))}`,
  );
  assert.ok(Buffer.byteLength(description, "utf8") <= FALLBACK_LIMITS.storyDescription);
  assert.ok(description.includes("[truncated by github-to-eat"), "the body still says it was cut");
  assert.equal(warnings.length, 1);
  // The children keep their half of the relation, so both directions still agree.
  assert.equal(storyFor(clamped, "12").description, "first child\n\nSub-issue of #7");
});

test("a cross-link block bigger than the whole limit is clamped, not left over the limit", () => {
  const repo = subIssueRepo();
  repo.subIssues = new Map([["7", Array.from({ length: 40 }, (_, i) => String(i + 100))]]);
  const limits = { ...FALLBACK_LIMITS, storyDescription: 60 };
  const clamped = clampPlan(mapRepo(repo), limits, {});
  for (const op of clamped.stories) {
    const bytes = Buffer.byteLength(op.description ?? "", "utf8");
    assert.ok(bytes <= 60, `#${op.external_id} stays inside the limit, got ${bytes} bytes`);
  }
});

test("the marker reservation is charged on top of the preserved cross-link block", () => {
  const repo = subIssueRepo();
  repo.issues[0].body = "x".repeat(FALLBACK_LIMITS.storyDescription + 50);
  const marker = markerFor("o", "r", "7");
  const clamped = clampPlan(mapRepo(repo), FALLBACK_LIMITS, {
    reserveDescription: () => Buffer.byteLength(marker, "utf8") + 2,
  });
  const stamped = withMarker(storyFor(clamped, "7").description, marker);
  assert.ok(Buffer.byteLength(stamped, "utf8") <= FALLBACK_LIMITS.storyDescription);
  assert.ok(stamped.includes("\n\nSub-issues: #12, #14\n\n"));
  assert.equal(markerExternalId(stamped, "o", "r"), "7");
});

// --- releases → release stories (#31932) -------------------------------------

/** One published GitHub release, shaped like the live REST row (probed 2026-07-29). */
function releaseRow(overrides = {}) {
  return {
    id: 100,
    tag_name: "v2.0.0",
    name: "2026-07-08, Version 2.0.0 (Current)",
    body: "  the notes  ",
    draft: false,
    prerelease: false,
    created_at: "2026-07-08T11:46:45Z",
    published_at: "2026-07-08T11:59:40Z",
    html_url: "https://github.com/o/r/releases/tag/v2.0.0",
    ...overrides,
  };
}

/** A fetched-repo stub carrying only releases. @param {...any} releases */
function releaseRepo(...releases) {
  return { issues: [], comments: [], labels: [], releases };
}

test("a published release maps to an accepted release story keyed release-<id>", () => {
  const [op] = mapRepo(releaseRepo(releaseRow())).stories;
  assert.equal(op.external_id, "release-100");
  assert.equal(op.name, "v2.0.0");
  assert.equal(op.description, "the notes");
  assert.equal(op.story_type, "release");
  assert.equal(op.current_state, "accepted");
  assert.equal(op.created_at, "2026-07-08T11:46:45Z");
  assert.equal(op.completed_at, "2026-07-08T11:59:40Z");
  assert.deepEqual(op.labels, []);
  assert.deepEqual(op.tasks, []);
  assert.deepEqual(op.comments, []);
});

// The server importer's GhRelease has no `name` member at all (github.rs:223-239),
// so the release's human title is never the story title — the tag is.
test("the story title is the tag, never the release's own name", () => {
  const [op] = mapRepo(releaseRepo(releaseRow({ name: "Shiny title" }))).stories;
  assert.equal(op.name, "v2.0.0");
  const [untitled] = mapRepo(releaseRepo(releaseRow({ name: null }))).stories;
  assert.equal(untitled.name, "v2.0.0");
});

// github.rs:885 is `title: release.tag_name` — no trim — and git refnames forbid
// whitespace anyway, so trimming here would be the only cross-engine title drift.
test("the tag is the title byte-for-byte, untrimmed like the server", () => {
  const [op] = mapRepo(releaseRepo(releaseRow({ tag_name: "  v2.0.0  " }))).stories;
  assert.equal(op.name, "  v2.0.0  ");
});

// github.rs:877-882 sends drafts to the backlog; it never skips them.
test("a draft release imports to the backlog rather than being skipped", () => {
  const [op] = mapRepo(releaseRepo(releaseRow({ draft: true, tag_name: "v2.1.0-draft" }))).stories;
  assert.equal(op.external_id, "release-100");
  assert.equal(op.name, "v2.1.0-draft");
  assert.equal(op.current_state, "unstarted");
  assert.equal(op.completed_at, null);
  assert.equal(op.created_at, "2026-07-08T11:46:45Z");
});

test("a published:false release with no publish date is a backlog story too", () => {
  const [op] = mapRepo(releaseRepo(releaseRow({ published_at: null }))).stories;
  assert.equal(op.current_state, "unstarted");
  assert.equal(op.completed_at, null);
});

// github.rs:869-876 runs both dates through parse_source_datetime, which yields None on
// anything it cannot read — so "published" means the date is real. The direct engine has a
// second, stricter bound the importer does not: it *forwards* the value into
// `POST /stories`, whose created_at/completed_at are `Option<DateTime<Utc>>` and so
// deserialize RFC3339 only. Anything else is a 400 that aborts the whole run.
// `Date.parse` cannot be the test here: it reads "0", "-1", "12345" and "2026" as years.
const UNSENDABLE_DATES = [
  "",
  "   ",
  0,
  false,
  "not-a-date",
  12345,
  {},
  [],
  "0",
  "-1",
  "12345",
  "2026",
  "Jul 8 2026",
  "2026-07-08", // date-only: kept by the importer's rung 6, rejected by the create
  "2026-07-08 11:59:40", // naive, no offset
  "2026-07-08T11:59:40", // no zone designator
  "2026-13-45T00:00:00Z", // syntactically RFC3339, not a real instant
  "2026-02-30T00:00:00Z", // Date.parse rolls this into March; chrono refuses it
  " 2026-07-08T11:59:40Z", // padded: chrono does not trim, so this is not sendable either
  "2026-07-08T11:59:40Z ",
  "on 2026-07-08T11:59:40Z", // anchors: a timestamp inside prose is not a timestamp
  "2026-07-08T11:59:40Z or so",
  "2026-07-08 11:59:40Z", // space separator: Date.parse takes it, RFC3339 needs the T
  "2026-07-08T25:00:00Z", // in-shape but out-of-range time components — the day check
  "2026-07-08T12:60:00Z", // only covers Y/M/D, so these rest on the parse check
  "2026-07-08T11:59:61Z",
  ["2026-07-08T11:59:40Z"], // String()s to a valid stamp; forwarding the array is a 400
];

test("a published_at the create would reject is unpublished, not an unsendable date", () => {
  for (const published_at of UNSENDABLE_DATES) {
    const [op] = mapRepo(releaseRepo(releaseRow({ published_at }))).stories;
    assert.equal(op.current_state, "unstarted", `published_at ${JSON.stringify(published_at)}`);
    assert.equal(op.completed_at, null, `published_at ${JSON.stringify(published_at)}`);
  }
});

test("a created_at the create would reject is dropped, not forwarded to the write", () => {
  for (const created_at of UNSENDABLE_DATES) {
    const [op] = mapRepo(releaseRepo(releaseRow({ created_at }))).stories;
    assert.equal(op.created_at, null, `created_at ${JSON.stringify(created_at)}`);
  }
});

test("every RFC3339 form GitHub emits is kept verbatim, offset and all", () => {
  for (const date of [
    "2026-07-08T11:59:40Z",
    "2026-07-08T11:59:40+07:00",
    "2026-07-08T11:59:40-05:30",
    "2026-07-08T11:59:40.123Z",
    "2028-02-29T00:00:00Z", // a real leap day must survive the calendar-day check
  ]) {
    const [op] = mapRepo(releaseRepo(releaseRow({ created_at: date, published_at: date }))).stories;
    assert.equal(op.created_at, date, date);
    assert.equal(op.completed_at, date, date);
    assert.equal(op.current_state, "accepted", date);
  }
});

test("empty or whitespace-only release notes map to a null description", () => {
  for (const body of ["", "   \n  ", null, undefined]) {
    const [op] = mapRepo(releaseRepo(releaseRow({ body }))).stories;
    assert.equal(op.description, null, `body ${JSON.stringify(body)}`);
  }
});

// The server never deserializes `prerelease`, so published-or-draft is the only axis.
test("a prerelease is an ordinary release", () => {
  const [op] = mapRepo(releaseRepo(releaseRow({ prerelease: true }))).stories;
  assert.equal(op.current_state, "accepted");
  assert.equal(op.story_type, "release");
});

test("no releases key, or an empty one, maps no release stories", () => {
  assert.deepEqual(mapRepo({ issues: [], comments: [], labels: [] }).stories, []);
  assert.deepEqual(mapRepo(releaseRepo()).stories, []);
});

test("--story-type does not retype releases; the type is what makes them releases", () => {
  for (const storyType of ["feature", "bug", "chore"]) {
    const plan = mapRepo(releaseRepo(releaseRow()), {
      ...DEFAULT_CUSTOMIZATION,
      storyType: /** @type {any} */ (storyType),
    });
    assert.equal(plan.stories[0].story_type, "release");
  }
});

test("the issue-state and milestone filters leave releases alone", () => {
  for (const states of ["open", "closed"]) {
    const plan = mapRepo(releaseRepo(releaseRow()), {
      ...DEFAULT_CUSTOMIZATION,
      states: /** @type {any} */ (states),
      milestones: ["nothing matches this"],
    });
    assert.equal(plan.stories.length, 1);
  }
});

test("mappableRelease rejects rows that could not be written or deduped", () => {
  assert.equal(mappableRelease(releaseRow()), true);
  assert.equal(mappableRelease(releaseRow({ id: Number.MAX_SAFE_INTEGER })), true);
  for (const id of [
    0,
    -1,
    1.5,
    "100",
    null,
    undefined,
    1e21,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER + 2,
    Number.MAX_VALUE,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(mappableRelease(releaseRow({ id })), false, `id ${JSON.stringify(id)}`);
  }
  for (const tag_name of ["", "   ", null, undefined, 42]) {
    assert.equal(
      mappableRelease(releaseRow({ tag_name })),
      false,
      `tag ${JSON.stringify(tag_name)}`,
    );
  }
  assert.equal(mappableRelease(null), false);
});

// The two ways an unsafe id breaks the machinery, pinned so the guard can't relax
// back to Number.isInteger: at 1e21 String() goes exponential, and past 2^53 two
// GitHub ids collapse onto one JS number — one external_id, one Idempotency-Key.
test("an unsafe id is rejected because it cannot key a release", () => {
  assert.equal(releaseExternalId(1e21), "release-1e+21");
  assert.equal(markerExternalId(markerFor("o", "r", "release-1e+21"), "o", "r"), null);
  assert.equal(describeOp("release-1e+21"), "issue #release-1e+21");

  assert.equal(
    releaseExternalId(Number.MAX_SAFE_INTEGER + 1),
    releaseExternalId(Number.MAX_SAFE_INTEGER + 2),
  );
});

test("every id mappableRelease admits round-trips through its marker", () => {
  for (const id of [1, 100, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    const key = releaseExternalId(id);
    assert.equal(mappableRelease(releaseRow({ id })), true, `id ${id}`);
    assert.equal(markerExternalId(markerFor("o", "r", key), "o", "r"), key, `id ${id}`);
    assert.equal(describeOp(key), `release #${id}`);
  }
});

test("an unmappable release is dropped from the plan, not written half-formed", () => {
  const plan = mapRepo(
    releaseRepo(releaseRow({ id: 0 }), releaseRow({ tag_name: "" }), releaseRow()),
  );
  assert.deepEqual(
    plan.stories.map((s) => s.external_id),
    ["release-100"],
  );
});

test("a release with no html_url or dates still maps", () => {
  const [op] = mapRepo(
    releaseRepo({ id: 7, tag_name: "v1", draft: false, published_at: null }),
  ).stories;
  assert.equal(op.external_id, "release-7");
  assert.equal(op.created_at, null);
  assert.equal(op.completed_at, null);
  assert.equal(op.description, null);
});

test("releases and issues share one plan, each keeping its own id space", () => {
  const plan = mapRepo({
    issues: [{ number: 100, title: "issue one hundred", state: "open", labels: [] }],
    comments: [],
    labels: [],
    releases: [releaseRow()],
  });
  assert.deepEqual(plan.stories.map((s) => s.external_id).sort(), ["100", "release-100"]);
});

test("a releases value that is not an array is ignored, not thrown on", () => {
  for (const releases of [/** @type {any} */ ({}), "v1", 7, null, undefined]) {
    assert.deepEqual(
      mapRepo({ issues: [], comments: [], labels: [], releases }).stories,
      [],
      `releases ${JSON.stringify(releases)}`,
    );
  }
});

test("the clamp warning names an issue an issue and a release a release", () => {
  /** @type {string[]} */
  const warnings = [];
  const plan = mapRepo({
    issues: [
      {
        number: 64,
        title: "long",
        body: "x".repeat(FALLBACK_LIMITS.storyDescription + 10),
        state: "open",
        labels: [],
      },
    ],
    comments: [],
    labels: [],
    releases: [releaseRow({ body: "y".repeat(FALLBACK_LIMITS.storyDescription + 10) })],
  });
  clampPlan(plan, FALLBACK_LIMITS, { warn: (m) => warnings.push(m) });
  assert.deepEqual(warnings.sort(), [
    `warning: issue #64: description truncated to ${FALLBACK_LIMITS.storyDescription} bytes (server limit)\n`,
    `warning: release #100: description truncated to ${FALLBACK_LIMITS.storyDescription} bytes (server limit)\n`,
  ]);
});

test("describeOp reads the numeric half of a release key, and issues unchanged", () => {
  assert.equal(describeOp("64"), "issue #64");
  assert.equal(describeOp("release-100"), "release #100");
  // Anything that is not exactly the namespaced form stays an issue reference.
  assert.equal(describeOp("release-"), "issue #release-");
  assert.equal(describeOp("xrelease-1"), "issue #xrelease-1");
  assert.equal(describeOp("release-1x"), "issue #release-1x");
});

test("a release's clamped description still fits once its marker is stamped", () => {
  const marker = markerFor("o", "r", "release-100");
  const plan = mapRepo(
    releaseRepo(releaseRow({ body: "n".repeat(FALLBACK_LIMITS.storyDescription + 500) })),
  );
  const clamped = clampPlan(plan, FALLBACK_LIMITS, {
    reserveDescription: (op) => Buffer.byteLength(markerFor("o", "r", op.external_id), "utf8") + 2,
  });
  const stamped = withMarker(clamped.stories[0].description, marker);
  assert.ok(
    Buffer.byteLength(stamped, "utf8") <= FALLBACK_LIMITS.storyDescription,
    `stamped description fits, got ${Buffer.byteLength(stamped, "utf8")} bytes`,
  );
  assert.equal(markerExternalId(stamped, "o", "r"), "release-100");
  assert.ok(stamped.includes(TRUNCATION_NOTICE));
});

// --- milestones → epics (#31931) ---------------------------------------------

/** @param {any} [milestone] @param {any} [overrides] */
const milestoneRepo = (milestone, overrides = {}) => ({
  issues: [ghIssue({ number: 7, milestone })],
  comments: [],
  labels: [],
  ...overrides,
});

const withEpics = { epics: true };

test("a milestone becomes an epic whose title is the story's label", () => {
  const plan = mapRepo(
    milestoneRepo({ title: "V1", state: "open", due_on: "2024-12-01T00:00:00Z" }),
    DEFAULT_CUSTOMIZATION,
    withEpics,
  );
  assert.deepEqual(plan.epics, [
    { title: "V1", description: "GitHub milestone — State: open, Due: 2024-12-01" },
  ]);
  assert.deepEqual(plan.stories[0].labels, ["V1"]);
});

test("the epic description mirrors the server's four milestone_epic_desc shapes", () => {
  /** @param {any} m */
  const desc = (m) =>
    mapRepo(milestoneRepo(m), DEFAULT_CUSTOMIZATION, withEpics).epics[0].description;
  assert.equal(
    desc({ title: "V1", state: "open", due_on: "2024-12-01T00:00:00Z" }),
    "GitHub milestone — State: open, Due: 2024-12-01",
  );
  assert.equal(desc({ title: "V1", state: "closed" }), "GitHub milestone — State: closed");
  assert.equal(desc({ title: "V1", due_on: "2025-01-15" }), "GitHub milestone — Due: 2025-01-15");
  assert.equal(desc({ title: "V1" }), null);
  // the separator is an em dash (U+2014), like the server's
  assert.ok(String(desc({ title: "V1", state: "open" })).includes("—"));
});

test("a closed milestone still yields an epic — epics have no state of their own", () => {
  const plan = mapRepo(
    milestoneRepo({ title: "V1", state: "closed" }),
    DEFAULT_CUSTOMIZATION,
    withEpics,
  );
  assert.equal(plan.epics.length, 1);
  assert.deepEqual(plan.stories[0].labels, ["V1"]);
});

test("a blank or non-string milestone title yields no epic and no label", () => {
  for (const milestone of [{ title: "   " }, { title: "" }, { title: 7 }, {}, null, "V1", 3]) {
    const plan = mapRepo(milestoneRepo(milestone), DEFAULT_CUSTOMIZATION, withEpics);
    assert.deepEqual(plan.epics, [], `milestone ${JSON.stringify(milestone)} made an epic`);
    assert.deepEqual(plan.stories[0].labels, []);
  }
});

test("a non-string milestone state or due date contributes no description part", () => {
  const plan = mapRepo(
    milestoneRepo({ title: "V1", state: 1, due_on: {} }),
    DEFAULT_CUSTOMIZATION,
    withEpics,
  );
  assert.deepEqual(plan.epics, [{ title: "V1", description: null }]);
});

test("without the epics option a milestone contributes nothing at all", () => {
  const repo = milestoneRepo({ title: "V1", state: "open", due_on: "2024-12-01T00:00:00Z" });
  const off = mapRepo(repo, DEFAULT_CUSTOMIZATION, { epics: false });
  assert.deepEqual(off.epics, []);
  assert.deepEqual(off.stories[0].labels, []);
  // and the default (no options at all) is the same, byte for byte
  assert.deepEqual(mapRepo(repo), off);
});

test("two issues in one milestone share a single epic, deduped case-insensitively", () => {
  const plan = mapRepo(
    {
      issues: [
        ghIssue({ number: 1, milestone: { title: "V1", state: "open" } }),
        ghIssue({ number: 2, milestone: { title: " v1 ", state: "closed" } }),
      ],
      comments: [],
      labels: [],
    },
    DEFAULT_CUSTOMIZATION,
    withEpics,
  );
  assert.equal(plan.epics.length, 1);
  // the first spelling wins, and every story in the epic carries that one label name
  assert.equal(plan.epics[0].title, "V1");
  assert.equal(plan.epics[0].description, "GitHub milestone — State: open");
  assert.deepEqual(plan.stories[0].labels, ["V1"]);
  assert.deepEqual(plan.stories[1].labels, ["V1"]);
});

test("the epic label is never created as a plain label of its own", () => {
  const plan = mapRepo(milestoneRepo({ title: "V1" }), DEFAULT_CUSTOMIZATION, withEpics);
  assert.deepEqual(plan.epics, [{ title: "V1", description: null }]);
  assert.deepEqual(plan.labels, []);
});

test("an issue label matching its milestone is not listed twice", () => {
  const plan = mapRepo(
    {
      issues: [
        ghIssue({
          number: 1,
          labels: [{ name: "v1", color: "d73a4a" }],
          milestone: { title: "V1" },
        }),
      ],
      comments: [],
      labels: [],
    },
    DEFAULT_CUSTOMIZATION,
    withEpics,
  );
  assert.deepEqual(plan.stories[0].labels, ["v1"]);
  assert.deepEqual(plan.epics, [{ title: "V1", description: null }]);
  assert.deepEqual(plan.labels, [
    { name: "v1", background_color_hex: "#d73a4a", text_color_hex: "#ffffff" },
  ]);
});

test("a milestone can never reclassify a story's type", () => {
  const plan = mapRepo(milestoneRepo({ title: "bugfix" }), DEFAULT_CUSTOMIZATION, withEpics);
  assert.equal(plan.stories[0].story_type, "feature");
  assert.deepEqual(plan.stories[0].labels, ["bugfix"]);
});

test("the epic label lands after the issue's own labels and the closed-reason label", () => {
  const plan = mapRepo(
    {
      issues: [
        ghIssue({
          number: 1,
          state: "closed",
          state_reason: "not_planned",
          labels: [{ name: "ui" }],
          milestone: { title: "V1" },
        }),
      ],
      comments: [],
      labels: [],
    },
    DEFAULT_CUSTOMIZATION,
    withEpics,
  );
  assert.deepEqual(plan.stories[0].labels, ["ui", "not-planned", "V1"]);
});

test("an over-long milestone title is cut to 255 bytes on both the epic and the label", () => {
  const plan = mapRepo(milestoneRepo({ title: "v".repeat(300) }), DEFAULT_CUSTOMIZATION, withEpics);
  assert.equal(plan.epics[0].title, "v".repeat(255));
  assert.deepEqual(plan.stories[0].labels, ["v".repeat(255)]);
  // A 4-byte character straddling the boundary must not split into a lone surrogate:
  // 63 emoji fill 252 bytes, so the 64th cannot fit inside 255.
  const astral = "\u{1F600}".repeat(100);
  const cut = mapRepo(milestoneRepo({ title: astral }), DEFAULT_CUSTOMIZATION, withEpics).epics[0]
    .title;
  assert.equal(cut, "\u{1F600}".repeat(63));
  assert.equal(Buffer.byteLength(cut, "utf8"), 252);
  // A lone surrogate would encode to U+FFFD, so the round-trip would differ.
  assert.equal(cut, Buffer.from(cut, "utf8").toString("utf8"));
});

// The slice runs after the trim, so a cut landing on a space leaves a title the server
// stores one byte shorter — and every later run then misses it in the listing.
test("a cut that lands on whitespace is trimmed again, so the stored title round-trips", () => {
  const title = `${"a".repeat(254)} b`;
  const plan = mapRepo(milestoneRepo({ title }), DEFAULT_CUSTOMIZATION, withEpics);
  assert.equal(plan.epics[0].title, "a".repeat(254));
  assert.deepEqual(plan.stories[0].labels, ["a".repeat(254)]);
});

// Trimming *before* the cut is what keeps padding from eating the budget: measure the
// padded string and 5 real characters fall off the end, with no truncation warning.
test("leading whitespace is trimmed before the cut, not counted against the 255 bytes", () => {
  const title = `${" ".repeat(10)}${"a".repeat(250)}`;
  const plan = mapRepo(milestoneRepo({ title }), DEFAULT_CUSTOMIZATION, withEpics);
  assert.equal(plan.epics[0].title, "a".repeat(250));
});

// Every other plan text field is clamped, and this one is written before any story, so an
// unbounded description would 400 the epic stage and kill the import before it starts.
test("an over-long epic description is clamped like every other plan text field", () => {
  const plan = clampPlan(
    {
      labels: [],
      stories: [],
      epics: [
        { title: "V1", description: `GitHub milestone — State: ${"s".repeat(400)}` },
        { title: "V2", description: null },
      ],
    },
    { ...FALLBACK_LIMITS, epicDescription: 100 },
  );
  assert.ok(bytes(String(plan.epics[0].description)) <= 100);
  assert.ok(String(plan.epics[0].description).endsWith(TRUNCATION_NOTICE));
  assert.equal(plan.epics[1].description, null);
  // Titles are cut at map time, so the clamp leaves them alone.
  assert.equal(plan.epics[0].title, "V1");
});

test("an epic description inside the limit is passed through untouched", () => {
  const epics = [{ title: "V1", description: "GitHub milestone — State: open" }];
  const plan = clampPlan({ labels: [], stories: [], epics }, FALLBACK_LIMITS);
  assert.deepEqual(plan.epics, epics);
});

// Bytes, not UTF-16 units — the limit the server enforces is `str::len()`.
test("an epic description is clamped by bytes, so multi-byte text cannot slip past", () => {
  const description = "é".repeat(200); // 400 bytes, 200 UTF-16 units
  const plan = clampPlan(
    { labels: [], stories: [], epics: [{ title: "V1", description }] },
    {
      ...FALLBACK_LIMITS,
      epicDescription: 300,
    },
  );
  assert.ok(bytes(String(plan.epics[0].description)) <= 300);
  assert.notEqual(plan.epics[0].description, description);
});

// The fallback is `limits::EPIC_DESCRIPTION`, not a conservative guess like the text
// fields: a smaller one would truncate notes the server would have accepted.
test("the epic-description fallback is the server's documented 100,000 bytes", () => {
  const description = "d".repeat(100_000);
  const plan = clampPlan(
    { labels: [], stories: [], epics: [{ title: "V1", description }] },
    FALLBACK_LIMITS,
  );
  assert.equal(plan.epics[0].description, description);
  const over = clampPlan(
    { labels: [], stories: [], epics: [{ title: "V1", description: `${description}x` }] },
    FALLBACK_LIMITS,
  );
  assert.ok(bytes(String(over.epics[0].description)) <= 100_000);
  assert.ok(String(over.epics[0].description).endsWith(TRUNCATION_NOTICE));
});

test("filtered-out issues contribute no epic", () => {
  const repo = {
    issues: [
      ghIssue({ number: 1, state: "closed", milestone: { title: "V1" } }),
      ghIssue({ number: 2, state: "open", milestone: { title: "V2" } }),
    ],
    comments: [],
    labels: [],
  };
  const plan = mapRepo(repo, custom({ states: "open" }), withEpics);
  assert.deepEqual(
    plan.epics.map((e) => e.title),
    ["V2"],
  );
});

test("clampPlan carries the epics through untouched", () => {
  const plan = mapRepo(
    milestoneRepo({ title: "V1", state: "open" }),
    DEFAULT_CUSTOMIZATION,
    withEpics,
  );
  assert.equal(plan.epics.length, 1);
  assert.deepEqual(clampPlan(plan, FALLBACK_LIMITS, {}).epics, plan.epics);
});

test("a padded milestone state or due date is trimmed into the epic description", () => {
  const plan = mapRepo(
    milestoneRepo({ title: "V1", state: "  open  ", due_on: "  2024-12-01T00:00:00Z  " }),
    DEFAULT_CUSTOMIZATION,
    withEpics,
  );
  assert.equal(plan.epics[0].description, "GitHub milestone — State: open, Due: 2024-12-01");
});

// --- pull requests: the fold respects the run's filters (#31933) --------------

// The fold exists so a resolved issue is the single story. When a filter keeps the issue
// out of the run there is no such story, so dropping the PR too would import nothing.
test("a PR is not folded into an issue this run's filters exclude", () => {
  const repo = {
    issues: [
      ghIssue({ number: 7, state: "closed", closed_at: "2024-01-02T00:00:00Z" }),
      ghIssue({
        number: 10,
        title: "the fix",
        body: "Fixes #7",
        state: "closed",
        closed_at: "2024-03-05T00:00:00Z",
        html_url: "https://github.com/o/r/pull/10",
        milestone: { title: "v1.0", state: "open" },
        pull_request: { merged_at: "2024-03-05T00:00:00Z" },
      }),
    ],
    comments: [],
    labels: [],
  };
  const all = mapRepo(repo, DEFAULT_CUSTOMIZATION, { pullRequests: true });
  assert.deepEqual(
    all.stories.map((s) => s.external_id),
    ["7"],
  );

  const filtered = mapRepo(
    repo,
    { ...DEFAULT_CUSTOMIZATION, milestones: ["v1.0"] },
    { pullRequests: true },
  );
  assert.deepEqual(
    filtered.stories.map((s) => s.external_id),
    ["10"],
  );
});

// --- NUL parity with the server importer (services/import/normalize.rs strip_nul_bytes) ---

test("NUL bytes are stripped from every plan string, as the server importer does", () => {
  const N = String.fromCharCode(0);
  /** @type {{ labels: any[], epics: any[], stories: any[] }} */
  const plan = {
    labels: [
      { name: `bu${N}g`, background_color_hex: `#ff${N}0000`, text_color_hex: `#ff${N}ffff` },
    ],
    epics: [{ title: `ep${N}ic`, description: `d${N}esc` }],
    stories: [
      {
        external_id: `1${N}`,
        name: `ti${N}tle`,
        description: `bo${N}dy`,
        crossLinks: `Sub-issu${N}es: #12`,
        story_type: /** @type {const} */ ("feature"),
        current_state: /** @type {const} */ ("accepted"),
        created_at: null,
        completed_at: null,
        labels: [`la${N}bel`],
        tasks: [{ description: `ta${N}sk`, complete: false }],
        blockers: [{ desc: `blo${N}cker` }],
        links: [{ url: `http://x/${N}`, link_type: `pull${N}_request` }],
        requestor: { source: "github", external_id: "7", username: `al${N}ice` },
        owners: [{ source: "github", external_id: "8", username: `b${N}ob` }],
        comments: [
          {
            text: `he${N}llo`,
            created_at: null,
            author: { source: "github", external_id: "9", username: `ca${N}rol` },
          },
        ],
      },
    ],
  };
  const out = clampPlan(plan, FALLBACK_LIMITS);
  const s = out.stories[0];
  const flat = JSON.stringify(out);
  assert.equal(flat.includes("\\u0000"), false, "no plan string may still carry a NUL");
  assert.equal(s.name, "title");
  assert.equal(s.description, "body");
  assert.equal(s.comments[0].text, "hello");
  assert.equal(s.tasks[0].description, "task");
  assert.equal(s.blockers?.[0].desc, "blocker");
  assert.deepEqual(s.labels, ["label"]);
  assert.equal(out.labels[0].name, "bug");
  assert.equal(s.requestor?.username, "alice");
  assert.equal(s.owners?.[0].username, "bob");
  assert.equal(s.comments[0].author?.username, "carol");
  assert.equal(s.external_id, "1");
  assert.equal(s.crossLinks, "Sub-issues: #12");
  assert.equal(s.links?.[0].link_type, "pull_request");
  assert.equal(out.labels[0].background_color_hex, "#ff0000");
  assert.equal(out.labels[0].text_color_hex, "#ffffff");
});

test("a NUL in the cross-link block still lets the clamp cut around it", () => {
  const N = String.fromCharCode(0);
  const crossLinks = `Sub-issu${N}es: #12, #14`;
  /** @type {{ labels: any[], epics: any[], stories: any[] }} */
  const plan = {
    labels: [],
    epics: [],
    stories: [
      {
        external_id: "7",
        name: "t",
        // Stripped, so it no longer ends with an unstripped `crossLinks` — the clamp
        // then cuts the block away instead of cutting the body around it.
        description: `${"x".repeat(FALLBACK_LIMITS.storyDescription)}\n\n${crossLinks}`,
        crossLinks,
        story_type: /** @type {const} */ ("feature"),
        current_state: /** @type {const} */ ("accepted"),
        created_at: null,
        completed_at: null,
        labels: [],
        tasks: [],
        blockers: [],
        comments: [],
      },
    ],
  };
  const description = String(clampPlan(plan, FALLBACK_LIMITS, {}).stories[0].description);
  assert.ok(
    description.endsWith("\n\nSub-issues: #12, #14"),
    `block survives the clamp, got: ${JSON.stringify(description.slice(-60))}`,
  );
  assert.ok(Buffer.byteLength(description, "utf8") <= FALLBACK_LIMITS.storyDescription);
});

test("NUL is stripped before the byte clamp, so the clamp measures real bytes", () => {
  const N = String.fromCharCode(0);
  // Over the limit while the NULs are counted, exactly at it once they are gone: only
  // stripping first leaves this untruncated.
  const body = N.repeat(40) + "x".repeat(FALLBACK_LIMITS.commentText);
  /** @type {{ labels: any[], epics: any[], stories: any[] }} */
  const plan = {
    labels: [],
    epics: [],
    stories: [
      {
        external_id: "1",
        name: "t",
        description: "d",
        story_type: /** @type {const} */ ("feature"),
        current_state: /** @type {const} */ ("accepted"),
        created_at: null,
        completed_at: null,
        labels: [],
        tasks: [],
        blockers: [],
        comments: [{ text: body, created_at: null, author: null }],
      },
    ],
  };
  /** @type {string[]} */
  const warns = [];
  const out = clampPlan(plan, FALLBACK_LIMITS, { warn: (w) => warns.push(w) });
  assert.equal(out.stories[0].comments[0].text.length, FALLBACK_LIMITS.commentText);
  assert.deepEqual(warns, []);
});
