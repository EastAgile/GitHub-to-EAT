/**
 * The interactive `--customize` wizard: asks one question at a time on the
 * terminal and returns a {@link import("./mapping.js").Customization} for this
 * run only (nothing is persisted). Questions derive from the already-fetched
 * issues, so no extra GitHub request is made.
 */

import readline from "node:readline/promises";

import { mappableRow, stripControls } from "./mapping.js";

/** Thrown when the member closes the input (Ctrl-D) before answering every question. */
export class WizardAborted extends Error {
  constructor() {
    super("customization wizard aborted");
    this.name = "WizardAborted";
  }
}

/**
 * The rows this run would map, so the questions describe the run that will happen:
 * under `--include prs` a PR row is one of them.
 *
 * @param {{ issues?: any[] }} fetched
 * @param {boolean} pullRequests
 * @returns {any[]}
 */
function mappableRows(fetched, pullRequests) {
  return (fetched.issues ?? []).filter((row) => mappableRow(row, pullRequests));
}

/**
 * Prompt for one of a numbered list, blank = the default entry.
 *
 * @param {(prompt: string) => Promise<string>} ask
 * @param {(chunk: string) => void} write
 * @param {string} header
 * @param {string[]} choices
 * @param {number} defaultIndex
 * @returns {Promise<number>} the chosen 0-based index
 */
async function askMenu(ask, write, header, choices, defaultIndex) {
  while (true) {
    write(`${header}\n`);
    choices.forEach((choice, i) => {
      write(`  ${i + 1}) ${choice}${i === defaultIndex ? " [default]" : ""}\n`);
    });
    const answer = await ask("> ");
    if (answer === "") return defaultIndex;
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
    write(`Please enter a number 1-${choices.length}, or blank for the default.\n`);
  }
}

/**
 * @param {(prompt: string) => Promise<string>} ask
 * @param {string} question
 * @param {boolean} dflt
 * @returns {Promise<boolean>}
 */
async function askYesNo(ask, question, dflt) {
  const suffix = dflt ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await ask(`${question} ${suffix} `)).toLowerCase();
    if (answer === "") return dflt;
    if (/^y(es)?$/.test(answer)) return true;
    if (/^n(o)?$/.test(answer)) return false;
  }
}

/**
 * Run the wizard against the fetched repo and return this run's customization.
 *
 * @param {{ issues: any[], comments: any[], labels: any[] }} fetched
 * @param {{ input: import("node:stream").Readable,
 *   output: import("./progress.js").OutStream, pullRequests?: boolean }} options
 *   streams are injected so tests can script answers and assert rendered prompts;
 *   `pullRequests` is the run's `--include prs`, which decides whether a PR row counts
 * @returns {Promise<import("./mapping.js").Customization>}
 * @throws {WizardAborted} on EOF before every question is answered
 */
export async function runWizard(fetched, { input, output, pullRequests = false }) {
  // OutStream is the minimal write-sink tests inject; readline only calls write.
  const rl = readline.createInterface({ input, output: /** @type {any} */ (output) });
  const lines = rl[Symbol.asyncIterator]();
  const write = (/** @type {string} */ chunk) => output.write(chunk);
  const ask = async (/** @type {string} */ prompt) => {
    write(prompt);
    const { value, done } = await lines.next();
    if (done) throw new WizardAborted();
    return value.trim();
  };

  try {
    const rows = mappableRows(fetched, pullRequests);
    const open = rows.filter((r) => String(r.state ?? "").toLowerCase() === "open").length;
    const closed = rows.filter((r) => String(r.state ?? "").toLowerCase() === "closed").length;

    const statesIdx = await askMenu(
      ask,
      write,
      `Import which issue states? (${open} open, ${closed} closed)`,
      ["all", "open only", "closed only"],
      0,
    );
    const states = /** @type {"all" | "open" | "closed"} */ (["all", "open", "closed"][statesIdx]);

    const milestones = await askMilestones(ask, write, rows);

    const typeIdx = await askMenu(
      ask,
      write,
      "Story type for imported issues?",
      ["infer (issue type, else labels/title)", "all feature", "all bug", "all chore"],
      0,
    );
    const storyType = /** @type {"infer" | "feature" | "bug" | "chore"} */ (
      ["infer", "feature", "bug", "chore"][typeIdx]
    );

    const comments = await askYesNo(ask, "Import issue comments?", true);
    const tasks = await askYesNo(ask, "Convert body checklists to story tasks?", true);

    return { states, milestones, storyType, comments, tasks };
  } finally {
    rl.close();
  }
}

/**
 * Multi-select milestone filter, or `null` (all). Skipped — returns `null`
 * without prompting — when no mappable row carries a milestone.
 *
 * @param {(prompt: string) => Promise<string>} ask
 * @param {(chunk: string) => void} write
 * @param {any[]} rows the rows this run would map
 * @returns {Promise<string[] | null>}
 */
async function askMilestones(ask, write, rows) {
  /** @type {string[]} */
  const titles = [];
  const seen = new Set();
  for (const row of rows) {
    const title = row.milestone?.title;
    if (typeof title === "string" && title && !seen.has(title)) {
      seen.add(title);
      titles.push(title);
    }
  }
  if (titles.length === 0) return null;

  while (true) {
    write("Filter by milestone (blank = all). Enter numbers, comma-separated:\n");
    titles.forEach((title, i) => {
      write(`  ${i + 1}) ${stripControls(title)}\n`);
    });
    const answer = await ask("> ");
    if (answer === "") return null;
    const picks = answer
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10));
    if (picks.length && picks.every((n) => Number.isInteger(n) && n >= 1 && n <= titles.length)) {
      return titles.filter((_title, i) => picks.includes(i + 1));
    }
    write(`Please enter numbers 1-${titles.length} (comma-separated), or blank for all.\n`);
  }
}
