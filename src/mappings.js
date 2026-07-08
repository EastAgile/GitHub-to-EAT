/**
 * The central registry of importable GitHub source types.
 *
 * Single source of truth for the `--include` flag: which types exist, which
 * server request field switches each one on, and how each maps onto EAT
 * (rendered as the legend). Extend here first; the CLI derives everything
 * else from this table.
 */

/**
 * @typedef {object} Mapping
 * @property {string | null} requestField server import-request boolean that
 *   enables the type, or null when the type is always imported
 * @property {string[]} legend human-readable GitHub -> EAT mapping lines
 */

/** @type {Record<string, Mapping>} */
export const MAPPINGS = {
  issues: {
    requestField: null,
    legend: [
      "open issue → story (unstarted); closed issue → story (accepted, keeps the closed date)",
      "labels → labels (with colors); issue-body checklists → story tasks",
      "comments → comments (body only)",
    ],
  },
  prs: {
    requestField: "include_pull_requests",
    legend: [
      "open PR → story (started); merged PR → story (accepted, 'pull-request' label)",
      "closed-unmerged PR → story (rejected)",
      "a merged PR that closes an imported issue folds into that issue's story",
    ],
  },
};

/**
 * Parse and validate a `--include` value against the registry.
 *
 * Returns the selected type names (deduplicated, registry order). Throws an
 * `Error` with a usage-style message on unknown types or a selection that
 * omits `issues` — the server always imports issues; the other types only
 * add to them.
 *
 * @param {string} value comma-separated type list, e.g. "issues,prs"
 * @returns {string[]}
 */
export function parseInclude(value) {
  const known = Object.keys(MAPPINGS);
  const requested = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!requested.length) {
    throw new Error(`--include needs at least one type; valid types: ${known.join(", ")}`);
  }
  for (const type of requested) {
    if (!known.includes(type)) {
      throw new Error(`unknown import type '${type}'; valid types: ${known.join(", ")}`);
    }
  }
  const selected = known.filter((type) => requested.includes(type));
  if (!selected.includes("issues")) {
    const allowed = known.map((t, i) => known.slice(0, i + 1).join(",")).join(" | ");
    throw new Error(
      `--include must contain 'issues' (the other types only add to an issue import); ` +
        `allowed: ${allowed}`,
    );
  }
  return selected;
}

/**
 * Map a selection from {@link parseInclude} to the server request fields.
 *
 * @param {string[]} selected
 * @returns {Record<string, boolean>} e.g. { include_pull_requests: true }
 */
export function requestFlags(selected) {
  /** @type {Record<string, boolean>} */
  const flags = {};
  for (const type of selected) {
    const field = MAPPINGS[type].requestField;
    if (field) flags[field] = true;
  }
  return flags;
}
