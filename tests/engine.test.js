import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertDirectSupportsIncludes,
  DEFAULT_ENGINE,
  DIRECT_SUPPORTED_INCLUDES,
  ENGINES,
  parseEngine,
} from "../src/engine.js";
import { MAPPINGS } from "../src/mappings.js";

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

test("DIRECT_SUPPORTED_INCLUDES now covers every type the registry offers", () => {
  assert.deepEqual(DIRECT_SUPPORTED_INCLUDES, ["issues", "prs", "milestones", "releases"]);
  // Transcribed, not derived: a type added to the registry must be decided here rather
  // than inheriting direct support it has no mapping for.
  assert.deepEqual(DIRECT_SUPPORTED_INCLUDES, Object.keys(MAPPINGS));
});

for (const selected of [
  ["issues"],
  ["issues", "prs"],
  ["issues", "milestones"],
  ["issues", "releases"],
  ["issues", "prs", "milestones", "releases"],
]) {
  test(`assertDirectSupportsIncludes allows ${selected.join(",")}`, () => {
    assert.doesNotThrow(() => assertDirectSupportsIncludes(selected));
  });
}

// The CLI prefixes this message with whichever flag the member typed, so the
// body must not name a flag of its own. The supported list is derived, so it
// cannot go on claiming a narrower scope than the engine has.
test("assertDirectSupportsIncludes names the engine and its real scope, not a flag", () => {
  assert.throws(
    () => assertDirectSupportsIncludes(["issues", "wikis"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(
        err.message,
        "the direct engine imports issues + prs + milestones + releases; " +
          "wikis not supported by the direct engine yet",
      );
      assert.ok(!err.message.includes("--"), `message names a flag: ${err.message}`);
      return true;
    },
  );
});
