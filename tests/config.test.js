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
