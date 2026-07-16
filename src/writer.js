/**
 * The direct engine's write stage. Labels go first (the story payload's own
 * get-or-create would create them colorless), then stories oldest-first to keep board order.
 */

import { randomUUID } from "node:crypto";
import { AuthError, ConflictError, EATError, EATTimeout, NotFoundError } from "./client.js";
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
 *   idempotencyKey: string) => Promise<any>} createComment
 */

/**
 * @typedef {{ labels: import("./mapping.js").LabelOp[],
 *   stories: import("./mapping.js").StoryOp[] }} WritePlan
 */

/**
 * @typedef {object} WriteResult
 * @property {number} labelsCreated
 * @property {number} labelsExisting labels the project already had (409 conflict)
 * @property {number} stories
 * @property {number} tasks
 * @property {number} comments
 */

/**
 * Timeouts, network failures, and 5xx are retried — the per-op Idempotency-Key
 * makes a retried write replay, not duplicate. Typed 4xx just repeat the failure.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryable(err) {
  if (err instanceof EATTimeout) return true;
  if (err instanceof AuthError || err instanceof NotFoundError || err instanceof ConflictError) {
    return false;
  }
  if (err instanceof EATError) return err.status === undefined || err.status >= 500;
  return false;
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
 * Execute the mapped plan; fails fast once retries exhaust. A partial run is
 * safe to redo — writes are idempotency-keyed and dedup skips already-imported stories.
 *
 * @param {WriterClient} client
 * @param {number} projectId
 * @param {WritePlan} plan
 * @param {{ runId?: string, stream?: import("./progress.js").OutStream,
 *   retryAttempts?: number, retryDelayMs?: number }} [options] `runId` scopes
 *   the idempotency keys (fresh per run, stable across in-run retries)
 * @returns {Promise<WriteResult>}
 */
export async function writePlan(client, projectId, plan, options = {}) {
  const { runId = randomUUID(), stream, retryAttempts = 3, retryDelayMs = 250 } = options;
  /** @template T @param {() => Promise<T>} fn */
  const retrying = (fn) => withRetry(fn, retryAttempts, retryDelayMs);

  const result = { labelsCreated: 0, labelsExisting: 0, stories: 0, tasks: 0, comments: 0 };

  if (plan.labels.length) {
    await runWithProgress(
      async () => {
        for (const label of plan.labels) {
          try {
            await retrying(() =>
              client.createLabel(projectId, label, `${runId}:label:${label.name.toLowerCase()}`),
            );
            result.labelsCreated += 1;
          } catch (err) {
            if (err instanceof ConflictError && err.code === "conflict") {
              result.labelsExisting += 1;
            } else {
              throw err;
            }
          }
        }
      },
      `creating ${plan.labels.length} labels`,
      { stream },
    );
  }

  const ordered = [...plan.stories].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? ""),
  );
  if (ordered.length) {
    await runWithProgress(
      async () => {
        for (const op of ordered) {
          const created = await retrying(() =>
            client.createStory(
              projectId,
              {
                name: op.name,
                description: op.description,
                story_type: op.story_type,
                current_state: op.current_state,
                labels: op.labels,
              },
              `${runId}:story:${op.external_id}`,
            ),
          );
          result.stories += 1;
          for (const [i, task] of op.tasks.entries()) {
            await retrying(() =>
              client.createTask(
                projectId,
                created.story_id,
                task,
                `${runId}:task:${op.external_id}:${i}`,
              ),
            );
            result.tasks += 1;
          }
          for (const [i, comment] of op.comments.entries()) {
            await retrying(() =>
              client.createComment(
                projectId,
                created.story_id,
                comment.text,
                `${runId}:comment:${op.external_id}:${i}`,
              ),
            );
            result.comments += 1;
          }
        }
      },
      `creating ${ordered.length} stories`,
      { stream },
    );
  }

  return result;
}
