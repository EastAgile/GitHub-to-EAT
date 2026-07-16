/**
 * Import engines: the default server-side importer and the new client-side
 * "direct" pipeline.
 *
 * The server engine posts one call to `POST /import/json` and lets EAT do the
 * fetch/map/write. The direct engine runs that pipeline client-side (fetch from
 * GitHub, map to EAT shapes, write via the API). This module owns the `--engine`
 * flag's valid values and the direct engine's V3 scope limit; the pipeline
 * itself lives in `direct.js`.
 */

/** @typedef {"server" | "direct"} Engine */

/** @type {Engine[]} */
export const ENGINES = ["server", "direct"];

/** @type {Engine} */
export const DEFAULT_ENGINE = "server";

/**
 * Import types the direct engine supports today. V3 is issues-only; PRs,
 * milestones, and releases land in V4.
 */
export const DIRECT_SUPPORTED_INCLUDES = ["issues"];

/**
 * Validate an `--engine` value against {@link ENGINES}.
 *
 * @param {string} value
 * @returns {Engine}
 */
export function parseEngine(value) {
  if (!ENGINES.includes(/** @type {Engine} */ (value))) {
    throw new Error(`unknown engine '${value}'; valid engines: ${ENGINES.join(", ")}`);
  }
  return /** @type {Engine} */ (value);
}

/**
 * Reject an `--include` selection the direct engine can't do yet.
 *
 * The server engine handles every type; the direct engine is issues-only until
 * V4. Throws an `Error` naming the unsupported types.
 *
 * @param {string[]} included types from {@link import("./mappings.js").parseInclude}
 */
export function assertDirectSupportsIncludes(included) {
  const unsupported = included.filter((type) => !DIRECT_SUPPORTED_INCLUDES.includes(type));
  if (unsupported.length) {
    throw new Error(
      `--engine direct imports issues only (V3); ` +
        `${unsupported.join(", ")} not supported by the direct engine yet`,
    );
  }
}
