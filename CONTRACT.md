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
     `include_pull_requests`, `include_milestones`, `include_releases`,
     `include_dependencies` (issues are always imported; the flags only add
     types).
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
  pinned in the server's `GET .../openapi.json`). This 200 shape is now the
  **legacy/fallback** path: the primary path is the async `202` accept +
  poll (see *Async import* below). The CLI still accepts this synchronous body
  from older servers, and the body below is byte-identical to the terminal
  job's `result`:
  ```json
  {
    "dry_run": false,
    "imported": { "stories": 39, "labels": 0 },
    "skipped": 0,
    "errors": [{ "code": "missing_title", "row": 3 }],
    "warnings": [{ "code": "history_floor_clamped", "count": 3, "floor_year": 2010 }],
    "external_members_created": ["octocat"],
    "unmatched": { "owners": [], "followers": [], "reviewers": [],
                   "requesters": [], "comment_authors": [] }
  }
  ```
  `imported` is an **object**, not an integer; it counts stories and labels
  only (epics created from milestones are not counted). `skipped` means
  "already imported" (see re-import dedup above). `dry_run` echoes the request's
  `dry_run` field.

  `errors` is **not** a list of strings: each entry is a coded
  `{ "code": "missing_title", "row": 3 }` object — a stable machine code plus
  the 1-based source row, never a pre-formatted English sentence (server story
  #31311). The CLI renders one `  - row <row>: <code>` line per entry on stderr
  and still exits 1; a bare string from an older/other source is rendered as-is,
  and every entry is control-character-scrubbed before it reaches the terminal.

  `warnings` are **coded** non-fatal advisories about an import that otherwise
  succeeded — unlike `errors`, nothing was skipped (server story #32239). Each
  entry is a `{ "code": ..., "count": N, "floor_year": Y }` object; today the
  only code is `history_floor_clamped` (completed stories dated before the
  server's grid floor were placed on the oldest iteration's Done board), which
  fires for any source with imported stories, so a GitHub import of long-closed
  issues can hit it. The CLI renders one scrubbed `note:` line per
  entry naming the code, the story count and the floor year.

  **`unmatched` is always empty for a GitHub import.** The lists are built from
  the *email/name actor cells* a source can carry — `owner_emails`,
  `follower_emails`, `reviewers[].email`, `requester_email`,
  `ImportComment.author_name` — and the GitHub connector never populates any of
  them: it fills `author` and `assignees` with GitHub `ImportedPerson` rows,
  routed through `resolve_person_actor`, which resolves member-or-external and
  never reports (`import/github.rs`, `import/common.rs`). The sources that do
  feed these lists are the ones carrying email/name actor cells — EAT CSV, Jira,
  GitLab, Shortcut, Pivotal — not GitHub. Note that `looks_like_email`
  (`import/common.rs`) gates only the **comment-author** path; `owners` /
  `followers` / `reviewers` / `requesters` report *any* non-empty, non-`agent:`
  value that misses the member map, so "a GitHub login is not an email" is not
  what keeps these lists empty. `comment_authors` is also **not** a list of
  strings: its entries are `{ "email": "...", "count": N }` objects. The lists
  are still serialized on every import, so the CLI parses the field — but it
  must never be presented as GitHub-user coverage.

  `"external_members_created": ["<github login>", ...]` — the GitHub logins
  whose external-member rows (display-only owner attributions outside the
  project roster; auto-linked to a real member when a matching GitHub account
  signs in) were newly created by this import; reused rows are excluded, the
  list is deduped and sorted, and a `dry_run` preview reports it too (server
  story #32141, verified against the server tree — the field landed after the
  last prod deploy, so hosted emission is read from the source, not observed).
  The CLI renders a placeholder-owners note when the field is present and
  non-empty (on `--dry-run`, as a `would create` line in the plan);
  an absent field (an older server), empty array, or non-array value renders
  nothing and never errors. Entries that are not valid GitHub logins
  (alphanumerics and single inner hyphens, at most 39 chars) are dropped and
  duplicates collapsed before rendering. The mock server emits the field in
  computed mode (`fixture.assignees`), creating each login at most once per
  project.
- **Project** (`GET .../projects/{id}`): the name field is `project_title` (not
  `title`/`name`); also `project_id`, `project_desc`, etc.
- **Stories** (`GET .../projects/{id}/stories`): with `?limit=` (or `?cursor=`) it
  returns a cursor page `{ "items": [...], "next_cursor": <str|null> }`; with no
  query it returns a bare JSON array. Each row carries the title under **both**
  `title` and its `name` alias, and both are in the `fields=` allowlist (real
  server 2026-08-12: `handlers/stories.rs` projects `"title": row.title,
  "name": row.title` on the list path and again on the detail path, and both keys
  are members of its `STORY_FIELDS` allowlist).
  **Two filters hide rows by default**, so a reader that wants a whole project
  must opt into them: `include_done=true` admits Done-panel stories (those frozen
  on a *past* iteration — a row that is iceboxed, on no iteration, or on the
  iteration covering `now()` is never hidden), and `include_archived=true` admits
  archived rows. The latter is a back-compat alias for the tri-state
  `archived=exclude|include|only` (default `exclude`), which wins when both are
  sent; any other `archived` value is `400 validation_failed` with
  `details.fields=["archived"]`. Both booleans deserialise as `Option<bool>`, so
  `true` / `false` are the only spellings that reach the handler — anything else
  is rejected by the query extractor as `400 validation_failed` with an **empty**
  `details.fields`. Those are two distinct 400 shapes: the extractor's names no
  field, the handler's names the offending one.
- **Story comments** (`GET .../projects/{id}/stories/{sid}/comments`) — **not read
  by today's CLI** (which only `POST`s here); documented for readback and parity
  consumers. With no query it returns a **bare JSON array** ordered by `created`;
  any *non-empty* `cursor` / `limit` / `order` switches the response to the
  `{ "items": [...], "next_cursor": <str|null> }` envelope, ordered by
  `story_comment_id`. `?cursor=` and `?order=` empty stay the bare array
  (`empty_string_as_none`). A reader must tolerate both shapes.

These shapes are mirrored by the bundled mock server (`src/mockserver.js`). Where
it knowingly diverges — verified against the real server 2026-08-13, so a test
built on the mock is not misread as proof about the server:

- It serves only `POST` on the comments route.
- Having no iteration calendar, its `include_done` filter stands in for "frozen on
  a past iteration" with "carries any `iteration_id`", so it hides
  current-iteration rows the real server returns.
- Its read row omits `archived` / `archived_at`, which the real list and detail
  paths always project. The mock also has no route that archives a story.
- Validation **order** differs: the mock checks `archived` before `fields=`,
  `limit` and `cursor`, where the real handler validates those three first and
  `archived` last. Only a request carrying two invalid params can tell, and it
  names a different field on each side.
- A non-numeric `limit` is an extractor rejection on the server (empty
  `details.fields`), where the mock answers `details.fields=["limit"]`; only
  `limit=0` and `limit>200` reach the real handler and legitimately name it.
- The mock's `fields=` allowlist mirrors the published `openapi.json` list, which
  omits `archived` / `archived_at` / `iteration_id` that the server's own
  `STORY_FIELDS` accepts — so `fields=archived` 400s on the mock and 200s on the
  server.

### GitHub identity mapping (both engines)

How an import turns GitHub people into EAT rows — verified against the
server importer (`services/import/github.rs`, `common.rs`; server stories
#26314 / #32141). The direct engine mirrors every rule below (tracker story
#33465); where the two can still differ is spelled out after the list:

- **Identity is the numeric GitHub user id, not the login.** Each person becomes
  an `external_member` row keyed `(source = "github", external_id = <numeric
  GitHub user id>)`, so a login rename converges on the existing row instead of
  forking a second identity.
- **The login is a display value and a mapping key, nothing more.** It is stored
  as `external_username` (and `display_name`, since GitHub's issue payloads
  carry no profile name) and refreshed on every re-import. Linking an external
  member to a real EAT member is a separate scan matching
  `lower(external_username) = lower(oauth_identity.provider_username)`; a row
  that is already mapped keeps its mapping across a rename, because the identity
  is the id.
- **An external member is display-only.** The import never creates a `member`
  row and never touches project membership.
- **Ghosts are dropped.** A user object missing either the id or the login
  (GitHub's `ghost` for a deleted account) is not carried at all — but only an
  *assignee* simply disappears. A ghost issue author leaves the story with no
  author, so it falls back to the importing member as requestor; a ghost comment
  author likewise leaves the comment attributed to the importing member.
- **Roles** — the issue author becomes the story's **requestor**; assignees
  become **owners**, and for a pull request the creator is an owner too.
- **Comment attribution is structural, not textual.** A comment is authored by
  its author's `external_member` row and its body is stored verbatim — no
  `(originally …)` prefix, and nothing reported in `unmatched`. That prefix is
  the unmatched-comment-author fallback, reached only by a source that carries
  an email-valued author cell — never a GitHub import.

**How the direct engine writes the same rows.** It has no importer stage; it
sends the people on the public writes, which land on the same `external_member`
substrate: `requestor: ExternalPersonInput` and `owners[].external` on
`POST .../stories`, `author: ExternalPersonInput` on `POST .../comments` (server
story #32773). The payload it builds is `to_person`'s output field for field —
`source: "github"`, `external_id` the stringified numeric id, `username` and
`display_name` both the trimmed login, `html_url` when the payload carried one —
so both engines get-or-create the same `(source, external_id)` row. A ghost is
omitted rather than sent partially; the story's requestor and the comment's author
then fall back to the calling key (the server importer's own fallback), while a
ghost *assignee* is simply absent — the caller does not become an owner.
`tests/parity.test.js` pins the triples. The differences that remain:

- **Gating** — all three fields are **owner-gated and create-only**, so the engine
  feature-detects them first and falls back to the `@login` comment prefix against
  a server that does not advertise them (see *Fidelity limitations* below).
- **A safe-integer id floor** — `valid_gh_user` keeps any non-zero `i64`, but a
  GitHub id past 2^53 does not survive `JSON.parse` intact, and two such ids would
  stringify to one `external_id`, merging two people onto one `external_member`
  row. The direct engine drops that person instead (pinned in the ghost table of
  `tests/mapping.test.js`).
- **Two CLI-side normalisations** — a whitespace-only `html_url` is dropped rather
  than sent (`to_person` passes `Option<String>` through untouched), and the
  comment body is trimmed before it is sent (the server importer stores it
  untrimmed, testing `trim()` only to skip blank comments).
- **Placeholder-owner reporting** — the create responses carry no created-vs-reused
  signal, so the direct engine's `N placeholder owner(s)` line reports the distinct
  logins the run *attached*, not strictly the `external_member` rows it created; on
  a re-import into a project that already knows those people the count therefore
  over-reports where the server engine's would read 0.

## v2 — async import

The import is a background job. `POST .../import/json` **accepts** the work and
returns immediately; the CLI polls a status endpoint until the job finishes.

- **Accept** (`POST .../import/json`, HTTP **202**):
  ```json
  { "import_id": "imp-abc123", "status": "pending" }
  ```
  The Idempotency-Key semantics are unchanged (same key + same body replays the
  same `202`/`import_id`; different body → `409 idempotency_conflict`). Dry-run
  imports ride the **same** async job (`202` → poll → `done` with
  `result.dry_run: true`).

- **Status** (`GET .../projects/{id}/imports/{import_id}`, HTTP 200):
  ```json
  {
    "import_id": "imp-abc123", "project_id": 91, "source": "github",
    "created": "2026-07-24T00:00:00Z",
    "status": "fetching",
    "progress_current": 2, "progress_total": 5,
    "error": null, "error_code": null,
    "result": null
  }
  ```
  - `status` lifecycle: `pending → fetching → writing → done | failed`. Only
    **done** and **failed** are terminal; file sources skip `fetching`.
  - `progress_current` / `progress_total` (`int|null`) — the X/Y for the current
    phase, driving the live progress line.
  - `error` / `error_code` (`string|null`) — set on `failed`.
  - `result` (`ImportResult | null`) — present **only on `done`**, and
    byte-identical to the legacy synchronous 200 body above.

- **Client behaviour** — on a `202`, the CLI polls the status endpoint with
  **capped exponential backoff** (0.5s → 5s, giving up after ~15 min) and
  renders a **live progress line** on stderr (`queued` → `fetching X/Y` →
  `writing` → `done`/`failed`); stdout and the final result rendering are
  unchanged. A `failed` status raises the job's `error`/`error_code`. When the
  server instead answers a synchronous `200` (older servers), the CLI uses that
  body directly — no polling. The shape is detected by the response body, not a
  version flag.

The async accept, status endpoint, and progression are mirrored by the bundled
mock server under `makeState({ asyncImport: true })` (`--async` when run
standalone); `asyncFail: true` drives the `failed` branch.

## Reserved — not built yet

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

- **Every `--include` type.** `--engine direct` composes with `--include`; it
  supports `issues` (always imported), `prs`, `milestones`, `releases` and
  `deps` — the whole registry, so no selection the flag accepts is refused by
  the direct engine. There is no direct-unsupported refusal path: `parseInclude`
  is the only producer of a selection and it yields registry types only,
  rejecting anything else with `unknown import type '<x>'`. A type added to the
  registry therefore reaches both engines, and gating one off is a decision for
  whichever story adds it — `deps` is the one type gated the other way round,
  refused on the **server** engine when that server's import body has no
  `include_dependencies`.
- **Staged build.** This epic ships across several stories; the pipeline is
  now wired end-to-end. `--engine direct` performs real imports,
  prompting for confirmation exactly like the server engine. `--dry-run` runs
  the same fetch → map → prescan stages and stops before the write, rendering
  the same would-import / would-skip plan block as the server dry-run path.
  Unlike the server engine there is no `openapi.json` feature-detection gate —
  the plan is computed client-side, so no server dry-run support is required.
  The would-import label count is the plan's label set; labels the project
  already has are only discovered at write time (`409` → existing), so a real
  run may create fewer. A dry run pays the **full** fetch cost, sub-issue
  listings included: it is a rehearsal of the real run, so it must render the
  descriptions the real run would write — a cheaper dry run would print bodies
  missing their cross-link block and quietly stop being a preview.

### Per-run customization

A run can narrow or override the issue mapping for itself (nothing is
persisted), either **interactively** with `--customize` or **declaratively**
with the customization flags below. Both produce the same `Customization`
object and are direct-only by construction — the server engine maps everything
server-side, so there is nothing to customize there.

Either front-end implies `--engine direct` (the legend header names the
engine); an explicit `--engine server` alongside `--customize` or any
customization flag exits 2 naming the conflict. `--customize` additionally
needs an interactive terminal — the wizard prompts on the TTY — so non-TTY
stdin or stdout exits 2; that terminal check runs before the `--include` check
below, so a piped `--customize` reports the terminal error even when
`--include` is also unsupported. The declarative flags are the non-TTY path:
they imply the same engine and need no terminal at all.

The implied engine inherits the direct engine's v3 limits, so an `--include`
type the direct engine cannot do yet also exits 2. The message itself names no
flag, so the attribution prefix is the only flag a member is pointed at, and it
names whichever flag selected the engine: `--engine` when `--engine direct` was
passed explicitly, else `--customize`, else the customization flag that implied
it, else `--include` when the engine came from the default.

A `Customization` object, defined next to the mapping profile in
`src/mapping.js`, threads through the direct pipeline and is applied by
`mapRepo` client-side as pure filters and overrides:

- `states` (`"all" | "open" | "closed"`) — drops non-matching issues before
  mapping; a dropped issue contributes no story, no labels, no comments.
- `milestones` (`string[] | null`) — when set, keeps only issues whose
  `milestone.title` matches an entry exactly (case-sensitive); issues with no
  milestone drop. `null` disables the filter, and an empty array is treated the
  same way — it imports every issue rather than matching none. That widening is
  object-level only: `--milestones` with no titles is a usage error (exit 2, see
  the flag rules below), so no CLI invocation reaches `mapRepo` with `[]`.
  Entries match verbatim, so a blank entry is not special-cased and matches
  nothing; neither the flag parser nor the wizard emits one.
- `storyType` (`"infer" | "feature" | "bug" | "chore"`) — `"infer"` reads the
  org's issue type first and falls back to the label/title inference (see "Issue
  type" below); a fixed value applies to every mapped story, ignoring both.
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
3. **Story type** — infer (default; the org's issue type, else labels/title) /
   all feature / all bug / all chore.
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

#### Declarative flags (no terminal required)

Each flag sets one `Customization` field, so a flag-driven run reaches exactly
the object the equivalent wizard answers would produce — the wizard is one
front-end for it, these flags are the other. Any of them implies
`--engine direct`; `--engine server` with one exits 2 naming the conflict.

| Flag            | `Customization` field | Values / effect                                    | Default   |
| --------------- | --------------------- | -------------------------------------------------- | --------- |
| `--states`      | `states`              | `all` \| `open` \| `closed`                        | `all`     |
| `--milestones`  | `milestones`          | exact `milestone.title` allowlist; comma-separated, repeatable | all |
| `--story-type`  | `storyType`           | `infer` \| `feature` \| `bug` \| `chore`           | `infer`   |
| `--no-comments` | `comments`            | sets it `false`                                    | imported  |
| `--no-tasks`    | `tasks`               | sets it `false`                                    | converted |

- An invalid `--states` / `--story-type` value exits 2 with a usage error naming
  the flag and its allowed values; `--milestones` with no titles does the same.
  Titles are trimmed and deduplicated, order preserved. The flag rejecting an
  empty selection is deliberate, and does not contradict the object-level rule
  above that an empty `milestones` array imports everything: the flag never
  builds one.
- `--milestones` may be given more than once; every occurrence's titles flatten
  into one allowlist. Each occurrence is also split on commas, so a title that
  contains one is written `\,` (e.g. `--milestones 'v1.0\, beta'`) — without
  that escape the wizard could select such a milestone and the flags could not.
- A `--milestones` title that no issue **surviving the other filters** carries
  would import nothing with no explanation, so the run **warns** naming the
  unmatched titles (the match is exact and case-sensitive). `--states open
  --milestones v2.0`, where `v2.0` sits only on closed issues, warns for that
  reason. Independently, a run whose filters together match no issue at all
  warns that there is nothing to import, naming the filters — so a zero-story
  import is never silent.
- The customized legend, including the `Customized:` block, renders for a
  flag-driven run too — before the confirm, and under `--dry-run` — so the plan
  is always visible. With no customization flag the legend is byte-identical to
  the pre-customization output, on both engines.
- Combining any customization flag with `--customize` exits 2 naming the
  conflict: a caller either declares its answers or asks to be asked, not both.

### Confirmation gate — fail closed off a terminal

Applies to **every** run, both engines, not just customized ones.

A run that would write asks for confirmation (`[y/N]`, default no) and honours
`--yes`/`-y`. Off a terminal there is nowhere to show that prompt, so such a run
**exits 2 with a usage error naming `--yes` and writes nothing** — it never
proceeds on an assumed answer. `--dry-run` is exempt: it writes nothing, so it
still runs unattended with no `--yes` and prints its plan.

This replaces the earlier rule that non-interactive runs simply never prompted
(which made `-y` a no-op for pipes and CI, and let an unattended run write with
no gate at all). It is a **breaking change** for any piped or CI invocation that
relied on the old silent-proceed behaviour: add `--yes`. EOF (Ctrl-D) at the
prompt counts as "no" and aborts with exit 1.

### GitHub fetch stage

The direct engine reads GitHub itself (the server engine never exposed this —
EAT did the fetch). The client-side fetcher (`src/github.js`) uses the
repo-wide list endpoints under `https://api.github.com`, all `per_page=100`
with `Link`-header pagination:

- `GET /repos/{owner}/{repo}/issues?state=all` — issues. The endpoint mixes in
  pull requests (tagged with a `pull_request` key); the fetcher drops them unless
  `--include prs` asks for them. That stub carries `merged_at` (non-null exactly
  when the PR was merged), so merge state costs **no** extra request: the run's
  rate budget is the same whether or not PRs are imported. No `/pulls` endpoint
  is ever requested.
- `GET /repos/{owner}/{repo}/issues/comments` — every issue comment,
  repo-wide. The endpoint includes PR conversation comments — GitHub models them
  as issue comments, so their `issue_url` points at `/issues/<n>`, never
  `/pulls/<n>`. The fetcher keeps only comments whose `issue_url` points at a
  **kept row**, so PR chatter reaches mapping exactly when its PR does and never
  otherwise.
- `GET /repos/{owner}/{repo}/labels` — the repo's labels.
- `GET /repos/{owner}/{repo}/issues/{n}/sub_issues` — one issue's sub-issues,
  requested **only** for rows whose `sub_issues_summary.total` is a number
  greater than zero (every issue row carries that summary; an absent, null or
  non-numeric one reads as "no sub-issues"). A flat repo therefore pays nothing
  extra and a repo using sub-issues pays **at least** one extra request per
  parent — the listing itself paginates at `per_page=100`, so a parent with more
  than 100 sub-issues costs a request per page, capped at 20 pages (a `Link`
  chain past that is refused as a broken server, like the other two pagination
  refusals below). These run sequentially, after the three list endpoints above
  (which still run concurrently), so a wide hierarchy cannot burst into GitHub's
  secondary rate limit. The stage runs before the wizard, so it cannot know
  `--states` / `--milestones` and is deliberately filter-blind.
  **This stage degrades; it never fails the run.** It is optional, un-budgeted
  and runs last, with the issues, comments and labels already fetched — so
  neither a `404` (issue deleted or transferred mid-fetch) nor a rate limit that
  this stage itself provoked may throw away an import that has otherwise
  succeeded. A `404` drops that parent's links and, with them, the
  `Sub-issue of #n` line on every one of its children; a rate limit stops the
  stage where it stands and keeps the links gathered so far. Both warn on stderr,
  naming `--token` for the limit case, and however many parents failed the run
  emits **one** aggregated line — a repo-wide `404` (a GHES without the endpoint,
  or an org with sub-issues off) reports a count, not 200 near-identical lines.
  Every other failure — auth, transport, malformed payload — propagates and fails
  the run, like any other page, and a rate limit on any *other* endpoint stays
  fatal. Only rows whose `number` is a positive integer are kept, and a listing
  that names its own parent, or the same sub-issue twice, is deduplicated.

- `GET /repos/{owner}/{repo}/releases` — the repo's releases, requested **only**
  under `--include …,releases`. Without that flag the endpoint is never touched,
  so a default run's request count is unchanged. It runs *concurrently* with the
  three list endpoints above, inside the same `Promise.all`, and follows `Link`
  up to 200 pages — the server importer's own cap (`github.rs` `MAX_PAGES`), so
  no repo the server accepts is refused here; a chain past that is refused as a
  broken server.

  **This stage does not degrade — a releases-listing failure is fatal**, exactly
  like the three list endpoints above and unlike the sub-issue stage. Only
  `#fetchSubIssues` carries the degrade wrapper. A `404` (a GHES without the
  endpoint), a rate limit, a non-array 200 body, or the 200-page refusal all
  propagate and kill the whole import, issues included. Budget accordingly: a
  release-heavy repo can spend up to 200 requests on a *fatal* endpoint, against
  an anonymous allowance of 60/hour — pass `--token` for release-heavy repos.

  **Drafts are listed only for a token with push access.** GitHub returns draft
  releases from this endpoint to no one else, so on the headline case — a public
  repo read anonymously or with a read-only token — no draft is visible, the
  draft mapping below is unreachable, and the CLI cannot tell that any draft was
  omitted (an invisible draft is indistinguishable from a repo with none).

- `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` — one issue's
  blockers, requested **only** under `--include …,deps`. Without that flag the
  endpoint is never touched and every written row is byte-identical to a
  pre-`deps` run. Unlike the sub-issue listing there is **no rollup field to gate
  on** — the issue row carries no dependency count — so an opted-in run pays *at
  least* one request per issue, sequentially, after the three list endpoints;
  an issue past 100 dependencies pages, and each page is another request, so
  "one per issue" is a lower bound everywhere it is quoted. It follows
  `Link` at `per_page=100` up to 20 pages, the server importer's own
  `MAX_DEPENDENCY_PAGES`, and — like `list_blocked_by` — **keeps the pages it
  already collected** when it hits that cap rather than dropping the listing.

  **These routes ship under their own REST API version.** The request sends
  `X-GitHub-Api-Version: 2026-03-10`; every other endpoint above keeps
  `2022-11-28`, which these routes answer `415`. Both engines do this — the
  server grew a version-explicit `send_with_api_version` sibling for the same
  reason.

  **A route-level failure degrades; it never fails the run**, matching the
  server's enrichment-only contract (`fetch_blocked_by_for_issues` logs a warning
  and yields an empty list for that issue). A `404` (a GHES without the route), a
  `415` (a host that refuses the API version), a `5xx`, or an unreadable body
  costs *that issue* its blockers and nothing else. The warning quotes the first
  failure's own message and claims the API-version diagnosis **only when every
  failure was a 404 or 415** — a cause the fetcher can actually establish.
  Warnings are aggregated into one line however many issues failed, so a
  host-wide refusal reports a count rather than 200 lines.

  **Three failures are not route-level and behave differently.** A rate limit
  stops the stage where it stands and keeps what it has. A `401` is re-thrown and
  fails the run: a revoked token would fail every write that follows, and
  reporting it as a missing route sends the reader after the wrong thing. And
  three *consecutive* transport failures (connection reset, timeout) stop the
  stage: a partition would otherwise cost one doomed request per issue, each
  armed with the full 30 s timeout — hours of stall on a large repo.

  **A run is refused up front when it cannot afford the stage.** Before spending
  a single dependency request the fetcher compares the issue count against the
  `x-ratelimit-remaining` its earlier responses reported; a run short of that
  budget fails with a `RateBudgetError`, rather than dying halfway with an
  arbitrary half of the repo's blockers written and no way to repair them (an
  import never updates a story it already created). The gate is on the budget
  *observed*, not on whether a token was passed — a shared or CI PAT near its
  ceiling is exactly the case it exists to catch — and only the anonymous message
  advises `--token`. A host that publishes no budget header cannot be gated. This
  is the one place the stage fails the run rather than degrading: the refusal is
  pre-flight, so nothing has been written and re-running without `deps` (or with
  a token) is a clean retry — where a *partial* stage is unrepairable. This
  preflight is **CLI-only and not an engine divergence**: the server always holds
  the platform PAT, so it has no 60/h ceiling to cross.

  **A `--dry-run` spends the same requests as the real run.** `fetchAll` runs
  before the dry-run branch, so the preview cannot preview its own cost without
  paying it: for an anonymous run past roughly 28 issues, preview-then-import is
  self-defeating — the dry run consumes the budget the real run is then refused
  for. The dry-run note says so.

There is deliberately **no** milestones endpoint: every issue row already embeds
the milestone fields the mapping reads, so `--include …,milestones` adds no
request at all (see "Milestones → epics" below).

`owner` and `repo` are URL-encoded into the request path, so metacharacters in
`--repo` yield a well-formed request (and a clear repo-not-found error), never
a mangled query string. Pagination refuses a `Link` rel=next URL that is
unparseable or whose origin differs from the API base — the `Authorization`
header never leaves the API origin — and a 200 body that is not a JSON array
is a fetch error, not an empty page.

Anonymous requests share GitHub's 60 req/h budget; a mid-sized *flat* repo
(~1,000 issues) stays ~15–25 requests. Two stages scale past that: sub-issues
scale with the repo's *shape* — a repo with ~55 parents exhausts the anonymous
budget on that stage alone, which is why it degrades instead of failing and why
`--token` is what the warning names — and `--include deps`, which has no rollup
to gate on and so bills every issue, making it the larger term whenever it is on. `--token` / `GITHUB_TOKEN` is sent as
`Authorization: Bearer` and raises the ceiling to 5000/h (and reaches private
repos). Error mapping: 404 → repo-not-found; rate limits — HTTP 429, a 403
with `x-ratelimit-remaining: 0`, or a secondary-limit 403 carrying
`retry-after` — → rate-limit (the message prefers `retry-after` when present,
falling back to the `x-ratelimit-reset` time); 401 → token rejected.

#### GraphQL transport — present, not yet wired

The server engine moved its issue fetch to GraphQL (server story #47449) and the
direct engine is following it (tracker story #57629). The transport primitive
lands first: **no fetch stage calls it yet.** Every listing above is still the
REST path, and a run's observable behaviour — request count, rows, errors — is
unchanged by its presence. The listing queries, the REST-shape rename layer and
the removal of the REST issue path are separate stories.

The transport (`src/github-graphql.js`) is one `POST {apiBase}/graphql` carrying
`{ operationName, query, variables }` under
`Accept: application/vnd.github+json`. **The token rides the
`Authorization: Bearer` header only** — never the query, never the variables,
never an error message, never a log line: the same invariant the server states
for its own `graphql()`, restated here because moving transports is the one
change that could break it. A token is not optional the way it is for the REST
listings: GitHub's GraphQL endpoint answers an anonymous request `401`, which
maps to token-rejected; the transport has no separate anonymous mode, and the
constructor refuses a missing or empty token outright rather than spend a
round-trip to be told. The POST also refuses redirects (`redirect: "error"`)
instead of following one — a redirect target's envelope would otherwise be
parsed as trusted GitHub data, the same confinement the REST path applies to an
off-origin `rel=next`.

GraphQL answers most refusals with HTTP 200 plus an `errors` array, so the
envelope carries its own classification onto the **same** error hierarchy the
REST path uses. The first error in the array decides, matched
case-insensitively, exactly as `classify_gql_errors` does on the server:

| GraphQL `errors[0].type`             | Error                              |
| ------------------------------------ | ---------------------------------- |
| `RATE_LIMITED`                       | rate-limit                         |
| `NOT_FOUND`                          | repo-not-found                     |
| `FORBIDDEN`, `INSUFFICIENT_SCOPES`   | token rejected                     |
| `UNAUTHORIZED`, `BAD_CREDENTIALS`    | token rejected                     |
| anything else                        | fetch error, quoting the message   |

A `data.repository` that is present and `null` is GraphQL's other way of saying
404, and maps to repo-not-found too. A 200 that is not a GraphQL envelope (a
JSON array, a bare `null`, a proxy's HTML), an `errors` field that is not an
array, and an envelope whose `data` is missing or itself an array are all fetch
errors naming an "unexpected response shape". HTTP statuses keep
the REST mapping above unchanged — 404, the `x-ratelimit-remaining: 0` /
`retry-after` rate-limit discrimination, 401, and the generic `>=400` with the
body scrubbed of control characters — because both transports call the same
status mapper, not a copy of it. A repo-not-found carries `status = 404`
whichever route raised it (an HTTP 404, a `NOT_FOUND` error, or
`repository: null`), so a caller inspecting it cannot tell the transports apart.

**One status divergence, named.** A bare HTTP 403 — budget left, no
`retry-after` — stays a generic fetch error here, where the server's
`http_status_error` maps `403 => Forbidden`. It follows from both transports
keeping today's REST status mapping rather than growing a GraphQL-only copy of
it; the cost is wording on an already-failed run (SAML enforcement or an IP
allow-list reads as an unclassified fetch error rather than "check your token"),
never a different row.

**The transport does not retry a rate limit.** The server re-issues a
rate-limited request after the advertised `retry-after`, or after a one-minute
floor when the header is absent, for at most three attempts — abandoning the
wait when it would exceed two minutes, since that is the hourly budget resetting
rather than GitHub's secondary limit (its story #145337). This transport
classifies such a refusal identically and then raises it. Tracked as story
#259659; until that lands, a run meeting the secondary limit stops where the
server engine would have waited it out.

**The point budget is a separate bucket.** GraphQL bills 5000 *points* per hour,
scored on the nodes a query returns; it does **not** draw on the REST request
budget that the releases and `--include deps` stages spend, and the two are not
interchangeable. The transport reads `rateLimit { remaining resetAt }` whenever a
query asks for one and warns on stderr at 100 points or fewer — **once per
client**, not once per query, since that stream is the one the progress line
redraws with `\r`; the server-supplied reset time is scrubbed of control
characters and capped before it is printed, like every other server string.
Nothing feeds that number into the `--include deps` preflight above, which still
gates on the REST `x-ratelimit-remaining` its own responses reported.

**No schema degradation, deliberately.** The server drops an optional selection
when a host refuses it. Since its story #146020 that is three independent flags
(`dependencies`, `sub_issues`, `issue_type`) where a refusal costs only the field
it names — replacing the linear `Full` → `NoSubIssues` → `Core` ladder it used to
walk. The direct engine omits the whole apparatus: the server's own
import-mapping doc still marks the GHES GraphQL endpoint unreachable (a gap
raised 2026-08-10, unresolved), so the fallback is aspirational there and
untestable here. The consequence is precise — an `undefinedField` error, or one
whose message says a field "doesn't exist on type", lands in the generic
fetch-error bucket instead of triggering a retry, and so does a refusal GitHub
scopes to a single field through the error's `path`.
**This is an intended omission, not engine drift**; should a reachable GHES
appear, the per-field degradation is the thing to port.

### Default mapping profile (issues → stories)

The direct engine maps fetched GitHub JSON to an EAT write-op plan client-side
(`src/mapping.js` — pure functions, no HTTP), mirroring the server importer's
issue mapping so both engines classify the same repo identically — with three
deliberate exceptions, the closed-reason state and labels, the org issue type
and the sub-issue cross-links below, which only the direct engine produces.

Each exception exists because the server's `GhIssue` never deserializes the
field (or, for sub-issues, never requests it), not because the two engines
disagree about the mapping. Each is tracked for the server side, after which
the exception list should shrink to nothing: tracker
[#33135](https://eastagiletracker.com/projects/5/stories/33135) (closed
reason), [#33136](https://eastagiletracker.com/projects/5/stories/33136)
(issue type), [#33137](https://eastagiletracker.com/projects/5/stories/33137)
(sub-issues). Everything below that is *not* on that list is mirrored, and
`tests/parity.test.js` holds each mirrored path to the expectations the
server's own Rust unit tests assert, so the claim fails a gate rather than
drifting in prose.

- **State** — open issue → `unstarted` story; closed → `accepted`, keeping the
  GitHub closed date (`completed_at`) — except for the abandoned closed reasons
  below, which land `rejected`.
- **Closed reason** (**direct engine only** — the server importer never reads
  `state_reason` and flattens every closed issue to `accepted`) — a closed
  issue's reason decides both the state and a label. `not_planned` and
  `duplicate` are *abandoned* work, not delivered work: they land `rejected`
  (keeping the closed date) and earn a `not-planned` / `duplicate` label, so a
  board filter can still tell closed-as-done from closed-as-wontfix. This
  follows the tracker's own cross-connector rule — `import/common.rs`'s
  `map_status` maps `wontfix` and `duplicate` to `rejected` for every other
  source (story #29516), and `rejected` is seeded `done_state = 0` where
  `accepted` is `1`, so accepting a wontfix would credit the team's velocity
  with work nobody did. **A chore is the exception**: the server's
  `valid_states_for_type` gives chores only `unstarted`/`started`/`accepted`, so
  a chore closed as `not_planned` stays `accepted` and carries the label alone.
  Matching is on GitHub's exact lowercase spelling. The mapping is total —
  `completed`, `reopened`, an absent or non-string reason, a differently-cased
  one, any reason GitHub adds later, and a `state_reason` on an open row all add
  no label and leave the state `accepted`. Reason labels go through the label pipeline below (no
  hard-coded color, case-insensitive dedup), so an issue already carrying a
  same-named repo label keeps that label's casing and color and gains nothing.
  The label is this mapper's own classification, not the author's, so it is
  added *after* type inference has read the issue's labels and can never change
  a story's type. Only issues imported after this landed carry a reason label or
  the `rejected` state — an import appends and never updates, and "Marker dedup"
  below skips stories already imported, so on an existing board every closed
  issue keeps the `accepted` it was given and no repair pass exists.
- **Issue type** (**direct engine only** — the server importer's issue struct has
  no `type` field, so serde drops it and the server always infers) — GitHub
  organizations can define issue types; every REST issue row from an org repo
  carries a `type` (null when unset), while personal-account repos and older
  GitHub Enterprise Server omit the key entirely. The fetcher already downloads
  it, so reading it costs no extra request. A recognised `type.name` classifies
  the story outright: `Bug` → `bug`, `Feature`/`Enhancement`/`Task` → `feature`,
  `Chore` → `chore`.
  - **`Task` types as `feature`, not `chore`**, deviating from the story's
    original acceptance criteria. GitHub seeds every new organization with
    exactly `Bug` / `Feature` / `Task`, so `Task` is the catch-all for ordinary
    product work. Typing it `chore` would put that work in EAT's unpointed
    bucket, outside velocity — where before this rule existed it defaulted to
    `feature` — and would make the two engines disagree on the most common org
    type of all: the server never reads `type`, so `infer_story_type`
    (agile-tracker `common.rs`) types a `Task` issue carrying no chore-ish label
    and a neutral title as `feature`. Only an explicit `Chore` type yields a
    chore.
  - Type names are org-authored free text, not a GitHub enum, so the match is
    case-insensitive on the trimmed name (`bug`, `BUG` and `" Bug "` all
    classify) — unlike the closed-reason table above, which matches GitHub's own
    lowercase spelling exactly. The match is also **exact, not substring**, which
    is a second divergence worth naming: an issue typed `Bug Report` does not
    classify and falls through to the inference, where a *label* named
    `Bug Report` would make the story a bug (the inference matches substrings).
  - The mapping is total: an unrecognised name, `type: null`, an absent `type`, a
    `type` that is not an object and a `name` that is not a string all fall
    through to the inference below, leaving that output identical to v3. A run
    whose in-scope issues carry unrecognised names warns once, with the **count
    only** — the name is only ever a lookup key, so no org-authored text reaches
    the terminal from this path.
  - Precedence, highest first: an explicit `--story-type feature|bug|chore` (the
    member's own instruction for the whole run), then `type.name`, then the
    inference. Only issues imported after this landed carry type-derived story
    types — an import appends and never updates.
- **Type inference** (labels + title, bug checked first) — the fallback when the
  org set no issue type. A label containing `bug`/`fix`/`defect`, or a title
  starting with `fix`/`bug` → `bug`; a label containing
  `chore`/`maintenance`/`devops`/`infra` → `chore`; else `feature`. It reads the
  issue's own labels only: both the closed-reason label above and any other label
  this mapper synthesises are added after typing, so neither can reclassify a story.
- **Labels** — names trimmed (blank dropped); duplicate names on one issue
  collapse case-insensitively, the first spelling winning, so a story never
  lists the same label twice (EAT get-or-creates labels case-insensitively, so
  the collapsed spellings would have resolved to one label anyway); colors
  normalized to lowercase `#rrggbb` (anything else dropped, never an error)
  with a perceptual-luminance text color (black on light, white on dark). The
  issue payload's own color wins; the repo label list fills gaps. Only labels
  on mapped issues are created.
- **Sub-issue cross-links** (**direct engine only** — the server importer's issue
  struct has no `sub_issues_summary` and it never calls `/sub_issues`, so serde
  drops the field and the server produces no such text) — EAT has no native
  parent/child story relation, so the hierarchy rides in the description. A
  parent's description gains a `Sub-issues: #12, #14` line; each child's gains a
  `Sub-issue of #7` line. A row that is both gets both, **parent line first**,
  as one two-line block. The block is separated from the issue body by a blank
  line and is the description's **last** paragraph — the dedup marker is
  appended after it at write time and stays the last line, so "Marker dedup"
  below is unaffected. An issue with an empty body gets the block as its whole
  description.
  - **Numbers only, never remote text.** A reference renders only when it is a
    string of digits (the fetcher emits nothing else); anything else is dropped
    rather than rendered, so no org-authored text can reach a description
    through this path.
  - **Order** — children appear in GitHub's own `/sub_issues` order, which is
    the order maintainers set in the UI; the fetcher only concatenates pages.
  - **The mapping is total.** A self-reference is dropped from both directions;
    a repeated number renders once; an issue a payload somehow reports under two
    parents names the **first** parent only, so a story never carries two parent
    lines. An issue in no relation gets a description byte-identical to before
    this rule existed.
  - **A linked number may name an issue this run did not import.** The block is
    computed from what GitHub declares, not from what survived `--states` /
    `--milestones` — so a parent still lists a child the filters excluded, and a
    child still names a filtered-out parent. The references are GitHub *issue
    numbers*, not EAT story ids: they match the imported story's `external_id`
    when the issue was imported and point at a real GitHub issue either way, and
    the text a story carries does not depend on which run created it.
  - **The clamp cuts the body around the block, never the block itself.** The
    block is the description's tail, so a naive clamp would make it the *first*
    thing lost — and precisely on umbrella issues, the ones with both long bodies
    and children. Since an import never updates, that loss would be permanent and
    one-sided: the children would still say `Sub-issue of #7` while the parent had
    forgotten them. So "Length limits" below reserves the block's bytes (on top of
    the dedup marker's) and truncates only the issue body, re-appending the block
    intact; the `description truncated` warning still fires for the body. Only if
    the block alone would exceed the whole limit does the clamp fall back to
    cutting everything. Only issues imported after this landed carry cross-links.
- **Checklists** — `- [ ]` / `- [x]` items (also `*`/`+` markers, indentation
  allowed) become story tasks; the lines stay in the description verbatim. They
  are parsed from the issue body alone, never from the cross-link block.
- **Comments** — joined to their issue by `issue_url`. The fetcher has already
  dropped PR conversation comments by the same key, and the join keeps any
  stray unmatched comment inert (its issue is never mapped). The body is stored
  with **no prefix** (leading/trailing whitespace trimmed — a CLI-side
  normalisation) and the author rides on the write's own `author` field, like the
  server engine's. That needs *both* person and backdating support: whenever the
  comment's date cannot ride on the write, the body is prefixed
  `@<login> on <YYYY-MM-DD>:` so the date is not lost (`@<login>:` when the date
  does ride but people do not; deleted accounts render as `@ghost`) — see "Comment
  authorship" under *Fidelity limitations*.
- **People** — the issue author becomes the story's `requestor` and the
  assignees its `owners`, both as `ExternalPersonInput` (see *GitHub identity
  mapping (both engines)* above). Releases carry neither.
- **Identity** — `external_id` is the issue number as a string. GitHub numbers
  issues and PRs in one space, so a PR needs no namespace of its own (unlike a
  release's `release-<id>`); rows carrying a `pull_request` key are dropped
  unless `--include prs` is on (see "Pull requests → stories" below).

The CLI legend's `issues` lines are assembled by this module's own renderer,
whose default output is what the `MAPPINGS` registry re-exports — the registry
entry is that render path's product, not a parallel copy, so legend and mapper
cannot drift. The server engine's legend output stays byte-identical. The
closed-reason, issue-type and sub-issue lines are the exceptions — they render
only under `--engine direct`, because the server importer flattens every closed
issue, never reads `type`, and never fetches `/sub_issues`. The issue-type line
names every name the table classifies because it is built from that table, and
the sub-issue line quotes the same two prefixes the description assembly
renders, so neither can be left describing text the mapper no longer produces.

The legend describes the mapping, not the selection: a *filter* never drops a
line, so `--states open` still shows both the closed-state line and the
closed-reason line. A *mapping override* does, because it turns the described
rule off for the whole run — `--no-comments` / `--no-tasks` drop their lines, and
`--story-type feature|bug|chore` drops the issue-type line (the rule is dead for
that run; the `Customized:` block names the override instead). `--story-type
infer` is the default, so it keeps the line. No override turns the sub-issue
rule off, so its line renders for every `--engine direct` run.

### Pull requests → stories (direct engine)

Opt-in via `--include prs` (the server engine's `include_pull_requests`, server
story #26313). Off, every byte the engine fetches, maps and writes is what it
wrote before PRs existed: the PR rows are dropped at the fetch, so nothing
downstream sees them.

The mapping mirrors `github.rs` `issue_to_record`'s PR branches exactly;
`tests/parity.test.js` pins each rule against that module's own Rust assertions.

- **State** — open PR → `started`; merged PR → `accepted`; closed-unmerged PR →
  `rejected`. Merge state is read from the listing row's
  `pull_request.merged_at` (non-null ⇒ merged), never from a per-PR fetch. A
  closed PR keeps its GitHub closed date the way a closed issue does, but only an
  `accepted` create carries it on the wire (see *Length limits* → the write rule
  below). An **open** PR additionally carries its own `created_at` as its
  `started_at` (`github.rs:1186`), so its history is the importer's single
  `NULL → started @ created`; a closed PR of either kind carries none — see
  *Started dates* under *Fidelity limitations*.
- **`state_reason` never applies to a PR.** The closed-reason state and labels
  are computed `if closed && !is_pr`, so a PR closed `not_planned` is still
  `rejected` because it was not merged, and one closed `duplicate` after a merge
  is still `accepted`. A PR never earns a `not-planned` / `duplicate` label.
- **The chore carve-out does not apply either.** The closed-reason branch is
  gated on the type accepting `rejected` (a chore has no such state in
  `valid_states_for_type`), but the PR branch is ungated — the server writes a
  closed-unmerged chore PR `rejected`, and so does the direct engine. The public
  `POST /stories` resolves `story_type` and `current_state` independently and
  applies no per-type state check on create (`handlers/stories.rs::create`; the
  per-type table gates *transitions*), so the create accepts it.
- **A synthetic `pull-request` label** rides on every PR story. It is added
  *after* type inference has read the author's own labels, so it can never
  reclassify the story; it goes through the normal label pipeline, so a repo
  label of the same name keeps its casing and colour and the label is not
  doubled. The server importer reaches the same rows by a different route — its
  `labels.push` is unconditional (`github.rs:993`), and the duplicate is absorbed
  by the lowercase-keyed label cache plus `INSERT INTO story_has_label … ON
  CONFLICT DO NOTHING` (`common.rs:2192`, `:1928-1934`) — so this is not an
  engine divergence, only a difference in where the deduplication happens.
- **People** — the PR's creator is the story's `requestor` **and** an owner (they
  authored the work), appended after the assignees and deduplicated on the
  numeric GitHub id, so a creator who is also an assignee is one owner.
- **Links** — the PR's own `html_url` is attached to its story as a
  `link_type: "pull_request"` link (server story #30751), not as description
  text. When a PR's body closes an imported issue, that PR's URL is also attached
  to the *issue's* story (server story #26528), deduplicated per issue by URL.
  Closing references are detected keyword-only, mirroring
  `parse_closing_issue_refs`: `close`/`closed`/`closes`/`fix`/`fixed`/`fixes`/
  `resolve`/`resolved`/`resolves`, word-bounded, `:`/whitespace tolerated before
  a same-repo `#N`. Like the server's, the detection misses PRs linked only via
  GitHub's UI "Development" panel and cross-repo (`owner/repo#N`) references.
- **The #26313 fold** — a **merged** PR whose body closes an imported issue that
  is itself `closed` in the snapshot resolved that issue (GitHub only auto-closes
  on merge), so it writes **no** second story: the issue is the single story, and
  the PR's URL lands on it as the link above. The fold is gated on the issue
  being closed — a still-open one means the merge did not resolve it (a race, or
  a manual reopen), so that PR keeps its own `accepted` story and the link is
  recorded anyway.
  - **What the fold discards.** A folded PR has no story, and nothing of its own
    is moved onto the issue's story: its conversation comments, its repo labels
    (including the synthetic `pull-request` one), its creator-as-owner, its dates
    and its body are all dropped. Only its URL survives, as the link above. This
    mirrors the server importer, which filters the folded numbers out *before*
    fetching comments and before `issue_to_record` runs (`github.rs:477-482`), so
    both engines lose the same thing — but it is real data loss the bullets above
    would not lead a reader to expect.
- **Comments** — a PR's conversation comments attach to the PR's own story, by
  the same `issue_url` join issues use. A folded PR has no story, so its comments
  are dropped rather than moved (see *What the fold discards*).
- **Filters and overrides** — `--states` / `--milestones` select PR rows the same
  way they select issues, and the warning counts (`no fetched issue matches this
  run's filters`, the milestone note) count PR rows once `--include prs` is on —
  minus the folded ones, which write no story. The fold and the links are
  computed over the rows a run actually maps, so a PR is never folded into an
  issue a filter excluded — there would be no story to fold it into. No
  `--customize` choice switches the PR mapping off.

The legend's `prs` block keeps the three lines the server engine has always
printed and adds the two link lines under `--engine direct`, the way the
milestones and releases blocks do.

### Milestones → epics (direct engine)

`--include …,milestones` maps each GitHub milestone to an EAT **epic**, mirroring
the server importer's `issue_to_record` + `get_or_create_epic_label`
(agile-tracker `github.rs` / `common.rs`) so both engines group a repo the same
way. In EAT an epic *owns* a label and a story belongs to the epic by carrying
that label, so the label is the whole join:

- **Title — the milestone's own `title`, trimmed.** It is both the epic's name
  and its backing label's name; the server uses the same string for both, with
  no prefix and no `milestone:` namespacing. A milestone whose title is blank,
  whitespace-only, or not a string yields **no** epic and **no** label — the
  server's `Some(m) if !m.title.trim().is_empty()` guard.
- **Description** — the milestone's state and due date, in the server's exact
  format: `GitHub milestone — State: open, Due: 2024-12-01` (em dash U+2014;
  state first, then due; `due_on` trimmed to its `YYYY-MM-DD` prefix). Either
  part alone renders alone; neither leaves the description NULL. The legend's
  example is rendered by that same builder, so it cannot describe stale text.
  Epics carry no state column, so **a closed milestone does not close or archive
  its epic** — `State: closed` in the description is the only trace.
- **A milestone can never reclassify a story.** The epic's label is added after
  type inference has read the issue's own labels, exactly like the closed-reason
  label — a milestone called `bugfix` does not make its stories bugs.
- **One epic per milestone, keyed case-insensitively**, like the server's
  `epic_by_title` cache and EAT's own `lower(label_name)` unique index. The
  first spelling encountered wins and every story in that epic carries that one
  name, so two issues whose milestone differs only in case still share one epic.
- **Titles are cut to 255 bytes** — `POST /epics` validates `name` with Rust's
  `str::len()` and both columns are `varchar(255)`. The cut happens at map time,
  before the dedup key, so the epic and the label its stories carry are always
  the same string (the server truncates before keying too). Two milestones
  agreeing on their first 255 bytes therefore **collapse into one epic**; that
  merge is not silent — the run warns, with the count of over-long titles.
- **Only milestones a mapped story carries become epics.** The epic set is
  derived from the issues that survive `--states` / `--milestones`, so a
  milestone no imported issue references creates nothing. That is the server's
  rule (it reads `issue.milestone`, never a milestone listing) and it keeps
  `--milestones v2.0` from seeding empty epics for the milestones it excluded.
  Being a *selection* filter, `--milestones` narrows which epics exist but never
  drops a milestone legend line.
- **No extra GitHub request.** Every issue row from
  `GET /repos/{owner}/{repo}/issues` embeds its milestone with the three fields
  the mapping reads (`title`, `state`, `due_on`) — the same three the server's
  `GhMilestone` deserializes — so `/repos/{owner}/{repo}/milestones` is **never**
  requested and a run's GitHub request count is unchanged by the flag.
- **Get-or-create is the CLI's job.** Unlike the server's internal writer, the
  public `POST /projects/{id}/epics` does **not** dedup: a title matching an
  existing epic *or* an existing plain label is a `409 conflict`. So the writer
  lists `GET /projects/{id}/epics` first (a bare array, no pagination) and posts
  only the titles that listing does not already carry, matched on
  `LOWER(TRIM(epic_title))` — the server's own key, applied to both halves by one
  function so a plan key can never drift from a listing key (the title is
  re-trimmed after being cut to 255 bytes, since the cut can land on a space the
  server would then trim away). A `409` on the create is not swallowed, and it is
  **read, not guessed**: the body already names which kind of row holds the title.
  `Epic '<t>' …` means another writer got there first → counted *existing*, with
  no second read. `Label '<t>' …` means a plain label holds it and no epic can
  ever be made → the run warns, naming the title, and continues: the stories
  still carry the label, so they stay grouped. Only a 409 naming neither falls
  back to re-reading the listing, and the warning it prints then hedges, because
  nothing has established the cause. An `idempotency_conflict` 409 is never
  mistaken for any of these and still fails. A `GET /epics` body that is **not** a
  bare array is an error, not an empty project — reading an envelope as "no epics"
  would POST every epic, 409 it, re-read nothing, and report every milestone
  blocked, on every run.
- **Epics are written before labels**, so the epic's backing label (auto-created
  by `POST /epics` with the server's deterministic colour) claims the name first
  and a same-named GitHub label folds into it as a `409 conflict` → *existing*.
  The consequence, and the one deviation from the server's internal writer: when
  a repo has both a milestone and a label of the same name, the label wears the
  epic's colour here, where the server's promotion path keeps GitHub's.
- **Epics are not counted.** `ImportCounts` is `{stories, labels}` and the
  server counts neither an epic nor its backing label; the direct engine matches —
  the epic title never enters the plan's label set. A GitHub label that *shares* a
  milestone's name is the one place the flag changes the reported total: because
  epics are written first, `POST /epics` creates that name as the epic's backing
  label, so the run's own `POST /labels` 409s into *existing* and the label total
  is **lower by one per collision** than the same run without the flag. The
  `--dry-run` preview subtracts the same collisions, so preview and run always
  agree — a preview that reported the pre-flag total would misstate the run it
  previews.
- **A re-run creates neither a duplicate epic nor a duplicate label.** Epics are
  pruned to those a *surviving* story still carries, so a fully-skipped re-run
  plans no epic work at all and makes no epic request; a partially-new run finds
  the epic in the listing and reuses it. `epic_desc` is written **only on
  creation** on both engines, so a reused epic keeps its original note even if
  the milestone's state or due date has since changed — an import never updates.
- **The pruning is announced, because it is not repairable.** An import never
  re-labels a story already in EAT, so an issue imported *without* the flag can
  never join an epic; adding `--include …,milestones` afterwards would otherwise
  do nothing and say nothing. Under the flag the prescan therefore also reads each
  already-imported story's `labels`, and the run warns in two shapes: one for
  milestones whose every member is already imported unlabelled (the epic is not
  created, and the only repair named is deleting those stories and re-running),
  and one for an epic that *is* created but holds fewer than its members (naming
  how many are missing). A member the prescan shows already wearing the label was
  grouped by an earlier flagged run, so it is silent — a healthy re-run prints
  neither warning. `epicDescription` is clamped like every other plan text field,
  since the epic stage runs before the first story write.
- **Without the flag the direct engine imports the milestone as nothing.** This
  is a deliberate divergence: with `include_milestones` off the *server* reverses
  its own mapping and pushes a synthetic `milestone:<title>` label instead
  (`github.rs`), while the direct engine's default profile must stay
  byte-identical to what it produced before this rule existed — synthesising
  labels by default would silently change every existing direct-engine board.
  So the loss is announced instead: a run whose in-scope issues carry milestones
  prints one `note:` naming the count and the `--include` value that adds
  `milestones` **to that run's own selection** (so advice followed verbatim never
  drops a type the run already had), and says plainly that a later run groups only
  the issues it imports itself. The count only — milestone titles are
  author-controlled text, and this path never renders one.
- The mock server mirrors both epic endpoints, the 409-on-duplicate behaviour
  (epic *and* plain-label collisions alike), the backing-label auto-create, and
  both documented length limits, so the get-or-create path — and the title
  truncation that exists to stay inside `name` ≤ 255 bytes — is exercised against
  a server that really refuses.

### Releases → release stories (direct engine)

`--include …,releases` adds one `release`-type story per GitHub release,
mirroring the server importer's `release_to_record` (agile-tracker
`github.rs`) so both engines classify a repo's releases identically:

- **Title — the tag, never the release's own name.** `tag_name` → the story
  name, byte-for-byte and **untrimmed**, because the server's own mapping is a
  bare `title: release.tag_name`. GitHub releases also carry a human `name`
  ("2026-07-08, Version 26.5.0"); the server importer's release struct has no
  `name` member at all, so it is never read, and the direct engine does not read
  it either. Using either would give the two engines different titles for the
  same release.
- **Notes** — `body`, trimmed; empty or whitespace-only notes store no
  description (NULL), like an empty issue body.
- **State** — a **published** release (`draft` is not true **and**
  `published_at` is a real **RFC3339** instant) → `accepted` with
  `completed_at = published_at`, so the shared date rule buckets it into the
  matching historical iteration like a closed issue. Anything else — a
  **draft**, a row with no `published_at`, or one whose `published_at` is not a
  sendable timestamp — → `unstarted`, in the backlog. A readable date, not mere
  presence, is the test on both sides: the server runs the field through
  `parse_source_datetime`, which yields "no date" on anything it cannot read,
  and forwarding such a value instead would be a `400` that aborts the run.
  The direct engine is bounded *more* tightly than the importer here, and has to
  be: it does not parse the date, it forwards the string into `POST /stories`,
  whose `created_at` / `completed_at` are `Option<DateTime<Utc>>` and therefore
  deserialize **RFC3339 only**. So the handful of shapes the importer's lower
  rungs still accept — a bare `2026-07-08`, a naive `2026-07-08 11:59:40`,
  `Jul 8 2026` — are dropped here rather than sent, and a syntactically valid
  but impossible instant (`2026-02-30T00:00:00Z`, which JS silently rolls into
  March) is dropped too. GitHub's API only ever emits RFC3339, so no real
  release loses its date to this; the bound exists so a proxy or a mock cannot
  turn one odd row into a failed import.
  **Drafts are imported, not skipped** — that is the server's mapping, and
  skipping them would make a re-import with the flag on produce different rows
  per engine — but see the listing note above: **drafts reach either engine only
  when the token has push access**, so on a public repo read anonymously this
  branch never runs.
- **`created_at`** — the release's own `created_at` on both branches, under the
  same RFC3339 rule as `published_at` (unsendable → no date), and subject to the
  backdating feature-detect under "Fidelity limitations".
- **No estimate, ever.** The `release` story type is seeded with
  `allow_points = false`, so no `estimate` is sent on the create.
- **No prerelease axis.** The server never deserializes `prerelease`, so a
  prerelease is an ordinary release here too; published-or-draft is the only
  distinction either engine draws.
- **Identity** — `external_id` is `release-<id>`, where `<id>` is the GitHub
  Release object's own numeric id (not the tag, not an index). See "Marker
  dedup" below for why it is namespaced.
- **The issue customization does not reach releases.** `--states` and
  `--milestones` select *issues*; `--story-type` sets the type of every
  imported *issue*, and `release` is the type that defines a release story, so
  none of them alters, filters, or retypes a release. `--no-comments` /
  `--no-tasks` have nothing to act on: a release story is created with no tasks
  and no comments. Consequently a run whose filters match no issue but which
  still imports releases says so — the "nothing to import" warning becomes "no
  issues to import; the run would import up to N release(s)". "Up to": that
  count is taken before the prescan, so a re-run may already hold some of them.
- **A release that cannot be written is reported, not dropped in silence.** A
  row whose `id` is not a positive **safe** integer has no usable re-import key,
  and a row with a blank `tag_name` has no story name (a `400 validation_failed`
  that would abort the whole run rather than lose one row). Both are left out of
  the plan and counted in one stderr warning naming both causes. The safe-integer
  bound is what makes the key trustworthy: past 2^53 two distinct GitHub release
  ids round to one JS number — one `external_id` **and** one `Idempotency-Key`,
  so the second create would replay the first and lose a release while the
  imported count still said two — and from 1e21 the id renders in exponential
  notation (`release-1e+21`), which the marker regex cannot read back, so every
  re-run would duplicate that row on a provenance-off server. Real GitHub
  payloads carry none of these shapes; the guard exists so a proxy or a mock
  cannot make a release vanish quietly.
- **Legend** — the `releases` block is rendered by the same registry entry the
  server engine uses, so `--engine server` prints exactly the line it always
  has. `--engine direct` adds one line for the draft rule (which, per the
  listing note, only a push-access token can actually exercise). As with issues,
  no customization drops a release line, because none of them switches the rule
  off. `--story-type` reads "all issues &lt;type&gt;" in the `Customized:` block,
  not "all": the override retypes issues and never touches a release.

### Issue dependencies → story blockers (both engines)

Under `--include …,deps` each issue's GitHub "blocked by" dependencies become
`blocker` rows on its story. This is a **both-engines** type: the server ask
(EAT #35491) shipped before this CLI story, so the direct engine mirrors
`github.rs` rather than inventing anything. Every mapping rule below matches;
two *write-side* divergences are named at the end of this section, and both are
pinned by `tests/parity.test.js` rather than asserted here.

**The server engine is capability-gated.** `include_dependencies` reached the
server on 2026-08-04 and `ImportJsonRequest` has no `deny_unknown_fields`, so a
tracker that predates it would accept the flag, ignore it, and report a
successful import with no blockers at all. `--include …,deps` on `--engine
server` therefore probes `GET /openapi.json` for `include_dependencies` on the
import body (`EATClient.supportsDependencyImport`, the same shape as
`supportsServerDryRun`) **before the legend is printed**, and refuses the run —
exit 1, nothing written, no legend promising blockers — when it is absent,
naming `--engine direct` and dropping `deps` as the two ways forward. A server
that publishes no spec counts as "not supported", as it does for every other
probe.

- **Text** — `Blocked by #<number> (<title>)`, the blocking issue's title
  **trimmed**, and `resolved: false`. Byte-identical to `blocked_by_desc` up to
  the length clamp, which is the first divergence listed below. A
  dependency row's `number` and `title` are both `#[serde(default)]` server-side,
  so a row with no title renders `Blocked by #90 ()` rather than being dropped.
- **Selection** — one blocker per `blocked_by` entry, in GitHub's own listing
  order. Rows whose `number` is not a positive integer are skipped (`#[serde(default)]`
  covers a *missing* number, which becomes 0 and the same guard drops; a
  present-but-wrong-typed one is a serde error server-side, failing that whole
  page, where the CLI drops the single row and keeps the rest), and repeats are
  deduplicated by number across pages, the first title winning.
- **Scope** — a blocker is recorded whether or not the blocking issue is itself
  imported: the server never intersects `blocked_by` with the import set, so
  neither does the CLI. An issue with an empty listing, or one whose listing
  degraded, gets no blockers at all — indistinguishable, by design. Releases
  carry none: `release_to_record` leaves the list empty.
- **Re-runs add nothing.** Blockers hang off the story create, and a re-import
  skips an already-imported story entirely, so its blockers are never written a
  second time — the same guarantee the server's own re-import test asserts. Since
  an import never *updates*, a dependency added on GitHub after the first import
  never reaches EAT; delete the story and re-run to pick it up.
- **Counting** — blockers are not stories, so no import total moves. The result
  line's story and label counts are identical with and without the flag.
- **Legend** — the `deps` block is rendered by the same registry entry both
  engines use, from `blockedByDesc` itself, so the legend cannot drift from what
  is written. Both engines print the unimported-blocker note, because
  `github.rs` does not intersect `blocked_by` with the import set either.
  `--engine direct` adds one further line — the per-issue request cost, quoted as
  a lower bound — since only the direct engine spends a caller's own GitHub budget.
- **Two write-side divergences**, both a consequence of the public API's shape
  rather than of a mapping choice:
  - **Length is clamped in bytes, not characters.** `POST /blockers` validates
    with `validate_length` → Rust's `str::len()`, so the CLI cuts `blocker_desc`
    at 255 **bytes** (never splitting a character); the server importer writes
    the column directly and cuts at 255 **chars** (`desc.chars().take(255)`).
    For a multi-byte title between 256 bytes and 255 chars the two engines write
    different text — the CLI's is a prefix of the server's. The CLI's behaviour
    is the only one the public route accepts; server ask **#35629
    (/s/y9q8ea68)** tracks reconciling the two ends.
  - **`blocker_display_order` is not settable from the CLI.** `CreateBlocker` is
    `{ blocker_desc, resolved }` and `blockers.rs` INSERTs
    `(story_id, blocker_desc, resolved)`, leaving the column at its
    `NOT NULL DEFAULT 0`; the server importer writes the entry index. So every
    direct-engine blocker lands at 0 where a server-engine one carries its
    position, and the story-list projection — which orders by
    `blocker_display_order` with no tiebreaker — returns direct-engine blockers
    in unspecified order. The writer still posts them sequentially in GitHub's
    `blocked_by` order, because insertion order is all it controls. Server ask
    **#35639 (/s/kp82mw25)** tracks both halves — a settable order on the public
    create, and a tiebreaker on the projection.

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
- **`GET /epics`** → 200, a **bare JSON array** (no cursor page, no `Link`), one
  row per epic with `epic_id`, `label_id`, `epic_title`, `epic_desc`, and an
  embedded `label` object. Newer servers also publish `name` / `description`
  aliases; `epic_title` is the field every version emits, so it is the one the
  get-or-create scan matches on.
- **`POST /epics`** — body `{ "name": "...", "description": "..." }`
  (`epic_title` is an accepted request alias — the handler reads
  `epic_title.or(name)` and 400s when both are absent; a blank name is
  `400`; `name` ≤ 255 bytes, `description` ≤ 100,000). With no `label_id` the
  handler auto-creates the epic's backing label with a deterministic colour in
  the same transaction → 200 with the epic object. **It does not get-or-create:**
  a name colliding case-insensitively with an existing epic is
  `409 conflict "Epic '<title>' already exists in this project"`, and one
  colliding with a plain label is the same 409 naming `Label`. Callers must
  therefore list first and treat a 409 as "look again" — see "Milestones →
  epics" above.
- **`POST /stories`** — body requires `name` (the read side publishes it as
  `title` *and* under a `name` alias, both in the `fields=` allowlist;
  missing → `400 validation_failed`); optional `description`, `story_type`,
  `current_state`, `estimate`, `icebox`, `created_at`, `started_at`,
  `completed_at`, `import_source`, `import_external_id`, `requestor`, `owners`,
  and `labels` as bare strings or `{ "name": "..." }` objects — the server
  attaches by name, get-or-creating with default colors (unlike `POST /labels`,
  it never 409s on an existing name), and embeds the full label objects in the
  response. `current_state: "accepted"` is accepted at create time for an
  unestimated feature (verified 2026-07-16) — no estimate guard, so no
  create-then-transition fallback is needed. `current_state: "started"` is
  likewise a legal create state (what an open PR lands in). **`completed_at` is
  valid only on a create that lands *done*** (`state_rank >= finished`);
  `rejected` carries no rank at all ("rejected stays NULL by design"), so the
  writer sends `completed_at` on `accepted` creates only and omits it on every
  other state — including a `rejected` closed-unmerged PR and a `rejected`
  abandoned issue, both of which carry a GitHub closed date the plan keeps but
  the write cannot express. **`started_at` is the same rule one rank lower**
  (`state_rank >= 1`, server story #35489): valid on a create at or past
  `started`, clamped forward to `created_at`, and refused on `rejected` — so the
  writer sends it on the open-PR `started` create and omits it everywhere else.
  The five backdating / provenance fields are owner-gated, and so are
  `requestor` and `owners[].external` (`ExternalPersonInput`, server story
  #32773 — create-only: the PUT `owners` reconcile rejects `external`); see
  "Marker dedup", "GitHub identity mapping (both engines)" and "Fidelity
  limitations". The create body has **no** `scheduled_at` — that column is
  importer-only, so the direct engine cannot reproduce the planned date the
  server importer seeds on a draft release. 200 → the full story object
  (`story_id`, `title`, `current_state`, `labels`, …). `estimate` is on the
  create schema (`CreateStory`, read from `GET /openapi.json` 2026-07-29) —
  typed `["string", "null"]`, a scale *label* ("3", "½") resolved within the
  project's own effort scale, not a number — but the writer never sends it: no
  story type it creates is estimated, and `bug`/`chore`/`release` are seeded
  `allow_points = false`.
- **Story types are seeded, global reference data, so `release` needs no guard.**
  `GET /story_types` (public and unscoped — it answers unauthenticated; read
  2026-07-29) returns exactly `feature` (`allow_points: true`), `bug`, `chore`
  and `release`, the latter three `allow_points: false`. The list is global, not
  per-project, so the `release` type a release story needs is not something an
  instance or a project can be missing. `GET /meta` carries `auth`, `hint` and a
  `transitions` graph with one entry per type (`release: { unstarted:
  ["accepted"] }` — the only legal release transition, matching the server's own
  `valid_states_for_type`, which is what makes `current_state: "accepted"` legal
  on a release create); it publishes **no** `story_types` list, so there is
  nothing on that response for the writer to pre-check a type against. The direct
  engine therefore sends `story_type: "release"` and `current_state: "accepted"`
  unguarded: the type list and the legal-state table are both compiled into the
  server, not per-instance configuration.
- **`POST /stories/{id}/tasks`** — body `{ "description": "...",
  "complete": bool }` (`task_desc` is an accepted request alias; empty →
  `400 invalid_parameter`, "task_desc is required") → 200
  `{ task_id, story_id, task_desc, complete, task_order, created }`.
- **`POST /stories/{id}/comments`** — body `{ "text": "..." }`
  (`comment_text` is an accepted request alias; empty →
  `400 invalid_parameter`, "comment must have text or emoji") → 200
  `{ comment_id, story_comment_id, story_id, comment_text, created }`.
  Optional `created_at` and `author` (`ExternalPersonInput`) are both
  owner-gated by the same check (server stories #31425 / #32773).
- **`POST /stories/{id}/blockers`** — body `{ "blocker_desc": "...",
  "resolved": bool }` (`resolved` is `Option<bool>`, defaulting false; a blank
  or whitespace-only description is `400 invalid_parameter`; `blocker_desc`
  ≤ 255) → 200 `{ blocker_id, story_id, blocker_desc, blocker_display_order,
  resolved, created, expired }`. Written after the story's tasks, one sequential
  request per blocker, in GitHub's own `blocked_by` order. The route binds no
  display order — the response echoes the column's `DEFAULT 0` on every row — so
  insertion order is all the writer controls (see the deps divergences above).
  Member-gated, not owner-gated. Used only under `--include …,deps`; a plan
  carrying no blockers never touches the route, and a plan that does carry them
  is refused before the first write when the client cannot write blockers at all.
- **`POST /stories/{id}/links`** — body `{ "url": "...", "link_type": "...",
  "title": "..." }` → 200 with the link row.
  - `url` is required and trimmed; empty → `400`. It must use an **`http`** or
    **`https`** scheme (case-insensitive) — any other scheme (`javascript:`,
    `data:`, `file:`, `ftp:`, …) is `400 "url must use http or https"` — carry no
    null bytes, and fit `limits::LINK_URL` (1000 bytes). `title` is optional,
    fits `limits::LINK_TITLE` (255) and is omitted rather than sent null.
  - `link_type` is **not** free text. The server allowlists exactly
    `relates_to`, `duplicates`, `blocks`, `is_blocked_by`, `pull_request`,
    `branch`, `other` and answers `400 "link_type is not permitted"` to anything
    else (`handlers/story_links.rs` `VALID_LINK_TYPES`). Omit it and the server
    derives one from the URL (`detect_link_type`: a `github.com` `/pull/` URL →
    `pull_request`, `/tree/` → `branch`, else `other`) — it never stores null.
    The import sends `pull_request`, which is on the list.
  - Feature-detected from `GET /openapi.json` like the other newer capabilities:
    a server that does not publish the path 404s it, and a 404 is terminal for
    the writer, so the engine probes first and imports without links (warning
    aloud) rather than dying part-written.
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
  limit wins). Production now publishes them (read 2026-07-29: story name 255,
  story description 20,000, task description 255, comment text 20,000), so a
  current server's own numbers win. The **fallback defaults** apply only to a
  server that publishes none: story name 255; story description, task
  description, and comment text 16,000 bytes each — chosen between the longest
  comment a real server accepted (13,101) and one it rejected (46,411). Tune
  the fallbacks if such a server still rejects. `blocker_desc` falls back to
  **255** — `limits::BLOCKER_DESC`, the column width — and production publishes
  that same number on the blockers path.
- **Clamp shape** — block text is cut and suffixed with a visible notice
  (`[truncated by github-to-eat: …]`), total within the limit; names are cut
  with a trailing ellipsis whose own 3 bytes come out of the budget. Story
  descriptions reserve room for the dedup marker line before clamping, so the
  marker always survives intact. Each clamp warns on stderr naming the source
  row and field
  (`warning: issue #64: comment 1 truncated to 16000 bytes (server limit)`; a
  release names itself `release #100`, off the numeric half of its key, rather
  than reading `issue #release-100`). A **blocker is the exception**: it is cut
  plainly, with no notice, because the notice is 76 bytes of a 255-byte
  one-liner — the server's own writer truncates blockers bare for the same reason.
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
  number as a string, or `release-<id>` for a release — the same keys the
  server-side GitHub importer writes; see "Namespaced ids" below).
  EAT owner-gates the pair and rejects a lone field, so the two are built from
  one object and always sent together. Feature-detected from
  `GET /openapi.json` (the `import_source` property on the project-scoped
  `POST …/stories` schema); on a server that advertises it the prescan reads
  provenance back via the `GET /stories?import_source=github` list filter
  (`fields=story_id,import_external_id,tasks_count,comment_count`, plus `labels`
  under `--include …,milestones`, which is the only rule that reads them). Because the
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
  - **Namespaced ids.** An issue and a PR are keyed by the bare decimal number;
    a **release** is keyed `release-<id>` off the GitHub Release object's own
    numeric id. The prefix is the server importer's, and deliberate: release
    ids and issue numbers are separate id spaces, so an unprefixed release id
    could collide with an issue number in the same dedup key. Matching the
    server's exact spelling is what makes cross-engine dedup work for releases
    — a release the server importer wrote is skipped by a later direct run, and
    a release the direct engine wrote is skipped by a later server import.
- **Marker (fallback)** — every story it writes also ends its description with a
  stable marker line: `Imported from https://github.com/{owner}/{repo}/issues/{n}`
  for an issue, and
  `Imported from https://api.github.com/repos/{owner}/{repo}/releases/{id}` for a
  release. The release form points at the API resource rather than a
  `github.com` path because only `/releases/tag/{tag}` browses and the tag is
  not recoverable from the numeric key, while `github.com/{owner}/{repo}/releases/{id}`
  404s (both checked 2026-07-29). The two forms are distinct enough that neither
  can parse as the other, and the issue form is byte-identical to what earlier
  versions wrote, so no existing row's dedup changes.
  The marker prescan always runs **alongside** the provenance prescan (their
  results are unioned), so rows written by an older marker-only CLI run (no pair
  on the server row) are still skipped. When the server does not advertise the
  pair, the direct engine sends no provenance and dedups on the marker alone,
  byte-identical to earlier behaviour. The marker is appended after everything
  the mapper assembled, so the sub-issue cross-link block above sits *before* it
  and the marker is still the description's last line — the only line the
  prescan reads.
- **Divergence: the description back-link** — on **100% of rows**. The direct
  engine ends **every** imported description with a link home; the server ends
  most of them, with the two exceptions below. Where both write one, neither
  writes the other's words: the server importer appends
  `[View original issue](<original_url>)` after a blank line (`common.rs:1551`;
  the server line numbers cited for this divergence and for the backfill cap
  under *Fidelity limitations* were checked against agile-tracker
  `main@0dc48ab0`, 2026-08-06), the direct engine appends `Imported from <url>`
  (`src/dedup.js:20-34`). The direct engine cannot simply adopt the server's
  form, because that sentence is its fallback dedup key — `markerExternalId`
  parses it back off the description's last line, and it is the *only* key a row
  written before `import_source`/`import_external_id` existed carries, so
  rewording it would re-import every legacy row. Three consequences worth naming:
  - **An empty body diverges hardest.** The server gates its back-link on the
    source description being non-empty (`(None, _) => String::new()`,
    `common.rs:1553`, and deliberately — "we don't fabricate a body out of just
    the link", `common.rs:1544`), so an issue with an empty body gets an empty
    description and **no** link at all. `withMarker` has no such gate: the direct
    engine writes the marker **alone**, because dropping it there would leave
    that row with no re-run key whatsoever on a pre-provenance server.
  - **A PR carries no server back-link.** The importer sets `original_url: None`
    for a PR and attaches the URL as a `pull_request` link instead
    (`github.rs:1223`), so a PR story's description is footer-free server-side.
    The direct engine stamps its marker on a PR like any other row.
  - **A release's two links differ in host.** The server's is the release's
    `github.com` `html_url` (`github.rs:1366`); the marker is the API resource,
    for the browsability reason given above.

  Pinned by `tests/parity.test.js`, like the deps divergences, so the claim
  cannot rot into prose.
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
- The pair and marker both land at story-create, before that story's tasks,
  blockers and comments. A run interrupted in that window leaves an incomplete
  story that stays skipped on re-runs; when a skipped story has fewer
  tasks/blockers/comments than the current GitHub issue, the next run warns
  (`tasks X/Y, blockers X/Y, comments X/Y`) naming both possible causes — an
  interrupted run, or the issue changing since import — with the repair path:
  delete that story in EAT and re-run. All three counts are read in the prescan's
  `fields=` allowlist; blockers are written *between* tasks and comments, so
  without `blocker_count` a run killed mid-blockers on a comment-less issue would
  trip no counter at all. Adding `--include deps` to an already-imported project
  warns for the same reason, and correctly: those stories can never gain blockers.
- The mock server mirrors all of this behind a `provenance` flag (default on):
  it advertises the pair in `/openapi.json`, validates + persists it on create,
  and honours the `import_source`/`import_external_id` list filters; turning it
  off simulates an older server.

### Fidelity limitations (direct engine)

- **Timestamps** — feature-detected from `GET /openapi.json`: when the story
  create advertises `created_at` (the probe gates all three backdated fields,
  which shipped together), the direct writer sends `created_at` on **every**
  story create, `completed_at` on accepted creates only — GitHub's `closed_at`
  for a closed issue, a release's `published_at` for a published release; open
  issues and draft releases omit it entirely — and `created_at` on every
  comment create. All are owner-gated server-side; the CLI's agent key
  qualifies. Against a server that does **not** advertise the field (older
  server, or `/openapi.json` missing/unparseable) every payload stays
  byte-identical to v3 — no `created_at` / `completed_at` keys — and `created`
  is the import time. Server behaviour (owner-gated): `completed_at` is valid
  only on a done-state create and clamps forward to `created_at`; an accepted
  create lands in the iteration window containing its completion. The
  grid-extension ask (#32434) has **shipped**:
  `extend_grid_backwards_for_completion` (`iterations.rs:506`, called from
  `handlers/stories.rs:3508`) creates the historical windows a backdated
  completion needs — but only up to `MAX_BACKFILL_PAST_WINDOWS = 199`
  (`iterations.rs:50`). The cap is **not** an absolute reach from today. New
  windows tile backwards from the project's **oldest existing iteration
  `start`** (`oldest_start = MIN(start)`, `iterations.rs:515-516`); the server
  needs `n = ceil(gap / iteration_length_weeks)` of them (`iterations.rs:544`)
  and bails when `n > 199` (`iterations.rs:548`), so one create reaches
  `199 × iteration_length_weeks` back from that oldest boundary — on a
  two-week grid, ~7.6 years past whatever the project already covers. Past the
  cap the backfill is all-or-nothing: it creates **no** window at all and the
  completion falls back to the **current** iteration. Every extension that does
  succeed moves `MIN(start)` earlier, so successive creates **compound** and
  placement is **order-dependent** — `src/writer.js:263-267` orders creates by
  `created_at`, which is not `completed_at` order, so which completions clear
  the cap depends on the order they happen to be written in.
  Observed on the 2026-08-06 two-engine parity run: 94 done stories the server
  engine spread across 62 historical iterations back to 2012 all landed in the
  current week through the direct engine's public creates. The cap explains that
  only if every one of those 94 completions was still outside it at the moment
  it was written; that run's per-story placement was not retained, so the
  measurement stands but the causal attribution is **unconfirmed**.
  Server ask [#36735](https://eastagiletracker.com/s/gz8kucea) tracks the cap.
  The create response does carry the placement — `POST /projects/{id}/stories`
  returns the
  full story DTO (`handlers/stories.rs:3727`, `build_story_payload`) including
  `iteration_id` (`:2577`) and `current_panel` (`:2589`) — but the CLI never
  reads it (nothing under `src/` mentions an iteration) and `src/mockserver.js`
  models no iterations at all, so the write report cannot surface which
  iteration a backdated story landed in.
- **Started dates** — `started_at` (server story
  [#35489](https://eastagiletracker.com/s/e3cqxk6d)) rides the same story create,
  behind its **own** probe: it shipped after the `created_at` / `completed_at`
  pair, so a server can publish that pair and not this field, and `CreateStory`
  declares no `deny_unknown_fields` — sending it unprobed would lose the marker
  silently rather than fail loudly. Under `--include prs` an **open** PR is
  created with its own GitHub `created_at` as its `started_at`, mirroring
  `github.rs:1186` (`let started_at = if is_pr && !closed { created_at } else
  { None };`), so its reconstructed history is the server importer's single
  `NULL → started @ created`. Every other row sends none: a merged PR
  (`accepted`), a closed-unmerged PR (`rejected`) and every issue and release row
  are terminal or never started. The field rides only when `created_at` does —
  the server clamps `started_at` forward to `created_at`, so a marker on a
  `now()`-stamped story would collapse to the import instant and say nothing
  about when the work began. Server behaviour (owner-gated): `started_at` is
  valid only on a create at or past `started` (`state_rank >= 1`); `rejected` is
  off that axis, so the writer omits it there the way it omits `completed_at`.
  Against a server whose spec does not advertise it the run imports normally,
  just without the marker: the row still lands `started`, but its `started`
  instant stays NULL rather than falling back to the import time (observed on a
  real stack 2026-08-06 — the pre-#35489 behaviour this closes), so anything
  reading that column treats the PR as never started. `tests/parity.test.js`
  pins the open-PR rule against `github.rs`'s own assertions; the mock server
  mirrors it behind a `startedBackdating` flag (default on) so the older-server
  case stays testable.
- **People** — feature-detected from `GET /openapi.json`: when the story create
  advertises `requestor` **and** the comment create advertises `author`, the
  direct engine sends the issue author as the story's `requestor`, the assignees
  as `owners[].external`, and each comment's author as that comment's `author` —
  all `ExternalPersonInput` (server story #32773, one change, so one probe gates
  all three; both halves are checked because neither request body rejects unknown
  fields, so half-support would drop the field silently). All are owner-gated
  server-side and honoured on create only; the CLI's agent key qualifies. A ghost
  (no numeric id, no login, or an id past 2^53 — see *GitHub identity mapping*)
  sends no field at all: the story's requestor and the comment's author then fall
  back to the calling key, matching the server importer, while a ghost assignee is
  simply absent and the story ends with one fewer owner. Against a server that
  does **not** advertise the fields (older server, or `/openapi.json`
  missing/unparseable) nobody is mapped and every payload stays byte-identical to
  v3, with the GitHub author riding in the comment body prefix instead. The prefix
  also survives the mixed case: because backdating and person attribution are two
  independent probes, the body keeps `@login on YYYY-MM-DD:` whenever the
  comment's `created_at` cannot ride on the write, and collapses to `@login:` (or
  disappears entirely, once people ride too) only when it can. Under
  `--include prs` a PR's creator is sent as an owner as well as the requestor,
  mirroring the server importer.
- **Placeholder-owner reporting** — the direct engine's `N placeholder owner(s)
  created` / `would create N placeholder owner(s)` line lists the distinct GitHub
  logins the run attached as requestor, owner or comment author. The story-create
  response carries no created-vs-reused signal, so unlike the server engine's
  `external_members_created` this is the roster touched, not the rows created: a
  re-import into a project that already knows those people still lists them.
- **Sub-issue hierarchy** — EAT has no parent/child story relation, so the
  cross-links above are plain text in the description, not a queryable link: a
  board can read them, nothing can filter or traverse on them, and moving or
  deleting either story leaves the other's text stale (an import never updates).
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
  one GitHub repo per EAT project. Releases are keyed off GitHub's global
  release ids, which do not collide across repos, so only the issue half of the
  key carries this hazard.
- **A rejected story loses its completion date.** A closed-unmerged PR (and an
  issue closed `not_planned` / `duplicate`) lands `rejected`, which the create
  treats as not-done, so `completed_at` cannot ride along — the row keeps its
  GitHub closed date in the plan but is created with the import time. The server
  importer writes the column directly and is not subject to that guard. Nothing
  else about the row differs.
- **Story links need a server that publishes them.** The PR links above are
  written through `POST /stories/{id}/links`, feature-detected from
  `GET /openapi.json`. Against a server that does not publish the path the run
  still imports every story and says so before the confirm, and — because an
  import never updates a story it already created — those links can only be
  recovered by deleting the stories and re-running against a server that has the
  endpoint. The two losses differ: a PR that imports as its own story still
  reaches EAT through its dedup marker (`Imported from …`, which redirects to the
  PR), while a folded PR's URL and every link onto a closed issue reach EAT
  nowhere at all.
- **Adding `--include prs` to an already-imported repo cannot backfill its
  links.** A cross-link belongs on the *issue's* story, and re-running a repo
  imported without `prs` finds that issue already imported — so the dedup drops
  the story and its links together, and an import never adds a link to a story
  already in EAT. The run reports the count it could not write (`N pull-request
  link(s) belong on story(s) already imported`); recovering them means deleting
  those stories in EAT and re-running with `--include issues,prs`. Only the
  cross-links are affected: a PR importing as its own story is new, so its
  self-link is written normally.
- **A blank `html_url` on a PR is skipped, where the server folds anyway.** The
  direct engine trims a PR's `html_url` and skips a row whose URL is blank, so
  such a PR is never folded and keeps its own story. The server importer guards
  only on the field being present (`github.rs:452`) — it folds the PR away and
  then drops the blank URL at insert (`common.rs:2053-2056`), so the PR's story
  is lost with nothing to show for it. GitHub does not emit a blank `html_url`,
  so this is a divergence in the degenerate case only, named here because the
  engines are otherwise expected to agree row for row. Both engines write **no**
  link row for a blank URL (`github.rs:1086-1090` filters it on the self-link
  path too).
- **A draft release loses its planned date.** The server importer seeds a draft
  release's `scheduled_at` from the release's `created_at`, which places it in
  the iteration grid. `scheduled_at` is not on the public `POST /stories` body
  (it is importer-only), so the direct engine imports the draft to the backlog
  with its `created_at` and no planned date. Everything else about the row —
  title, notes, type, state, external id — matches the server importer, so the
  two engines still dedup each other's releases. Raising `scheduled_at` on the
  public create is the EAT-side ask that would close the gap.
