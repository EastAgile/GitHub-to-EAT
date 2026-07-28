import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";

import { defaultConfirm, main, parseRepo } from "../src/cli.js";
import { AuthError } from "../src/client.js";
import { runDirect as realRunDirect } from "../src/direct.js";
import { GitHubError } from "../src/github.js";
import { MAPPINGS } from "../src/mappings.js";
import { startMockServer } from "../src/mockserver.js";
import { VERSION } from "../src/version.js";
import { capture, inTempDir, withEnv } from "./helpers.js";

/**
 * A TTY-flagged readable that answers wizard prompts one line at a time, then EOFs.
 *
 * @param {string[]} lines
 */
function scriptedStdin(lines) {
  return Object.assign(Readable.from(lines.map((l) => `${l}\n`)), { isTTY: true });
}

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
    externalMembersCreated: [],
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
      const code = await main(["--project", "91", "--repo", "octocat/hello-world", "-y"], {
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
      const code = await main(["--project", "91", "--repo", "octocat/hello-world", "-y"], {
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
      const code = await main(["--project", "91", "--repo", "octocat/hello-world", "-y"], {
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
      const code = await main(["--project", "91", "--repo", "octocat/hello-world", "-y"], {
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

test("--engine direct with --dry-run renders the same plan block as the server path", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = capture();
      /** @type {boolean[]} */
      const dryRuns = [];
      const asked = [];
      const code = await main(
        ["--project", "91", "--repo", "o/r", "--engine", "direct", "--dry-run"],
        {
          stdout: out,
          stderr: capture(),
          preflight: async () => preflightResult(),
          runDirect: async (_client, _project, _owner, _repo, opts) => {
            dryRuns.push(opts.dryRun ?? false);
            return outcome({ importedStories: 2, importedLabels: 1, skipped: 1, dryRun: true });
          },
          confirm: async () => {
            asked.push(1);
            return false;
          },
        },
      );
      assert.equal(code, 0);
      assert.deepEqual(dryRuns, [true]);
      assert.equal(asked.length, 0);
      assert.ok(out.buf.includes("Dry run plan for o/r into project 91 (Demo):"));
      assert.ok(
        out.buf.includes("would import 2 stories (1 labels), would skip 1 (already imported)"),
      );
      assert.ok(out.buf.includes("No changes made."));
      assert.ok(!out.buf.includes("Importing"));
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

test("accepting the prompt runs the direct import", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = capture();
      const direct = [];
      const code = await main(["--project", "91", "--repo", "o/r", "--engine", "direct"], {
        stdout: out,
        stderr: capture(),
        preflight: async () => preflightResult(),
        runDirect: async () => {
          direct.push(1);
          return outcome({ importedStories: 4 });
        },
        confirm: async () => true,
      });
      assert.equal(code, 0);
      assert.equal(direct.length, 1);
      assert.ok(out.buf.includes("Imported 4"));
    }),
  );
});

test("a GitHub failure in the direct engine maps to a clean exit 1", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const err = capture();
      const code = await main(["--project", "91", "--repo", "o/r", "--engine", "direct", "-y"], {
        stdout: capture(),
        stderr: err,
        preflight: async () => preflightResult(),
        runDirect: async () => {
          throw new GitHubError("GitHub request failed (404): repo not found");
        },
      });
      assert.equal(code, 1);
      assert.ok(err.buf.includes("error: GitHub request failed (404)"));
    }),
  );
});

// --- --customize (V3 plumbing) -----------------------------------------------

/** A TTY-flagged capture stream, for tests that simulate an interactive run. */
function ttyCapture() {
  return Object.assign(capture(), { isTTY: true });
}

test("--help documents --customize", async () => {
  const out = capture();
  const code = await main(["--help"], { stdout: out, stderr: capture() });
  assert.equal(code, 0);
  assert.ok(out.buf.includes("--customize"));
});

test("--engine server --customize is a usage error naming the conflict", async () => {
  const err = capture();
  const code = await main(
    ["--project", "91", "--repo", "o/r", "--engine", "server", "--customize"],
    { stdout: ttyCapture(), stderr: err, stdin: { isTTY: true } },
  );
  assert.equal(code, 2);
  assert.ok(err.buf.includes("--customize"));
  assert.ok(err.buf.includes("--engine server"));
});

test("--customize with non-TTY stdin is a usage error", async () => {
  const err = capture();
  const code = await main(["--project", "91", "--repo", "o/r", "--customize"], {
    stdout: ttyCapture(),
    stderr: err,
    stdin: { isTTY: false },
  });
  assert.equal(code, 2);
  assert.ok(err.buf.includes("interactive terminal"));
});

test("--customize with non-TTY stdout is a usage error", async () => {
  const err = capture();
  const code = await main(["--project", "91", "--repo", "o/r", "--customize"], {
    stdout: capture(),
    stderr: err,
    stdin: { isTTY: true },
  });
  assert.equal(code, 2);
  assert.ok(err.buf.includes("interactive terminal"));
});

test("--customize implies the direct engine and names it in the legend", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = ttyCapture();
      const server = [];
      const direct = [];
      const code = await main(["--project", "91", "--repo", "o/r", "--customize", "-y"], {
        stdout: out,
        stderr: capture(),
        stdin: { isTTY: true },
        preflight: async () => preflightResult(),
        runImport: async () => {
          server.push(1);
          return outcome();
        },
        // #31908 moved the customized legend after the wizard, into runDirect's
        // announce hook, so the stub must drive it to render the legend.
        runDirect: async (_client, _project, _owner, _repo, opts) => {
          direct.push(1);
          await opts.announce?.(
            { issues: [], comments: [], labels: [] },
            { states: "all", milestones: null, storyType: "infer", comments: true, tasks: true },
          );
          return outcome({ importedStories: 3 });
        },
      });
      assert.equal(code, 0);
      assert.equal(direct.length, 1);
      assert.equal(server.length, 0);
      assert.ok(out.buf.includes("[engine: direct]"));
    }),
  );
});

test("--engine direct --customize is accepted, not a conflict", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const code = await main(
        ["--project", "91", "--repo", "o/r", "--engine", "direct", "--customize", "-y"],
        {
          stdout: ttyCapture(),
          stderr: capture(),
          stdin: { isTTY: true },
          preflight: async () => preflightResult(),
          runDirect: async () => outcome(),
        },
      );
      assert.equal(code, 0);
    }),
  );
});

test("--customize threads a wizard seam (not a fixed customization) into the direct pipeline", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      /** @type {any} */
      let seen = null;
      const code = await main(["--project", "91", "--repo", "o/r", "--customize", "-y"], {
        stdout: ttyCapture(),
        stderr: capture(),
        stdin: { isTTY: true },
        preflight: async () => preflightResult(),
        runDirect: async (_client, _project, _owner, _repo, opts) => {
          seen = opts;
          return outcome();
        },
      });
      assert.equal(code, 0);
      assert.equal(typeof seen.customize, "function");
      assert.equal(seen.customization, undefined);
    }),
  );
});

test("--customize output is byte-identical to --engine direct alone (mockserver)", async () => {
  /** GitHubClient#fetchAll-shaped fixture, stubbed so no GitHub call happens. */
  const fetched = {
    issues: [
      {
        number: 7,
        title: "newer open issue",
        body: "steps\n\n- [ ] repro",
        state: "open",
        created_at: "2024-05-01T00:00:00Z",
        labels: [],
      },
      {
        number: 3,
        title: "older closed issue",
        body: "done",
        state: "closed",
        created_at: "2020-01-01T00:00:00Z",
        closed_at: "2020-02-01T00:00:00Z",
        labels: [{ name: "bug", color: "ff0000" }],
      },
    ],
    comments: [
      {
        issue_url: "https://api.github.com/repos/o/r/issues/3",
        user: { login: "alice" },
        created_at: "2020-01-05T00:00:00Z",
        body: "confirmed",
      },
    ],
    labels: [{ name: "bug", color: "ff0000" }],
  };

  /** @param {string[]} argv */
  const run = async (argv) => {
    const mock = await startMockServer();
    try {
      return await inTempDir(() =>
        withEnv(
          {
            EAT_AGENT_KEY: "key",
            EAT_API_BASE: mock.baseUrl,
            EAT_APP_BASE: "https://eat.example",
          },
          async () => {
            const out = ttyCapture();
            const code = await main(argv, {
              stdout: out,
              stderr: capture(),
              // All-default wizard answers keep --customize byte-identical to plain direct.
              stdin: scriptedStdin(["", "", "", "", ""]),
              runDirect: (client, project, owner, repo, opts) =>
                realRunDirect(client, project, owner, repo, {
                  ...opts,
                  github: { fetchAll: async () => fetched },
                }),
            });
            const rows = (mock.state.stories[91] ?? []).map((row) => ({
              title: row.title,
              description: row.description,
              story_type: row.story_type,
              current_state: row.current_state,
              labels: row.labels.map((/** @type {any} */ l) => l.label_name),
              tasks: row.tasks.map((/** @type {any} */ t) => ({
                task_desc: t.task_desc,
                complete: t.complete,
              })),
              comments: row.comments.map((/** @type {any} */ c) => c.comment_text),
            }));
            return { code, stdout: out.buf, rows };
          },
        ),
      );
    } finally {
      await mock.close();
    }
  };

  const base = ["--project", "91", "--repo", "o/r", "-y"];
  const plain = await run([...base, "--engine", "direct"]);
  const customized = await run([...base, "--customize"]);
  assert.equal(plain.code, 0);
  assert.equal(customized.code, 0);
  assert.equal(plain.rows.length, 2);
  assert.equal(customized.stdout, plain.stdout);
  assert.deepEqual(customized.rows, plain.rows);
});

test("EOF mid-wizard aborts --customize with exit 1 and nothing written (mockserver)", async () => {
  const fetched = {
    issues: [{ number: 7, title: "open issue", body: "", state: "open", labels: [] }],
    comments: [],
    labels: [],
  };
  const mock = await startMockServer();
  try {
    await inTempDir(() =>
      withEnv(
        { EAT_AGENT_KEY: "key", EAT_API_BASE: mock.baseUrl, EAT_APP_BASE: "https://eat.example" },
        async () => {
          const err = capture();
          const code = await main(["--project", "91", "--repo", "o/r", "--customize", "-y"], {
            stdout: ttyCapture(),
            stderr: err,
            stdin: scriptedStdin([]), // EOF at the first question
            runDirect: (client, project, owner, repo, opts) =>
              realRunDirect(client, project, owner, repo, {
                ...opts,
                github: { fetchAll: async () => fetched },
              }),
          });
          assert.equal(code, 1);
          assert.equal((mock.state.stories[91] ?? []).length, 0);
          assert.ok(err.buf.includes("Aborted"));
        },
      ),
    );
  } finally {
    await mock.close();
  }
});

test("--customize --yes runs the wizard and skips the [y/N] confirm (mockserver)", async () => {
  const fetched = {
    issues: [
      { number: 7, title: "open one", body: "", state: "open", labels: [] },
      {
        number: 3,
        title: "closed one",
        body: "",
        state: "closed",
        closed_at: "2020-02-01T00:00:00Z",
        labels: [],
      },
    ],
    comments: [],
    labels: [],
  };
  const mock = await startMockServer();
  try {
    await inTempDir(() =>
      withEnv(
        { EAT_AGENT_KEY: "key", EAT_API_BASE: mock.baseUrl, EAT_APP_BASE: "https://eat.example" },
        async () => {
          const out = ttyCapture();
          /** @type {string[]} */
          const asked = [];
          // No milestones on these issues, so the wizard asks four questions:
          // states → "open only", story type default, comments off, tasks default.
          const code = await main(["--project", "91", "--repo", "o/r", "--customize", "-y"], {
            stdout: out,
            stderr: capture(),
            stdin: scriptedStdin(["2", "", "n", ""]),
            confirm: async (q) => {
              asked.push(q);
              return false;
            },
            runDirect: (client, project, owner, repo, opts) =>
              realRunDirect(client, project, owner, repo, {
                ...opts,
                github: { fetchAll: async () => fetched },
              }),
          });
          assert.equal(code, 0);
          assert.equal(asked.length, 0); // --yes: the [y/N] confirm is skipped
          // The legend reflects the wizard's non-default answers (rendered after it).
          assert.ok(out.buf.includes("Customized:"));
          assert.ok(out.buf.includes("issue states: open only"));
          assert.ok(out.buf.includes("comments: not imported"));
          // states = open only drops the closed issue; only the open one is written.
          const rows = mock.state.stories[91] ?? [];
          assert.equal(rows.length, 1);
          assert.equal(rows[0].title, "open one");
        },
      ),
    );
  } finally {
    await mock.close();
  }
});

test("--customize confirms after the wizard; declining writes nothing (mockserver)", async () => {
  const fetched = {
    issues: [{ number: 7, title: "open one", body: "", state: "open", labels: [] }],
    comments: [],
    labels: [],
  };
  const mock = await startMockServer();
  try {
    await inTempDir(() =>
      withEnv(
        { EAT_AGENT_KEY: "key", EAT_API_BASE: mock.baseUrl, EAT_APP_BASE: "https://eat.example" },
        async () => {
          const out = ttyCapture();
          const err = capture();
          const code = await main(["--project", "91", "--repo", "o/r", "--customize"], {
            stdout: out,
            stderr: err,
            stdin: scriptedStdin(["", "", "", ""]), // all-default answers
            confirm: async () => {
              // The confirm runs after the wizard: the customized legend is already on stdout.
              assert.ok(
                out.buf.includes("Import mapping (GitHub → East Agile Tracker) [engine: direct]:"),
              );
              return false;
            },
            runDirect: (client, project, owner, repo, opts) =>
              realRunDirect(client, project, owner, repo, {
                ...opts,
                github: { fetchAll: async () => fetched },
              }),
          });
          assert.equal(code, 1);
          assert.equal((mock.state.stories[91] ?? []).length, 0);
          assert.ok(err.buf.includes("Aborted"));
          // The abort throws before the "Importing..." write, so nothing past the legend prints.
          assert.ok(!out.buf.includes("Importing "));
        },
      ),
    );
  } finally {
    await mock.close();
  }
});

test("--customize --dry-run runs the wizard, prints the plan, and writes nothing (mockserver)", async () => {
  const fetched = {
    issues: [
      { number: 7, title: "open one", body: "", state: "open", labels: [] },
      {
        number: 3,
        title: "closed one",
        body: "",
        state: "closed",
        closed_at: "2020-02-01T00:00:00Z",
        labels: [],
      },
    ],
    comments: [],
    labels: [],
  };
  const mock = await startMockServer();
  try {
    await inTempDir(() =>
      withEnv(
        { EAT_AGENT_KEY: "key", EAT_API_BASE: mock.baseUrl, EAT_APP_BASE: "https://eat.example" },
        async () => {
          const out = ttyCapture();
          /** @type {string[]} */
          const asked = [];
          // states → "open only", then defaults; no milestones, so four questions.
          const code = await main(
            ["--project", "91", "--repo", "o/r", "--customize", "--dry-run"],
            {
              stdout: out,
              stderr: capture(),
              stdin: scriptedStdin(["2", "", "", ""]),
              confirm: async (q) => {
                asked.push(q);
                return false;
              },
              runDirect: (client, project, owner, repo, opts) =>
                realRunDirect(client, project, owner, repo, {
                  ...opts,
                  github: { fetchAll: async () => fetched },
                }),
            },
          );
          assert.equal(code, 0);
          assert.equal(asked.length, 0); // dry-run skips the [y/N] confirm
          // The customized legend still renders (after the wizard)...
          assert.ok(out.buf.includes("Customized:"));
          assert.ok(out.buf.includes("issue states: open only"));
          // ...but the write path is never entered.
          assert.ok(!out.buf.includes("Importing "));
          assert.ok(out.buf.includes("Dry run plan"));
          assert.equal((mock.state.stories[91] ?? []).length, 0);
        },
      ),
    );
  } finally {
    await mock.close();
  }
});

// --- declarative customization flags (#32499) --------------------------------

/** fetchAll-shaped stub: one open issue with a comment, one closed issue. */
function flagFetched() {
  return {
    issues: [
      { number: 7, title: "open one", body: "note\n\n- [ ] todo", state: "open", labels: [] },
      {
        number: 3,
        title: "closed one",
        body: "",
        state: "closed",
        closed_at: "2020-02-01T00:00:00Z",
        labels: [],
      },
    ],
    comments: [
      {
        issue_url: "https://api.github.com/repos/o/r/issues/7",
        user: { login: "alice" },
        created_at: "2020-01-05T00:00:00Z",
        body: "confirmed",
      },
    ],
    labels: [],
  };
}

/**
 * The legend block of a run's stdout, header through the append/dedup line.
 *
 * @param {string} stdout
 */
function legendBlock(stdout) {
  const start = stdout.indexOf("Import mapping (GitHub");
  const tail = "nothing is updated or deleted.\n";
  const end = stdout.indexOf(tail, start);
  return stdout.slice(start, end + tail.length);
}

/**
 * Run `main` against the bundled mock server with the real direct pipeline and
 * a stubbed GitHub fetch. `deps` overrides the streams and seams.
 *
 * @param {string[]} argv
 * @param {any} [deps]
 */
async function runAgainstMock(argv, deps = {}) {
  const mock = await startMockServer();
  try {
    return await inTempDir(() =>
      withEnv(
        { EAT_AGENT_KEY: "key", EAT_API_BASE: mock.baseUrl, EAT_APP_BASE: "https://eat.example" },
        async () => {
          const out = deps.stdout ?? capture();
          const err = deps.stderr ?? capture();
          const fetched = deps.fetched ?? flagFetched();
          const code = await main(argv, {
            confirm: null, // no terminal to confirm on — a piped/CI run
            ...deps,
            stdout: out,
            stderr: err,
            runDirect: (client, project, owner, repo, opts) =>
              realRunDirect(client, project, owner, repo, {
                ...opts,
                github: { fetchAll: async () => fetched },
              }),
          });
          const rows = (mock.state.stories[91] ?? []).map((row) => ({
            title: row.title,
            story_type: row.story_type,
            current_state: row.current_state,
            tasks: row.tasks.length,
            comments: row.comments.length,
          }));
          return { code, stdout: out.buf, stderr: err.buf, rows };
        },
      ),
    );
  } finally {
    await mock.close();
  }
}

test("a customization flag implies the direct engine", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      const out = capture();
      const server = [];
      const direct = [];
      const code = await main(["--project", "91", "--repo", "o/r", "--states", "open", "-y"], {
        stdout: out,
        stderr: capture(),
        preflight: async () => preflightResult(),
        runImport: async () => {
          server.push(1);
          return outcome();
        },
        runDirect: async () => {
          direct.push(1);
          return outcome({ importedStories: 1 });
        },
      });
      assert.equal(code, 0);
      assert.equal(direct.length, 1);
      assert.equal(server.length, 0);
      assert.ok(out.buf.includes("[engine: direct]"));
    }),
  );
});

test("customization flags thread a fixed customization, not a wizard, into the pipeline", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      /** @type {any} */
      let seen = null;
      const code = await main(
        [
          ...["--project", "91", "--repo", "o/r", "-y"],
          ...["--states", "closed", "--milestones", "v1.0,v2.0", "--story-type", "chore"],
          ...["--no-comments", "--no-tasks"],
        ],
        {
          stdout: capture(),
          stderr: capture(),
          preflight: async () => preflightResult(),
          runDirect: async (_client, _project, _owner, _repo, opts) => {
            seen = opts;
            return outcome();
          },
        },
      );
      assert.equal(code, 0);
      assert.equal(seen.customize, undefined);
      assert.deepEqual(seen.customization, {
        states: "closed",
        milestones: ["v1.0", "v2.0"],
        storyType: "chore",
        comments: false,
        tasks: false,
      });
    }),
  );
});

test("--help documents every customization flag", async () => {
  const out = capture();
  const code = await main(["--help"], { stdout: out, stderr: capture() });
  assert.equal(code, 0);
  for (const flag of ["--states", "--milestones", "--story-type", "--no-comments", "--no-tasks"]) {
    assert.ok(out.buf.includes(flag), `--help omits ${flag}`);
  }
});

test("--milestones repeats: each occurrence adds titles to one allowlist", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      /** @type {any} */
      let seen = null;
      const code = await main(
        [
          ...["--project", "91", "--repo", "o/r", "-y"],
          ...["--milestones", "v1.0,v2.0", "--milestones", "v3.0"],
        ],
        {
          stdout: capture(),
          stderr: capture(),
          preflight: async () => preflightResult(),
          runDirect: async (_client, _project, _owner, _repo, opts) => {
            seen = opts;
            return outcome();
          },
        },
      );
      assert.equal(code, 0);
      assert.deepEqual(seen.customization.milestones, ["v1.0", "v2.0", "v3.0"]);
    }),
  );
});

test("a --milestones typo surfaces the warning through main, not just runDirect", async () => {
  const run = await runAgainstMock([
    ...["--project", "91", "--repo", "o/r", "-y"],
    ...["--milestones", "v9.9"],
  ]);
  assert.equal(run.code, 0);
  assert.match(run.stderr, /warning:.*v9\.9/);
  assert.deepEqual(run.rows, []);
});

test("--states sideways is a usage error naming the flag and its allowed values", async () => {
  const err = capture();
  const code = await main(["--project", "91", "--repo", "o/r", "--states", "sideways"], {
    stdout: capture(),
    stderr: err,
  });
  assert.equal(code, 2);
  assert.ok(err.buf.includes("--states"));
  assert.ok(err.buf.includes("sideways"));
  assert.ok(err.buf.includes("all, open, closed"));
});

test("--story-type epic is a usage error naming the flag and its allowed values", async () => {
  const err = capture();
  const code = await main(["--project", "91", "--repo", "o/r", "--story-type", "epic"], {
    stdout: capture(),
    stderr: err,
  });
  assert.equal(code, 2);
  assert.ok(err.buf.includes("--story-type"));
  assert.ok(err.buf.includes("epic"));
  assert.ok(err.buf.includes("infer, feature, bug, chore"));
});

test("a customization flag with --customize is a usage error naming the conflict", async () => {
  const err = capture();
  const code = await main(["--project", "91", "--repo", "o/r", "--states", "open", "--customize"], {
    stdout: ttyCapture(),
    stderr: err,
    stdin: { isTTY: true },
  });
  assert.equal(code, 2);
  assert.ok(err.buf.includes("--states conflicts with --customize"));
});

test("the flag/--customize conflict is named off a terminal too, not the TTY gate", async () => {
  const err = capture();
  const code = await main(["--project", "91", "--repo", "o/r", "--no-tasks", "--customize"], {
    stdout: capture(),
    stderr: err,
    stdin: { isTTY: false },
  });
  assert.equal(code, 2);
  assert.ok(err.buf.includes("--no-tasks conflicts with --customize"));
});

test("--engine server with a customization flag is a usage error naming the conflict", async () => {
  const err = capture();
  const code = await main(
    ["--project", "91", "--repo", "o/r", "--engine", "server", "--no-tasks"],
    { stdout: capture(), stderr: err },
  );
  assert.equal(code, 2);
  assert.ok(err.buf.includes("--no-tasks conflicts with --engine server"));
});

test("--engine direct with a customization flag is accepted, not a conflict", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      /** @type {any[]} */
      const direct = [];
      const code = await main(
        ["--project", "91", "--repo", "o/r", "--engine", "direct", "--states", "open", "-y"],
        {
          stdout: capture(),
          stderr: capture(),
          preflight: async () => preflightResult(),
          runDirect: async (_client, _project, _owner, _repo, opts) => {
            direct.push(opts.customization);
            return outcome();
          },
        },
      );
      assert.equal(code, 0);
      assert.equal(direct.length, 1);
      assert.equal(direct[0].states, "open");
    }),
  );
});

test("an unsupported --include blames the customization flag that implied the engine", async () => {
  const err = capture();
  const code = await main(
    ["--project", "91", "--repo", "o/r", "--include", "issues,prs", "--states", "open"],
    { stdout: capture(), stderr: err },
  );
  assert.equal(code, 2);
  assert.ok(err.buf.includes("argument --states:"));
  assert.ok(!err.buf.includes("argument --engine:"));
});

test("an unsupported --include blames --customize when that implied the engine", async () => {
  const err = capture();
  const code = await main(
    ["--project", "91", "--repo", "o/r", "--include", "issues,prs", "--customize"],
    { stdout: ttyCapture(), stderr: err, stdin: { isTTY: true } },
  );
  assert.equal(code, 2);
  assert.ok(err.buf.includes("argument --customize:"));
  assert.ok(!err.buf.includes("argument --engine:"));
});

test("an unsupported --include still blames --engine when it was passed", async () => {
  const err = capture();
  const code = await main(
    ["--project", "91", "--repo", "o/r", "--include", "issues,prs", "--engine", "direct"],
    { stdout: capture(), stderr: err },
  );
  assert.equal(code, 2);
  assert.ok(err.buf.includes("argument --engine:"));
});

test("a flag-driven run renders the Customized: block, and composes with --dry-run", async () => {
  const run = await runAgainstMock([
    ...["--project", "91", "--repo", "o/r", "--dry-run"],
    ...["--states", "open", "--story-type", "bug", "--no-comments"],
  ]);
  assert.equal(run.code, 0);
  assert.ok(run.stdout.includes("Customized:"));
  assert.ok(run.stdout.includes("issue states: open only"));
  assert.ok(run.stdout.includes("story type: all bug"));
  assert.ok(run.stdout.includes("comments: not imported"));
  assert.ok(run.stdout.includes("Dry run plan for o/r into project 91"));
  assert.ok(run.stdout.includes("would import 1 stories"));
  assert.deepEqual(run.rows, []);
});

test("the flag-driven legend matches the equivalent wizard answers", async () => {
  // states → "open only", story type default, comments off, tasks default.
  const wizard = await runAgainstMock(["--project", "91", "--repo", "o/r", "--customize", "-y"], {
    stdout: ttyCapture(),
    stdin: scriptedStdin(["2", "", "n", ""]),
  });
  const flags = await runAgainstMock([
    ...["--project", "91", "--repo", "o/r", "-y"],
    ...["--states", "open", "--no-comments"],
  ]);
  assert.equal(wizard.code, 0);
  assert.equal(flags.code, 0);
  assert.equal(legendBlock(flags.stdout), legendBlock(wizard.stdout));
  assert.ok(legendBlock(flags.stdout).includes("Customized:"));
  assert.deepEqual(flags.rows, wizard.rows);
});

test("a piped flag-driven run with --yes imports the customized subset and exits 0", async () => {
  const run = await runAgainstMock([
    ...["--project", "91", "--repo", "o/r", "-y"],
    ...["--states", "open", "--story-type", "chore", "--no-comments", "--no-tasks"],
  ]);
  assert.equal(run.code, 0);
  assert.deepEqual(run.rows, [
    { title: "open one", story_type: "chore", current_state: "unstarted", tasks: 0, comments: 0 },
  ]);
});

test("a non-TTY run that would write and lacks --yes exits 2 naming --yes, writing nothing", async () => {
  const run = await runAgainstMock(["--project", "91", "--repo", "o/r", "--states", "open"]);
  assert.equal(run.code, 2);
  assert.ok(run.stderr.includes("--yes"));
  assert.deepEqual(run.rows, []);
});

test("the fail-closed rule applies to a plain run too, not just customized ones", async () => {
  const run = await runAgainstMock(["--project", "91", "--repo", "o/r", "--engine", "direct"]);
  assert.equal(run.code, 2);
  assert.ok(run.stderr.includes("--yes"));
  assert.deepEqual(run.rows, []);
});

test("--dry-run on a non-TTY needs no --yes: exit 0 and the plan still prints", async () => {
  const run = await runAgainstMock(["--project", "91", "--repo", "o/r", "--dry-run"]);
  assert.equal(run.code, 0);
  assert.ok(run.stdout.includes("Dry run plan for o/r into project 91"));
  assert.deepEqual(run.rows, []);
});

test("a TTY run still shows the [y/N] confirm before writing", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key" }, async () => {
      /** @type {string[]} */
      const asked = [];
      const direct = [];
      const code = await main(["--project", "91", "--repo", "o/r", "--states", "open"], {
        stdout: ttyCapture(),
        stderr: capture(),
        stdin: { isTTY: true },
        preflight: async () => preflightResult(),
        runDirect: async () => {
          direct.push(1);
          return outcome();
        },
        confirm: async (q) => {
          asked.push(q);
          return false;
        },
      });
      assert.equal(code, 1);
      assert.equal(asked.length, 1);
      assert.ok(asked[0].includes("[y/N]"));
      assert.equal(direct.length, 0);
    }),
  );
});

for (const [answer, expected] of [
  ["", false],
  ["\n", false],
  ["n", false],
  ["no", false],
  ["maybe", false],
  ["y", true],
  ["YES", true],
]) {
  test(`the terminal confirm reads ${JSON.stringify(answer)} as ${expected}`, async () => {
    const proceed = await defaultConfirm("Import? [y/N] ", {
      input: Readable.from([`${answer}\n`]),
      output: capture(),
    });
    assert.equal(proceed, expected);
  });
}

test("the terminal confirm treats EOF as no", async () => {
  const proceed = await defaultConfirm("Import? [y/N] ", {
    input: Readable.from([]),
    output: capture(),
  });
  assert.equal(proceed, false);
});

test("the terminal confirm treats a broken stdin as no", async () => {
  const input = new Readable({
    read() {
      this.destroy(new Error("stdin exploded"));
    },
  });
  const proceed = await defaultConfirm("Import? [y/N] ", { input, output: capture() });
  assert.equal(proceed, false);
});

/**
 * A TTY input/output pair, so readline runs in terminal mode and redraws the
 * line on every edit — the mode the `capture()` sink above cannot reach.
 */
function ttyStreams(/** @type {string[]} */ keystrokes) {
  let buf = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        buf += String(chunk);
        cb();
      },
    }),
    { isTTY: true, columns: 80, rows: 24 },
  );
  return {
    input: Object.assign(Readable.from(keystrokes), { isTTY: true }),
    output,
    // Everything drawn after the last line-clear: what the member ends up seeing.
    get lastRedraw() {
      return buf.split("\x1b[0J").at(-1) ?? "";
    },
  };
}

test("on a terminal the confirm question survives a backspace edit", async () => {
  const io = ttyStreams(["n", "\x7f", "y\n"]);
  const proceed = await defaultConfirm("Import o/r into project 91 (Demo)? [y/N] ", io);
  assert.equal(proceed, true);
  assert.ok(
    io.lastRedraw.includes("Import o/r into project 91 (Demo)? [y/N] "),
    `the redraw dropped the question: ${JSON.stringify(io.lastRedraw)}`,
  );
});

// AC6 — the no-flags output is the byte-for-byte text this story inherited.
const GOLDEN_TAIL =
  "  issues:\n" +
  "    - open issue → story (unstarted); closed issue → story (accepted, keeps the closed date)\n" +
  "    - labels → labels (with colors); issue-body checklists → story tasks\n" +
  "    - comments → comments (body only)\n" +
  "Imports append to the project; re-runs skip already-imported items; nothing is updated or deleted.\n" +
  "Importing o/r into project 91 (Demo)...\n" +
  "Imported 2 stories (1 labels), skipped 1 (already imported), 0 error(s).\n" +
  "Board: https://eat.example/projects/91\n";

for (const [label, argv, header] of /** @type {[string, string[], string][]} */ ([
  ["server", [], "Import mapping (GitHub → East Agile Tracker):\n"],
  [
    "direct",
    ["--engine", "direct"],
    "Import mapping (GitHub → East Agile Tracker) [engine: direct]:\n",
  ],
])) {
  test(`no customization flags: the ${label} engine's output is byte-identical`, async () => {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "key", EAT_APP_BASE: "https://eat.example" }, async () => {
        const out = capture();
        const err = capture();
        const code = await main(["--project", "91", "--repo", "o/r", "-y", ...argv], {
          stdout: out,
          stderr: err,
          preflight: async () => preflightResult(),
          runImport: async () => outcome({ importedStories: 2, importedLabels: 1, skipped: 1 }),
          runDirect: async () => outcome({ importedStories: 2, importedLabels: 1, skipped: 1 }),
        });
        assert.equal(code, 0);
        assert.equal(out.buf, header + GOLDEN_TAIL);
        assert.equal(err.buf, "");
      }),
    );
  });
}
