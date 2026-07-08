import assert from "node:assert/strict";
import { test } from "node:test";

import { main } from "../src/cli.js";
import { EATClient } from "../src/client.js";
import { runImport } from "../src/importer.js";
import { makeState, startMockServer } from "../src/mockserver.js";
import { capture, inTempDir, withEnv } from "./helpers.js";

/**
 * A recording stand-in for the client, returning a canned raw result.
 *
 * @param {unknown} raw
 */
function fakeClient(raw) {
  return {
    /** @type {unknown[][]} */
    calls: [],
    /**
     * @param {number} projectId
     * @param {string} owner
     * @param {string} repo
     * @param {{ idempotencyKey: string, token?: string }} options
     */
    async importGithub(projectId, owner, repo, { idempotencyKey, token }) {
      this.calls.push([projectId, owner, repo, idempotencyKey, token]);
      return raw;
    },
  };
}

test("importGithub posts the expected body and idempotency key", async () => {
  const state = makeState({ importResult: { imported: 2, skipped: 0, errors: [] } });
  const mock = await startMockServer(state);
  try {
    const result = await new EATClient(mock.baseUrl, "tok").importGithub(91, "octocat", "hello", {
      idempotencyKey: "key-1",
    });
    assert.equal(result.imported, 2);
  } finally {
    await mock.close();
  }
  assert.equal(state.imports[0].idempotency_key, "key-1");
  assert.deepEqual(state.imports[0].body, { source: "github", owner: "octocat", repo: "hello" });
  assert.ok(!("token" in state.imports[0].body)); // server uses its platform PAT
});

test("importGithub includes the token when given", async () => {
  const mock = await startMockServer();
  try {
    await new EATClient(mock.baseUrl, "tok").importGithub(91, "o", "r", {
      idempotencyKey: "k",
      token: "ghp_x",
    });
  } finally {
    await mock.close();
  }
  assert.equal(mock.state.imports[0].body.token, "ghp_x");
});

test("runImport normalizes missing fields", async () => {
  assert.deepEqual(await runImport(fakeClient({}), 91, "o", "r", { idempotencyKey: "k" }), {
    importedStories: 0,
    importedLabels: 0,
    skipped: 0,
    errors: [],
    unmatched: {},
    dryRun: false,
  });
});

test("runImport reads nested imported", async () => {
  const raw = { imported: { stories: 5, labels: 2 }, skipped: 1, errors: ["x"] };
  assert.deepEqual(await runImport(fakeClient(raw), 91, "o", "r", { idempotencyKey: "k" }), {
    importedStories: 5,
    importedLabels: 2,
    skipped: 1,
    errors: ["x"],
    unmatched: {},
    dryRun: false,
  });
});

test("runImport tolerates flat imported", async () => {
  const raw = { imported: 3, skipped: 0, errors: [] };
  assert.deepEqual(await runImport(fakeClient(raw), 91, "o", "r", { idempotencyKey: "k" }), {
    importedStories: 3,
    importedLabels: 0,
    skipped: 0,
    errors: [],
    unmatched: {},
    dryRun: false,
  });
});

test("runImport passes the token through", async () => {
  const fake = fakeClient({ imported: { stories: 0, labels: 0 }, skipped: 0, errors: [] });
  await runImport(fake, 91, "o", "r", { idempotencyKey: "k", token: "ghp_z" });
  assert.equal(fake.calls[0].at(-1), "ghp_z");
});

test("runImport reads unmatched", async () => {
  const raw = {
    imported: { stories: 1, labels: 0 },
    skipped: 0,
    errors: [],
    unmatched: { owners: ["a", "b"], followers: [] },
  };
  const outcome = await runImport(fakeClient(raw), 91, "o", "r", { idempotencyKey: "k" });
  assert.deepEqual(outcome.unmatched, { owners: ["a", "b"], followers: [] });
});

test("full import against the mock", async () => {
  const result = { imported: { stories: 4, labels: 0 }, skipped: 2, errors: [] };
  const mock = await startMockServer(makeState({ importResult: result }));
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv(
        {
          EAT_AGENT_KEY: "ea_token",
          EAT_API_BASE: mock.baseUrl,
          EAT_APP_BASE: "https://tracker.example",
          GITHUB_TOKEN: undefined,
        },
        async () => {
          const code = await main(["--project", "91", "--repo", "octocat/hello-world"], {
            stdout: out,
            stderr: capture(),
          });
          assert.equal(code, 0);
        },
      ),
    );
  } finally {
    await mock.close();
  }

  assert.ok(out.buf.includes("Importing octocat/hello-world"));
  assert.ok(out.buf.includes("Imported 4"));
  assert.ok(out.buf.includes("skipped 2"));
  assert.ok(out.buf.includes("https://tracker.example/projects/91"));

  const sent = mock.state.imports[0];
  assert.deepEqual(sent.body, { source: "github", owner: "octocat", repo: "hello-world" });
  assert.ok(!("token" in sent.body));
  assert.ok(sent.idempotency_key);
});

test("import errors exit one", async () => {
  const result = { imported: { stories: 1, labels: 0 }, skipped: 0, errors: ["issue 5 failed"] };
  const mock = await startMockServer(makeState({ importResult: result }));
  const err = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        const code = await main(["--project", "91", "--repo", "o/r"], {
          stdout: capture(),
          stderr: err,
        });
        assert.equal(code, 1);
      }),
    );
  } finally {
    await mock.close();
  }
  assert.ok(err.buf.includes("issue 5 failed"));
});

test("--dry-run makes no import", async () => {
  const mock = await startMockServer();
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        const code = await main(["--project", "91", "--repo", "o/r", "--dry-run"], {
          stdout: out,
          stderr: capture(),
        });
        assert.equal(code, 0);
      }),
    );
  } finally {
    await mock.close();
  }
  assert.equal(mock.state.imports.length, 1);
  assert.equal(mock.state.imports[0].body.dry_run, true);
  assert.deepEqual(mock.state.importedIds, {}); // nothing persisted
  assert.ok(out.buf.includes("Dry run"));
});

test("--token flag flows to the import", async () => {
  const mock = await startMockServer();
  try {
    await inTempDir(() =>
      withEnv(
        { EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl, GITHUB_TOKEN: undefined },
        async () => {
          const code = await main(["--project", "91", "--repo", "o/r", "--token", "ghp_flag"], {
            stdout: capture(),
            stderr: capture(),
          });
          assert.equal(code, 0);
        },
      ),
    );
  } finally {
    await mock.close();
  }
  assert.equal(mock.state.imports[0].body.token, "ghp_flag");
});

test("GITHUB_TOKEN env flows to the import", async () => {
  const mock = await startMockServer();
  try {
    await inTempDir(() =>
      withEnv(
        { EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl, GITHUB_TOKEN: "ghp_env" },
        async () => {
          const code = await main(["--project", "91", "--repo", "o/r"], {
            stdout: capture(),
            stderr: capture(),
          });
          assert.equal(code, 0);
        },
      ),
    );
  } finally {
    await mock.close();
  }
  assert.equal(mock.state.imports[0].body.token, "ghp_env");
});

test("unmatched users are reported", async () => {
  const result = {
    imported: { stories: 1, labels: 0 },
    skipped: 0,
    errors: [],
    unmatched: { owners: ["alice", "bob"], comment_authors: ["carol"] },
  };
  const mock = await startMockServer(makeState({ importResult: result }));
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        const code = await main(["--project", "91", "--repo", "o/r"], {
          stdout: out,
          stderr: capture(),
        });
        assert.equal(code, 0);
      }),
    );
  } finally {
    await mock.close();
  }
  assert.ok(out.buf.includes("3 GitHub user"));
});

test("--include issues,prs sends include_pull_requests and counts PR stories", async () => {
  const mock = await startMockServer(); // computed mode: 3 issues + 2 prs
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        const code = await main(["--project", "91", "--repo", "o/r", "--include", "issues,prs"], {
          stdout: out,
          stderr: capture(),
        });
        assert.equal(code, 0);
      }),
    );
  } finally {
    await mock.close();
  }
  assert.equal(mock.state.imports[0].body.include_pull_requests, true);
  assert.ok(out.buf.includes("Imported 5"));
});

test("default import sends no include flags and imports issues only", async () => {
  const mock = await startMockServer();
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        const code = await main(["--project", "91", "--repo", "o/r"], {
          stdout: out,
          stderr: capture(),
        });
        assert.equal(code, 0);
      }),
    );
  } finally {
    await mock.close();
  }
  assert.ok(!("include_pull_requests" in mock.state.imports[0].body));
  assert.ok(out.buf.includes("Imported 3"));
});

test("--include prs alone is a usage error", async () => {
  const err = capture();
  const code = await main(["--project", "91", "--repo", "o/r", "--include", "prs"], {
    stdout: capture(),
    stderr: err,
  });
  assert.equal(code, 2);
  assert.ok(err.buf.includes("must contain 'issues'"));
});

test("--include with an unknown type is a usage error", async () => {
  const err = capture();
  const code = await main(["--project", "91", "--repo", "o/r", "--include", "issues,wiki"], {
    stdout: capture(),
    stderr: err,
  });
  assert.equal(code, 2);
  assert.ok(err.buf.includes("unknown import type 'wiki'"));
});

test("--include issues,milestones,releases sends both flags; releases add stories", async () => {
  const mock = await startMockServer(); // fixture: 3 issues + 1 release
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        const code = await main(
          ["--project", "91", "--repo", "o/r", "--include", "issues,milestones,releases"],
          { stdout: out, stderr: capture() },
        );
        assert.equal(code, 0);
      }),
    );
  } finally {
    await mock.close();
  }
  const body = mock.state.imports[0].body;
  assert.equal(body.include_milestones, true);
  assert.equal(body.include_releases, true);
  assert.ok(!("include_pull_requests" in body));
  assert.ok(out.buf.includes("Imported 4")); // 3 issues + 1 release; milestones -> epics, uncounted
});

test("re-import against the mock skips already-imported rows", async () => {
  const mock = await startMockServer(); // computed mode with dedup
  try {
    const client = new EATClient(mock.baseUrl, "tok");
    const first = await client.importGithub(91, "o", "r", { idempotencyKey: "k1" });
    assert.equal(first.imported.stories, 3);
    assert.equal(first.skipped, 0);
    const second = await client.importGithub(91, "o", "r", { idempotencyKey: "k2" });
    assert.equal(second.imported.stories, 0);
    assert.equal(second.skipped, 3);
    const wider = await client.importGithub(91, "o", "r", {
      idempotencyKey: "k3",
      flags: { include_pull_requests: true },
    });
    assert.equal(wider.imported.stories, 2); // only the PRs are new
    assert.equal(wider.skipped, 3);
  } finally {
    await mock.close();
  }
});

test("skipped rows are reported as already imported", async () => {
  const mock = await startMockServer();
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        assert.equal(
          await main(["--project", "91", "--repo", "o/r"], {
            stdout: capture(),
            stderr: capture(),
          }),
          0,
        );
        assert.equal(
          await main(["--project", "91", "--repo", "o/r"], { stdout: out, stderr: capture() }),
          0,
        );
      }),
    );
  } finally {
    await mock.close();
  }
  assert.ok(out.buf.includes("skipped 3 (already imported)"));
});

test("a first import does not carry the already-imported note", async () => {
  const mock = await startMockServer();
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        assert.equal(
          await main(["--project", "91", "--repo", "o/r"], { stdout: out, stderr: capture() }),
          0,
        );
      }),
    );
  } finally {
    await mock.close();
  }
  assert.ok(out.buf.includes("skipped 0,"));
  assert.ok(!out.buf.includes("already imported"));
});

test("supportsServerDryRun reads the published openapi (incl. $ref schemas)", async () => {
  const mock = await startMockServer();
  try {
    assert.equal(await new EATClient(mock.baseUrl, "tok").supportsServerDryRun(), true);
  } finally {
    await mock.close();
  }
  const old = await startMockServer(makeState({ serverDryRun: false }));
  try {
    assert.equal(await new EATClient(old.baseUrl, "tok").supportsServerDryRun(), false);
  } finally {
    await old.close();
  }
});

test("a server dry_run computes the plan without persisting", async () => {
  const mock = await startMockServer();
  try {
    const client = new EATClient(mock.baseUrl, "tok");
    const plan = await client.importGithub(91, "o", "r", { idempotencyKey: "k1", dryRun: true });
    assert.equal(plan.dry_run, true);
    assert.equal(plan.imported.stories, 3);
    assert.equal(plan.skipped, 0);
    const real = await client.importGithub(91, "o", "r", { idempotencyKey: "k2" });
    assert.equal(real.dry_run, false);
    assert.equal(real.imported.stories, 3); // dry run persisted nothing
  } finally {
    await mock.close();
  }
});

test("--dry-run renders the server plan and writes nothing", async () => {
  const mock = await startMockServer();
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        assert.equal(
          await main(["--project", "91", "--repo", "o/r", "--dry-run"], {
            stdout: out,
            stderr: capture(),
          }),
          0,
        );
      }),
    );
    assert.ok(out.buf.includes("would import 3 stories"));
    assert.ok(out.buf.includes("No changes made."));
    assert.deepEqual(mock.state.importedIds, {}); // nothing persisted
    assert.equal(mock.state.imports[0].body.dry_run, true);
  } finally {
    await mock.close();
  }
});

test("--dry-run plan is dedup-aware after a real import", async () => {
  const mock = await startMockServer();
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        assert.equal(
          await main(["--project", "91", "--repo", "o/r"], {
            stdout: capture(),
            stderr: capture(),
          }),
          0,
        );
        assert.equal(
          await main(["--project", "91", "--repo", "o/r", "--dry-run"], {
            stdout: out,
            stderr: capture(),
          }),
          0,
        );
      }),
    );
  } finally {
    await mock.close();
  }
  assert.ok(out.buf.includes("would import 0 stories"));
  assert.ok(out.buf.includes("would skip 3 (already imported)"));
});

test("--dry-run falls back to the local preview on older servers", async () => {
  const mock = await startMockServer(makeState({ serverDryRun: false }));
  const out = capture();
  try {
    await inTempDir(() =>
      withEnv({ EAT_AGENT_KEY: "ea_token", EAT_API_BASE: mock.baseUrl }, async () => {
        assert.equal(
          await main(["--project", "91", "--repo", "o/r", "--dry-run"], {
            stdout: out,
            stderr: capture(),
          }),
          0,
        );
      }),
    );
  } finally {
    await mock.close();
  }
  assert.ok(out.buf.includes("Dry run: would import o/r into project 91"));
  assert.equal(mock.state.imports.length, 0); // no import call at all
});

test("runImport surfaces the dry_run echo", async () => {
  const fake = fakeClient({ dry_run: true, imported: { stories: 2, labels: 0 }, skipped: 1 });
  const outcome = await runImport(fake, 91, "o", "r", { idempotencyKey: "k", dryRun: true });
  assert.equal(outcome.dryRun, true);
  assert.equal(outcome.skipped, 1);
});
