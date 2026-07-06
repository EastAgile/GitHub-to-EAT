# GitHub-to-EAT

Onboard a public GitHub repository's issues into an [East Agile Tracker](https://eastagiletracker.com) (EAT) project — in one command.

> **Status:** the v1 CLI is built and works end-to-end against the bundled mock
> server. Running against **production EAT** additionally needs the server-side
> v1 features described in [CONTRACT.md](CONTRACT.md) (owner-role agent keys,
> agent-callable import, optional token), which are tracked separately.

## What it does

Point it at a public GitHub repo and an EAT project; the EAT server imports the
repo's issues into your project's backlog as stories — title, body + a link back
to the issue, open/closed state, labels, and milestones. Pull requests are
excluded.

You never supply a GitHub token for public repos: the EAT **server** fetches the
issues with a platform credential, so all you provide is your EAT project key.

## Requirements

- Python 3.10+
- An East Agile Tracker project and an **owner-role agent API key**
  (mint one in the SPA under **Project Settings → API keys**)

## Install

Until the tool is published, install from source:

```bash
git clone git@github.com:EastAgile/GitHub-to-EAT.git
cd GitHub-to-EAT
pip install .
```

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
github-to-eat --project 147 --repo octocat/hello-world --dry-run   # preflight only, no writes
github-to-eat --version
github-to-eat --help
```

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

## Try it locally against the mock server

The package ships a mock EAT server so you can exercise the full flow without a
real project:

```bash
# Terminal 1 — start the mock on http://127.0.0.1:8080
python -m github_to_eat.mockserver --port 8080

# Terminal 2 — point the CLI at it (the mock ships with project 91 preloaded)
EAT_AGENT_KEY=ea_demo EAT_API_BASE=http://127.0.0.1:8080 \
  github-to-eat --project 91 --repo octocat/hello-world
```

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
