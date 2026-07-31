/**
 * The "direct" import engine: fetch → map → prescan → write, all client-side. `--dry-run`
 * runs the same pipeline but stops before the write — no server dry-run support needed.
 */

import {
  applyDedup,
  markerFor,
  prescanImported,
  prescanProvenance,
  unionImported,
} from "./dedup.js";
import { GitHubClient } from "./github.js";
import {
  clampPlan,
  DEFAULT_CUSTOMIZATION,
  describeFilters,
  FALLBACK_LIMITS,
  hasMilestoneFilter,
  ISSUE_TYPE_NAMES,
  mapRepo,
  matchesMilestones,
  matchesStates,
  storyTypeFromIssueType,
  stripControls,
} from "./mapping.js";
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
 *       supportsBackdating?: () => Promise<boolean> }} DirectClient
 */

/**
 * Warn when a run's filters leave nothing to import — a `--milestones` typo, or
 * a milestone the `--states` filter already excluded, would otherwise import
 * zero stories with no explanation. Unmatched titles are named on their own
 * because the run may still import the other ones.
 *
 * @param {{ issues: any[] }} fetched
 * @param {import("./mapping.js").Customization} customization
 * @param {import("./progress.js").OutStream} [stream]
 */
function warnFiltersMatchNothing({ issues }, customization, stream) {
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
    stream?.write(
      `warning: no fetched issue matches this run's filters (${filters.join("; ")}) — ` +
        "nothing to import.\n",
    );
  }
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
 * Run the client-side import pipeline and return the same
 * {@link import("./importer.js").ImportOutcome} shape the server engine yields.
 *
 * @param {DirectClient} client
 * @param {number} projectId
 * @param {string} owner
 * @param {string} repo
 * @param {{ token?: string, included: string[], dryRun?: boolean,
 *   stream?: import("./progress.js").OutStream, runId?: string,
 *   customization?: import("./mapping.js").Customization,
 *   customize?: (fetched: { issues: any[], comments: any[], labels: any[] })
 *     => Promise<import("./mapping.js").Customization>,
 *   announce?: (fetched: { issues: any[], comments: any[], labels: any[] },
 *     customization: import("./mapping.js").Customization) => Promise<void>,
 *   github?: { fetchAll(): Promise<{ issues: any[], comments: any[], labels: any[],
 *     subIssues?: Map<string, string[]> }> } }} options `customize` (the wizard) runs at the
 *   fetch→map seam so its questions use real data; `announce` (the customized
 *   legend + confirm) runs right after, and may throw to abort before any
 *   write; `github` is a test seam
 * @returns {Promise<import("./importer.js").ImportOutcome>}
 */
export async function runDirect(client, projectId, owner, repo, options) {
  const { token, dryRun, stream, runId, github, customize, announce } = options;
  // Buffered, not written straight through: the fetch runs under a TTY spinner that
  // holds an open `\r` line, which would otherwise swallow the first warning.
  /** @type {string[]} */
  const fetchWarnings = [];
  const source =
    github ?? new GitHubClient(owner, repo, { token, warn: (m) => fetchWarnings.push(m) });
  const fetched = await runWithProgress(
    () => source.fetchAll(),
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
  // The customized legend + confirm reflect those answers, so they land here —
  // a declined confirm throws, aborting before any prescan or write.
  if (announce) await announce(fetched, customization);
  // Clamp before the marker lands so the description budget can reserve room
  // for it — one giant GitHub comment must not 400 the whole run.
  const limits = { ...FALLBACK_LIMITS, ...(await (client.fieldLimits?.() ?? {})) };
  // One probe gates all three backdated fields; degrades to false, so an older
  // server gets v3-identical payloads and the full-date comment prefix.
  const sendDates = await (client.supportsBackdating?.() ?? false);
  const mapped = clampPlan(mapRepo(fetched, customization, sendDates), limits, {
    reserveDescription: (op) =>
      Buffer.byteLength(markerFor(owner, repo, op.external_id), "utf8") + 2,
    warn: (message) => stream?.write(message),
  });

  // One probe gates writing the pair and reading it back via the list filters.
  const sendProvenance = await (client.supportsProvenanceDedup?.() ?? false);

  const imported = await runWithProgress(
    async () => {
      if (!sendProvenance) return prescanImported(client, projectId, owner, repo);
      // Union, not replace: legacy marker-only rows carry no pair, pair-only
      // rows (server-written, or newer direct runs) carry no marker. The two
      // reads are independent, so run them concurrently.
      const [marker, provenance] = await Promise.all([
        prescanImported(client, projectId, owner, repo),
        prescanProvenance(client, projectId),
      ]);
      return unionImported(marker, provenance);
    },
    `scanning project ${projectId} for already-imported stories`,
    { stream },
  );
  const { plan, skipped } = applyDedup(mapped, imported, owner, repo);

  // The marker lands at story-create, before tasks/comments — a run that died
  // in that window left a skipped-but-incomplete story. Surface it, loudly.
  for (const op of mapped.stories) {
    const row = imported.get(op.external_id);
    if (!row) continue;
    const tasksCount = Number(row.tasks_count ?? 0);
    const commentCount = Number(row.comment_count ?? 0);
    if (tasksCount < op.tasks.length || commentCount < op.comments.length) {
      stream?.write(
        `warning: issue #${op.external_id} has fewer tasks/comments in EAT than on GitHub ` +
          `(tasks ${tasksCount}/${op.tasks.length}, comments ${commentCount}/${op.comments.length}) — ` +
          "an earlier run may have been interrupted, or the issue changed since import; " +
          "it stays skipped — delete that story in EAT and re-run to repair.\n",
      );
    }
  }

  if (dryRun) {
    return {
      importedStories: plan.stories.length,
      importedLabels: plan.labels.length,
      skipped,
      errors: [],
      unmatched: {},
      externalMembersCreated: [],
      dryRun: true,
    };
  }

  const written = await writePlan(client, projectId, plan, {
    stream,
    runId,
    sendProvenance,
    sendDates,
  });
  return {
    importedStories: written.stories,
    importedLabels: written.labelsCreated,
    skipped,
    errors: [],
    unmatched: {},
    externalMembersCreated: [],
    dryRun: false,
  };
}
