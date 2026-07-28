import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertDirectSupportsIncludes,
  DEFAULT_ENGINE,
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

test("assertDirectSupportsIncludes allows issues only", () => {
  assert.doesNotThrow(() => assertDirectSupportsIncludes(["issues"]));
});

for (const extra of ["prs", "milestones", "releases"]) {
  test(`assertDirectSupportsIncludes rejects issues,${extra}`, () => {
    assert.throws(
      () => assertDirectSupportsIncludes(["issues", extra]),
      /not supported by the direct engine yet/,
    );
  });
}

// The CLI prefixes this message with whichever flag the member typed, so the
// body must not name a flag of its own.
test("assertDirectSupportsIncludes names the engine, not a flag", () => {
  assert.throws(
    () => assertDirectSupportsIncludes(["issues", "prs"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(
        err.message,
        "the direct engine imports issues only (V3); prs not supported by the direct engine yet",
      );
      assert.ok(!err.message.includes("--"), `message names a flag: ${err.message}`);
      return true;
    },
  );
});
