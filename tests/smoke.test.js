import assert from "node:assert/strict";
import { test } from "node:test";

import { VERSION } from "../src/version.js";

test("version is a non-empty string", () => {
  assert.equal(typeof VERSION, "string");
  assert.ok(VERSION.length > 0);
});
