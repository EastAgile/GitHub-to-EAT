/**
 * The central registry of importable GitHub source types.
 *
 * Single source of truth for the `--include` flag: which types exist, which
 * server request field switches each one on, and how each maps onto EAT
 * (rendered as the legend). Extend here first; the CLI derives everything
 * else from this table.
 */

import { customizedIssuesLegend, describeCustomization, ISSUES_LEGEND } from "./mapping.js";

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
    // Lives in mapping.js next to the functions that implement each line, so
    // the legend and the direct engine's mapper can't drift apart.
    legend: ISSUES_LEGEND,
  },
  prs: {
    requestField: "include_pull_requests",
    legend: [
      "open PR → story (started); merged PR → story (accepted, 'pull-request' label)",
      "closed-unmerged PR → story (rejected)",
      "a merged PR that closes an imported issue folds into that issue's story",
    ],
  },
  milestones: {
    requestField: "include_milestones",
    legend: ["milestone → epic (an issue keeps its milestone as the epic's label)"],
  },
  releases: {
    requestField: "include_releases",
    legend: ["release → release-type story (tag → title, notes → description, publish date kept)"],
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
    throw new Error(
      `--include must contain 'issues' (the other types only add to an issue import); ` +
        `e.g. issues | issues,prs | issues,${selected.join(",")}`,
    );
  }
  return selected;
}

/**
 * Render the GitHub → EAT mapping legend for a selection ("show the mirror").
 *
 * One block per selected type, straight from the registry, ending with the
 * append + dedup behaviour so users know a run never replaces or updates. The
 * header names the active engine only when it isn't the default `server`, so
 * the default output stays byte-identical.
 *
 * With a `--customize` {@link import("./mapping.js").Customization}, the issues
 * block reflects the choices (comments/checklist lines drop when off) and a
 * `Customized:` block names every non-default choice. An all-default (or null)
 * customization renders exactly the pre-customize legend, byte-for-byte.
 *
 * @param {string[]} selected types from {@link parseInclude}
 * @param {import("./engine.js").Engine} [engine] active import engine
 * @param {import("./mapping.js").Customization | null} [customization] per-run choices
 * @returns {string} multi-line legend text (no trailing newline)
 */
export function renderLegend(selected, engine = "server", customization = null) {
  const engineTag = engine === "server" ? "" : ` [engine: ${engine}]`;
  const lines = [`Import mapping (GitHub → East Agile Tracker)${engineTag}:`];
  for (const type of selected) {
    lines.push(`  ${type}:`);
    const rows =
      type === "issues" && customization
        ? customizedIssuesLegend(customization)
        : MAPPINGS[type].legend;
    for (const row of rows) {
      lines.push(`    - ${row}`);
    }
  }
  const customized = customization ? describeCustomization(customization) : [];
  if (customized.length) {
    lines.push("Customized:");
    for (const choice of customized) lines.push(`  - ${choice}`);
  }
  lines.push(
    "Imports append to the project; re-runs skip already-imported items; nothing is updated or deleted.",
  );
  return lines.join("\n");
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
