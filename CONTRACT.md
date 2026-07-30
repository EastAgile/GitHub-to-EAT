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

- **Issues, milestones and releases.** `--engine direct` composes with
  `--include`; it supports `issues` (always imported), `milestones` and
  `releases`. `prs` exits with a usage error ("not supported by the direct
  engine yet"). The message names the supported set straight from the engine
  module's own list, so it cannot go on advertising a narrower scope than the
  engine has.
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
  pull requests (tagged with a `pull_request` key); the fetcher drops them.
- `GET /repos/{owner}/{repo}/issues/comments` — every issue comment,
  repo-wide. The endpoint includes PR conversation comments; the fetcher keeps
  only comments whose `issue_url` points at a kept issue, so PR chatter never
  reaches the mapping stage.
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
(~1,000 issues) stays ~15–25 requests. Sub-issues are the one term that scales
with the repo's shape rather than its size — a repo with ~55 parents exhausts the
anonymous budget on that stage alone, which is why it degrades instead of failing
and why `--token` is what the warning names. `--token` / `GITHUB_TOKEN` is sent as
`Authorization: Bearer` and raises the ceiling to 5000/h (and reaches private
repos). Error mapping: 404 → repo-not-found; rate limits — HTTP 429, a 403
with `x-ratelimit-remaining: 0`, or a secondary-limit 403 carrying
`retry-after` — → rate-limit (the message prefers `retry-after` when present,
falling back to the `x-ratelimit-reset` time); 401 → token rejected.

### Default mapping profile (issues → stories)

The direct engine maps fetched GitHub JSON to an EAT write-op plan client-side
(`src/mapping.js` — pure functions, no HTTP), mirroring the server importer's
issue mapping so both engines classify the same repo identically — with three
deliberate exceptions, the closed-reason labels, the org issue type and the
sub-issue cross-links below, which only the direct engine produces:

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
  stray unmatched comment inert (its issue is never mapped). The public EAT API has
  no comment-author attribution, so each body is prefixed
  `@<login> on <YYYY-MM-DD>:` (deleted accounts render as `@ghost`).
- **Identity** — `external_id` is the issue number as a string; rows carrying
  a `pull_request` key are dropped (v3 is issues-only).

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
- **`POST /stories`** — body requires `name` (the read-side field is `title`;
  missing → `400 validation_failed`); optional `description`, `story_type`,
  `current_state`, `estimate`, `icebox`, `created_at`, `completed_at`,
  `import_source`, `import_external_id`, and `labels` as bare strings or
  `{ "name": "..." }` objects — the server attaches by name, get-or-creating
  with default colors (unlike `POST /labels`, the story payload never 409s on
  an existing name), and embeds the full label objects in the response.
  `current_state: "accepted"` is accepted at create time for an unestimated
  feature (verified 2026-07-16) — no estimate guard, so no
  create-then-transition fallback is needed. The four backdating / provenance
  fields are owner-gated (see "Marker dedup" and "Fidelity limitations"); the
  create body has **no** `scheduled_at` — that column is importer-only, so the
  direct engine cannot reproduce the planned date the server importer seeds on
  a draft release. 200 → the full story object (`story_id`, `title`,
  `current_state`, `labels`, …). `estimate` is on the create schema
  (`CreateStory`, read from `GET /openapi.json` 2026-07-29) — typed
  `["string", "null"]`, a scale *label* ("3", "½") resolved within the project's
  own effort scale, not a number — but the writer never sends it: no story type
  it creates is estimated, and `bug`/`chore`/`release` are seeded
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
  the fallbacks if such a server still rejects.
- **Clamp shape** — block text is cut and suffixed with a visible notice
  (`[truncated by github-to-eat: …]`), total within the limit; names are cut
  with a trailing ellipsis whose own 3 bytes come out of the budget. Story
  descriptions reserve room for the dedup marker line before clamping, so the
  marker always survives intact. Each clamp warns on stderr naming the source
  row and field
  (`warning: issue #64: comment 1 truncated to 16000 bytes (server limit)`; a
  release names itself `release #100`, off the numeric half of its key, rather
  than reading `issue #release-100`).
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
  create lands in the iteration window containing its completion. A completion
  that predates the iteration grid falls back to the **current** iteration until
  the grid-extension server ask (#32434) lands; the create response carries no
  iteration info, so the write report cannot yet surface which iteration a
  backdated story landed in.
- **Comment authorship** — the API has no comment-author attribution; comments
  are authored by the importing key, with the GitHub author riding in the body
  prefix. When the comment's `created_at` is sent (backdating-capable server)
  the prefix is `@login:`; against an older server the date rides there too
  (`@login on YYYY-MM-DD:`).
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
- **A draft release loses its planned date.** The server importer seeds a draft
  release's `scheduled_at` from the release's `created_at`, which places it in
  the iteration grid. `scheduled_at` is not on the public `POST /stories` body
  (it is importer-only), so the direct engine imports the draft to the backlog
  with its `created_at` and no planned date. Everything else about the row —
  title, notes, type, state, external id — matches the server importer, so the
  two engines still dedup each other's releases. Raising `scheduled_at` on the
  public create is the EAT-side ask that would close the gap.
