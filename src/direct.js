/**
 * The "direct" import engine: run the import pipeline client-side instead of
 * delegating to the EAT server — fetch from GitHub, map issues to EAT shapes,
 * prescan for markers, write the survivors. Local dry-run is the one stage
 * still pending (next story); until it lands `--dry-run` rejects loudly.
 */

import { applyDedup, prescanImported } from "./dedup.js";
import { GitHubClient } from "./github.js";
import { mapRepo } from "./mapping.js";
import { runWithProgress } from "./progress.js";
import { writePlan } from "./writer.js";

/** Raised by the direct engine (kept distinct from the EAT HTTP errors). */
export class DirectEngineError extends Error {}

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
  if (dryRun) {
    throw new DirectEngineError(
      "the direct engine's local dry-run is not built yet — drop --dry-run or use --engine server",
    );
  }

  const source = github ?? new GitHubClient(owner, repo, { token });
  const fetched = await runWithProgress(
    () => source.fetchAll(),
    `fetching ${owner}/${repo} from GitHub`,
    { stream },
  );
  const mapped = mapRepo(fetched);

  const importedIds = await runWithProgress(
    () => prescanImported(client, projectId, owner, repo),
    `scanning project ${projectId} for already-imported stories`,
    { stream },
  );
  const { plan, skipped } = applyDedup(mapped, importedIds, owner, repo);

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
