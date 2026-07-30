import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CUSTOMIZATION } from "../src/mapping.js";
import { MAPPINGS, parseInclude, renderLegend, requestFlags } from "../src/mappings.js";

test("issues is a known type with no request field", () => {
  assert.equal(MAPPINGS.issues.requestField, null);
  assert.ok(MAPPINGS.issues.legend.length > 0);
});

test("parseInclude defaults shape: issues only", () => {
  assert.deepEqual(parseInclude("issues"), ["issues"]);
});

test("parseInclude accepts issues,prs", () => {
  assert.deepEqual(parseInclude("issues,prs"), ["issues", "prs"]);
});

test("parseInclude normalizes order and whitespace", () => {
  assert.deepEqual(parseInclude(" prs , issues "), ["issues", "prs"]);
});

test("parseInclude rejects unknown types, listing valid ones", () => {
  assert.throws(() => parseInclude("issues,bogus"), /unknown import type 'bogus'.*issues/);
});

test("parseInclude rejects an empty selection", () => {
  assert.throws(() => parseInclude(" , "), /at least one type/);
});

test("parseInclude rejects a selection without issues", () => {
  assert.throws(() => parseInclude("prs"), /must contain 'issues'/);
});

test("requestFlags maps prs to include_pull_requests", () => {
  assert.deepEqual(requestFlags(["issues"]), {});
  assert.deepEqual(requestFlags(["issues", "prs"]), { include_pull_requests: true });
});

test("parseInclude accepts milestones and releases", () => {
  assert.deepEqual(parseInclude("issues,milestones,releases"), [
    "issues",
    "milestones",
    "releases",
  ]);
});

test("requestFlags maps milestones and releases to their server fields", () => {
  assert.deepEqual(requestFlags(["issues", "milestones", "releases"]), {
    include_milestones: true,
    include_releases: true,
  });
});

test("parseInclude still requires issues with the new types", () => {
  assert.throws(() => parseInclude("milestones,releases"), /must contain 'issues'/);
});

// --- renderLegend + --customize (#31908) -------------------------------------

test("renderLegend names every non-default choice in a Customized block", () => {
  const legend = renderLegend(["issues"], "direct", {
    states: "closed",
    milestones: ["v1.0", "v2.0"],
    storyType: "bug",
    comments: false,
    tasks: false,
  });
  assert.match(legend, /^Customized:$/m);
  assert.match(legend, /- issue states: closed only/);
  assert.match(legend, /- milestones: v1\.0, v2\.0/);
  assert.match(legend, /- story type: all bug/);
  assert.match(legend, /- comments: not imported/);
  assert.match(legend, /- tasks: not imported/);
});

test("an all-default customization renders today's legend byte-identical, both engines", () => {
  for (const engine of /** @type {const} */ (["server", "direct"])) {
    assert.equal(
      renderLegend(["issues"], engine, DEFAULT_CUSTOMIZATION),
      renderLegend(["issues"], engine),
    );
    assert.equal(renderLegend(["issues"], engine, null), renderLegend(["issues"], engine));
  }
  assert.doesNotMatch(renderLegend(["issues"], "direct", DEFAULT_CUSTOMIZATION), /Customized:/);
});

test("comments-off drops the comments legend line, keeps the checklist→tasks line", () => {
  const legend = renderLegend(["issues"], "direct", { ...DEFAULT_CUSTOMIZATION, comments: false });
  assert.doesNotMatch(legend, /comments → comments/);
  assert.match(legend, /issue-body checklists → story tasks/);
});

test("tasks-off drops the checklist→tasks line, keeps the labels and comments lines", () => {
  const legend = renderLegend(["issues"], "direct", { ...DEFAULT_CUSTOMIZATION, tasks: false });
  assert.doesNotMatch(legend, /issue-body checklists → story tasks/);
  assert.match(legend, /labels → labels \(with colors\)/);
  assert.match(legend, /comments → comments \(body only\)/);
});

// --- closed-reason labels in the legend (#31930) -----------------------------

test("the direct legend documents the closed-reason labels; the server legend does not", () => {
  assert.match(renderLegend(["issues"], "direct"), /not-planned.*duplicate/);
  assert.doesNotMatch(renderLegend(["issues"], "server"), /not-planned/);
  assert.equal(renderLegend(["issues"], "server"), renderLegend(["issues"]));
});

// The legend describes the mapping, not the selection — `--states open` still names
// the closed rules, exactly as the pre-existing state line already does.
test("the closed-reason line survives every customization field, states included", () => {
  for (const customization of [
    DEFAULT_CUSTOMIZATION,
    ...["all", "open", "closed"].map((states) => ({ ...DEFAULT_CUSTOMIZATION, states })),
    ...["infer", "feature", "bug", "chore"].map((storyType) => ({
      ...DEFAULT_CUSTOMIZATION,
      storyType,
    })),
    ...[null, [], ["v1.0"]].map((milestones) => ({ ...DEFAULT_CUSTOMIZATION, milestones })),
    { ...DEFAULT_CUSTOMIZATION, comments: false },
    { ...DEFAULT_CUSTOMIZATION, tasks: false },
  ]) {
    const c = /** @type {import("../src/mapping.js").Customization} */ (customization);
    assert.match(renderLegend(["issues"], "direct", c), /not-planned/);
    assert.doesNotMatch(renderLegend(["issues"], "server", c), /not-planned/);
  }
});

test("the state line and the closed-reason line agree: --states open keeps both", () => {
  const openOnly = renderLegend(["issues"], "direct", {
    ...DEFAULT_CUSTOMIZATION,
    states: "open",
  });
  assert.match(openOnly, /closed issue → story \(accepted/);
  assert.match(openOnly, /closed as not planned \/ duplicate/);
  assert.match(openOnly, /- issue states: open only/);
});

test("renderLegend strips terminal control chars from milestone titles", () => {
  const legend = renderLegend(["issues"], "direct", {
    ...DEFAULT_CUSTOMIZATION,
    milestones: ["v1\u001b[31m.0"],
  });
  assert.ok(!legend.includes("\u001b"));
  assert.match(legend, /- milestones: v1\[31m\.0/);
});
