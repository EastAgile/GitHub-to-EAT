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
  assert.deepEqual(mock.state.imports, []);
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
