/**
 * Two-engine parity harness against a real East Agile Tracker (story #32775).
 *
 * Imports one fixture repo twice — `--engine server` into one project,
 * `--engine direct` into another — then reads both projects back through the
 * API and asserts field equivalence, keyed by GitHub issue number. The rules
 * live in `parity-compare.js`, which the default suite unit-tests; this file is
 * the live run.
 *
 * Opt-in and skipped by default, like `e2e.test.js`. Configure via environment:
 *
 *     EAT_AGENT_KEY                owner-role agent key for both projects
 *     EAT_PARITY_SERVER_PROJECT    id of a disposable, EMPTY project for --engine server
 *     EAT_PARITY_DIRECT_PROJECT    id of a second disposable, EMPTY project for --engine direct
 *     EAT_PARITY_REPO              public GitHub repo as OWNER/NAME
 *     EAT_PARITY_INCLUDE           (optional) --include types; default `issues`
 *     EAT_API_BASE                 (optional) override the API base URL
 *     GITHUB_TOKEN                 (optional) read by the CLI itself; a local stack with no
 *                                  platform PAT needs it for the server engine
 *
 * Both projects must start empty: the run keys rows by provenance and compares
 * whole projects, and a re-run against a used project would dedup to nothing.
 *
 * Run just this test with:  node --test tests/parity.e2e.test.js
 *
 * NOT COMPARED — `completed_at`. No read path exposes it to an agent key: it is
 * absent from the story list row and the story detail payload, and it is not in
 * the `fields=` allowlist (`handlers/stories.rs` STORY_FIELDS). The only carrier
 * is the project export, which rejects agent keys (`AuthUser` resolves members
 * and user keys only). Closing this needs a server ask; until then the harness
 * reports the field as uncompared instead of passing over it silently, and pins
 * the readable neighbours — `current_state`, `created`, `started`, `rejected_at`.
 *
 * Iteration placement is likewise out of scope: the two engines diverge there by
 * the `MAX_BACKFILL_PAST_WINDOWS = 199` cap (server ask #36735), which is a
 * placement difference, not a field difference.
 *
 * Labels are compared as each story carries them — name, both colours, and the
 * attachment itself — not as a project-level label inventory.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { main } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { capture } from "./helpers.js";
import { compareProjects, formatReport } from "./parity-compare.js";

const REQUIRED = [
  "EAT_AGENT_KEY",
  "EAT_PARITY_SERVER_PROJECT",
  "EAT_PARITY_DIRECT_PROJECT",
  "EAT_PARITY_REPO",
];
const missing = REQUIRED.filter((name) => !process.env[name]);

/** Both engines' back-link footers, which carry the source id on rows with no provenance. */
const BACK_LINK =
  /(?:\[View original issue]\(|Imported from )https?:\/\/(?:api\.)?github\.com\/(?:repos\/)?[^/\s]+\/[^/\s]+\/(issues|pull|releases)\/(\d+)\)?$/i;

/**
 * The row's cross-engine key: the provenance id both importers write, else the
 * back-link footer's id for a server too old to persist provenance.
 *
 * @param {any} row
 * @returns {string}
 */
function keyOf(row) {
  if (row.import_external_id != null) return String(row.import_external_id);
  const last = String(row.description ?? "")
    .trimEnd()
    .split("\n")
    .pop()
    ?.trim();
  const match = BACK_LINK.exec(last ?? "");
  if (!match) return `unkeyed-story-${row.story_id}`;
  return match[1].toLowerCase() === "releases" ? `release-${match[2]}` : match[2];
}

/**
 * Run `fn` over `items` with at most `width` in flight — the comment read is one
 * request per story, and sequential round-trips dominate the run otherwise.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} width
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function pooled(items, width, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

test("the direct engine imports the same repo as the server engine", {
  skip: missing.length ? `parity e2e not configured (missing ${missing.join(", ")})` : false,
}, async () => {
  const config = loadConfig();
  const repo = process.env.EAT_PARITY_REPO ?? "";
  const include = process.env.EAT_PARITY_INCLUDE ?? "issues";
  const projects = {
    server: process.env.EAT_PARITY_SERVER_PROJECT ?? "",
    direct: process.env.EAT_PARITY_DIRECT_PROJECT ?? "",
  };
  assert.notEqual(projects.server, projects.direct, "the two engines need separate projects");

  /**
   * @param {string} path
   * @returns {Promise<any>}
   */
  const get = async (path) => {
    const response = await fetch(`${config.apiBase}${path}`, {
      headers: { "X-TrackerToken": config.agentKey, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`GET ${path} → ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    return response.json();
  };

  /**
   * Cursor-walk every story in a project. `include_done` is not optional:
   * without it the list hides rows frozen on a past iteration, which is most
   * of a backdated import — and hides a different share of each engine's, so
   * the row sets would differ for a reason that is not a parity defect.
   *
   * @param {string} projectId
   * @param {string} [fields]
   * @returns {Promise<any[]>}
   */
  const walk = async (projectId, fields = "") => {
    const base =
      `/projects/${projectId}/stories?include_done=true&include_archived=true&limit=200` +
      (fields ? `&fields=${fields}` : "");
    /** @type {any[]} */
    const rows = [];
    /** @type {string | undefined} */
    let cursor;
    do {
      const page = await get(base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
      rows.push(...(page.items ?? []));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return rows;
  };

  /**
   * @param {string} projectId
   * @returns {Promise<import("./parity-compare.js").ParityRow[]>}
   */
  const readProject = async (projectId) => {
    const rows = await walk(projectId);
    // `tasks` embeds only when named in `fields=`, and `fields=` cannot carry
    // `requestor` — so the full row and the task arrays are two walks.
    const withTasks = await walk(projectId, "story_id,tasks");
    const tasksById = new Map(withTasks.map((r) => [r.story_id, r.tasks ?? []]));
    const comments = await pooled(rows, 8, async (row) =>
      row.comment_count > 0
        ? await get(`/projects/${projectId}/stories/${row.story_id}/comments`)
        : [],
    );
    return rows.map((row, i) => ({
      key: keyOf(row),
      story_type: row.story_type,
      current_state: row.current_state,
      icebox: row.icebox,
      created: row.created,
      started: row.started,
      rejected_at: row.rejected_at,
      description: row.description ?? "",
      import_source: row.import_source,
      import_external_id: row.import_external_id,
      tasks: (tasksById.get(row.story_id) ?? []).map((/** @type {any} */ t) => ({
        description: t.task_desc,
        complete: t.complete,
      })),
      comments: (comments[i] ?? []).map((/** @type {any} */ c) => ({
        text: c.comment_text,
        created: c.created,
        author: c.author,
      })),
      labels: (row.labels ?? []).map((/** @type {any} */ l) => ({
        name: l.label_name ?? l.name,
        background_color_hex: l.background_color_hex ?? null,
        text_color_hex: l.text_color_hex ?? null,
      })),
      requestor: row.requestor,
      owners: row.owners ?? [],
    }));
  };

  for (const [engine, projectId] of Object.entries(projects)) {
    const existing = await get(`/projects/${projectId}/stories?limit=1&include_done=true`);
    assert.equal(
      (existing.items ?? []).length,
      0,
      `project ${projectId} (${engine}) already has stories — this harness needs two empty ` +
        "projects, since a second import into a used project dedups to nothing",
    );
  }

  for (const [engine, projectId] of Object.entries(projects)) {
    const out = capture();
    const started = performance.now();
    const code = await main(
      ["--project", projectId, "--repo", repo, "--include", include, "--engine", engine, "-y"],
      { stdout: out, stderr: capture() },
    );
    const elapsed = (performance.now() - started) / 1000;
    console.log(`[parity] ${engine} import of ${repo} took ${elapsed.toFixed(1)}s`);
    assert.equal(code, 0, `${engine} import failed:\n${out.buf}`);
  }

  const [server, direct] = [await readProject(projects.server), await readProject(projects.direct)];
  const result = compareProjects(server, direct, {
    unavailable: {
      completed_at:
        "no agent-key read path — absent from the story list row, the detail payload and the " +
        "fields= allowlist; the project export carries it but rejects agent keys",
    },
  });
  const report = formatReport(result);
  console.log(report);

  const unkeyed = [...server, ...direct].filter((r) => r.key.startsWith("unkeyed-"));
  assert.equal(unkeyed.length, 0, `rows with neither provenance nor a back-link:\n${report}`);
  assert.equal(result.mismatches.length, 0, report);
  assert.equal(result.counts.server, result.counts.direct, report);
});
