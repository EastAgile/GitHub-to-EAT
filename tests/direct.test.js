import assert from "node:assert/strict";
import { test } from "node:test";

import { DirectEngineError, runDirect } from "../src/direct.js";

const stubClient = /** @type {import("../src/client.js").EATClient} */ (
  /** @type {unknown} */ ({})
);

test("runDirect scaffold rejects — the pipeline stages are not built yet", async () => {
  await assert.rejects(
    () => runDirect(stubClient, 91, "octocat", "hello-world", { included: ["issues"] }),
    (err) => {
      assert.ok(err instanceof DirectEngineError);
      assert.match(err.message, /not implemented yet/);
      return true;
    },
  );
});
