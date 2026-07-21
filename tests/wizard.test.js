import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { DEFAULT_CUSTOMIZATION } from "../src/mapping.js";
import { runWizard, WizardAborted } from "../src/wizard.js";
import { capture } from "./helpers.js";

/**
 * A readable that yields the given answers one line at a time, then EOFs.
 *
 * @param {string[]} lines
 */
function scripted(lines) {
  return Readable.from(lines.map((l) => `${l}\n`));
}

test("the states question renders the fetched open/closed counts", async () => {
  const fetched = {
    issues: [
      { number: 1, state: "open" },
      { number: 2, state: "open" },
      { number: 3, state: "closed" },
    ],
    comments: [],
    labels: [],
  };
  const output = capture();
  // no milestones → Q1, Q3, Q4, Q5 (four prompts)
  const customization = await runWizard(fetched, { input: scripted(["", "", "", ""]), output });
  assert.match(output.buf, /2 open, 1 closed/);
  assert.equal(customization.states, "all");
});

test("choosing 'open only' at the states question sets states to open", async () => {
  const fetched = {
    issues: [
      { number: 1, state: "open" },
      { number: 2, state: "closed" },
    ],
    comments: [],
    labels: [],
  };
  const customization = await runWizard(fetched, {
    input: scripted(["2", "", "", ""]),
    output: capture(),
  });
  assert.equal(customization.states, "open");
});

test("the milestone question lists the titles on fetched issues and returns the picks", async () => {
  const fetched = {
    issues: [
      { number: 1, state: "open", milestone: { title: "v1.0" } },
      { number: 2, state: "closed", milestone: { title: "v2.0" } },
      { number: 3, state: "open" },
    ],
    comments: [],
    labels: [],
  };
  const output = capture();
  // Q1 all, Q2 pick v1.0, Q3 infer, Q4/Q5 defaults
  const customization = await runWizard(fetched, {
    input: scripted(["", "1", "", "", ""]),
    output,
  });
  assert.match(output.buf, /v1\.0/);
  assert.match(output.buf, /v2\.0/);
  assert.deepEqual(customization.milestones, ["v1.0"]);
});

test("the milestone question is skipped when no fetched issue carries a milestone", async () => {
  const fetched = {
    issues: [
      { number: 1, state: "open" },
      { number: 2, state: "closed" },
    ],
    comments: [],
    labels: [],
  };
  const output = capture();
  const customization = await runWizard(fetched, {
    input: scripted(["", "", "", ""]),
    output,
  });
  assert.equal(customization.milestones, null);
  assert.doesNotMatch(output.buf, /milestone/i);
});

test("non-default answers build the matching Customization object", async () => {
  const fetched = {
    issues: [
      { number: 1, state: "open", milestone: { title: "v1.0" } },
      { number: 2, state: "closed", milestone: { title: "v2.0" } },
    ],
    comments: [],
    labels: [],
  };
  // states=closed, milestones=both, storyType=bug, comments=no, tasks=no
  const customization = await runWizard(fetched, {
    input: scripted(["3", "1,2", "3", "n", "n"]),
    output: capture(),
  });
  assert.deepEqual(customization, {
    states: "closed",
    milestones: ["v1.0", "v2.0"],
    storyType: "bug",
    comments: false,
    tasks: false,
  });
});

test("plain Enter at every prompt yields the default customization", async () => {
  const fetched = { issues: [{ number: 1, state: "open" }], comments: [], labels: [] };
  const customization = await runWizard(fetched, {
    input: scripted(["", "", "", ""]),
    output: capture(),
  });
  assert.deepEqual(customization, DEFAULT_CUSTOMIZATION);
});

test("EOF mid-wizard rejects with WizardAborted", async () => {
  const fetched = { issues: [{ number: 1, state: "open" }], comments: [], labels: [] };
  await assert.rejects(
    runWizard(fetched, { input: scripted([]), output: capture() }),
    (err) => err instanceof WizardAborted,
  );
});

test("milestone titles are stripped of terminal control chars at render but returned verbatim", async () => {
  // A crafted title: ESC (colour/cursor), CR + LF that could forge a fake "9)" menu row.
  const evil = "v1\x1b[31m\r\n  9) spoofed";
  const fetched = {
    issues: [{ number: 1, state: "open", milestone: { title: evil } }],
    comments: [],
    labels: [],
  };
  const output = capture();
  // Q1 all, Q2 pick 1, Q3 infer, Q4/Q5 defaults
  const customization = await runWizard(fetched, {
    input: scripted(["", "1", "", "", ""]),
    output,
  });
  // no ESC or CR from the title reaches the terminal, and the injected newline
  // cannot open a second numbered line — the title renders on one row.
  assert.ok(!output.buf.includes("\x1b"), "ESC is stripped");
  assert.ok(!output.buf.includes("\r"), "CR is stripped");
  assert.doesNotMatch(output.buf, /^ {2}9\) spoofed$/m);
  // mapRepo matches GitHub's real milestone title, so the pick is returned unmodified.
  assert.deepEqual(customization.milestones, [evil]);
});
