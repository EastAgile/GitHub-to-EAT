/**
 * Command-line interface for github-to-eat.
 *
 * Parses arguments, resolves configuration, runs preflight, then performs the
 * GitHub -> EAT import. See CONTRACT.md for the target behaviour.
 */

import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";

import { EATClient, EATError, EATTimeout } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { DirectEngineError, runDirect as defaultRunDirect } from "./direct.js";
import { assertDirectSupportsIncludes, DEFAULT_ENGINE, ENGINES, parseEngine } from "./engine.js";
import { GitHubError } from "./github.js";
import { runImport as defaultRunImport } from "./importer.js";
import { MAPPINGS, parseInclude, renderLegend, requestFlags } from "./mappings.js";
import { preflight as defaultPreflight } from "./preflight.js";
import { runWithProgress } from "./progress.js";
import { VERSION } from "./version.js";

const USAGE =
  "usage: github-to-eat [-h] [-V] --project ID --repo OWNER/NAME " +
  "[--include TYPES] [--engine NAME] [--dry-run] [-y] [--token GITHUB_TOKEN]";

const HELP = `${USAGE}

Onboard a public GitHub repo's issues into an East Agile Tracker project.

options:
  -h, --help            show this help message and exit
  -V, --version         show program's version number and exit
  --project ID          target East Agile Tracker project id
  --repo OWNER/NAME     public GitHub repository, e.g. octocat/hello-world
  --include TYPES       comma-separated types to import: ${Object.keys(MAPPINGS).join(",")} (default: issues)
  --engine NAME         import engine: ${ENGINES.join("|")} (default: ${DEFAULT_ENGINE})
  --dry-run             run preflight and show the plan without importing anything
  -y, --yes             skip the interactive confirmation prompt
  --token GITHUB_TOKEN  GitHub token for a private repo (or set GITHUB_TOKEN); public repos need none
`;

/**
 * Ask a yes/no question on the controlling terminal; default no.
 *
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function defaultConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false; // EOF (Ctrl-D) or closed input at the prompt means "no"
  } finally {
    rl.close();
  }
}

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
 * Write the import result and board link; return the process exit code (1 when
 * the server reported per-item errors, else 0). Shared by both engines so their
 * output convention is identical.
 *
 * @param {import("./importer.js").ImportOutcome} outcome
 * @param {{ stdout: import("./progress.js").OutStream,
 *   stderr: import("./progress.js").OutStream, project: number, appBase: string }} ctx
 * @returns {number}
 */
function reportImport(outcome, { stdout, stderr, project, appBase }) {
  const skippedNote = outcome.skipped ? " (already imported)" : "";
  stdout.write(
    `Imported ${outcome.importedStories} stories (${outcome.importedLabels} labels), ` +
      `skipped ${outcome.skipped}${skippedNote}, ${outcome.errors.length} error(s).\n`,
  );
  const unmatchedTotal = Object.values(outcome.unmatched).reduce((n, v) => n + v.length, 0);
  if (unmatchedTotal) {
    stdout.write(`note: ${unmatchedTotal} GitHub user(s) could not be matched to members.\n`);
  }
  stdout.write(`Board: ${appBase}/projects/${project}\n`);
  for (const err of outcome.errors) {
    stderr.write(`  - ${err}\n`);
  }
  return outcome.errors.length ? 1 : 0;
}

/**
 * Injectable seams and streams for tests; production callers pass nothing.
 *
 * @typedef {object} MainDeps
 * @property {import("./progress.js").OutStream} [stdout]
 * @property {import("./progress.js").OutStream} [stderr]
 * @property {typeof defaultPreflight} [preflight]
 * @property {typeof defaultRunImport} [runImport]
 * @property {typeof defaultRunDirect} [runDirect]
 * @property {((question: string) => Promise<boolean>) | null} [confirm] yes/no
 *   prompt; defaults to a terminal prompt when stdin is a TTY, else null
 *   (no prompt — scripts keep running unattended)
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
    runDirect = defaultRunDirect,
    confirm = process.stdin.isTTY ? defaultConfirm : null,
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
        include: { type: "string" },
        engine: { type: "string" },
        "dry-run": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
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

  let included;
  try {
    included = parseInclude(values.include ?? "issues");
  } catch (err) {
    return usageError(`argument --include: ${err instanceof Error ? err.message : err}`);
  }
  const flags = requestFlags(included);

  let engine;
  try {
    engine = parseEngine(values.engine ?? DEFAULT_ENGINE);
    if (engine === "direct") assertDirectSupportsIncludes(included);
  } catch (err) {
    return usageError(`argument --engine: ${err instanceof Error ? err.message : err}`);
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

  stdout.write(`${renderLegend(included, engine)}\n`);

  // One prompt for both engines — dry-run paths never prompt (they write nothing).
  if (!values["dry-run"] && !values.yes && confirm) {
    const proceed = await confirm(
      `Import ${owner}/${repo} into project ${project} (${result.projectTitle})? [y/N] `,
    );
    if (!proceed) {
      stderr.write("Aborted — nothing imported.\n");
      return 1;
    }
  }

  if (engine === "direct") {
    const token = values.token || process.env.GITHUB_TOKEN || undefined;
    if (!values["dry-run"]) {
      stdout.write(
        `Importing ${owner}/${repo} into project ${project} (${result.projectTitle})...\n`,
      );
    }
    let outcome;
    try {
      // The pipeline renders its own per-stage progress on stderr.
      outcome = await runDirect(client, project, owner, repo, {
        token,
        included,
        dryRun: values["dry-run"],
        stream: stderr,
      });
    } catch (err) {
      if (
        err instanceof DirectEngineError ||
        err instanceof EATError ||
        err instanceof GitHubError
      ) {
        stderr.write(`error: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
    return reportImport(outcome, { stdout, stderr, project, appBase: config.appBase });
  }

  if (values["dry-run"]) {
    // Server-side dry_run is feature-detected first: sending the flag to a
    // server that ignores unknown fields would run a real import.
    if (await client.supportsServerDryRun()) {
      const token = values.token || process.env.GITHUB_TOKEN || undefined;
      let plan;
      try {
        plan = await runWithProgress(
          () =>
            runImport(client, project, owner, repo, {
              idempotencyKey: randomUUID(),
              token,
              flags,
              dryRun: true,
            }),
          "waiting for the server to compute the import plan",
          { stream: stderr },
        );
      } catch (err) {
        if (err instanceof EATError) {
          stderr.write(`error: dry run failed: ${err.message}\n`);
          return 1;
        }
        throw err;
      }
      if (!plan.dryRun) {
        stderr.write(
          "warning: the server did not confirm dry-run mode — check the board before re-running.\n",
        );
      }
      const skippedNote = plan.skipped ? " (already imported)" : "";
      stdout.write(
        `Dry run plan for ${owner}/${repo} into project ${project} (${result.projectTitle}):\n` +
          `  would import ${plan.importedStories} stories (${plan.importedLabels} labels), ` +
          `would skip ${plan.skipped}${skippedNote}, ${plan.errors.length} error(s).\n` +
          "No changes made.\n",
      );
      for (const err of plan.errors) {
        stderr.write(`  - ${err}\n`);
      }
      return 0;
    }
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
      () => runImport(client, project, owner, repo, { idempotencyKey: randomUUID(), token, flags }),
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

  return reportImport(outcome, { stdout, stderr, project, appBase: config.appBase });
}
