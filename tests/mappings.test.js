import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CUSTOMIZATION,
  ISSUE_TYPE_STORY_TYPES,
  MILESTONES_LEGEND,
  milestoneEpicDescription,
  milestonesLegend,
  releasesLegend,
} from "../src/mapping.js";
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
  assert.match(legend, /- story type: all issues bug/);
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

// --- org-defined issue types in the legend (#31927) --------------------------

test("the direct legend documents the issue-type rule; the server legend does not", () => {
  assert.match(renderLegend(["issues"], "direct"), /- issue type Bug → bug;/);
  assert.doesNotMatch(renderLegend(["issues"], "server"), /issue type/);
  assert.equal(renderLegend(["issues"], "server"), renderLegend(["issues"]));
});

// The line is built from the table, so a sixth entry cannot leave it stale.
test("every name the issue-type table classifies is named in the direct legend", () => {
  const line = renderLegend(["issues"], "direct")
    .split("\n")
    .find((l) => l.includes("issue type"));
  assert.ok(line, "the direct legend has an issue-type line");
  for (const [name, storyType] of ISSUE_TYPE_STORY_TYPES) {
    assert.match(line, new RegExp(`${name}[^;]*→ ${storyType}`, "i"));
  }
});

test("the issue-type line survives every customization field but the story-type override", () => {
  for (const customization of [
    DEFAULT_CUSTOMIZATION,
    ...["all", "open", "closed"].map((states) => ({ ...DEFAULT_CUSTOMIZATION, states })),
    ...[null, [], ["v1.0"]].map((milestones) => ({ ...DEFAULT_CUSTOMIZATION, milestones })),
    { ...DEFAULT_CUSTOMIZATION, comments: false },
    { ...DEFAULT_CUSTOMIZATION, tasks: false },
  ]) {
    const c = /** @type {import("../src/mapping.js").Customization} */ (customization);
    assert.match(renderLegend(["issues"], "direct", c), /issue type Bug/);
    assert.doesNotMatch(renderLegend(["issues"], "server", c), /issue type/);
  }
});

// `--story-type` is a mapping override, not a selection filter: it disables the rule
// for the whole run, so the legend would otherwise contradict its own Customized: block.
test("a fixed --story-type drops the issue-type line but keeps the closed-reason line", () => {
  for (const storyType of ["feature", "bug", "chore"]) {
    const legend = renderLegend(["issues"], "direct", {
      ...DEFAULT_CUSTOMIZATION,
      storyType: /** @type {"feature" | "bug" | "chore"} */ (storyType),
    });
    assert.doesNotMatch(legend, /issue type/);
    assert.match(legend, /closed as not planned/);
    assert.match(legend, new RegExp(`- story type: all issues ${storyType}`));
  }
});

test("renderLegend strips terminal control chars from milestone titles", () => {
  const legend = renderLegend(["issues"], "direct", {
    ...DEFAULT_CUSTOMIZATION,
    milestones: ["v1\u001b[31m.0"],
  });
  assert.ok(!legend.includes("\u001b"));
  assert.match(legend, /- milestones: v1\[31m\.0/);
});

// --- sub-issue cross-links in the legend (#31928) ----------------------------

/** Every `--include` selection parseInclude accepts — issues is mandatory, the rest optional. */
const INCLUDE_SUBSETS = /** @type {string[][]} */ ([["issues"]]);
for (const type of ["prs", "milestones", "releases"]) {
  for (const subset of INCLUDE_SUBSETS.slice()) INCLUDE_SUBSETS.push([...subset, type]);
}

/** Every single-field customization the flags can produce, plus the default. */
const CUSTOMIZATIONS = [
  DEFAULT_CUSTOMIZATION,
  ...["all", "open", "closed"].map((states) => ({ ...DEFAULT_CUSTOMIZATION, states })),
  ...["infer", "feature", "bug", "chore"].map((storyType) => ({
    ...DEFAULT_CUSTOMIZATION,
    storyType,
  })),
  ...[null, [], ["v1.0"]].map((milestones) => ({ ...DEFAULT_CUSTOMIZATION, milestones })),
  { ...DEFAULT_CUSTOMIZATION, comments: false },
  { ...DEFAULT_CUSTOMIZATION, tasks: false },
].map((c) => /** @type {import("../src/mapping.js").Customization} */ (c));

test("the direct legend documents the sub-issue cross-links; the server legend does not", () => {
  assert.match(renderLegend(["issues"], "direct"), /- sub-issues → /);
  assert.match(renderLegend(["issues"], "direct"), /Sub-issue of #n.*Sub-issues: #n/);
  assert.doesNotMatch(renderLegend(["issues"], "server"), /sub-issue/i);
  assert.equal(renderLegend(["issues"], "server"), renderLegend(["issues"]));
});

// The rule has no `--customize` off switch, so unlike the issue-type line no
// override may drop it — and being a *filter* never has, for any line.
test("the sub-issue line survives every customization field, none of which disables the rule", () => {
  for (const c of CUSTOMIZATIONS) {
    assert.match(renderLegend(["issues"], "direct", c), /- sub-issues → /);
  }
});

// The pre-#31928 text of the server legend, transcribed from `renderLegend` at
// 7f1046d: a same-build comparison could not catch a line leaking into `server`.
const SERVER_ISSUES_BLOCK_AT_7f1046d = [
  "  issues:",
  "    - open issue → story (unstarted); closed issue → story (accepted, keeps the closed date)",
  "    - labels → labels (with colors); issue-body checklists → story tasks",
  "    - comments → comments (body only)",
].join("\n");

test("--engine server renders the pre-#31928 issues block for every include subset", () => {
  for (const selected of INCLUDE_SUBSETS) {
    for (const customization of [null, DEFAULT_CUSTOMIZATION]) {
      assert.ok(
        renderLegend(selected, "server", customization).includes(SERVER_ISSUES_BLOCK_AT_7f1046d),
        `server legend drifted for --include ${selected.join(",")}`,
      );
    }
  }
});

// `--no-comments` / `--no-tasks` reshape the server block too (those lines are engine-
// agnostic), so what must hold for every case is that no sub-issue text reaches server.
test("no --include subset or customization leaks sub-issue text into --engine server", () => {
  let cases = 0;
  for (const selected of INCLUDE_SUBSETS) {
    for (const customization of [null, ...CUSTOMIZATIONS]) {
      cases += 1;
      assert.doesNotMatch(renderLegend(selected, "server", customization), /sub-issue/i);
    }
  }
  assert.equal(cases, INCLUDE_SUBSETS.length * (CUSTOMIZATIONS.length + 1));
});

// --- releases in the legend (#31932) -----------------------------------------

// Transcribed from `renderLegend` at a309000, before the direct engine imported
// releases: a same-build comparison could not catch a line leaking into `server`.
const SERVER_RELEASES_BLOCK_AT_a309000 = [
  "  releases:",
  "    - release → release-type story (tag → title, notes → description, publish date kept)",
].join("\n");

test("--engine server renders the pre-#31932 releases block for every customization", () => {
  let cases = 0;
  for (const customization of [null, ...CUSTOMIZATIONS]) {
    cases += 1;
    const legend = renderLegend(["issues", "releases"], "server", customization);
    assert.ok(legend.includes(SERVER_RELEASES_BLOCK_AT_a309000), "server releases block drifted");
    assert.doesNotMatch(legend, /draft/i);
  }
  assert.equal(cases, CUSTOMIZATIONS.length + 1);
});

test("the direct legend documents draft releases; the server legend does not", () => {
  const direct = renderLegend(["issues", "releases"], "direct");
  assert.match(direct, /- draft release → story in the backlog \(unstarted\)/);
  assert.ok(direct.includes(SERVER_RELEASES_BLOCK_AT_a309000.split("\n")[1]));
  assert.doesNotMatch(renderLegend(["issues", "releases"], "server"), /draft/i);
});

// No customization flag touches releases, so no case may drop or reshape the block.
test("the release lines survive every customization on the direct engine", () => {
  let cases = 0;
  for (const customization of [null, ...CUSTOMIZATIONS]) {
    cases += 1;
    const legend = renderLegend(["issues", "releases"], "direct", customization);
    assert.match(legend, /- release → release-type story/);
    assert.match(legend, /- draft release → /);
  }
  assert.equal(cases, CUSTOMIZATIONS.length + 1);
});

test("a run without --include releases renders no release lines at all", () => {
  for (const engine of /** @type {const} */ (["server", "direct"])) {
    assert.doesNotMatch(renderLegend(["issues"], engine), /release/i);
  }
});

test("the releases registry entry is the renderer's own default output", () => {
  assert.deepEqual(MAPPINGS.releases.legend, releasesLegend());
  assert.deepEqual(MAPPINGS.releases.legend, releasesLegend("server"));
});

// --- milestones → epics in the legend (#31931) -------------------------------

// Transcribed from `renderLegend` at 715fc28, before the direct engine imported
// milestones: a same-build comparison could not catch a line leaking into `server`.
const SERVER_MILESTONES_BLOCK_AT_715fc28 = [
  "  milestones:",
  "    - milestone → epic (an issue keeps its milestone as the epic's label)",
].join("\n");

test("--engine server renders the pre-#31931 milestones block for every customization", () => {
  let cases = 0;
  for (const customization of [null, ...CUSTOMIZATIONS]) {
    cases += 1;
    const legend = renderLegend(["issues", "milestones"], "server", customization);
    assert.ok(
      legend.includes(SERVER_MILESTONES_BLOCK_AT_715fc28),
      "server milestones block drifted",
    );
    assert.doesNotMatch(legend, /epic's description|reused, never duplicated/);
  }
  assert.equal(cases, CUSTOMIZATIONS.length + 1);
});

test("the direct legend documents the epic note and reuse; the server legend does not", () => {
  const direct = renderLegend(["issues", "milestones"], "direct");
  assert.ok(direct.includes(SERVER_MILESTONES_BLOCK_AT_715fc28.split("\n")[1]));
  assert.match(direct, /- milestone state \+ due date → the epic's description/);
  assert.match(direct, /a closed milestone leaves its epic open/);
  assert.match(direct, /- an epic that already exists is reused, never duplicated/);
  assert.match(direct, /not counted in the import totals/);
});

// The example in the note line is rendered by the description builder itself, so a
// change to the server-mirroring format cannot leave the legend describing the old text.
test("the epic-note legend line quotes what milestoneEpicDescription actually renders", () => {
  const line = renderLegend(["issues", "milestones"], "direct")
    .split("\n")
    .find((l) => l.includes("epic's description"));
  assert.ok(line, "the direct legend has an epic-description line");
  assert.ok(
    line.includes(String(milestoneEpicDescription({ state: "open", due_on: "2024-12-01" }))),
  );
});

// `--milestones` is a *selection* filter, not a mapping override: it narrows which
// issues map, it does not switch the milestone→epic rule off for the run.
test("the milestone lines survive every customization on the direct engine", () => {
  let cases = 0;
  for (const customization of [null, ...CUSTOMIZATIONS]) {
    cases += 1;
    const legend = renderLegend(["issues", "milestones"], "direct", customization);
    assert.match(legend, /- milestone → epic/);
    assert.match(legend, /- milestone state \+ due date → /);
    assert.match(legend, /- an epic that already exists is reused/);
  }
  assert.equal(cases, CUSTOMIZATIONS.length + 1);
});

test("a run without --include milestones renders no milestone mapping lines at all", () => {
  for (const engine of /** @type {const} */ (["server", "direct"])) {
    assert.doesNotMatch(renderLegend(["issues"], engine), /milestone/i);
    assert.doesNotMatch(renderLegend(["issues", "releases"], engine), /milestone/i);
  }
});

test("no --include subset or customization leaks epic text into --engine server", () => {
  let cases = 0;
  for (const selected of INCLUDE_SUBSETS) {
    for (const customization of [null, ...CUSTOMIZATIONS]) {
      cases += 1;
      assert.doesNotMatch(renderLegend(selected, "server", customization), /epic's description/);
    }
  }
  assert.equal(cases, INCLUDE_SUBSETS.length * (CUSTOMIZATIONS.length + 1));
});

test("the milestones registry entry is the renderer's own default output", () => {
  assert.equal(MAPPINGS.milestones.legend, MILESTONES_LEGEND);
  assert.deepEqual(MAPPINGS.milestones.legend, milestonesLegend());
  assert.deepEqual(MAPPINGS.milestones.legend, milestonesLegend("server"));
});

// The description builder is the single source of that format: the legend quotes what it
// renders, so changing the format without touching the legend cannot go unnoticed.
test("the epic-note legend line and the description builder agree on one format", () => {
  const line = renderLegend(["issues", "milestones"], "direct")
    .split("\n")
    .find((l) => l.includes("epic's description"));
  const rendered = String(milestoneEpicDescription({ state: "open", due_on: "2024-12-01" }));
  assert.ok(line?.includes(`('${rendered}')`), `legend quotes '${rendered}', got ${line}`);
  assert.match(rendered, /^GitHub milestone — State: open, Due: 2024-12-01$/);
});
