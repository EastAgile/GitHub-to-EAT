import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  ConfigError,
  DEFAULT_API_BASE,
  DEFAULT_APP_BASE,
  loadConfig,
  loadDotenv,
} from "../src/config.js";
import { inTempDir, withEnv } from "./helpers.js";

test("loadDotenv sets missing vars", async () => {
  await inTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, 'EAT_AGENT_KEY="abc123"\n# comment\nEAT_API_BASE=https://x/api\n');
    await withEnv({ EAT_AGENT_KEY: undefined, EAT_API_BASE: undefined }, () => {
      loadDotenv(envFile);
      assert.equal(process.env.EAT_AGENT_KEY, "abc123");
      assert.equal(process.env.EAT_API_BASE, "https://x/api");
    });
  });
});

test("loadDotenv strips a single surrounding quote pair, keeping inner quotes", async () => {
  await inTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    writeFileSync(
      envFile,
      [
        `DQ="abc123"`, // surrounding double quotes -> stripped
        `SQ='abc123'`, // surrounding single quotes -> stripped
        `INNER_SQ="it's"`, // a content apostrophe must survive
        `INNER_DQ='say "hi"'`, // a content double quote must survive
        `TRAIL_DQ=5'6"`, // unquoted value ending in " must stay intact
        `TRAIL_UNBALANCED="abc`, // a lone leading quote is not a pair
      ].join("\n"),
    );
    await withEnv(
      {
        DQ: undefined,
        SQ: undefined,
        INNER_SQ: undefined,
        INNER_DQ: undefined,
        TRAIL_DQ: undefined,
        TRAIL_UNBALANCED: undefined,
      },
      () => {
        loadDotenv(envFile);
        assert.equal(process.env.DQ, "abc123");
        assert.equal(process.env.SQ, "abc123");
        assert.equal(process.env.INNER_SQ, "it's");
        assert.equal(process.env.INNER_DQ, 'say "hi"');
        assert.equal(process.env.TRAIL_DQ, `5'6"`);
        assert.equal(process.env.TRAIL_UNBALANCED, `"abc`);
      },
    );
  });
});

test("loadDotenv does not override existing vars", async () => {
  await inTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "EAT_AGENT_KEY=fromfile\n");
    await withEnv({ EAT_AGENT_KEY: "fromenv" }, () => {
      loadDotenv(envFile);
      assert.equal(process.env.EAT_AGENT_KEY, "fromenv");
    });
  });
});

test("loadDotenv missing file is a no-op", async () => {
  await inTempDir((dir) => {
    loadDotenv(path.join(dir, "does-not-exist")); // should not throw
  });
});

test("loadConfig reads the environment", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key", EAT_API_BASE: undefined, EAT_APP_BASE: undefined }, () => {
      assert.deepEqual(loadConfig(), {
        agentKey: "key",
        apiBase: DEFAULT_API_BASE,
        appBase: DEFAULT_APP_BASE,
      });
    }),
  );
});

test("loadConfig missing key throws", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: undefined }, () => {
      assert.throws(() => loadConfig(), ConfigError);
    }),
  );
});

test("loadConfig strips a trailing slash", async () => {
  await inTempDir(() =>
    withEnv({ EAT_AGENT_KEY: "key", EAT_API_BASE: "https://host/api/" }, () => {
      assert.equal(loadConfig().apiBase, "https://host/api");
    }),
  );
});
