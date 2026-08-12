import assert from "node:assert/strict";
import test from "node:test";

import { FALLBACK_LIMITS, TRUNCATION_NOTICE } from "../src/mapping.js";
import { compareProjects, DIVERGENCES, floorViolation, formatReport } from "./parity-compare.js";

const byteLen = (/** @type {string} */ s) => Buffer.byteLength(s, "utf8");

/** What `clampBlock` really writes: the prefix that fits `limit`, then the notice. */
const clampBlock = (/** @type {string} */ fill, /** @type {number} */ limit) =>
  `${fill.repeat(limit - byteLen(TRUNCATION_NOTICE) - 2)}\n\n${TRUNCATION_NOTICE}`;

const row = (/** @type {any} */ over = {}) => {
  const key = over.key ?? "7";
  return {
    key,
    name: "Fix the thing",
    story_type: "feature",
    current_state: "unstarted",
    created: "2026-01-02T03:04:05Z",
    description: `Body\n\nImported from https://github.com/o/r/issues/${key}`,
    import_source: "github",
    import_external_id: key,
    tasks: [],
    comments: [],
    labels: [],
    requestor: null,
    owners: [],
    ...over,
  };
};

/** @param {{ mismatches: any[] }} result */
const seen = (result) => result.mismatches.map((m) => [m.key, m.field, m.server, m.direct]);

test("a differing story_type is reported, keyed by the GitHub issue number", () => {
  const result = compareProjects([row({})], [row({ story_type: "bug" })]);

  assert.deepEqual(seen(result), [["7", "story_type", "feature", "bug"]]);
});

test("a row only one engine wrote is reported both ways", () => {
  const result = compareProjects([row({ key: "7" })], [row({ key: "9" })]);

  assert.deepEqual(seen(result), [
    ["7", "story", "present", "missing"],
    ["9", "story", "missing", "present"],
  ]);
});

test("every scalar field mismatch is reported, not just the first", () => {
  const result = compareProjects(
    [row({})],
    [row({ story_type: "bug", current_state: "accepted", import_external_id: "8" })],
  );

  assert.deepEqual(seen(result), [
    ["7", "story_type", "feature", "bug"],
    ["7", "current_state", "unstarted", "accepted"],
    ["7", "import_external_id", "7", "8"],
  ]);
});

test("created compares to the second — sub-second noise and zone spelling are not a mismatch", () => {
  const same = compareProjects(
    [row({ created: "2026-01-02T03:04:05Z" })],
    [row({ created: "2026-01-02T03:04:05.812+00:00" })],
  );
  assert.deepEqual(same.mismatches, []);

  const off = compareProjects(
    [row({ created: "2026-01-02T03:04:05Z" })],
    [row({ created: "2026-01-02T03:04:06Z" })],
  );
  assert.deepEqual(
    off.mismatches.map((m) => m.field),
    ["created"],
  );
});

// --- known divergences: tolerated, never silently dropped ------------------

test("the back-link footer is normalised away, and the row counted as tolerated", () => {
  const result = compareProjects(
    [row({ description: "Body\n\n[View original issue](https://github.com/o/r/issues/7)" })],
    [row({ description: "Body\n\nImported from https://github.com/o/r/issues/7" })],
  );

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(
    result.tolerated.map((t) => [t.key, t.field, t.reason]),
    [["7", "description", DIVERGENCES.BACKLINK]],
  );
});

test("a blank issue body — server writes nothing, direct writes a bare marker — is tolerated", () => {
  const result = compareProjects(
    [row({ description: "" })],
    [row({ description: "Imported from https://github.com/o/r/issues/7" })],
  );

  assert.deepEqual(result.mismatches, []);
  assert.equal(result.tolerated.length, 1);
});

test("a real description difference survives back-link normalisation", () => {
  const result = compareProjects(
    [row({ description: "Body\n\n[View original issue](https://github.com/o/r/issues/7)" })],
    [row({ description: "Other\n\nImported from https://github.com/o/r/issues/7" })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => [m.field, m.server, m.direct]),
    [["description", "Body", "Other"]],
  );
});

test("completed_at on a rejected row is tolerated (#36701), on an accepted row is not", () => {
  const rejected = compareProjects(
    [row({ current_state: "rejected", completed_at: "2026-02-03T04:05:06Z" })],
    [row({ current_state: "rejected", completed_at: null })],
  );
  assert.deepEqual(rejected.mismatches, []);
  assert.deepEqual(
    rejected.tolerated.map((t) => t.reason),
    [DIVERGENCES.REJECTED_COMPLETED_AT],
  );

  const accepted = compareProjects(
    [row({ current_state: "accepted", completed_at: "2026-02-03T04:05:06Z" })],
    [row({ current_state: "accepted", completed_at: null })],
  );
  assert.deepEqual(
    accepted.mismatches.map((m) => m.field),
    ["completed_at"],
  );
});

test("a body the CLI clamped to the write route's maxLength is tolerated (#35629)", () => {
  // What `clampBlock` really writes: the prefix that fits, then the notice.
  const source = "x".repeat(20_000);
  const clamped = `${"x".repeat(16_000 - TRUNCATION_NOTICE.length - 2)}\n\n${TRUNCATION_NOTICE}`;
  const result = compareProjects([row({ description: source })], [row({ description: clamped })]);

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(
    result.tolerated.map((t) => t.reason),
    [DIVERGENCES.CLAMP],
  );
});

test("a field named unavailable is not compared, and is reported as skipped", () => {
  const result = compareProjects(
    [row({ current_state: "accepted", completed_at: "2026-02-03T04:05:06Z" })],
    [row({ current_state: "accepted", completed_at: null })],
    { unavailable: { completed_at: "no read path" } },
  );

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.skipped, [{ field: "completed_at", reason: "no read path" }]);
});

// --- collections and people -----------------------------------------------

const ext = (/** @type {string} */ username, /** @type {number} */ id) => ({
  kind: "external",
  id,
  name: username,
  username,
  source: "github",
});

test("tasks compare on description and complete, in order", () => {
  const tasks = [{ description: "one", complete: true }];
  const result = compareProjects(
    [row({ tasks })],
    [row({ tasks: [{ description: "one", complete: false }] })],
  );

  assert.deepEqual(seen(result), [["7", "tasks[0].complete", true, false]]);
});

test("a task only one engine wrote is reported", () => {
  const result = compareProjects(
    [row({ tasks: [{ description: "one", complete: false }] })],
    [row({ tasks: [] })],
  );

  assert.deepEqual(seen(result), [["7", "tasks.length", 1, 0]]);
});

test("comments compare on text, created and author, ignoring tie order", () => {
  const a = { text: "first", created: "2026-01-01T00:00:00Z", author: ext("sam", 1) };
  const b = { text: "second", created: "2026-01-01T00:00:00Z", author: ext("kim", 2) };
  const same = compareProjects([row({ comments: [a, b] })], [row({ comments: [b, a] })]);
  assert.deepEqual(same.mismatches, []);

  const wrongAuthor = compareProjects(
    [row({ comments: [a] })],
    [row({ comments: [{ ...a, author: ext("kim", 9) }] })],
  );
  assert.deepEqual(seen(wrongAuthor), [
    ["7", "comments[0].author", "external:github/sam", "external:github/kim"],
  ]);
});

test("labels compare on name and both colours, ignoring attachment order", () => {
  const green = { name: "bug", background_color_hex: "#0f0", text_color_hex: "#000" };
  const blue = { name: "docs", background_color_hex: "#00f", text_color_hex: "#fff" };
  const same = compareProjects([row({ labels: [green, blue] })], [row({ labels: [blue, green] })]);
  assert.deepEqual(same.mismatches, []);

  const recoloured = compareProjects(
    [row({ labels: [green] })],
    [row({ labels: [{ ...green, background_color_hex: "#f00" }] })],
  );
  assert.deepEqual(seen(recoloured), [["7", "labels[0].background_color_hex", "#0f0", "#f00"]]);
});

test("people compare on source identity, not on the per-project row id", () => {
  const same = compareProjects(
    [row({ requestor: ext("sam", 1), owners: [ext("kim", 2)] })],
    [row({ requestor: ext("sam", 40), owners: [ext("kim", 41)] })],
  );
  assert.deepEqual(same.mismatches, []);

  const different = compareProjects(
    [row({ requestor: ext("sam", 1), owners: [ext("kim", 2)] })],
    [row({ requestor: null, owners: [] })],
  );
  assert.deepEqual(seen(different), [
    ["7", "requestor", "external:github/sam", "none"],
    ["7", "owners", "external:github/kim", ""],
  ]);
});

test("the story count of each project is reported", () => {
  const result = compareProjects([row({ key: "7" }), row({ key: "8" })], [row({ key: "7" })]);

  assert.deepEqual(result.counts, {
    server: 2,
    direct: 1,
    compared: 1,
    serverKeys: 2,
    directKeys: 1,
  });
});

// --- the failure report ----------------------------------------------------

test("the report names every mismatching field, keyed by issue, and never truncates", () => {
  const result = compareProjects(
    [row({ key: "7" }), row({ key: "8" }), row({ key: "9" })],
    [
      row({ key: "7", story_type: "bug", current_state: "accepted" }),
      row({ key: "8", created: "2020-01-01T00:00:00Z" }),
    ],
  );
  const report = formatReport(result);

  assert.match(report, /issue #7\s+story_type\s/);
  assert.match(report, /issue #7\s+current_state\s/);
  assert.match(report, /issue #8\s+created\s/);
  assert.match(report, /issue #9\s+story\s/);
  assert.match(report, /4 mismatching field\(s\) across 3 issue\(s\)/);
  assert.match(report, /story count: server 3, direct 2/);
});

test("the report aggregates tolerated divergences and lists what went uncompared", () => {
  const result = compareProjects(
    [row({ key: "7" }), row({ key: "8" })],
    [row({ key: "7", description: "Body" }), row({ key: "8", description: "Body" })],
    { unavailable: { completed_at: "no read path on this server" } },
  );
  const report = formatReport(result);

  assert.match(report, /tolerated \(known divergences\)/);
  assert.match(report, /2 row\(s\).*#36736/s);
  assert.match(report, /not compared:\n\s+completed_at — no read path on this server/);
});

// --- fields beyond the acceptance criteria, each proven identical by the
// --- two-engine run of 2026-08-06 ------------------------------------------

test("started, rejected_at and icebox are compared too", () => {
  const result = compareProjects(
    [row({ started: "2026-01-02T03:04:05Z", rejected_at: null, icebox: false })],
    [
      row({
        started: "2026-01-02T03:04:05.400Z",
        rejected_at: "2026-03-01T00:00:00Z",
        icebox: true,
      }),
    ],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["rejected_at", "icebox"],
  );
});

test("an owner or requestor arrives wrapped in its join row, and still keys on the actor", () => {
  const wrapped = { member_id: null, agent_id: null, external_member_id: 4, actor: ext("sam", 4) };
  const result = compareProjects(
    [row({ requestor: wrapped, owners: [wrapped] })],
    [row({ requestor: ext("sam", 90), owners: [ext("sam", 90)] })],
  );

  assert.deepEqual(result.mismatches, []);
});

// --- paths that let a run certify a parity it never measured ----------------

test("a key written twice on one side is reported before anything is compared", () => {
  const result = compareProjects(
    [row({ key: "7" }), row({ key: "8" })],
    [row({ key: "7" }), row({ key: "8" }), row({ key: "7", story_type: "bug" })],
  );

  assert.deepEqual(seen(result), [
    ["7", "duplicate-key", 1, 2],
    ["7", "story_type", "feature", "bug"],
  ]);
});

test("the story count is the raw row count, not the count of distinct keys", () => {
  const result = compareProjects([row({ key: "7" })], [row({ key: "7" }), row({ key: "7" })]);

  assert.equal(result.counts.server, 1);
  assert.equal(result.counts.direct, 2);
  assert.match(formatReport(result), /story count: server 1, direct 2/);
});

test("a run that compared nothing is a floor violation", () => {
  const result = compareProjects([], []);

  assert.equal(result.counts.compared, 0);
  assert.match(String(floorViolation(result.counts, 1)), /compared 0/);
});

test("a run that compared fewer rows than the configured floor is a violation", () => {
  const result = compareProjects([row({ key: "7" })], [row({ key: "7" })]);

  assert.match(String(floorViolation(result.counts, 5)), /5/);
  assert.equal(floorViolation(result.counts, 1), null);
});

test("the completed_at read-path gap names its companion server ask", () => {
  assert.match(DIVERGENCES.AGENT_KEY_COMPLETED_AT, /#44442/);
});

test("naming a field unavailable that the harness still compares throws", () => {
  assert.throws(
    () => compareProjects([row({})], [row({})], { unavailable: { description: "made up" } }),
    /description/,
  );
});

// --- tolerances that used to swallow arbitrary content ----------------------

test("text that merely opens with the truncation notice is a mismatch, not a clamp", () => {
  const result = compareProjects(
    [row({ description: `${TRUNCATION_NOTICE} then a completely different server body` })],
    [row({ description: "nothing whatsoever in common with the other side" })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
  assert.deepEqual(result.tolerated, []);
});

test("a clamp that is not shorter than the text it supposedly cut is a mismatch", () => {
  const result = compareProjects(
    [row({ description: "Body" })],
    [row({ description: `Body\n\n${TRUNCATION_NOTICE}` })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
});

test("a body whose last line is an unrelated 'Imported from' URL is not stripped", () => {
  const result = compareProjects(
    [row({ description: "Body\n\nImported from https://internal.example.com/ticket/9" })],
    [row({ description: "Body\n\nImported from https://github.com/o/r/issues/7" })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
});

test("two back-link footers naming different issues are a mismatch", () => {
  const result = compareProjects(
    [row({ description: "Body\n\n[View original issue](https://github.com/o/r/issues/9)" })],
    [row({ description: "Body\n\nImported from https://github.com/o/r/issues/7" })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
});

test("a footer for another repo is not stripped when the run names the repo", () => {
  const result = compareProjects(
    [row({ description: "Body\n\nImported from https://github.com/other/repo/issues/7" })],
    [row({ description: "Body\n\nImported from https://github.com/o/r/issues/7" })],
    { repo: { owner: "o", name: "r" } },
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
});

test("a description differing only in trailing whitespace is reported, not filed as a back-link", () => {
  const result = compareProjects([row({ description: "Body\n" })], [row({ description: "Body" })]);

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
  assert.deepEqual(result.tolerated, []);
});

// --- the story title, and the divergence the CLAMP text actually describes --

test("the story name is compared", () => {
  const result = compareProjects(
    [row({ name: "Real GitHub title" })],
    [row({ name: "TOTALLY WRONG" })],
  );

  assert.deepEqual(seen(result), [["7", "name", "Real GitHub title", "TOTALLY WRONG"]]);
});

test("a name the CLI cut in bytes where the importer cut in chars is tolerated (#35629)", () => {
  // The importer's 255 chars of a longer title — 510 bytes — against the CLI's
  // 252 bytes (126 of these chars) plus the ellipsis it appends.
  const result = compareProjects(
    [row({ name: "é".repeat(255) })],
    [row({ name: `${"é".repeat(126)}…` })],
  );

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(
    result.tolerated.map((t) => [t.field, t.reason]),
    [["name", DIVERGENCES.NAME_CLAMP]],
  );
});

test("a short name ending in an ellipsis is a mismatch, not a clamp", () => {
  const result = compareProjects([row({ name: "Fix the bug" })], [row({ name: "Fix…" })]);

  assert.deepEqual(seen(result), [["7", "name", "Fix the bug", "Fix…"]]);
});

test("the clamp reason names the limit its tolerance actually fires on", () => {
  assert.doesNotMatch(DIVERGENCES.CLAMP, /255/);
  assert.match(DIVERGENCES.NAME_CLAMP, /255/);
});

// --- accepted divergences that used to go red, and flaky orderings ----------

test("a comment body the CLI trimmed is tolerated as the declared trim divergence", () => {
  const at = "2026-01-01T00:00:00Z";
  const result = compareProjects(
    [row({ comments: [{ text: "Looks good to me\n", created: at, author: null }] })],
    [row({ comments: [{ text: "Looks good to me", created: at, author: null }] })],
  );

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(
    result.tolerated.map((t) => [t.field, t.reason]),
    [["comments[0].text", DIVERGENCES.COMMENT_TRIM]],
  );
});

test("a comment body that differs past its whitespace is still a mismatch", () => {
  const at = "2026-01-01T00:00:00Z";
  const result = compareProjects(
    [row({ comments: [{ text: "Looks good\n", created: at, author: null }] })],
    [row({ comments: [{ text: "Looks bad", created: at, author: null }] })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["comments[0].text"],
  );
});

test("tasks compare ignoring the order the projection returns them in", () => {
  const one = { description: "one", complete: true };
  const two = { description: "two", complete: false };
  const result = compareProjects([row({ tasks: [one, two] })], [row({ tasks: [two, one] })]);

  assert.deepEqual(result.mismatches, []);
});

test("the unordered-task divergence names its companion server ask", () => {
  assert.match(DIVERGENCES.TASK_ORDER, /#44443/);
});

test("comments whose sort keys collate equal are still ordered totally", () => {
  const at = "2026-01-01T00:00:00Z";
  const soft = { text: "a­b", created: at, author: null };
  const plain = { text: "ab", created: at, author: null };
  const result = compareProjects(
    [row({ comments: [soft, plain] })],
    [row({ comments: [plain, soft] })],
  );

  assert.deepEqual(result.mismatches, []);
});

test("labels whose names collate equal are still ordered totally", () => {
  const soft = { name: "a­b", background_color_hex: "#000", text_color_hex: "#fff" };
  const plain = { name: "ab", background_color_hex: "#111", text_color_hex: "#eee" };
  const result = compareProjects(
    [row({ labels: [soft, plain] })],
    [row({ labels: [plain, soft] })],
  );

  assert.deepEqual(result.mismatches, []);
});

// --- a clamp anchored on content, not on the cut the CLI actually made ------

test("an issue body that quotes the truncation notice cannot anchor the clamp comparison", () => {
  const result = compareProjects(
    [row({ description: `A${"S".repeat(30_000)}` })],
    [row({ description: `A${TRUNCATION_NOTICE}${"D".repeat(500)}\n\n${TRUNCATION_NOTICE}` })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
  assert.deepEqual(result.tolerated, []);
});

test("text past a quoted notice is compared, not swallowed as everything after the cut", () => {
  const result = compareProjects(
    [row({ description: `AB${TRUNCATION_NOTICE} ${"Z".repeat(4000)}` })],
    [
      row({
        description: `AB${TRUNCATION_NOTICE}\n\nNOTHING ALIKE HERE AT ALL\n\n${TRUNCATION_NOTICE}`,
      }),
    ],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
  assert.deepEqual(result.tolerated, []);
});

test("the clamp anchor is the trailing notice even when the clamp is exactly at the limit", () => {
  const limit = FALLBACK_LIMITS.storyDescription;
  const head = `A${TRUNCATION_NOTICE}`;
  const clamped = `${head}${"D".repeat(limit - byteLen(head) - byteLen(TRUNCATION_NOTICE) - 2)}\n\n${TRUNCATION_NOTICE}`;
  assert.equal(byteLen(clamped), limit, "the fixture must sit on the limit, not below it");

  const result = compareProjects(
    [row({ description: `A${"S".repeat(30_000)}` })],
    [row({ description: clamped })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
});

test("a clamp far below the limit it was supposedly cut to is a mismatch", () => {
  const result = compareProjects(
    [row({ description: `A${"z".repeat(20_000)}` })],
    [row({ description: `A${TRUNCATION_NOTICE}` })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
  assert.deepEqual(result.tolerated, []);
});

// --- tolerances are directional: each names which engine diverges -----------

test("a clamp on the SERVER side is a mismatch — only the CLI cuts to the write limit", () => {
  const result = compareProjects(
    [row({ description: clampBlock("x", FALLBACK_LIMITS.storyDescription) })],
    [row({ description: "x".repeat(20_000) })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
});

test("a name clamped on the SERVER side is a mismatch, not the byte-vs-char divergence", () => {
  const result = compareProjects(
    [row({ name: `${"é".repeat(126)}…` })],
    [row({ name: "é".repeat(255) })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["name"],
  );
});

test("the trim divergence runs one way: the CLI trims, so a trimmed SERVER body is a mismatch", () => {
  const at = "2026-01-01T00:00:00Z";
  const result = compareProjects(
    [row({ comments: [{ text: "Looks good to me", created: at, author: null }] })],
    [row({ comments: [{ text: "Looks good to me\n", created: at, author: null }] })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["comments[0].text"],
  );
});

// --- the back-link footer each engine actually writes -----------------------

test("'Imported from …/pull/N' is not a marker the direct engine ever writes", () => {
  const result = compareProjects(
    [row({ description: "Body\n\n[View original issue](https://github.com/o/r/pull/7)" })],
    [row({ description: "Body\n\nImported from https://github.com/o/r/pull/7" })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
});

test("the server's own '[View original issue](…/pull/N)' footer is still popped", () => {
  const result = compareProjects(
    [row({ description: "Body\n\n[View original issue](https://github.com/o/r/pull/7)" })],
    [row({ description: "Body\n\nImported from https://github.com/o/r/issues/7" })],
  );

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(
    result.tolerated.map((t) => t.reason),
    [DIVERGENCES.BACKLINK],
  );
});

// --- the cross-link block clampPlan cuts the body around ---------------------

test("a body clamped around its cross-link block is still the clamp divergence", () => {
  const tail = "\n\nSub-issue of #3";
  const bodyLimit = FALLBACK_LIMITS.storyDescription - byteLen(tail);
  const result = compareProjects(
    [row({ description: `${"X".repeat(30_000)}${tail}` })],
    [row({ description: `${clampBlock("X", bodyLimit)}${tail}` })],
  );

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(
    result.tolerated.map((t) => t.reason),
    [DIVERGENCES.CLAMP],
  );
});

test("two engines disagreeing on the cross-link block itself is a mismatch", () => {
  const result = compareProjects(
    [row({ description: "Body\n\nSub-issue of #3" })],
    [row({ description: "Body\n\nSub-issue of #4" })],
  );

  assert.equal(result.mismatches.length, 1);
  assert.match(result.mismatches[0].field, /cross-link/);
});

test("a cross-link block is only popped off the tail, never out of the body", () => {
  const result = compareProjects(
    [row({ description: "Sub-issues: #1, #2\n\nreal body" })],
    [row({ description: "Sub-issues: #9\n\nreal body" })],
  );

  assert.deepEqual(
    result.mismatches.map((m) => m.field),
    ["description"],
  );
});

// --- the row floor, and the families a run actually measured ----------------

test("a malformed row floor is a violation, never a quiet fallback to 1", () => {
  const counts = { compared: 1 };

  assert.match(String(floorViolation(counts, Number("1O"))), /NaN/);
  assert.match(String(floorViolation(counts, Number("50 rows"))), /NaN/);
  assert.match(String(floorViolation({ compared: 50 }, Number(""))), /0/);
  assert.equal(floorViolation(counts, 1), null);
});

test("the report counts the rows each field family was actually measured on", () => {
  const at = "2026-01-01T00:00:00Z";
  const rich = {
    comments: [{ text: "hi", created: at, author: null }],
    tasks: [{ description: "one", complete: true }],
    labels: [{ name: "bug", background_color_hex: "#0f0", text_color_hex: "#000" }],
    owners: [ext("sam", 1)],
    requestor: ext("kim", 2),
  };
  const result = compareProjects(
    [row({ key: "7", ...rich }), row({ key: "8" })],
    [row({ key: "7", ...rich }), row({ key: "8" })],
  );

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.coverage, {
    comments: 1,
    tasks: 1,
    labels: 1,
    owners: 1,
    requestor: 1,
  });
  assert.match(formatReport(result), /comments 1, tasks 1, labels 1, owners 1, requestor 1/);
});

test("a family neither engine read shows as zero, so an unmeasured family is visible", () => {
  const result = compareProjects([row({ key: "7" })], [row({ key: "7" })]);

  assert.equal(result.coverage.comments, 0);
  assert.match(formatReport(result), /comments 0/);
});

test("the report names the distinct-key counts whenever a key was written twice", () => {
  const result = compareProjects([row({ key: "7" }), row({ key: "7" })], [row({ key: "7" })]);

  assert.match(formatReport(result), /distinct keys: server 1, direct 1/);
});

test("the story-name limit is the run's resolved one, not a hand-copied 255", () => {
  const limits = { ...FALLBACK_LIMITS, storyName: 40 };
  const source = "é".repeat(40);
  const result = compareProjects([row({ name: source })], [row({ name: `${"é".repeat(18)}…` })], {
    limits,
  });

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(
    result.tolerated.map((t) => t.reason),
    [DIVERGENCES.NAME_CLAMP],
  );
});
