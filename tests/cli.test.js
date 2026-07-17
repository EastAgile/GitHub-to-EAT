import assert from "node:assert/strict";
import { test } from "node:test";

import { main, parseRepo } from "../src/cli.js";
import { AuthError } from "../src/client.js";
import { MAPPINGS } from "../src/mappings.js";
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
    dryRun: false,
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
    withEnv({ EAT_AGENT_KEY: "key", EAT_API_BASE: "http://127.0.0.1:9/api/v1" }, async () => {
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

test("the mapping legend derives from the registry and shows on dry-run", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key", EAT_API_BASE: "http://127.0.0.1:9/api/v1" }, async () => {
      const out = capture();
      const code = await main(
        ["--project", "91", "--repo", "o/r", "--include", "issues,milestones", "--dry-run"],
        { stdout: out, stderr: capture(), preflight: async () => preflightResult() },
      );
      assert.equal(code, 0);
      assert.ok(out.buf.includes("Import mapping (GitHub → East Agile Tracker):"));
      assert.ok(out.buf.includes(MAPPINGS.issues.legend[0]));
      assert.ok(out.buf.includes(MAPPINGS.milestones.legend[0]));
      assert.ok(!out.buf.includes(MAPPINGS.prs.legend[0])); // not selected
      assert.ok(out.buf.includes("re-runs skip already-imported items"));
    }),
  );
});

test("declining the confirm prompt aborts with exit 1", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      /** @type {string[]} */
      const asked = [];
      const called = [];
      const err = capture();
      const code = await main(["--project", "91", "--repo", "o/r"], {
        stdout: capture(),
        stderr: err,
        preflight: async () => preflightResult(),
        runImport: async () => {
          called.push(1);
          return outcome();
        },
        confirm: async (q) => {
          asked.push(q);
          return false;
        },
      });
      assert.equal(code, 1);
      assert.equal(called.length, 0);
      assert.equal(asked.length, 1);
      assert.ok(asked[0].includes("[y/N]"));
      assert.ok(err.buf.includes("Aborted — nothing imported."));
    }),
  );
});

test("accepting the confirm prompt proceeds with the import", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = capture();
      const code = await main(["--project", "91", "--repo", "o/r"], {
        stdout: out,
        stderr: capture(),
        preflight: async () => preflightResult(),
        runImport: async () => outcome({ importedStories: 1 }),
        confirm: async () => true,
      });
      assert.equal(code, 0);
      assert.ok(out.buf.includes("Imported 1"));
    }),
  );
});

test("--yes skips the confirm prompt entirely", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const asked = [];
      const code = await main(["--project", "91", "--repo", "o/r", "--yes"], {
        stdout: capture(),
        stderr: capture(),
        preflight: async () => preflightResult(),
        runImport: async () => outcome(),
        confirm: async () => {
          asked.push(1);
          return false;
        },
      });
      assert.equal(code, 0);
      assert.equal(asked.length, 0);
    }),
  );
});

test("--dry-run never prompts", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key", EAT_API_BASE: "http://127.0.0.1:9/api/v1" }, async () => {
      const asked = [];
      const code = await main(["--project", "91", "--repo", "o/r", "--dry-run"], {
        stdout: capture(),
        stderr: capture(),
        preflight: async () => preflightResult(),
        confirm: async () => {
          asked.push(1);
          return false;
        },
      });
      assert.equal(code, 0);
      assert.equal(asked.length, 0);
    }),
  );
});

test("an invalid --engine is a usage error", async () => {
  const err = capture();
  const code = await main(["--project", "91", "--repo", "o/r", "--engine", "local"], {
    stdout: capture(),
    stderr: err,
  });
  assert.equal(code, 2);
  assert.ok(err.buf.includes("engine"));
});

test("the default engine dispatches to the server importer, not the direct engine", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = capture();
      const server = [];
      const direct = [];
      const code = await main(["--project", "91", "--repo", "o/r", "-y"], {
        stdout: out,
        stderr: capture(),
        preflight: async () => preflightResult(),
        runImport: async () => {
          server.push(1);
          return outcome({ importedStories: 2 });
        },
        runDirect: async () => {
          direct.push(1);
          return outcome();
        },
      });
      assert.equal(code, 0);
      assert.equal(server.length, 1);
      assert.equal(direct.length, 0);
      assert.ok(out.buf.includes("Imported 2"));
    }),
  );
});

test("--engine server is byte-identical to the default: no engine tag in the legend", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = capture();
      const code = await main(["--project", "91", "--repo", "o/r", "--engine", "server", "-y"], {
        stdout: out,
        stderr: capture(),
        preflight: async () => preflightResult(),
        runImport: async () => outcome({ importedStories: 1 }),
      });
      assert.equal(code, 0);
      assert.ok(out.buf.includes("Import mapping (GitHub → East Agile Tracker):"));
      assert.ok(!out.buf.includes("[engine:"));
    }),
  );
});

test("--engine direct dispatches to the direct engine, not the server importer", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = capture();
      const server = [];
      const direct = [];
      const code = await main(["--project", "91", "--repo", "o/r", "--engine", "direct", "-y"], {
        stdout: out,
        stderr: capture(),
        preflight: async () => preflightResult(),
        runImport: async () => {
          server.push(1);
          return outcome();
        },
        runDirect: async () => {
          direct.push(1);
          return outcome({ importedStories: 3 });
        },
      });
      assert.equal(code, 0);
      assert.equal(direct.length, 1);
      assert.equal(server.length, 0);
      assert.ok(out.buf.includes("Imported 3"));
    }),
  );
});

test("--engine direct names the active engine in the legend header", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = capture();
      const code = await main(["--project", "91", "--repo", "o/r", "--engine", "direct", "-y"], {
        stdout: out,
        stderr: capture(),
        preflight: async () => preflightResult(),
        runDirect: async () => outcome(),
      });
      assert.equal(code, 0);
      assert.ok(out.buf.includes("[engine: direct]"));
    }),
  );
});

test("--engine direct with a non-issue type is a usage error", async () => {
  const err = capture();
  const code = await main(
    ["--project", "91", "--repo", "o/r", "--engine", "direct", "--include", "issues,prs"],
    { stdout: capture(), stderr: err },
  );
  assert.equal(code, 2);
  assert.ok(err.buf.includes("not supported by the direct engine yet"));
});

test("--engine direct with --dry-run reports the pending local dry-run stage", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const err = capture();
      const code = await main(
        ["--project", "91", "--repo", "o/r", "--engine", "direct", "--dry-run"],
        {
          stdout: capture(),
          stderr: err,
          preflight: async () => preflightResult(),
        },
      );
      assert.equal(code, 1);
      assert.ok(err.buf.includes("dry-run"));
      assert.ok(err.buf.includes("not built yet"));
    }),
  );
});

test("the direct engine prompts for confirmation like the server engine", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const err = capture();
      const direct = [];
      const code = await main(["--project", "91", "--repo", "o/r", "--engine", "direct"], {
        stdout: capture(),
        stderr: err,
        preflight: async () => preflightResult(),
        runDirect: async () => {
          direct.push(1);
          return outcome();
        },
        confirm: async () => false,
      });
      assert.equal(code, 1);
      assert.equal(direct.length, 0);
      assert.ok(err.buf.includes("Aborted"));
    }),
  );
});
