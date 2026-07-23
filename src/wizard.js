/**
 * The interactive `--customize` wizard: asks one question at a time on the
 * terminal and returns a {@link import("./mapping.js").Customization} for this
 * run only (nothing is persisted). Questions derive from the already-fetched
 * issues, so no extra GitHub request is made.
 */

import readline from "node:readline/promises";

import { stripControls } from "./mapping.js";

/** Thrown when the member closes the input (Ctrl-D) before answering every question. */
export class WizardAborted extends Error {
  constructor() {
    super("customization wizard aborted");
    this.name = "WizardAborted";
  }
}

/**
 * Non-PR issues only, matching {@link import("./mapping.js").mapRepo}'s filter.
 *
 * @param {{ issues?: any[] }} fetched
 * @returns {any[]}
 */
function realIssues(fetched) {
  return (fetched.issues ?? []).filter((issue) => !issue.pull_request);
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
 *   output: import("./progress.js").OutStream }} streams injected so tests can
 *   script answers and assert rendered prompts
 * @returns {Promise<import("./mapping.js").Customization>}
 * @throws {WizardAborted} on EOF before every question is answered
 */
export async function runWizard(fetched, { input, output }) {
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
    const issues = realIssues(fetched);
    const open = issues.filter((i) => String(i.state ?? "").toLowerCase() === "open").length;
    const closed = issues.filter((i) => String(i.state ?? "").toLowerCase() === "closed").length;

    const statesIdx = await askMenu(
      ask,
      write,
      `Import which issue states? (${open} open, ${closed} closed)`,
      ["all", "open only", "closed only"],
      0,
    );
    const states = /** @type {"all" | "open" | "closed"} */ (["all", "open", "closed"][statesIdx]);

    const milestones = await askMilestones(ask, write, issues);

    const typeIdx = await askMenu(
      ask,
      write,
      "Story type for imported issues?",
      ["infer from labels/title", "all feature", "all bug", "all chore"],
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
 * without prompting — when no fetched issue carries a milestone.
 *
 * @param {(prompt: string) => Promise<string>} ask
 * @param {(chunk: string) => void} write
 * @param {any[]} issues non-PR issues
 * @returns {Promise<string[] | null>}
 */
async function askMilestones(ask, write, issues) {
  /** @type {string[]} */
  const titles = [];
  const seen = new Set();
  for (const issue of issues) {
    const title = issue.milestone?.title;
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
