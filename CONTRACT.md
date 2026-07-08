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
   - **No token field** (public repos) — the EAT server fetches GitHub using a
     platform PAT (`GITHUB_IMPORT_PAT`), so users never supply a GitHub token.
     When neither a request token nor a platform PAT exists, the server
     responds `400 import_github_no_token`; a bad token is
     `400 import_github_auth`.
   - **Private repos / no platform PAT** — the CLI may include an optional
     `"token"` (a GitHub PAT) via `--token` / `GITHUB_TOKEN`; the server uses it
     instead of the platform PAT.
   - Sent with an `Idempotency-Key`. The server does **not** process it today
     (verified 2026-07-06); it is advisory. Retried runs are still safe
     because of re-import dedup (below).
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
