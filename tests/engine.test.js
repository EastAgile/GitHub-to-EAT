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
