import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contrastTextColor,
  ISSUES_LEGEND,
  inferStoryType,
  mapRepo,
  normalizeHexColor,
  parseChecklist,
} from "../src/mapping.js";
import { MAPPINGS } from "../src/mappings.js";

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
  assert.deepEqual(plan.stories[0].comments, [{ text: "@bob on 2026-03-04:\n\nLooks good" }]);
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
  assert.deepEqual(plan.stories[0].comments, [{ text: "@ghost on 2026-03-04:\n\nOrphaned" }]);
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

// --- MAPPINGS registry integration (AC: legend renders from the same table) --

test("MAPPINGS issues legend is the mapping module's own table, byte-identical", () => {
  assert.equal(MAPPINGS.issues.legend, ISSUES_LEGEND);
  assert.deepEqual(ISSUES_LEGEND, [
    "open issue → story (unstarted); closed issue → story (accepted, keeps the closed date)",
    "labels → labels (with colors); issue-body checklists → story tasks",
    "comments → comments (body only)",
  ]);
});
