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
import { ConfigError, loadConfig, loadDotenv } from "./config.js";
import { runDirect as defaultRunDirect } from "./direct.js";
import { DEFAULT_ENGINE, ENGINES, parseEngine } from "./engine.js";
import { GitHubError } from "./github.js";
import { runImport as defaultRunImport } from "./importer.js";
import { customizationFlagsGiven, parseCustomization } from "./mapping.js";
import { MAPPINGS, parseInclude, renderLegend, requestFlags } from "./mappings.js";
import { preflight as defaultPreflight } from "./preflight.js";
import { makeImportReporter, runWithProgress, scrubControl } from "./progress.js";
import { VERSION } from "./version.js";
import { runWizard as defaultRunWizard, WizardAborted } from "./wizard.js";

const USAGE =
  "usage: github-to-eat [-h] [-V] --project ID --repo OWNER/NAME " +
  "[--include TYPES] [--engine NAME] [--customize] [--states STATES] " +
  "[--milestones TITLES] [--story-type TYPE] [--no-comments] [--no-tasks] " +
  "[--dry-run] [-y] [--token GITHUB_TOKEN]";

const HELP = `${USAGE}

Onboard a public GitHub repo's issues into an East Agile Tracker project.

options:
  -h, --help            show this help message and exit
  -V, --version         show program's version number and exit
  --project ID          target East Agile Tracker project id
  --repo OWNER/NAME     public GitHub repository, e.g. octocat/hello-world
  --include TYPES       comma-separated types to import: ${Object.keys(MAPPINGS).join(",")} (default: issues)
  --engine NAME         import engine: ${ENGINES.join("|")} (default: ${DEFAULT_ENGINE})
  --customize           customize the import per run, interactively (implies --engine direct; needs a terminal)
  --dry-run             run preflight and show the plan without importing anything
  -y, --yes             skip the interactive confirmation prompt (required off a terminal, unless --dry-run)
  --token GITHUB_TOKEN  GitHub token (or set GITHUB_TOKEN); required by --engine direct,
                        and by --engine server only for a private repo

customization (each implies --engine direct; no terminal needed; not with --customize):
  --states STATES       issue states to import: all|open|closed (default: all)
  --milestones TITLES   comma-separated milestone titles to import, matched exactly; repeatable,
                        and \\, is a literal comma inside a title (default: all)
  --story-type TYPE     story type for every imported issue: infer|feature|bug|chore (default: infer)
  --no-comments         do not import issue comments
  --no-tasks            do not convert issue-body checklists into story tasks
`;

/** Thrown by the --customize announce hook when the member declines the post-wizard confirm. */
class ConfirmAborted extends Error {}

/**
 * Ask a yes/no question on the controlling terminal; default no.
 *
 * @param {string} question
 * @param {{ input?: import("node:stream").Readable,
 *   output?: import("./progress.js").OutStream }} [streams] injected by tests
 * @returns {Promise<boolean>}
 */
export async function defaultConfirm(
  question,
  { input = process.stdin, output = process.stderr } = {},
) {
  // OutStream is the minimal write-sink tests inject; readline only calls write.
  const rl = readline.createInterface({ input, output: /** @type {any} */ (output) });
  try {
    // readline must own the prompt: a line edit redraws it, and anything written
    // behind readline's back is erased by that redraw.
    rl.setPrompt(question);
    rl.prompt();
    // Read through the iterator so tests can inject the streams; `done` is EOF,
    // and a stdin that errors counts as "no" rather than crashing the CLI.
    const { value, done } = await rl[Symbol.asyncIterator]().next();
    return done ? false : /^y(es)?$/i.test(String(value).trim());
  } catch {
    return false;
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
 * Tail of the placeholder-owners message, shared by the import note and the
 * dry-run preview so the two renderings never drift.
 *
 * @param {string[]} created
 * @returns {string}
 */
function placeholderOwnersTail(created) {
  return (
    `${created.map((login) => `@${login}`).join(", ")} — external members outside ` +
    "the project roster; auto-linked when the matching GitHub account signs in.\n"
  );
}

/**
 * Render one row error. The server sends `{ code, row }` (CONTRACT.md), the direct
 * engine adds a `detail`, and a bare string from an older source still renders.
 *
 * @param {unknown} err
 * @returns {string}
 */
function rowErrorLine(err) {
  if (err && typeof err === "object" && "code" in err) {
    const { code, row, detail } = /** @type {{ code: unknown, row?: unknown,
      detail?: unknown }} */ (err);
    const head = scrubControl(row == null ? String(code) : `row ${row}: ${code}`);
    // Scrubbed on its own budget: a long detail must not cost the row and the code,
    // which are the half a user can act on.
    return detail == null ? head : `${head} — ${scrubControl(detail)}`;
  }
  return scrubControl(err);
}

/**
 * Render one non-fatal server advisory (`{ code, count, floor_year }`).
 *
 * @param {unknown} warning
 * @returns {string}
 */
function warningLine(warning) {
  if (!warning || typeof warning !== "object") return scrubControl(warning);
  const { code, count, floor_year: floorYear } = /** @type {any} */ (warning);
  const detail = [
    count == null ? null : `${count} ${count === 1 ? "story" : "stories"}`,
    floorYear == null ? null : `floor year ${floorYear}`,
  ].filter(Boolean);
  return scrubControl(detail.length ? `${code} (${detail.join(", ")})` : String(code));
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
  // The GitHub connector never fills the actor cells `unmatched` is built from,
  // so this note exists for a server that starts reporting actors anyway.
  const unmatchedTotal = Object.values(outcome.unmatched).reduce(
    (/** @type {number} */ n, v) => n + (Array.isArray(v) ? v.length : 0),
    0,
  );
  if (unmatchedTotal) {
    stdout.write(`note: ${unmatchedTotal} actor(s) could not be matched to members.\n`);
  }
  for (const warning of outcome.warnings ?? []) {
    stdout.write(`note: ${warningLine(warning)}\n`);
  }
  const created = Array.isArray(outcome.externalMembersCreated)
    ? outcome.externalMembersCreated
    : [];
  if (created.length) {
    stdout.write(
      `note: ${created.length} placeholder owner(s) created: ${placeholderOwnersTail(created)}`,
    );
  }
  stdout.write(`Board: ${appBase}/projects/${project}\n`);
  for (const err of outcome.errors) {
    stderr.write(`  - ${rowErrorLine(err)}\n`);
  }
  return outcome.errors.length ? 1 : 0;
}

/**
 * Write the would-import / would-skip plan; return exit code 0. Shared by the
 * server dry-run and the direct engine's local dry-run so the block is identical.
 *
 * @param {import("./importer.js").ImportOutcome} plan
 * @param {{ stdout: import("./progress.js").OutStream,
 *   stderr: import("./progress.js").OutStream, owner: string, repo: string,
 *   project: number, projectTitle: string }} ctx
 * @returns {number}
 */
function reportDryRunPlan(plan, { stdout, stderr, owner, repo, project, projectTitle }) {
  const skippedNote = plan.skipped ? " (already imported)" : "";
  const created = plan.externalMembersCreated;
  stdout.write(
    `Dry run plan for ${owner}/${repo} into project ${project} (${projectTitle}):\n` +
      `  would import ${plan.importedStories} stories (${plan.importedLabels} labels), ` +
      `would skip ${plan.skipped}${skippedNote}, ${plan.errors.length} error(s).\n` +
      (created.length
        ? `  would create ${created.length} placeholder owner(s): ${placeholderOwnersTail(created)}`
        : "") +
      "No changes made.\n",
  );
  for (const err of plan.errors) {
    stderr.write(`  - ${rowErrorLine(err)}\n`);
  }
  return 0;
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
 * @property {typeof defaultRunWizard} [wizard] the --customize wizard; defaults
 *   to the real one, reading from `stdin` and prompting on stderr
 * @property {((question: string) => Promise<boolean>) | null} [confirm] yes/no
 *   prompt; defaults to a terminal prompt when stdin is a TTY, else null —
 *   null means "nowhere to ask", and a run that would write then exits 2
 *   naming --yes (CONTRACT.md, "Confirmation gate — fail closed off a terminal")
 * @property {{ isTTY?: boolean } & Partial<import("node:stream").Readable>} [stdin]
 *   the --customize gate's TTY probe and the wizard's input; defaults to process.stdin
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
    wizard = defaultRunWizard,
    confirm = process.stdin.isTTY ? defaultConfirm : null,
    stdin = process.stdin,
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
        customize: { type: "boolean" },
        states: { type: "string" },
        milestones: { type: "string", multiple: true },
        "story-type": { type: "string" },
        "no-comments": { type: "boolean" },
        "no-tasks": { type: "boolean" },
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

  /** @type {import("./engine.js").Engine} */
  let engine;
  try {
    engine = parseEngine(values.engine ?? DEFAULT_ENGINE);
  } catch (err) {
    return usageError(`argument --engine: ${err instanceof Error ? err.message : err}`);
  }
  // Flag combinations are settled before the TTY gate below: a caller that
  // asked for two contradictory things should hear that, not "needs a terminal".
  const givenFlags = customizationFlagsGiven(values);
  /** @type {import("./mapping.js").Customization | null} */
  let customization = null;
  if (givenFlags.length) {
    if (values.customize) {
      return usageError(
        `${givenFlags[0]} conflicts with --customize: the customization flags declare the ` +
          "answers up front, --customize asks for them interactively; drop one of the two",
      );
    }
    if (values.engine === "server") {
      return usageError(
        `${givenFlags[0]} conflicts with --engine server: the server engine maps everything ` +
          "server-side, so there is nothing to customize; drop one of the two flags",
      );
    }
    engine = "direct";
    try {
      customization = parseCustomization(values);
    } catch (err) {
      return usageError(err instanceof Error ? err.message : String(err));
    }
  }

  if (values.customize) {
    if (values.engine === "server") {
      return usageError(
        "--customize conflicts with --engine server: the server engine maps everything " +
          "server-side, so there is nothing to customize; drop one of the two flags",
      );
    }
    engine = "direct";
    if (!stdin.isTTY || !stdout.isTTY) {
      return usageError(
        "--customize needs an interactive terminal (stdin and stdout must be TTYs)",
      );
    }
  }

  // GitHub's GraphQL API has no anonymous mode, so a tokenless direct run cannot work — and
  // this gate precedes loadConfig, so it loads .env or a token set there reads as absent.
  if (engine === "direct") {
    loadDotenv();
    if (!(values.token?.trim() || process.env.GITHUB_TOKEN?.trim())) {
      return usageError(
        "--engine direct fetches from GitHub's GraphQL API, which rejects anonymous callers: " +
          "pass --token <TOKEN>, or set GITHUB_TOKEN. (--engine server needs one only for a " +
          "private repo — EAT fetches public repos with its own credential.)",
      );
    }
  }

  // Fail closed: off-terminal there is no way to show the [y/N] confirm, so a
  // run that would write must say --yes rather than have it assumed.
  if (!values["dry-run"] && !values.yes && !confirm) {
    return usageError(
      "no interactive terminal to confirm on: pass --yes to import without confirmation, " +
        "or --dry-run to preview the plan without writing",
    );
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

  // Refused before the legend, not warned after it: the import body ignores
  // unknown fields, so this run would promise blockers, report success and write none.
  if (engine === "server" && included.includes("deps")) {
    if (!(await client.supportsDependencyImport())) {
      stderr.write(
        `error: project ${project}'s server cannot import issue dependencies — its ` +
          "import endpoint publishes no `include_dependencies` field, and the import body " +
          "ignores fields it does not know, so this run would report success and write no " +
          "blockers. Re-run with --engine direct, which imports them from GitHub itself, " +
          "or drop deps from --include.\n",
      );
      return 1;
    }
  }

  // --customize defers the legend + confirm until after the wizard, so they can
  // reflect the member's choices; they run in the direct pipeline's announce hook.
  if (!values.customize) {
    stdout.write(`${renderLegend(included, engine, customization)}\n`);

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
  }

  if (engine === "direct") {
    const token = values.token || process.env.GITHUB_TOKEN || undefined;
    // --customize prints "Importing..." from the announce hook instead, once the
    // member has confirmed — after the wizard, not before it.
    if (!values["dry-run"] && !values.customize) {
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
        // The declarative flags land here already built; --customize instead
        // threads the wizard below, which produces the same object.
        customization: customization ?? undefined,
        // The wizard runs at the pipeline's fetch→map seam so its questions
        // reflect real issue data; prompts go to stderr, keeping stdout clean.
        customize: values.customize
          ? (fetched) =>
              wizard(fetched, {
                input: /** @type {import("node:stream").Readable} */ (stdin),
                output: stderr,
                // The questions describe the rows this run maps, and under
                // --include prs a PR row is one of them.
                pullRequests: included.includes("prs"),
              })
          : undefined,
        // Runs after the wizard, before any write, so the legend + confirm
        // reflect the member's choices instead of the default profile.
        announce: values.customize
          ? async (_fetched, customization) => {
              stdout.write(`${renderLegend(included, engine, customization)}\n`);
              if (!values["dry-run"] && !values.yes && confirm) {
                const proceed = await confirm(
                  `Import ${owner}/${repo} into project ${project} (${result.projectTitle})? [y/N] `,
                );
                if (!proceed) throw new ConfirmAborted();
              }
              if (!values["dry-run"]) {
                stdout.write(
                  `Importing ${owner}/${repo} into project ${project} (${result.projectTitle})...\n`,
                );
              }
            }
          : undefined,
      });
    } catch (err) {
      if (err instanceof WizardAborted || err instanceof ConfirmAborted) {
        stderr.write("Aborted — nothing imported.\n");
        return 1;
      }
      if (err instanceof EATError || err instanceof GitHubError) {
        stderr.write(`error: ${values["dry-run"] ? "dry run failed: " : ""}${err.message}\n`);
        return 1;
      }
      throw err;
    }
    if (values["dry-run"]) {
      return reportDryRunPlan(outcome, {
        stdout,
        stderr,
        owner,
        repo,
        project,
        projectTitle: result.projectTitle,
      });
    }
    return reportImport(outcome, { stdout, stderr, project, appBase: config.appBase });
  }

  if (values["dry-run"]) {
    // Server-side dry_run is feature-detected first: sending the flag to a
    // server that ignores unknown fields would run a real import.
    if (await client.supportsServerDryRun()) {
      const token = values.token || process.env.GITHUB_TOKEN || undefined;
      let plan;
      const reporter = makeImportReporter({ stream: stderr });
      try {
        plan = await runImport(client, project, owner, repo, {
          idempotencyKey: randomUUID(),
          token,
          flags,
          dryRun: true,
          onProgress: reporter,
          onWait: (thunk) =>
            runWithProgress(thunk, "waiting for the server to compute the import plan", {
              stream: stderr,
            }),
        });
      } catch (err) {
        reporter.close(); // close the live line before any error text
        if (err instanceof EATTimeout) {
          stderr.write(`error: ${err.message}\n`);
          stderr.write(
            "The server may still be finishing the import — check the board in a " +
              "moment, or re-run.\n",
          );
          return 1;
        }
        if (err instanceof EATError) {
          stderr.write(`error: dry run failed: ${err.message}\n`);
          return 1;
        }
        throw err;
      } finally {
        reporter.close();
      }
      if (!plan.dryRun) {
        stderr.write(
          "warning: the server did not confirm dry-run mode — check the board before re-running.\n",
        );
      }
      return reportDryRunPlan(plan, {
        stdout,
        stderr,
        owner,
        repo,
        project,
        projectTitle: result.projectTitle,
      });
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
  const reporter = makeImportReporter({ stream: stderr });
  try {
    outcome = await runImport(client, project, owner, repo, {
      idempotencyKey: randomUUID(),
      token,
      flags,
      onProgress: reporter,
      onWait: (thunk) =>
        runWithProgress(thunk, "waiting for the server to import GitHub issues", {
          stream: stderr,
        }),
    });
  } catch (err) {
    reporter.close(); // close the live line before any error text
    if (err instanceof EATTimeout) {
      stderr.write(`error: ${err.message}\n`);
      stderr.write(
        "The server may still be finishing the import — check the board in a " +
          "moment, or re-run.\n",
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
  } finally {
    reporter.close();
  }

  return reportImport(outcome, { stdout, stderr, project, appBase: config.appBase });
}
