import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_ENGINE, ENGINES, parseEngine } from "../src/engine.js";
import { MAPPINGS, parseInclude } from "../src/mappings.js";

test("DEFAULT_ENGINE is server", () => {
  assert.equal(DEFAULT_ENGINE, "server");
});

test("ENGINES lists server and direct", () => {
  assert.deepEqual(ENGINES, ["server", "direct"]);
});

for (const value of ["server", "direct"]) {
  test(`parseEngine accepts ${value}`, () => {
    assert.equal(parseEngine(value), value);
  });
}

for (const bad of ["", "SERVER", "local", "srever", "both"]) {
  test(`parseEngine rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() => parseEngine(bad), /engine/);
  });
}

// Why engine.js carries no direct-unsupported gate any more: parseInclude is the only
// producer of an `--include` selection and it yields registry types only, so a second
// filter behind it could never fire. Breaking this is what a future gate would need.
test("parseInclude yields registry types only, so no engine-scope filter can fire", () => {
  const every = Object.keys(MAPPINGS);
  assert.deepEqual(parseInclude(every.join(",")), every);
  for (const type of parseInclude(every.join(","))) assert.ok(type in MAPPINGS);
  assert.throws(() => parseInclude("issues,wikis"), /unknown import type 'wikis'/);
});
