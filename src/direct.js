/**
 * The "direct" import engine: run the import pipeline client-side instead of
 * delegating to the EAT server.
 *
 * V3 introduces the `--engine` dispatch and this seam; the pipeline stages —
 * fetch from GitHub, map issues to EAT story shapes, write via the API — are
 * filled in by the following V3 stories. Until then `runDirect` reports that it
 * is not built rather than silently importing nothing.
 */

/** Raised by the direct engine (kept distinct from the EAT HTTP errors). */
export class DirectEngineError extends Error {}

/**
 * Run the client-side import pipeline and return the same
 * {@link import("./importer.js").ImportOutcome} shape the server engine yields.
 *
 * @param {import("./client.js").EATClient} _client
 * @param {number} _projectId
 * @param {string} _owner
 * @param {string} _repo
 * @param {{ token?: string, included: string[], dryRun?: boolean }} _options
 * @returns {Promise<import("./importer.js").ImportOutcome>}
 */
export async function runDirect(_client, _projectId, _owner, _repo, _options) {
  throw new DirectEngineError(
    "the direct engine is not implemented yet — run with --engine server (the default) for now",
  );
}
