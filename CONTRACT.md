# GitHub-to-EAT — Behaviour Contract

This document defines the behaviour the CLI is built against. It is the source of
truth for what the tool does and what it depends on from the East Agile Tracker
(EAT) server.

## v1

### User flow

1. User creates a project in the EAT SPA.
2. In **Project Settings → API keys**, the user mints an **owner-role agent key**
   and puts it in `.env` as `EAT_AGENT_KEY`.
3. User runs the CLI against a **public** GitHub repo:
   `github-to-eat --project <id> --repo <owner>/<name>`

### What the CLI does

1. **Preflight** (read-only, fails fast before any writes):
   - `GET /meta` — confirm the API is reachable and the key is valid.
   - Fetch the target project — confirm it exists and the key can access it.
   - Warn if the project is **non-empty** (import appends; it does not replace).
2. **Import** — a single call:
   - `POST /projects/{id}/import/json` with body
     `{ "source": "github", "owner": "...", "repo": "..." }`.
   - **Type selection** — `--include` adds optional boolean fields:
     `include_pull_requests`, `include_milestones`, `include_releases`
     (issues are always imported; the flags only add types).
   - **Dry run** — `--dry-run` sends `dry_run: true`: the server fetches
     GitHub and runs dedup but writes nothing, returning the would-import /
     would-skip plan (response echoes `dry_run: true`). The CLI only sends
     the field after confirming support via the server's published
     `GET /openapi.json` (older servers would ignore it and import for
     real); without support it falls back to a local preview.
   - **No token field** (public repos) — the EAT server fetches GitHub using a
     platform PAT (`GITHUB_IMPORT_PAT`), so users never supply a GitHub token.
     When neither a request token nor a platform PAT exists, the server
     responds `400 import_github_no_token`; a bad token is
     `400 import_github_auth`.
   - **Private repos / no platform PAT** — the CLI may include an optional
     `"token"` (a GitHub PAT) via `--token` / `GITHUB_TOKEN`; the server uses it
     instead of the platform PAT.
   - Sent with an `Idempotency-Key`, which the server now processes on every
     `POST` — import included (openapi 2026-07-14, verified 2026-07-16;
     supersedes the 2026-07-06 note that it was advisory): same key + same
     body replays the stored response; same key + different body is a
     `409 idempotency_conflict` carrying both body hashes. Retried runs with
     fresh keys are still safe because of re-import dedup (below).
   - **Re-import dedup** — imported rows persist their provenance
     (`story.import_source` + `story.import_external_id`); a re-run skips
     rows whose `(project, source, external_id)` already exist and counts
     them in `skipped` — it never duplicates or updates.
3. **Report** — render the import result (see *Response shapes* below) and a link
   to the board.

### Server-side dependencies (EAT [V1] use cases)

The tool assumes the EAT server provides:

- **Owner-role agent keys** — projects can mint agent keys with the owner role.
- **Agent-callable import** — the import endpoint accepts an agent-key caller
  (still owner-gated).
- **Optional token for GitHub import** — when the request omits a token, the
  server falls back to the platform PAT.
- **Re-import dedup** — re-running import skips issues already imported
  (by source + external id) rather than duplicating them.

### Response shapes

The API base is `.../api/v1`. Shapes the CLI parses:

- **Import success** (`POST .../import/json`, HTTP 200 — synchronous; schema
  pinned in the server's `GET .../openapi.json`):
  ```json
  {
    "dry_run": false,
    "imported": { "stories": 39, "labels": 0 },
    "skipped": 0,
    "errors": ["Row 3: ..."],
    "unmatched": { "owners": [], "followers": [], "reviewers": [],
                   "requesters": [],
                   "comment_authors": [{ "email": "x@users.noreply.github.com", "count": 2 }] }
  }
  ```
  `imported` is an **object**, not an integer; it counts stories and labels
  only (epics created from milestones are not counted). `skipped` means
  "already imported" (see re-import dedup above). `errors` is a list of
  strings. `dry_run` echoes the request's `dry_run` field.
- **Project** (`GET .../projects/{id}`): the name field is `project_title` (not
  `title`/`name`); also `project_id`, `project_desc`, etc.
- **Stories** (`GET .../projects/{id}/stories`): with `?limit=` (or `?cursor=`) it
  returns a cursor page `{ "items": [...], "next_cursor": <str|null> }`; with no
  query it returns a bare JSON array.

These shapes are mirrored by the bundled mock server (`src/mockserver.js`).

## v2 (reserved — not built yet)

- **Always-async import** — `POST` returns `202 { import_id }`; the CLI polls
  `GET /projects/{id}/imports/{import_id}` for progress.
- **Private repos** — a GitHub App authorization flow so users can import their
  own private repositories.

## v3 — the direct engine

v3 adds a second import engine selectable with `--engine server|direct`
(default `server`).

- **`server`** (default) — today's behavior, byte-identical: one
  `POST /projects/{id}/import/json` call; EAT does the GitHub fetch, mapping,
  and writes. Selecting `server` (or omitting `--engine`) changes nothing —
  same flags, exit codes, and output.
- **`direct`** — the CLI runs the pipeline client-side: fetch the repo from
  GitHub, map issues to EAT story shapes, and write them through the EAT API.
  The active engine is named in the legend header (`… [engine: direct]`); the
  `server` header is unchanged.

### v3 scope

- **Issues only.** `--engine direct` composes with `--include`, but v3 supports
  `issues` only; `prs`, `milestones`, and `releases` exit with a usage error
  ("not supported by the direct engine yet") — those land in v4.
- **Staged build.** This epic ships across several stories. The fetch → map →
  prescan → write pipeline is wired end-to-end: `--engine direct` performs real
  imports (issues only), prompting for confirmation exactly like the server
  engine. The one stage still pending is the local dry-run — `--dry-run` with
  `--engine direct` exits with an error naming it until that story lands.

### GitHub fetch stage

The direct engine reads GitHub itself (the server engine never exposed this —
EAT did the fetch). The client-side fetcher (`src/github.js`) uses the
repo-wide list endpoints under `https://api.github.com`, all `per_page=100`
with `Link`-header pagination:

- `GET /repos/{owner}/{repo}/issues?state=all` — issues. The endpoint mixes in
  pull requests (tagged with a `pull_request` key); the fetcher drops them.
- `GET /repos/{owner}/{repo}/issues/comments` — every issue comment, repo-wide.
- `GET /repos/{owner}/{repo}/labels` — the repo's labels.

Anonymous requests share GitHub's 60 req/h budget; a bats-sized repo stays
~15–25 requests. `--token` / `GITHUB_TOKEN` is sent as `Authorization: Bearer`
and raises the ceiling to 5000/h (and reaches private repos). Error mapping:
404 → repo-not-found; 403 with `x-ratelimit-remaining: 0` → rate-limit
(message carries the `x-ratelimit-reset` time); 401 → token rejected.

### Default mapping profile (issues → stories)

The direct engine maps fetched GitHub JSON to an EAT write-op plan client-side
(`src/mapping.js` — pure functions, no HTTP), mirroring the server importer's
issue mapping so both engines classify the same repo identically:

- **State** — open issue → `unstarted` story; closed → `accepted`, keeping the
  GitHub closed date (`completed_at`).
- **Type inference** (labels + title, bug checked first) — a label containing
  `bug`/`fix`/`defect`, or a title starting with `fix`/`bug` → `bug`; a label
  containing `chore`/`maintenance`/`devops`/`infra` → `chore`; else `feature`.
- **Labels** — names trimmed (blank dropped); colors normalized to lowercase
  `#rrggbb` (anything else dropped, never an error) with a
  perceptual-luminance text color (black on light, white on dark). The issue
  payload's own color wins; the repo label list fills gaps. Only labels on
  mapped issues are created.
- **Checklists** — `- [ ]` / `- [x]` items (also `*`/`+` markers, indentation
  allowed) become story tasks; the lines stay in the description verbatim.
- **Comments** — joined to their issue by `issue_url`, which also drops PR
  conversation comments (the repo-wide comments endpoint includes them; their
  issue numbers point at PRs that are never mapped). The public EAT API has
  no comment-author attribution, so each body is prefixed
  `@<login> on <YYYY-MM-DD>:` (deleted accounts render as `@ghost`).
- **Identity** — `external_id` is the issue number as a string; rows carrying
  a `pull_request` key are dropped (v3 is issues-only).

The CLI legend's `issues` lines render from this module's own table
(re-exported through the `MAPPINGS` registry), so legend and mapper cannot
drift; the server engine's legend output stays byte-identical.

### Write surface (direct engine)

The writer stage targets this EAT API surface, all under
`/projects/{id}`, one `Idempotency-Key` per write (shapes probed against the
real server 2026-07-16 and mirrored by `src/mockserver.js`):

- **`POST /labels`** — body `{ "name": "...", "background_color_hex": "#rrggbb",
  "text_color_hex": "#rrggbb" }` (`label_name` is an accepted request alias —
  openapi lists both, and the required-field error names `label_name`; colors
  optional; omitted colors get server defaults, observed `#3498db` /
  `#ffffff`) → 200
  `{ label_id, label_name, project_id, background_color_hex, text_color_hex }`.
  A duplicate name — case-insensitive — is a `409 conflict`, so "ensure
  label" means treating 409 as already-exists; a missing name is a
  `400 invalid_parameter`.
- **`POST /stories`** — body requires `name` (the read-side field is `title`;
  missing → `400 validation_failed`); optional `description`, `story_type`,
  `current_state`, `icebox`, and `labels` as bare strings or
  `{ "name": "..." }` objects — the server attaches by name, get-or-creating
  with default colors (unlike `POST /labels`, the story payload never 409s on
  an existing name), and embeds the full label objects in the response.
  `current_state: "accepted"` is accepted at create time for an unestimated
  feature (verified 2026-07-16) — no estimate guard, so no
  create-then-transition fallback is needed. 200 → the full story object
  (`story_id`, `title`, `current_state`, `labels`, …).
- **`POST /stories/{id}/tasks`** — body `{ "description": "...",
  "complete": bool }` (`task_desc` is an accepted request alias; empty →
  `400 invalid_parameter`, "task_desc is required") → 200
  `{ task_id, story_id, task_desc, complete, task_order, created }`.
- **`POST /stories/{id}/comments`** — body `{ "text": "..." }`
  (`comment_text` is an accepted request alias; empty →
  `400 invalid_parameter`, "comment must have text or emoji") → 200
  `{ comment_id, story_comment_id, story_id, comment_text, created }`.
- **Idempotency** — every `POST` replays on same key + same body and returns
  `409 idempotency_conflict` on same key + different body (see the v1 import
  note). The ledger is keyed by key + body only: a same-key + same-body
  request replays the stored response **even on a different endpoint**, and
  failed responses are keyed too (probed 2026-07-16) — so the writer must
  mint one unique key per logical write, never reuse keys across ops.

### Marker dedup (direct engine)

Server-side provenance (`import_source` / `import_external_id`) is not
exposed by the public API, so the direct engine's re-run safety is
marker-based:

- Every story it writes ends its description with a stable marker line:
  `Imported from https://github.com/{owner}/{repo}/issues/{n}`.
- Before writing, it prescans the target project —
  `GET /stories?limit=…&cursor=…&fields=story_id,description,tasks_count,comment_count`
  (cursor mode
  whenever `cursor=` or `limit=` is present; `fields=` is a sparse-fieldset
  allowlist, unknown values → `400 validation_failed`, `story_id` always
  included; invalid `limit`/`cursor` values — including out-of-range
  cursors — are also `400 validation_failed`, so a paging loop fails loudly
  rather than spinning) — and skips items whose marker already exists,
  reported as `skipped N (already imported)`, the server engine's wording.
- Dedup is scoped per `(owner, repo)`: markers pointing at other repos never
  suppress an import. Matching is case-insensitive (GitHub slugs are, and
  GitHub forbids same-name-other-case repos) and honors only the last
  non-blank line of a description — an issue body merely quoting the marker
  sentence mid-text cannot poison the dedup. Labels referenced only by
  skipped stories are not re-created.
- The marker lands at story-create, before that story's tasks and comments.
  A run interrupted in that window leaves an incomplete story that stays
  skipped on re-runs; when a marker-matched story has fewer
  tasks/comments than the current GitHub issue, the next run warns
  (`tasks X/Y, comments X/Y`) naming both possible causes — an interrupted
  run, or the issue changing since import — with the repair path: delete
  that story in EAT and re-run.

### Fidelity limitations (direct engine)

- **Timestamps** — `POST /stories` accepts no `created_at` / `completed_at`,
  so GitHub's creation and close dates cannot be preserved; `created` is the
  import time. The mapping profile still carries both in its plan for when
  the API grows the fields.
- **Comment authorship** — the API has no comment-author attribution;
  comments are authored by the importing key, with the GitHub author and
  date riding in the body prefix (`@login on YYYY-MM-DD:`).
- **No provenance interop** — marker dedup cannot see rows imported by the
  server engine (which stores provenance internally), and the server engine
  cannot see markers. Mixing engines against one project can duplicate
  stories; keep a project on one engine until the EAT-team ask to expose
  provenance lands.
