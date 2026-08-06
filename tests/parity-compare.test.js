import assert from "node:assert/strict";
import test from "node:test";

import { TRUNCATION_NOTICE } from "../src/mapping.js";
import { compareProjects, DIVERGENCES, formatReport } from "./parity-compare.js";

const row = (/** @type {object} */ over = {}) => ({
  key: "7",
  story_type: "feature",
  current_state: "unstarted",
  created: "2026-01-02T03:04:05Z",
  description: "Body\n\nImported from https://github.com/o/r/issues/7",
  import_source: "github",
  import_external_id: "7",
  tasks: [],
  comments: [],
  labels: [],
  requestor: null,
  owners: [],
  ...over,
});

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

test("text the CLI clamped is tolerated as the bytes-vs-chars divergence (#35629)", () => {
  const clamped = `Long body${TRUNCATION_NOTICE}`;
  const result = compareProjects(
    [row({ description: "Long body and then some more of it" })],
    [row({ description: clamped })],
  );

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

  assert.deepEqual(result.counts, { server: 2, direct: 1, compared: 1 });
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
