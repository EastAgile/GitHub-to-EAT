/**
 * Command-line interface for github-to-eat.
 *
 * Parses arguments, resolves configuration, runs preflight, then performs the
 * GitHub -> EAT import. See CONTRACT.md for the target behaviour.
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import { EATClient, EATError, EATTimeout } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { runImport as defaultRunImport } from "./importer.js";
import { preflight as defaultPreflight } from "./preflight.js";
import { runWithProgress } from "./progress.js";
import { VERSION } from "./version.js";

const USAGE =
  "usage: github-to-eat [-h] [-V] --project ID --repo OWNER/NAME [--dry-run] [--token GITHUB_TOKEN]";

const HELP = `${USAGE}

Onboard a public GitHub repo's issues into an East Agile Tracker project.

options:
  -h, --help            show this help message and exit
  -V, --version         show program's version number and exit
  --project ID          target East Agile Tracker project id
  --repo OWNER/NAME     public GitHub repository, e.g. octocat/hello-world
  --dry-run             run preflight and show the plan without importing anything
  --token GITHUB_TOKEN  GitHub token for a private repo (or set GITHUB_TOKEN); public repos need none
`;

/**
 * Split an `owner/name` string into `[owner, name]`.
 *
 * Throws an `Error` if the value is not exactly two non-empty parts.
 *
 * @param {string} value
 * @returns {[string, string]}
 */
export function parseRepo(value) {
  const parts = value.trim().split("/");
  if (parts.length !== 2 || !parts.every(Boolean)) {
    throw new Error(`invalid repository '${value}'; expected the form OWNER/NAME`);
  }
  return [parts[0], parts[1]];
}

/**
 * Injectable seams and streams for tests; production callers pass nothing.
 *
 * @typedef {object} MainDeps
 * @property {import("./progress.js").OutStream} [stdout]
 * @property {import("./progress.js").OutStream} [stderr]
 * @property {typeof defaultPreflight} [preflight]
 * @property {typeof defaultRunImport} [runImport]
 */

/**
 * Run the CLI; returns the process exit code.
 *
 * Exit codes: 0 success, 1 runtime error (or per-item import errors),
 * 2 usage error.
 *
 * @param {string[]} [argv]
 * @param {MainDeps} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    preflight = defaultPreflight,
    runImport = defaultRunImport,
  } = deps;

  /** @param {string} message */
  const usageError = (message) => {
    stderr.write(`${USAGE}\ngithub-to-eat: error: ${message}\n`);
    return 2;
  };

  let values;
  try {
    values = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        project: { type: "string" },
        repo: { type: "string" },
        "dry-run": { type: "boolean" },
        token: { type: "string" },
      },
      allowPositionals: false,
    }).values;
  } catch (err) {
    return usageError(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    stdout.write(`github-to-eat ${VERSION}\n`);
    return 0;
  }

  const projectRaw = values.project;
  const repoRaw = values.repo;
  if (projectRaw === undefined || repoRaw === undefined) {
    const missing = [
      ...(projectRaw === undefined ? ["--project"] : []),
      ...(repoRaw === undefined ? ["--repo"] : []),
    ];
    return usageError(`the following arguments are required: ${missing.join(", ")}`);
  }
  if (!/^\d+$/.test(projectRaw)) {
    return usageError(`argument --project: invalid int value: '${projectRaw}'`);
  }
  const project = Number.parseInt(projectRaw, 10);

  let owner;
  let repo;
  try {
    [owner, repo] = parseRepo(repoRaw);
  } catch (err) {
    return usageError(`argument --repo: ${err instanceof Error ? err.message : err}`);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const client = new EATClient(config.apiBase, config.agentKey);
  let result;
  try {
    result = await preflight(client, project);
  } catch (err) {
    if (err instanceof EATError) {
      stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (result.nonEmpty) {
    stderr.write(
      `warning: project ${project} (${result.projectTitle}) already has stories; ` +
        "import appends, it does not replace.\n",
    );
  }

  if (values["dry-run"]) {
    stdout.write(
      `Dry run: would import ${owner}/${repo} into project ${project} ` +
        `(${result.projectTitle}). No changes made.\n`,
    );
    return 0;
  }

  const token = values.token || process.env.GITHUB_TOKEN || undefined;
  stdout.write(`Importing ${owner}/${repo} into project ${project} (${result.projectTitle})...\n`);
  let outcome;
  try {
    outcome = await runWithProgress(
      () => runImport(client, project, owner, repo, { idempotencyKey: randomUUID(), token }),
      "waiting for the server to import GitHub issues",
      { stream: stderr },
    );
  } catch (err) {
    if (err instanceof EATTimeout) {
      stderr.write(`error: ${err.message}\n`);
      stderr.write(
        "The server may still be finishing the import — check the board in a " +
          "moment, or re-run. (v2 will stream progress for long imports.)\n",
      );
      return 1;
    }
    if (err instanceof EATError) {
      stderr.write(`error: import failed: ${err.message}\n`);
      if (!token) {
        stderr.write(
          "  hint: private repo, or the server has no platform PAT? " +
            "set GITHUB_TOKEN or pass --token.\n",
        );
      }
      return 1;
    }
    throw err;
  }

  stdout.write(
    `Imported ${outcome.importedStories} stories (${outcome.importedLabels} labels), ` +
      `skipped ${outcome.skipped}, ${outcome.errors.length} error(s).\n`,
  );
  const unmatchedTotal = Object.values(outcome.unmatched).reduce((n, v) => n + v.length, 0);
  if (unmatchedTotal) {
    stdout.write(`note: ${unmatchedTotal} GitHub user(s) could not be matched to members.\n`);
  }
  stdout.write(`Board: ${config.appBase}/projects/${project}\n`);
  for (const err of outcome.errors) {
    stderr.write(`  - ${err}\n`);
  }
  return outcome.errors.length ? 1 : 0;
}
