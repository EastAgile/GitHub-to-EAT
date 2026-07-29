import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertDirectSupportsIncludes,
  DEFAULT_ENGINE,
  DIRECT_SUPPORTED_INCLUDES,
  ENGINES,
  parseEngine,
} from "../src/engine.js";

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

test("DIRECT_SUPPORTED_INCLUDES is issues plus releases", () => {
  assert.deepEqual(DIRECT_SUPPORTED_INCLUDES, ["issues", "releases"]);
});

for (const selected of [["issues"], ["issues", "releases"]]) {
  test(`assertDirectSupportsIncludes allows ${selected.join(",")}`, () => {
    assert.doesNotThrow(() => assertDirectSupportsIncludes(selected));
  });
}

for (const extra of ["prs", "milestones"]) {
  test(`assertDirectSupportsIncludes rejects issues,${extra}`, () => {
    assert.throws(
      () => assertDirectSupportsIncludes(["issues", extra]),
      /not supported by the direct engine yet/,
    );
  });
}

// The CLI prefixes this message with whichever flag the member typed, so the
// body must not name a flag of its own. The supported list is derived, so it
// cannot go on claiming issues-only once another type lands.
test("assertDirectSupportsIncludes names the engine and its real scope, not a flag", () => {
  assert.throws(
    () => assertDirectSupportsIncludes(["issues", "prs"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(
        err.message,
        "the direct engine imports issues + releases; prs not supported by the direct engine yet",
      );
      assert.ok(!err.message.includes("--"), `message names a flag: ${err.message}`);
      return true;
    },
  );
});
