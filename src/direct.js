/**
 * The "direct" import engine: fetch → map → prescan → write, all client-side. `--dry-run`
 * runs the same pipeline but stops before the write — no server dry-run support needed.
 */

import {
  applyDedup,
  markerFor,
  prescanImported,
  prescanProvenance,
  storyLabelKeys,
  unionImported,
} from "./dedup.js";
import { GitHubClient } from "./github.js";
import { GITHUB_LOGIN } from "./importer.js";
import {
  clampPlan,
  DEFAULT_CUSTOMIZATION,
  describeFilters,
  describeOp,
  EPIC_TITLE_LIMIT,
  epicTitleKey,
  FALLBACK_LIMITS,
  hasMilestoneFilter,
  ISSUE_TYPE_NAMES,
  mappableRelease,
  mapRepo,
  matchesMilestones,
  matchesStates,
  milestoneEpicTitle,
  storyTypeFromIssueType,
  stripControls,
} from "./mapping.js";
import { includeWith } from "./mappings.js";
import { runWithProgress } from "./progress.js";
import { writePlan } from "./writer.js";

/**
 * The client surface the pipeline needs — the writer's methods plus the
 * prescan page reader (structural, so tests can pass stubs).
 *
 * @typedef {import("./writer.js").WriterClient
 *   & import("./dedup.js").PrescanClient
 *   & { fieldLimits?: () => Promise<Partial<import("./mapping.js").FieldLimits>>,
 *       supportsProvenanceDedup?: () => Promise<boolean>,
 *       supportsBackdating?: () => Promise<boolean>,
 *       supportsPersonAttribution?: () => Promise<boolean> }} DirectClient
 */

/**
 * Warn when a run's filters leave nothing to import — a `--milestones` typo, or
 * a milestone the `--states` filter already excluded, would otherwise import
 * zero stories with no explanation. Unmatched titles are named on their own
 * because the run may still import the other ones.
 *
 * @param {{ issues: any[], releases?: any[] }} fetched
 * @param {import("./mapping.js").Customization} customization
 * @param {import("./progress.js").OutStream} [stream]
 */
function warnFiltersMatchNothing({ issues, releases }, customization, stream) {
  const filters = describeFilters(customization);
  if (!filters.length) return;
  const { states, milestones } = customization;
  // Milestones are matched against what survives the other filters, because
  // that is the order mapRepo applies them in.
  const candidates = issues.filter((issue) => !issue.pull_request && matchesStates(issue, states));

  if (hasMilestoneFilter(milestones)) {
    const present = new Set(candidates.map((issue) => issue.milestone?.title));
    const unmatched = milestones.filter((title) => !present.has(title));
    if (unmatched.length) {
      stream?.write(
        `warning: no fetched ${states === "all" ? "issue" : `${states} issue`} carries the ` +
          `milestone(s) ${unmatched.map(stripControls).join(", ")} — ` +
          "the filter matches milestone titles exactly (case-sensitive); " +
          "those titles contribute no stories.\n",
      );
    }
  }

  if (!candidates.some((issue) => matchesMilestones(issue, milestones))) {
    // The filters select issues only, so a release-bearing run still imports something
    // and must not be told otherwise.
    const stillImports = (releases ?? []).filter(mappableRelease).length;
    stream?.write(
      `warning: no fetched issue matches this run's filters (${filters.join("; ")}) — ` +
        (stillImports
          ? // "up to": this runs before the prescan, so some of those may already be imported.
            `no issues to import; the run would import up to ${stillImports} release(s).\n`
          : "nothing to import.\n"),
    );
  }
}

/**
 * Both drops are silent data loss otherwise: no positive numeric id means no dedup key,
 * and a blank tag means no story name — a `400` that would abort the run, not lose a row.
 *
 * @param {{ releases?: any[] }} fetched
 * @param {import("./progress.js").OutStream} [stream]
 */
function warnUnmappableReleases({ releases }, stream) {
  const dropped = (releases ?? []).filter((release) => !mappableRelease(release)).length;
  if (!dropped) return;
  stream?.write(
    `warning: ${dropped} fetched release(s) carry no positive numeric id or no tag name and are ` +
      "not imported — the id is the re-import key and the tag is the story's title.\n",
  );
}

/**
 * The issues a run actually maps: not a PR, and past both selection filters.
 *
 * @param {any[]} issues
 * @param {import("./mapping.js").Customization} customization
 * @returns {any[]}
 */
function inScope(issues, { states, milestones }) {
  return issues.filter(
    (issue) =>
      !issue.pull_request && matchesStates(issue, states) && matchesMilestones(issue, milestones),
  );
}

/**
 * Without the flag a milestone is dropped entirely, where the server keeps a
 * `milestone:<title>` label. The count only: titles are author-controlled text.
 * The suggestion is scoped to what a later run can actually deliver — an import
 * never updates, so it cannot group stories this run has already written.
 *
 * @param {{ issues: any[] }} fetched
 * @param {import("./mapping.js").Customization} customization
 * @param {string[]} included
 * @param {import("./progress.js").OutStream} [stream]
 */
function noteMilestonesNotImported({ issues }, customization, included, stream) {
  const count = inScope(issues, customization).filter((issue) =>
    milestoneEpicTitle(issue.milestone),
  ).length;
  if (!count) return;
  stream?.write(
    `note: ${count} issue(s) carry a GitHub milestone this run does not import — pass ` +
      `--include ${includeWith(included, "milestones")} to import each milestone as an epic. ` +
      "That groups only the issues the run itself imports; a story already in EAT is never " +
      "re-labelled.\n",
  );
}

/**
 * What the epic dedup cost. `applyDedup` drops an epic no *surviving* story carries — its
 * label would group nothing — and an import never re-labels a story already in EAT, so a
 * member skipped by an earlier flagless run can never join. Silence there makes
 * `--include …,milestones` look like a no-op on an already-imported project. A member the
 * prescan shows already wearing the label was grouped by an earlier flagged run: nothing
 * to report, which is why the count is measured against the rows, not against `skipped`.
 *
 * @param {{ stories: import("./mapping.js").StoryOp[],
 *   epics: import("./mapping.js").EpicOp[] }} mapped
 * @param {import("./writer.js").WritePlan} plan post-dedup
 * @param {Map<string, any>} imported prescan rows, label-bearing under the flag
 * @param {string[]} included
 * @param {import("./progress.js").OutStream} [stream]
 */
function warnEpicsPruned(mapped, plan, imported, included, stream) {
  if (!mapped.epics.length) return;
  const planned = new Set((plan.epics ?? []).map((epic) => epicTitleKey(epic.title)));

  let dropped = 0;
  let partial = 0;
  let orphaned = 0;
  for (const epic of mapped.epics) {
    const key = epicTitleKey(epic.title);
    const unlabelled = mapped.stories.filter((op) => {
      if (!op.labels.some((name) => epicTitleKey(name) === key)) return false;
      const row = imported.get(op.external_id);
      return row !== undefined && !storyLabelKeys(row).has(key);
    }).length;
    if (!unlabelled) continue;
    if (planned.has(key)) {
      partial += 1;
      orphaned += unlabelled;
    } else {
      dropped += 1;
    }
  }

  if (dropped) {
    stream?.write(
      `warning: ${dropped} milestone(s) map to an epic this run does not create — every issue ` +
        "in them is already imported without its label, and an import never re-labels a story " +
        "already in EAT, so no epic can group them now; delete those stories in EAT and re-run " +
        `with --include ${includeWith(included, "milestones")} to import them into epics.\n`,
    );
  }
  if (partial) {
    stream?.write(
      `warning: ${partial} epic(s) this run creates are missing ${orphaned} already-imported ` +
        "issue(s) — those stories carry no milestone label and an import never adds one, so " +
        "each epic holds only the issues this run imports; delete the older stories in EAT " +
        "and re-run to group the whole milestone.\n",
    );
  }
}

/**
 * Two milestones agreeing on their first 255 bytes collapse into one epic (the server
 * truncates before keying too), so the merge must not be silent.
 *
 * @param {{ issues: any[] }} fetched
 * @param {import("./mapping.js").Customization} customization
 * @param {import("./progress.js").OutStream} [stream]
 */
function warnTruncatedMilestones({ issues }, customization, stream) {
  // Trimmed before the Set: two titles differing only in surrounding whitespace do
  // collapse into one epic, so counting them twice would over-report the merge.
  const long = new Set(
    inScope(issues, customization)
      .map((issue) => issue.milestone?.title)
      .filter((title) => typeof title === "string")
      .map((title) => title.trim())
      .filter((title) => Buffer.byteLength(title, "utf8") > EPIC_TITLE_LIMIT),
  );
  if (!long.size) return;
  stream?.write(
    `warning: ${long.size} milestone title(s) are longer than ${EPIC_TITLE_LIMIT} bytes and ` +
      "are cut to that length for the epic and its label — titles that agree on that prefix " +
      "share one epic.\n",
  );
}

/**
 * Warn once when issues carry an org issue type the table does not know — an org standardised
 * on `Spike`/`Support` would otherwise have every story silently typed by the old heuristic.
 * The count is all that is reported: type names are org-authored text, which never reaches the
 * terminal from this path.
 *
 * @param {{ issues: any[] }} fetched
 * @param {import("./mapping.js").Customization} customization
 * @param {import("./progress.js").OutStream} [stream]
 */
function warnUnrecognisedIssueTypes({ issues }, customization, stream) {
  const { storyType, states, milestones } = customization;
  if (storyType !== "infer") return;
  const count = issues.filter((issue) => {
    const name = issue.type?.name;
    return (
      !issue.pull_request &&
      matchesStates(issue, states) &&
      matchesMilestones(issue, milestones) &&
      typeof name === "string" &&
      name.trim() !== "" &&
      storyTypeFromIssueType(issue.type) === null
    );
  }).length;
  if (!count) return;
  stream?.write(
    `warning: ${count} issue(s) carry an issue type this importer does not recognise ` +
      `(it knows ${ISSUE_TYPE_NAMES.join(", ")}) — those stories take their type from ` +
      "labels + title instead.\n",
  );
}

/**
 * The distinct logins this plan attaches — the roster touched, not the rows created (the
 * creates carry no such signal). Filtered because these reach a terminal raw.
 *
 * @param {{ stories: import("./mapping.js").StoryOp[] }} plan
 * @returns {string[]}
 */
function attachedPeople(plan) {
  /** @type {Set<string>} */
  const logins = new Set();
  for (const story of plan.stories) {
    for (const person of [
      story.requestor,
      ...(story.owners ?? []),
      ...story.comments.map((c) => c.author),
    ]) {
      const login = person?.username;
      if (typeof login === "string" && GITHUB_LOGIN.test(login)) logins.add(login);
    }
  }
  return [...logins].sort();
}

/**
 * Run the client-side import pipeline and return the same
 * {@link import("./importer.js").ImportOutcome} shape the server engine yields.
 *
 * @param {DirectClient} client
 * @param {number} projectId
 * @param {string} owner
 * @param {string} repo
 * @param {{ token?: string, included?: string[], dryRun?: boolean,
 *   stream?: import("./progress.js").OutStream, runId?: string,
 *   customization?: import("./mapping.js").Customization,
 *   customize?: (fetched: { issues: any[], comments: any[], labels: any[] })
 *     => Promise<import("./mapping.js").Customization>,
 *   announce?: (fetched: { issues: any[], comments: any[], labels: any[] },
 *     customization: import("./mapping.js").Customization) => Promise<void>,
 *   github?: { fetchAll(options?: { releases?: boolean, dependencies?: boolean }):
 *     Promise<{ issues: any[], comments: any[], labels: any[],
 *     subIssues?: Map<string, string[]>, releases?: any[],
 *     blockedBy?: Map<string, any[]>, dependencyRequests?: number }> } }} options
 *   `customize` (the wizard) runs at the
 *   fetch→map seam so its questions use real data; `announce` (the customized
 *   legend + confirm) runs right after, and may throw to abort before any
 *   write; `github` is a test seam
 * @returns {Promise<import("./importer.js").ImportOutcome>}
 */
export async function runDirect(client, projectId, owner, repo, options) {
  const { token, dryRun, stream, runId, github, customize, announce, included = [] } = options;
  // Buffered, not written straight through: the fetch runs under a TTY spinner that
  // holds an open `\r` line, which would otherwise swallow the first warning.
  /** @type {string[]} */
  const fetchWarnings = [];
  const source =
    github ?? new GitHubClient(owner, repo, { token, warn: (m) => fetchWarnings.push(m) });
  const releases = included.includes("releases");
  // Every issue row carries its own milestone, so the epic mapping costs no extra fetch.
  const epics = included.includes("milestones");
  const dependencies = included.includes("deps");
  const fetched = await runWithProgress(
    () => source.fetchAll({ releases, dependencies }),
    `fetching ${owner}/${repo} from GitHub`,
    { stream },
  );
  for (const message of fetchWarnings) (stream ?? process.stderr).write(message);
  // The wizard sits after the fetch so its questions reflect real issues; EOF
  // rejects here, before any prescan or write.
  const customization = customize
    ? await customize(fetched)
    : (options.customization ?? DEFAULT_CUSTOMIZATION);
  warnFiltersMatchNothing(fetched, customization, stream);
  warnUnrecognisedIssueTypes(fetched, customization, stream);
  warnUnmappableReleases(fetched, stream);
  if (epics) warnTruncatedMilestones(fetched, customization, stream);
  else noteMilestonesNotImported(fetched, customization, included, stream);
  // The customized legend + confirm reflect those answers, so they land here —
  // a declined confirm throws, aborting before any prescan or write.
  if (announce) await announce(fetched, customization);
  // Clamp before the marker lands so the description budget can reserve room
  // for it — one giant GitHub comment must not 400 the whole run.
  const limits = { ...FALLBACK_LIMITS, ...(await (client.fieldLimits?.() ?? {})) };
  // One probe gates all three backdated fields; degrades to false, so an older
  // server gets v3-identical payloads and the full-date comment prefix.
  const sendDates = await (client.supportsBackdating?.() ?? false);
  // One probe gates requestor + owners[].external + the comment author (EAT #32773,
  // one change); degrades to false, which keeps the `@login` comment prefix.
  const sendPeople = await (client.supportsPersonAttribution?.() ?? false);
  const mapped = clampPlan(
    mapRepo(fetched, customization, { sendDates, epics, sendPeople }),
    limits,
    {
      reserveDescription: (op) =>
        Buffer.byteLength(markerFor(owner, repo, op.external_id), "utf8") + 2,
      warn: (message) => stream?.write(message),
    },
  );

  // One probe gates writing the pair and reading it back via the list filters.
  const sendProvenance = await (client.supportsProvenanceDedup?.() ?? false);

  const imported = await runWithProgress(
    async () => {
      // Labels only under the flag: they are what tells an already-grouped skipped story
      // from one no epic can ever reach, and nothing else reads them.
      const scan = { withLabels: epics };
      if (!sendProvenance) return prescanImported(client, projectId, owner, repo, scan);
      // Union, not replace: legacy marker-only rows carry no pair, pair-only
      // rows (server-written, or newer direct runs) carry no marker. The two
      // reads are independent, so run them concurrently.
      const [marker, provenance] = await Promise.all([
        prescanImported(client, projectId, owner, repo, scan),
        prescanProvenance(client, projectId, "github", scan),
      ]);
      return unionImported(marker, provenance);
    },
    `scanning project ${projectId} for already-imported stories`,
    { stream },
  );
  const { plan, skipped } = applyDedup(mapped, imported, owner, repo);
  warnEpicsPruned(mapped, plan, imported, included, stream);

  // The marker lands at story-create, before tasks/blockers/comments — a run that
  // died in that window left a skipped-but-incomplete story. Surface it, loudly.
  for (const op of mapped.stories) {
    const row = imported.get(op.external_id);
    if (!row) continue;
    const tasksCount = Number(row.tasks_count ?? 0);
    const blockerCount = Number(row.blocker_count ?? 0);
    const commentCount = Number(row.comment_count ?? 0);
    const blockers = op.blockers ?? [];
    if (
      tasksCount < op.tasks.length ||
      blockerCount < blockers.length ||
      commentCount < op.comments.length
    ) {
      stream?.write(
        `warning: ${describeOp(op.external_id)} has fewer tasks/blockers/comments in EAT than on ` +
          `GitHub (tasks ${tasksCount}/${op.tasks.length}, blockers ${blockerCount}/${blockers.length}, ` +
          `comments ${commentCount}/${op.comments.length}) — ` +
          "an earlier run may have been interrupted, or the issue changed since import; " +
          "it stays skipped — delete that story in EAT and re-run to repair.\n",
      );
    }
  }

  if (dryRun) {
    // The stage has no rollup to gate on, so its price is per-issue and only a
    // finished run can state it — the preview is where that lands.
    if (dependencies) {
      stream?.write(
        `note: --include deps cost ${fetched.dependencyRequests ?? 0} extra GitHub request(s) ` +
          "(at least one per issue, more where a listing paginates); an anonymous run has 60/h, " +
          "a --token run 5000/h — and a real run spends them again, this preview did not save them.\n",
      );
    }
    // Epics are written first, so a GitHub label sharing a milestone's name arrives as the
    // epic's backing label and 409s into *existing* — unsubtracted, the preview over-reports.
    const epicNames = new Set((plan.epics ?? []).map((epic) => epicTitleKey(epic.title)));
    return {
      importedStories: plan.stories.length,
      importedLabels: plan.labels.filter((label) => !epicNames.has(epicTitleKey(label.name)))
        .length,
      skipped,
      errors: [],
      warnings: [],
      unmatched: {},
      externalMembersCreated: attachedPeople(plan),
      dryRun: true,
    };
  }

  const written = await writePlan(client, projectId, plan, {
    stream,
    runId,
    sendProvenance,
    sendDates,
    sendPeople,
  });
  return {
    importedStories: written.stories,
    importedLabels: written.labelsCreated,
    skipped,
    errors: [],
    warnings: [],
    unmatched: {},
    externalMembersCreated: attachedPeople(plan),
    dryRun: false,
  };
}
