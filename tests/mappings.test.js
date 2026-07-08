import assert from "node:assert/strict";
import { test } from "node:test";

import { MAPPINGS, parseInclude, requestFlags } from "../src/mappings.js";

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
