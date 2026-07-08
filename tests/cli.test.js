import assert from "node:assert/strict";
import { test } from "node:test";

import { main, parseRepo } from "../src/cli.js";
import { AuthError } from "../src/client.js";
import { VERSION } from "../src/version.js";
import { capture, inTempDir, withEnv } from "./helpers.js";

/** @param {Partial<import("../src/preflight.js").PreflightResult>} [overrides] */
function preflightResult(overrides = {}) {
  return { projectId: 91, projectTitle: "Demo", nonEmpty: false, ...overrides };
}

/** @param {Partial<import("../src/importer.js").ImportOutcome>} [overrides] */
function outcome(overrides = {}) {
  return {
    importedStories: 0,
    importedLabels: 0,
    skipped: 0,
    errors: [],
    unmatched: {},
    ...overrides,
  };
}

test("parseRepo splits owner/name", () => {
  assert.deepEqual(parseRepo("octocat/hello-world"), ["octocat", "hello-world"]);
});

for (const bad of ["", "noslash", "a/b/c", "/name", "owner/"]) {
  test(`parseRepo rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() => parseRepo(bad));
  });
}

test("--version exits zero and prints the version", async () => {
  const out = capture();
  const code = await main(["--version"], { stdout: out, stderr: capture() });
  assert.equal(code, 0);
  assert.ok(out.buf.includes(VERSION));
});

test("missing --project is a usage error", async () => {
  const code = await main(["--repo", "octocat/hello-world"], {
    stdout: capture(),
    stderr: capture(),
  });
  assert.equal(code, 2);
});

test("bad --repo is a usage error", async () => {
  const code = await main(["--project", "91", "--repo", "not-a-repo"], {
    stdout: capture(),
    stderr: capture(),
  });
  assert.equal(code, 2);
});

test("missing key returns one", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: undefined }, async () => {
      const err = capture();
      const code = await main(["--project", "91", "--repo", "octocat/hello-world"], {
        stdout: capture(),
        stderr: err,
      });
      assert.equal(code, 1);
      assert.ok(err.buf.includes("EAT_AGENT_KEY"));
    }),
  );
});

test("happy path: preflight then import", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = capture();
      const code = await main(["--project", "91", "--repo", "octocat/hello-world"], {
        stdout: out,
        stderr: capture(),
        preflight: async () => preflightResult({ projectTitle: "Demo Board" }),
        runImport: async () => outcome({ importedStories: 2 }),
      });
      assert.equal(code, 0);
      assert.ok(out.buf.includes("Demo Board"));
      assert.ok(out.buf.includes("Imported 2"));
    }),
  );
});

test("non-empty project warns", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const err = capture();
      const code = await main(["--project", "91", "--repo", "octocat/hello-world"], {
        stdout: capture(),
        stderr: err,
        preflight: async () => preflightResult({ nonEmpty: true }),
        runImport: async () => outcome(),
      });
      assert.equal(code, 0);
      assert.ok(err.buf.includes("already has stories"));
    }),
  );
});

test("preflight error returns one", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const err = capture();
      const code = await main(["--project", "91", "--repo", "octocat/hello-world"], {
        stdout: capture(),
        stderr: err,
        preflight: async () => {
          throw new AuthError("bad token");
        },
      });
      assert.equal(code, 1);
      assert.ok(err.buf.includes("bad token"));
    }),
  );
});

test("--dry-run skips the import", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      /** @type {number[]} */
      const called = [];
      const out = capture();
      const code = await main(["--project", "91", "--repo", "octocat/hello-world", "--dry-run"], {
        stdout: out,
        stderr: capture(),
        preflight: async () => preflightResult(),
        runImport: async () => {
          called.push(1);
          return outcome();
        },
      });
      assert.equal(code, 0);
      assert.equal(called.length, 0);
      assert.ok(out.buf.includes("Dry run"));
    }),
  );
});
