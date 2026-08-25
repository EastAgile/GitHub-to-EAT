/**
 * The direct engine's write stage. Epics first (their backing label must claim the name
 * before a same-named GitHub label), then labels (else colorless), then stories oldest-first.
 */

import { randomUUID } from "node:crypto";
import {
  AuthError,
  ConflictError,
  EATError,
  EATTimeout,
  NotFoundError,
  RateLimitError,
} from "./client.js";
import { DONE_STATES, epicTitleKey, STARTED_STATES, stripControls } from "./mapping.js";
import { runWithProgress } from "./progress.js";

/**
 * The subset of {@link import("./client.js").EATClient} the writer calls
 * (structural, so tests can pass a stub).
 *
 * @typedef {object} WriterClient
 * @property {(projectId: number, label: { name: string, background_color_hex?: string,
 *   text_color_hex?: string }, idempotencyKey: string) => Promise<any>} createLabel
 * @property {(projectId: number, story: Record<string, unknown>,
 *   idempotencyKey: string) => Promise<any>} createStory
 * @property {(projectId: number, storyId: number, task: { description: string,
 *   complete?: boolean }, idempotencyKey: string) => Promise<any>} createTask
 * @property {(projectId: number, storyId: number, text: string,
 *   idempotencyKey: string, options?: { createdAt?: string | null,
 *   author?: import("./mapping.js").ExternalPerson | null }) => Promise<any>} createComment
 * @property {(projectId: number, storyId: number,
 *   blocker: import("./mapping.js").BlockerOp,
 *   idempotencyKey: string) => Promise<any>} [createBlocker] absent on a stub that
 *   writes no blockers; a plan carrying one needs it
 * @property {(projectId: number) => Promise<any[]>} listEpics
 * @property {(projectId: number, epic: { name: string, description?: string | null },
 *   idempotencyKey: string) => Promise<any>} createEpic
 * @property {(projectId: number, storyId: number, link: { url: string,
 *   link_type?: string | null, title?: string | null },
 *   idempotencyKey: string) => Promise<any>} [createLink]
 */

/**
 * @typedef {{ labels: import("./mapping.js").LabelOp[],
 *   stories: import("./mapping.js").StoryOp[],
 *   epics?: import("./mapping.js").EpicOp[] }} WritePlan
 */

/** The plan carries blockers but this client cannot write them (`createBlocker` absent). */
export class BlockerWriteUnsupported extends EATError {}

/** Too many row writes were refused in a row — the cause is systemic, not one row's text. */
export class RowErrorCeiling extends EATError {}

/** How many consecutive contained refusals end the run; any successful write resets the count. */
export const ROW_ERROR_CEILING = 20;

/**
 * @typedef {object} WriteResult
 * @property {number} epicsCreated
 * @property {number} epicsExisting epics the project already had
 * @property {number} epicsBlocked epics the server would not create — a plain label
 *   holds the name, or it refused the create outright
 * @property {number} labelsCreated
 * @property {number} labelsExisting labels the project already had (409 conflict)
 * @property {number} stories
 * @property {number} tasks
 * @property {number} comments
 * @property {number} blockers
 * @property {number} links
 * @property {{ code: string, row: string, detail: string }[]} errors row-scoped
 *   refusals the run contained and skipped, in write order
 */

/**
 * One epic listing row's dedup key — the server matches on `LOWER(TRIM(epic_title))`.
 * `epic_title` is the field every server version publishes; `name` is its newer alias.
 *
 * @param {any} row
 * @returns {string}
 */
function epicKey(row) {
  const title = typeof row?.epic_title === "string" ? row.epic_title : row?.name;
  return typeof title === "string" ? epicTitleKey(title) : "";
}

/**
 * Which kind of row the server says holds the name, from the 409 body it already sent
 * (`Epic '<t>' …` / `Label '<t>' …`). null when the wording is not one this knows —
 * an older server, or a proxy's own body — and the listing has to arbitrate instead.
 *
 * @param {string | undefined} detail the conflict's `error` field
 * @returns {"epic" | "label" | null}
 */
function conflictHolder(detail) {
  if (typeof detail !== "string") return null;
  if (detail.startsWith("Epic '")) return "epic";
  return detail.startsWith("Label '") ? "label" : null;
}

/**
 * Timeouts, network failures, and 5xx are retried — the per-op Idempotency-Key
 * makes a retried write replay, not duplicate. Typed 4xx just repeat the failure.
 * A 5xx the ledger stored replays as that same 5xx; retries only rescue
 * failures that never reached the ledger (connection drop, timeout, crash).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryable(err) {
  if (err instanceof EATTimeout) return true;
  if (
    err instanceof AuthError ||
    err instanceof NotFoundError ||
    err instanceof ConflictError ||
    err instanceof RateLimitError
  ) {
    return false;
  }
  if (err instanceof EATError) return err.status === undefined || err.status >= 500;
  return false;
}

/**
 * The statuses that mean "the server refused THIS row's content": skipping the row and
 * reporting it beats losing the run. An allowlist, not a `4xx` band — a band absorbs
 * 402/407/423/431/451 and every future 4xx, none of which is one row's text.
 */
const ROW_SCOPED_STATUSES = new Set([400, 413, 422]);

/**
 * A row-scoped failure. Auth/404/409/429 stay fatal — they say the run itself is wrong
 * (bad key, wrong story, replayed key, no budget left), not one row's text.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isRowScoped(err) {
  if (
    err instanceof AuthError ||
    err instanceof NotFoundError ||
    err instanceof ConflictError ||
    err instanceof RateLimitError
  ) {
    return false;
  }
  return err instanceof EATError && ROW_SCOPED_STATUSES.has(/** @type {number} */ (err.status));
}

/**
 * The server's machine code when it sent one, so the report says `invalid_parameter`
 * rather than a status number the user cannot look up.
 *
 * @param {EATError} err
 * @returns {string}
 */
function rowErrorCode(err) {
  return err.code ?? `http_${err.status}`;
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} attempts
 * @param {number} delayMs base delay, doubled per attempt
 * @returns {Promise<T>}
 */
async function withRetry(fn, attempts, delayMs) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Execute the mapped plan. A `400`/`413`/`422` refusal of one row's content is contained:
 * the row is skipped and recorded in `errors`, and `ROW_ERROR_CEILING` consecutive
 * refusals still abort. Everything else fails the run once retries exhaust — auth,
 * `404`, `409` and `429` say the run itself is wrong, not one row's text. A partial run is
 * safe to redo — writes are idempotency-keyed and dedup skips already-imported stories.
 *
 * @param {WriterClient} client
 * @param {number} projectId
 * @param {WritePlan} plan
 * @param {{ runId?: string, stream?: import("./progress.js").OutStream,
 *   retryAttempts?: number, retryDelayMs?: number, sendProvenance?: boolean,
 *   sendDates?: boolean, sendStarted?: boolean, sendPeople?: boolean,
 *   sendLinks?: boolean }} [options]
 *   `runId` scopes the idempotency keys (fresh per run, stable across in-run
 *   retries); `sendProvenance` adds the re-import pair (EAT #31427) to every
 *   story create; `sendDates` adds backdated `created_at`/`completed_at` to the
 *   writes; `sendStarted` adds a backdated `started_at` (EAT #35489) to creates at or past
 *   `started`; `sendPeople` adds the imported GitHub requestor, owners and comment author
 *   (EAT #32773); `sendLinks` writes each story's `pull_request` links — all off keep
 *   the payloads and the call sequence byte-identical to v3
 * @returns {Promise<WriteResult>}
 */
export async function writePlan(client, projectId, plan, options = {}) {
  const {
    runId = randomUUID(),
    stream,
    retryAttempts = 3,
    retryDelayMs = 250,
    sendProvenance = false,
    sendDates = false,
    sendStarted = false,
    sendPeople = false,
    sendLinks = false,
  } = options;
  /** @template T @param {() => Promise<T>} fn */
  const retrying = (fn) => withRetry(fn, retryAttempts, retryDelayMs);

  // Checked before the first write: the same miss discovered mid-plan is a bare
  // TypeError, and an import never updates the stories it already created.
  if (
    typeof client.createBlocker !== "function" &&
    plan.stories.some((op) => (op.blockers ?? []).length > 0)
  ) {
    throw new BlockerWriteUnsupported(
      "this client cannot write blockers (no createBlocker), but the plan carries them",
    );
  }

  const result = {
    /** @type {{ code: string, row: string, detail: string }[]} */
    errors: [],
    epicsCreated: 0,
    epicsExisting: 0,
    epicsBlocked: 0,
    labelsCreated: 0,
    labelsExisting: 0,
    stories: 0,
    tasks: 0,
    comments: 0,
    blockers: 0,
    links: 0,
  };

  let consecutiveRowErrors = 0;

  /**
   * Record one contained refusal, then abort the run once they stop being isolated:
   * a refusal every write in a row is a systemic fault, and dedup makes each skip permanent.
   *
   * @param {EATError} err @param {string} row @param {string} what
   */
  const recordRowError = (err, row, what) => {
    result.errors.push({ code: rowErrorCode(err), row, detail: `${what}: ${err.message}` });
    consecutiveRowErrors += 1;
    if (consecutiveRowErrors >= ROW_ERROR_CEILING) {
      throw new RowErrorCeiling(
        `aborting after ${consecutiveRowErrors} consecutive refused writes ` +
          `(last — ${row}, ${what}: ${err.message}). The server is refusing everything, ` +
          "not one bad row; nothing further would be written correctly.",
      );
    }
  };

  /**
   * Run one row-scoped write. A refusal of this row's content is reported and
   * skipped so a single bad row cannot cost the whole run; anything else still throws.
   *
   * @param {string} row @param {string} what @param {() => Promise<unknown>} fn
   * @returns {Promise<boolean>} false when the row was skipped
   */
  const contained = async (row, what, fn) => {
    try {
      await fn();
      consecutiveRowErrors = 0;
      return true;
    } catch (err) {
      if (!isRowScoped(err)) throw err;
      recordRowError(/** @type {EATError} */ (err), row, what);
      return false;
    }
  };

  const epics = plan.epics ?? [];
  if (epics.length) {
    await runWithProgress(
      async () => {
        /** @param {number} id */
        const scan = async (id) =>
          new Set((await retrying(() => client.listEpics(id))).map(epicKey));
        // The public create does not get-or-create — it 409s — so the listing is the
        // get half, and the 409 below is the concurrent-writer safety net.
        let existing = await scan(projectId);
        for (const [i, epic] of epics.entries()) {
          const key = epicTitleKey(epic.title);
          if (existing.has(key)) {
            result.epicsExisting += 1;
            continue;
          }
          try {
            await retrying(() =>
              client.createEpic(
                projectId,
                { name: epic.title, description: epic.description },
                `${runId}:epic:${i}`,
              ),
            );
            result.epicsCreated += 1;
          } catch (err) {
            if (!(err instanceof ConflictError) || err.code !== "conflict") {
              if (!isRowScoped(err)) throw err;
              // Same shape as the label-holds-the-name 409 below: the epic row is lost,
              // the stories keep the label, and the run continues.
              result.epicsBlocked += 1;
              stream?.write(
                `warning: epic '${stripControls(epic.title)}' was not created — the server ` +
                  `refused it (${rowErrorCode(/** @type {EATError} */ (err))}); its stories ` +
                  "still carry the label, so they stay grouped, but no epic row was made.\n",
              );
              continue;
            }
            // Another run created it, or a plain label holds the name forever. The 409 body
            // says which; the re-read is the tiebreaker for wording it does not recognise.
            const holder = conflictHolder(err.detail);
            if (holder === "epic") {
              result.epicsExisting += 1;
              continue;
            }
            if (holder === null) {
              existing = await scan(projectId);
              if (existing.has(key)) {
                result.epicsExisting += 1;
                continue;
              }
            }
            result.epicsBlocked += 1;
            stream?.write(
              `warning: epic '${stripControls(epic.title)}' was not created — ${
                holder === "label"
                  ? "a label of that name already exists in this project"
                  : "the server refused the name as taken and no epic of that name is in the " +
                    "project, so a plain label most likely holds it"
              }; its stories still carry the label, so they stay grouped, but no epic row ` +
                "was made.\n",
            );
          }
        }
      },
      `creating ${epics.length} epics`,
      { stream },
    );
  }

  if (plan.labels.length) {
    await runWithProgress(
      async () => {
        // Keys carry no user content — header values must be Latin-1 (undici
        // rejects emoji/CJK), so ops are keyed by stable plan position.
        for (const [i, label] of plan.labels.entries()) {
          // A refused label costs only its colour: POST /stories get-or-creates the
          // name with default colours (CONTRACT.md), so the row keeps its label.
          await contained(label.name, "label create", async () => {
            try {
              await retrying(() => client.createLabel(projectId, label, `${runId}:label:${i}`));
              result.labelsCreated += 1;
            } catch (err) {
              if (err instanceof ConflictError && err.code === "conflict") {
                result.labelsExisting += 1;
                return;
              }
              throw err;
            }
          });
        }
      },
      `creating ${plan.labels.length} labels`,
      { stream },
    );
  }

  const ordered = [...plan.stories].sort((a, b) => {
    const ka = a.created_at ?? "";
    const kb = b.created_at ?? "";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  if (ordered.length) {
    await runWithProgress(
      async () => {
        for (const op of ordered) {
          // Built from one object so no path can emit half the pair (EAT #31427
          // owner-gates it and 400s a lone field).
          /** @type {Record<string, unknown>} */
          const body = {
            name: op.name,
            description: op.description,
            story_type: op.story_type,
            current_state: op.current_state,
            labels: op.labels,
            ...(sendProvenance
              ? { import_source: "github", import_external_id: op.external_id }
              : {}),
          };
          if (sendDates) {
            body.created_at = op.created_at;
            // Needs a created_at to clamp against: started_at clamps forward to it, so a
            // marker on a `now()`-stamped story collapses to the import instant, saying nothing.
            if (
              sendStarted &&
              op.created_at != null &&
              op.started_at != null &&
              STARTED_STATES.has(op.current_state)
            ) {
              body.started_at = op.started_at;
            }
            // completed_at is valid only on a done-state create, and `rejected` is
            // off that axis (no state_rank), so a closed-unmerged PR sends none.
            if (op.completed_at != null && DONE_STATES.has(op.current_state)) {
              body.completed_at = op.completed_at;
            }
          }
          if (sendPeople) {
            // Omitted rather than null for a ghost: the server then falls back to
            // the calling agent, which is exactly the server importer's behaviour.
            if (op.requestor) body.requestor = op.requestor;
            if (op.owners?.length) body.owners = op.owners.map((p) => ({ external: p }));
          }
          /** @type {any} */
          let created;
          try {
            created = await retrying(() =>
              client.createStory(projectId, body, `${runId}:story:${op.external_id}`),
            );
          } catch (err) {
            if (!isRowScoped(err)) throw err;
            recordRowError(/** @type {EATError} */ (err), op.external_id, "story create");
            // Its tasks/blockers/comments would target a story that does not exist.
            continue;
          }
          result.stories += 1;
          consecutiveRowErrors = 0;
          for (const [i, task] of op.tasks.entries()) {
            const ok = await contained(op.external_id, `task ${i + 1}`, () =>
              retrying(() =>
                client.createTask(
                  projectId,
                  created.story_id,
                  task,
                  `${runId}:task:${op.external_id}:${i}`,
                ),
              ),
            );
            if (ok) result.tasks += 1;
          }
          // Written sequentially, in GitHub's own `blocked_by` order: the public
          // route sets no display order, so insertion order is all the CLI controls.
          for (const [i, blocker] of (op.blockers ?? []).entries()) {
            const ok = await contained(op.external_id, `blocker ${i + 1}`, () =>
              retrying(() =>
                // Non-null: the guard at the top refused this whole plan if the
                // method were missing, before a single write.
                /** @type {NonNullable<WriterClient["createBlocker"]>} */ (client.createBlocker)(
                  projectId,
                  created.story_id,
                  blocker,
                  `${runId}:blocker:${op.external_id}:${i}`,
                ),
              ),
            );
            if (ok) result.blockers += 1;
          }
          for (const [i, comment] of op.comments.entries()) {
            const extras = {
              ...(sendDates ? { createdAt: comment.created_at } : {}),
              ...(sendPeople && comment.author ? { author: comment.author } : {}),
            };
            const ok = await contained(op.external_id, `comment ${i + 1}`, () =>
              retrying(() =>
                client.createComment(
                  projectId,
                  created.story_id,
                  comment.text,
                  `${runId}:comment:${op.external_id}:${i}`,
                  // undefined, not {}, when neither rides: the v3 call shape is unchanged.
                  Object.keys(extras).length ? extras : undefined,
                ),
              ),
            );
            if (ok) result.comments += 1;
          }
          for (const [i, link] of (sendLinks ? (op.links ?? []) : []).entries()) {
            const ok = await contained(op.external_id, `link ${i + 1}`, () =>
              retrying(() =>
                /** @type {NonNullable<WriterClient["createLink"]>} */ (client.createLink)(
                  projectId,
                  created.story_id,
                  link,
                  `${runId}:link:${op.external_id}:${i}`,
                ),
              ),
            );
            if (ok) result.links += 1;
          }
        }
      },
      `creating ${ordered.length} stories`,
      { stream },
    );
  }

  return result;
}
