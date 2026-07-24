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

  **Optional** `"external_members_created": ["<github login>", ...]` — the
  GitHub logins whose external-member rows (display-only owner attributions
  outside the project roster; auto-linked to a real member when a matching
  GitHub account signs in) were newly created by this import. **Not yet
  emitted by the hosted tracker** — this is the agreed forward-compat shape
  (assignees-become-owners shipped server-side 2026-07-09 without reporting
  the rows it creates). The CLI renders a placeholder-owners note when the
  field is present and non-empty (on `--dry-run`, as a `would create` line in
  the plan); an absent field, empty array, or non-array value renders nothing
  and never errors. Entries that are not valid GitHub logins (alphanumerics
  and single inner hyphens, at most 39 chars) are dropped and duplicates
  collapsed before rendering. The mock server emits the field in computed
  mode (`fixture.assignees`), creating each login at most once per project.
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
- **Staged build.** This epic ships across several stories; the pipeline is
  now wired end-to-end. `--engine direct` performs real imports (issues only),
  prompting for confirmation exactly like the server engine. `--dry-run` runs
  the same fetch → map → prescan stages and stops before the write, rendering
  the same would-import / would-skip plan block as the server dry-run path.
  Unlike the server engine there is no `openapi.json` feature-detection gate —
  the plan is computed client-side, so no server dry-run support is required.
  The would-import label count is the plan's label set; labels the project
  already has are only discovered at write time (`409` → existing), so a real
  run may create fewer.

### Per-run customization (`--customize`)

`--customize` opts a run into per-run import customization. It is direct-only
by construction — the server engine maps everything server-side, so there is
nothing to customize there. The flag implies `--engine direct` (the legend
header names the engine); an explicit `--engine server --customize` exits 2
naming the conflict. It also needs an interactive terminal — the wizard that
will fill in the questions prompts on the TTY — so non-TTY stdin or stdout
exits 2.

A `Customization` object, defined next to the mapping profile in
`src/mapping.js`, threads through the direct pipeline and is applied by
`mapRepo` client-side as pure filters and overrides:

- `states` (`"all" | "open" | "closed"`) — drops non-matching issues before
  mapping; a dropped issue contributes no story, no labels, no comments.
- `milestones` (`string[] | null`) — when set, keeps only issues whose
  `milestone.title` matches an entry exactly (case-sensitive); issues with no
  milestone drop. `null` disables the filter.
- `storyType` (`"infer" | "feature" | "bug" | "chore"`) — `"infer"` keeps the
  label/title inference; a fixed value applies to every mapped story.
- `comments: false` maps no comments; `tasks: false` converts no body
  checklists to tasks (the checklist lines stay in the description verbatim
  either way).

The defaults — `{ states: "all", milestones: null, storyType: "infer",
comments: true, tasks: true }` — reproduce the default mapping
byte-identically, so a wizard run answered with plain Enter throughout is
output-identical to plain `--engine direct`.

The interactive wizard (`src/wizard.js`) fills in those answers. It runs at
the pipeline's fetch→map seam — after the GitHub fetch, so its questions
reflect the real issues — and asks, one at a time:

1. **States** — all / open only / closed only, with live counts from the
   fetch (e.g. `142 open, 730 closed`).
2. **Milestones** — a numbered multi-select of the milestone titles present on
   the fetched issues (blank = all). Skipped, with no extra GitHub request,
   when no fetched issue carries a milestone.
3. **Story type** — infer (default) / all feature / all bug / all chore.
4. **Import issue comments?** (`[Y/n]`).
5. **Convert body checklists to story tasks?** (`[Y/n]`).

Answers apply to this run only — nothing is persisted. Prompts render on
stderr, keeping stdout clean. EOF (Ctrl-D) mid-wizard aborts the run with
exit 1 before anything is written.

#### Order: fetch → wizard → customized legend → confirm → write

A `--customize` run reorders the legend and confirm to _after_ the wizard, so
the member reviews a legend that reflects their own choices — not the default
profile. The effective order is **fetch → wizard → customized legend + `[y/N]`
confirm → map → write**; non-`--customize` runs (server and direct alike) keep
today's pre-fetch legend + confirm, byte-for-byte.

The customized legend (`renderLegend`) adjusts to the `Customization`:

- The issues block drops the **comments** line when `comments` is off, and the
  **checklist→tasks** fragment when `tasks` is off (labels stay either way).
- A trailing **`Customized:`** block names every non-default choice — issue
  states, milestone filter (titles control-char-stripped, they are untrusted
  remote data), fixed story type, comments off, tasks off. An all-default set
  of answers renders no such block and no dropped lines, so the legend is
  byte-identical to plain `--engine direct`.

`--yes` skips the `[y/N]` confirm but never the wizard: a customized run always
shows the resulting legend before writing. `--customize --dry-run` runs the
wizard and prints the plan for the filtered subset without writing (dry-run
skips the confirm, as elsewhere). Declining the confirm — like EOF mid-wizard —
writes nothing and exits 1.

### GitHub fetch stage

The direct engine reads GitHub itself (the server engine never exposed this —
EAT did the fetch). The client-side fetcher (`src/github.js`) uses the
repo-wide list endpoints under `https://api.github.com`, all `per_page=100`
with `Link`-header pagination:

- `GET /repos/{owner}/{repo}/issues?state=all` — issues. The endpoint mixes in
  pull requests (tagged with a `pull_request` key); the fetcher drops them.
- `GET /repos/{owner}/{repo}/issues/comments` — every issue comment,
  repo-wide. The endpoint includes PR conversation comments; the fetcher keeps
  only comments whose `issue_url` points at a kept issue, so PR chatter never
  reaches the mapping stage.
- `GET /repos/{owner}/{repo}/labels` — the repo's labels.

`owner` and `repo` are URL-encoded into the request path, so metacharacters in
`--repo` yield a well-formed request (and a clear repo-not-found error), never
a mangled query string. Pagination refuses a `Link` rel=next URL that is
unparseable or whose origin differs from the API base — the `Authorization`
header never leaves the API origin — and a 200 body that is not a JSON array
is a fetch error, not an empty page.

Anonymous requests share GitHub's 60 req/h budget; a mid-sized repo (~1,000
issues) stays ~15–25 requests. `--token` / `GITHUB_TOKEN` is sent as
`Authorization: Bearer` and raises the ceiling to 5000/h (and reaches private
repos). Error mapping: 404 → repo-not-found; rate limits — HTTP 429, a 403
with `x-ratelimit-remaining: 0`, or a secondary-limit 403 carrying
`retry-after` — → rate-limit (the message prefers `retry-after` when present,
falling back to the `x-ratelimit-reset` time); 401 → token rejected.

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
- **Comments** — joined to their issue by `issue_url`. The fetcher has already
  dropped PR conversation comments by the same key, and the join keeps any
  stray unmatched comment inert (its issue is never mapped). The public EAT API has
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

### Length limits (direct engine)

The server rejects over-long write values with
`400 invalid_parameter {"constraint":"too_long","fields":[<field>]}` — a
typed 4xx the writer correctly never retries, so one giant GitHub comment
would otherwise abort the whole run (observed 2026-07-17: a 46,411-char
comment body). The direct engine therefore clamps plan text client-side
before writing:

- **Unit — UTF-8 bytes.** The server validates with Rust's `str::len()`, which
  counts bytes, so every limit here is a byte budget. The client measures the
  same way (`Buffer.byteLength`); measuring in JS `String.length` (UTF-16
  units) under-counts any non-ASCII text and lets it through to a `too_long`
  400 — emoji, arrows, curly quotes and CJK all cost 2–4 bytes per character.
  Truncation cuts on a **code-point boundary**, so a character is never split
  into a lone surrogate.
- **Limit source** — the field's `maxLength` in `GET /openapi.json` when
  published (aliased request fields share storage, so the smallest alias
  limit wins). Today's servers publish none, so **fallback defaults**
  apply: story name 255; story description, task description, and comment
  text 16,000 bytes each — chosen between the longest comment a real server
  accepted (13,101) and one it rejected (46,411). Tune the fallbacks (or ask
  the EAT team to publish `maxLength`) if a server still rejects.
- **Clamp shape** — block text is cut and suffixed with a visible notice
  (`[truncated by github-to-eat: …]`), total within the limit; names are cut
  with a trailing ellipsis whose own 3 bytes come out of the budget. Story
  descriptions reserve room for the dedup marker line before clamping, so the
  marker always survives intact. Each clamp warns on stderr naming the issue
  and field
  (`warning: issue #64: comment 1 truncated to 16000 bytes (server limit)`).
- **Guarantee** — because the clamp measures the server's own unit, a clamped
  plan cannot produce a `too_long` 400; one over-long GitHub issue can never
  abort the run.
- The mock server mirrors the rejection and, when configured with limits,
  publishes them as `maxLength` in its `/openapi.json`.

### Marker dedup (direct engine)

The direct engine's **primary** re-run key is the re-import provenance pair
(`import_source` / `import_external_id`, EAT #31427); the description **marker**
is the fallback for older servers and legacy marker-only rows. Both are written
and both are prescanned, in union.

- **Provenance pair (primary)** — every story create carries
  `import_source: "github"` and `import_external_id: "{n}"` (the GitHub issue
  number as a string — the same key the server-side GitHub importer writes).
  EAT owner-gates the pair and rejects a lone field, so the two are built from
  one object and always sent together. Feature-detected from
  `GET /openapi.json` (the `import_source` property on the project-scoped
  `POST …/stories` schema); on a server that advertises it the prescan reads
  provenance back via the `GET /stories?import_source=github` list filter
  (`fields=story_id,import_external_id,tasks_count,comment_count`). Because the
  server-side importer writes the same pair, cross-engine dedup is now
  **symmetric**: a direct-written story is skipped by a later server import and
  vice versa.
  - **Repo-blind, deliberately.** The key is `(project, source="github",
    external_id)` — the issue number alone, with **no** `(owner, repo)` scope.
    This is exactly the server importer's key, and matching it is what buys the
    cross-engine symmetry above; encoding the repo into `import_source` would
    break interop. The consequence: within one project, two GitHub repos whose
    issue numbers collide (repo-A #7 and repo-B #7) dedup against each other —
    the second is false-skipped. See the one-repo-per-project constraint below.
- **Marker (fallback)** — every story it writes also ends its description with a
  stable marker line: `Imported from https://github.com/{owner}/{repo}/issues/{n}`.
  The marker prescan always runs **alongside** the provenance prescan (their
  results are unioned), so rows written by an older marker-only CLI run (no pair
  on the server row) are still skipped. When the server does not advertise the
  pair, the direct engine sends no provenance and dedups on the marker alone,
  byte-identical to earlier behaviour.
- The prescan cursor-walks the project —
  `GET /stories?limit=…&cursor=…&fields=…` (cursor mode whenever `cursor=` or
  `limit=` is present; `fields=` is a sparse-fieldset allowlist, unknown values
  → `400 validation_failed`, `story_id` always included; invalid `limit`/`cursor`
  values — including out-of-range cursors — are also `400 validation_failed`, so
  a paging loop fails loudly rather than spinning) — and skips items whose pair
  or marker already exists, reported as `skipped N (already imported)`.
- Only the **marker fallback** is scoped per `(owner, repo)`: markers pointing
  at other repos never suppress an import. Matching is case-insensitive (GitHub
  slugs are, and GitHub forbids same-name-other-case repos) and honors only the
  last non-blank line of a description — an issue body merely quoting the marker
  sentence mid-text cannot poison the dedup. The primary provenance pass has no
  such scope (see "Repo-blind" above), so the *combined* dedup is repo-blind
  wherever the provenance pass is active. Labels referenced only by skipped
  stories are not re-created.
- The pair and marker both land at story-create, before that story's tasks and
  comments. A run interrupted in that window leaves an incomplete story that
  stays skipped on re-runs; when a skipped story has fewer tasks/comments than
  the current GitHub issue, the next run warns (`tasks X/Y, comments X/Y`)
  naming both possible causes — an interrupted run, or the issue changing since
  import — with the repair path: delete that story in EAT and re-run.
- The mock server mirrors all of this behind a `provenance` flag (default on):
  it advertises the pair in `/openapi.json`, validates + persists it on create,
  and honours the `import_source`/`import_external_id` list filters; turning it
  off simulates an older server.

### Fidelity limitations (direct engine)

- **Timestamps** — `POST /stories` accepts no `created_at` / `completed_at`,
  so GitHub's creation and close dates cannot be preserved; `created` is the
  import time. The mapping profile still carries both in its plan for when
  the API grows the fields.
- **Comment authorship** — the API has no comment-author attribution;
  comments are authored by the importing key, with the GitHub author and
  date riding in the body prefix (`@login on YYYY-MM-DD:`).
- **Cross-engine dedup** — against a server that exposes the re-import pair
  (EAT #31427), the direct and server engines share the
  `(project, import_source, import_external_id)` key, so mixing engines against
  one project no longer duplicates stories (see "Marker dedup" above). The
  caveat survives only for **older** servers that do not advertise the pair:
  there the direct engine falls back to its private description marker, which
  the server engine cannot see, so keep such a project on one engine.
- **One repo per project** — the shared key is repo-blind (`external_id` is the
  bare issue number, matching the server importer), so a project holding issues
  from two GitHub repos can false-skip where their issue numbers collide. Keep
  one GitHub repo per EAT project.
