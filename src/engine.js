/**
 * Import engines: the default server-side importer and the new client-side
 * "direct" pipeline.
 *
 * The server engine posts one call to `POST /import/json` and lets EAT do the
 * fetch/map/write. The direct engine runs that pipeline client-side (fetch from
 * GitHub, map to EAT shapes, write via the API). This module owns the `--engine`
 * flag's valid values; the pipeline itself lives in `direct.js`, and every
 * `--include` type the registry offers now runs on both engines.
 */

/** @typedef {"server" | "direct"} Engine */

/** @type {Engine[]} */
export const ENGINES = ["server", "direct"];

/** @type {Engine} */
export const DEFAULT_ENGINE = "server";

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
