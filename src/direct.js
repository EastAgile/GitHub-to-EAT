/**
 * The "direct" import engine: fetch → map → prescan → write, run client-side
 * instead of on the EAT server. `--dry-run` runs the same pipeline but stops
 * before the write — no server dry-run support needed, unlike the server engine.
 */

import { applyDedup, prescanImported } from "./dedup.js";
import { GitHubClient } from "./github.js";
import { mapRepo } from "./mapping.js";
import { runWithProgress } from "./progress.js";
import { writePlan } from "./writer.js";

/**
 * The client surface the pipeline needs — the writer's methods plus the
 * prescan page reader (structural, so tests can pass stubs).
 *
 * @typedef {import("./writer.js").WriterClient
 *   & import("./dedup.js").PrescanClient} DirectClient
 */

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
 *   github?: { fetchAll(): Promise<{ issues: any[], comments: any[],
 *     labels: any[] }> } }} options `github` is a test seam; production
 *   builds a {@link GitHubClient}
 * @returns {Promise<import("./importer.js").ImportOutcome>}
 */
export async function runDirect(client, projectId, owner, repo, options) {
  const { token, dryRun, stream, runId, github } = options;
  const source = github ?? new GitHubClient(owner, repo, { token });
  const fetched = await runWithProgress(
    () => source.fetchAll(),
    `fetching ${owner}/${repo} from GitHub`,
    { stream },
  );
  const mapped = mapRepo(fetched);

  const imported = await runWithProgress(
    () => prescanImported(client, projectId, owner, repo),
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
      dryRun: true,
    };
  }

  const written = await writePlan(client, projectId, plan, { stream, runId });
  return {
    importedStories: written.stories,
    importedLabels: written.labelsCreated,
    skipped,
    errors: [],
    unmatched: {},
    dryRun: false,
  };
}
