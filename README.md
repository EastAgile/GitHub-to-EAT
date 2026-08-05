# GitHub-to-EAT

Onboard a public GitHub repository's issues into an [East Agile Tracker](https://eastagiletracker.com) (EAT) project — in one command.

> **Status:** the v1 CLI is built and works end-to-end against the bundled mock
> server. Running against **production EAT** additionally needs the server-side
> v1 features described in [CONTRACT.md](CONTRACT.md) (owner-role agent keys,
> agent-callable import, optional token), which are tracked separately.

## What it does

Point it at a public GitHub repo and an EAT project; the EAT server imports the
repo's issues into your project's backlog as stories — title, body + a link back
to the issue, open/closed state, and labels. Pull requests, milestones, and
releases are excluded by default; opt in with `--include` (see below).
Re-running an import never duplicates: items that were already imported are
skipped.

You never supply a GitHub token for public repos: the EAT **server** fetches the
issues with a platform credential, so all you provide is your EAT project key.

## Requirements

- Node.js 22+
- An East Agile Tracker project and an **owner-role agent API key**
  (mint one in the SPA under **Project Settings → API keys**)

## Install

Until the tool is published to npm, install from source. First clone it:

```bash
git clone git@github.com:EastAgile/GitHub-to-EAT.git
cd GitHub-to-EAT
```

The CLI has **zero runtime dependencies**, so installing it just puts the
command on your PATH:

```bash
npm install --global .
```

Or skip installing and run it straight from the clone:

```bash
node bin/github-to-eat.js --project <project id> --repo <owner>/<name>
```

(Once the package is published, `npx github-to-eat` will work with no install
step at all.)

## Configure

Copy the example env file and set your key. A local `.env` is loaded
automatically (and never overrides variables already in your environment).

```bash
cp .env.example .env
# edit .env: EAT_AGENT_KEY=<your owner-role agent key>
```

| Variable        | Required | Default                                   | Description                                   |
| --------------- | -------- | ----------------------------------------- | --------------------------------------------- |
| `EAT_AGENT_KEY` | yes      | —                                         | Owner-role agent API key for the project      |
| `EAT_API_BASE`  | no       | `https://api.eastagiletracker.com/api/v1` | API base URL (override for self-hosted/local) |
| `EAT_APP_BASE`  | no       | `https://eastagiletracker.com`            | Web app base URL, used for the board link     |
| `GITHUB_TOKEN`  | no       | —                                         | GitHub token for **private** repos (or use `--token`); public repos need none |

## Usage

```bash
# Format
github-to-eat --project <project id> --repo <owner>/<name>

# Example: import github.com/octocat/hello-world into project 147
github-to-eat --project 147 --repo octocat/hello-world
```

Example output:

```
Importing octocat/hello-world into project 147 (My Board)...
Imported 42 stories (0 labels), skipped 0, 0 error(s).
Board: https://eastagiletracker.com/projects/147
```

Other flags:

```bash
github-to-eat --project 147 --repo octocat/hello-world --include issues,prs   # also import pull requests
github-to-eat --project 147 --repo octocat/hello-world --dry-run   # preflight only, no writes
github-to-eat --version
github-to-eat --help
```

Before importing, the CLI prints a **mapping legend** — exactly how each
selected GitHub type lands in EAT — and asks for confirmation (`[y/N]`,
defaulting to no). Pass `--yes`/`-y` to skip the prompt.

**Off a terminal (pipes, CI, agents) there is nowhere to show that prompt, so a
run that would write must pass `--yes`.** Without it the CLI exits `2` with a
usage error and writes nothing — it never guesses your answer. `--dry-run` is
exempt: it writes nothing, so it needs no `--yes` and prints the same legend.

`--include` chooses what gets imported (default: `issues`). Every selection
must contain `issues` — the other types only add to an issue import:

- `prs` — pull requests become stories: open → started, merged → accepted
  (with a `pull-request` label), closed-unmerged → rejected; a merged PR that
  closes an imported issue folds into that issue's story instead of creating
  its own.
- `milestones` — GitHub milestones become epics; every story whose issue is in
  the milestone carries the epic's label, and the milestone's state and due date
  ride in the epic's description. Works on both engines. **Add it from the
  start:** an import never updates a story it already wrote, so an issue imported
  without this flag can never join an epic later. Adding the flag to an
  already-imported project groups only the issues that run imports itself, and
  says so — to group the older ones, delete their stories in EAT and re-run.
- `releases` — GitHub Releases become release-type stories (tag → title,
  notes → description, publish date kept). Draft releases are imported too,
  landing in the backlog rather than being skipped — but GitHub only lists
  drafts to a token with push access, so an anonymous or read-only run never
  sees them. Works on both engines.
- `deps` — each issue's "blocked by" dependencies become blockers on its story,
  one per entry, reading `Blocked by #90 (Upstream fix)` and unresolved. A
  blocker is recorded whether or not the blocking issue is itself imported.
  Works on both engines, byte-identically. This costs **one extra GitHub request
  per issue** — the issue row carries no dependency count to gate the request on
  — so an anonymous run (60 req/h) may need `--token`; the direct engine refuses
  up front rather than dying halfway, and `--dry-run` reports what the flag
  spent. If a listing fails, that issue is imported without its blockers and the
  run keeps going.

**Sub-issues** need no flag. EAT has no parent/child story relation, so on
`--engine direct` the hierarchy rides the description's last paragraph instead:
a parent gains `Sub-issues: #12, #14`, and each child gains `Sub-issue of #7`.
A child listed by two parents keeps only the first, so the two directions never
contradict each other. This costs one extra request per issue that advertises
sub-issues — a flat repo pays nothing — and it is the one term that can push a
large run past the anonymous 60 req/h ceiling, so pass `--token` for a
hierarchy-heavy repo. If that listing fails or the budget runs out, the run
says so and keeps going; it never trades the whole import for the cross-links.

### Customizing an import

By default every issue is imported with the standard mapping. To narrow or
override that for a single run — nothing is persisted — pick one of two ways.
Both are direct-engine only, and imply `--engine direct`:

- **Interactively:** `--customize` asks the questions one at a time on your
  terminal (it needs one, and refuses to run off a TTY).
- **Declaratively:** the flags below need **no** terminal, so agents, scripts,
  and CI can drive them:

| Flag            | Values                                             | Default                        |
| --------------- | -------------------------------------------------- | ------------------------------ |
| `--states`      | `all`, `open`, `closed`                            | `all`                          |
| `--milestones`  | milestone titles, matched exactly; comma-separated, repeatable | every milestone     |
| `--story-type`  | `infer`, `feature`, `bug`, `chore`                 | `infer` (org issue type, else labels/title) |
| `--no-comments` | —                                                  | comments are imported          |
| `--no-tasks`    | —                                                  | body checklists become tasks   |

```bash
github-to-eat --project 147 --repo octocat/hello-world \
  --states open --milestones "v1.0,v1.1" --no-comments --yes
```

`--milestones` can also be repeated (`--milestones v1.0 --milestones v1.1`), and
`\,` inside a title is a literal comma — `--milestones 'v1.0\, beta'` selects the
single milestone named `v1.0, beta`.

`--story-type infer` — the default — reads the org's own **issue type** first.
GitHub lets an organization define issue types, and every issue from an org repo
carries one: `Bug` → bug, `Feature` / `Enhancement` / `Task` → feature, `Chore` →
chore. `Task` counts as a feature because GitHub seeds every new org with exactly
Bug / Feature / Task, making `Task` the bucket for ordinary product work. The match
is case-insensitive but **exact**, so a type named `Bug Report` does not classify.
Anything unrecognised — and personal-account repos, which carry no type at all —
falls back to the labels-and-title guess, and the run warns once with a count of the
issues whose type it did not know. Passing a type explicitly (`--story-type bug`)
overrides both.

The choices are echoed in a `Customized:` block under the legend, so the plan is
visible before anything is written — and under `--dry-run`, which writes nothing.
A milestone title no matching issue carries is called out with a warning rather
than silently importing nothing, and so is a set of filters that together match
no issue at all (`--states open --milestones v2.0`, where `v2.0` is only on
closed issues, warns on both counts).

The two ways are mutually exclusive: combining a customization flag with
`--customize` is a usage error, since a run either declares its answers or asks
to be asked for them.

`--dry-run` validates your key, the project, and connectivity (and warns if the
project already has stories), then asks the server for a real, dedup-aware
import plan — how many stories it *would* import and how many it *would* skip
as already imported — without writing anything. Against older servers that
don't support plan computation, it falls back to a local preview.

**Private repos:** public repos need no GitHub token (the server uses its platform
credential). For a **private** repo — or a server without that platform credential
— supply a GitHub token with `--token <TOKEN>` or the `GITHUB_TOKEN` env var (it
needs `repo`, or fine-grained *Issues: Read*, on that repo).

### Exit codes

| Code | Meaning                                                            |
| ---- | ----------------------------------------------------------------- |
| `0`  | Success                                                           |
| `1`  | Runtime error (bad key, project not found, timeout) or the import reported per-item errors |
| `2`  | Usage error (bad or missing arguments, or a writing run off a terminal without `--yes`) |

## Troubleshooting

- **`no interactive terminal to confirm on`** — the run would write but has no
  TTY to show the `[y/N]` prompt on (a pipe, CI, an agent). Add `--yes` to
  import without confirmation, or `--dry-run` to preview the plan instead.
- **`authentication failed`** — check `EAT_AGENT_KEY` is an owner-role agent key
  for this project and hasn't been revoked.
- **`not found: /projects/<id>`** — the project id is wrong or the key can't
  access it.
- **`... timed out`** — a large repo can take a while; the server may still be
  finishing. Check the board in a moment, or re-run. (v2 will stream progress.)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, tests, and linting.

## License

[MIT](LICENSE)
