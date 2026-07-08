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

`--include` chooses what gets imported (default: `issues`). Every selection
must contain `issues` — the other types only add to an issue import:

- `prs` — pull requests become stories: open → started, merged → accepted
  (with a `pull-request` label), closed-unmerged → rejected; a merged PR that
  closes an imported issue folds into that issue's story instead of creating
  its own.
- `milestones` — GitHub milestones become epics.
- `releases` — GitHub Releases become release-type stories (tag → title,
  notes → description, publish date kept).

`--dry-run` validates your key, the project, and connectivity (and warns if the
project already has stories), then prints the plan without importing anything.

**Private repos:** public repos need no GitHub token (the server uses its platform
credential). For a **private** repo — or a server without that platform credential
— supply a GitHub token with `--token <TOKEN>` or the `GITHUB_TOKEN` env var (it
needs `repo`, or fine-grained *Issues: Read*, on that repo).

### Exit codes

| Code | Meaning                                                            |
| ---- | ----------------------------------------------------------------- |
| `0`  | Success                                                           |
| `1`  | Runtime error (bad key, project not found, timeout) or the import reported per-item errors |
| `2`  | Usage error (bad or missing arguments)                            |

## Troubleshooting

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
