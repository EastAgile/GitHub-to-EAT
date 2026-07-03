# GitHub-to-EAT

Onboard a public GitHub repository's issues into an [East Agile Tracker](https://eastagiletracker.com) (EAT) project — in one command.

> **Status:** early development. [CONTRACT.md](CONTRACT.md) defines the v1 behaviour this tool is being built against; the CLI is not functional yet.

## What it does

Point it at a public GitHub repo and an EAT project, and it imports the repo's
issues into your project's backlog as stories — title, body + link back to the
issue, open/closed state, labels, and milestones.

You never supply a GitHub token for public repos: the EAT server fetches the
issues using a platform credential.

## Requirements

- Python 3.10+
- An East Agile Tracker project and an **owner-role agent API key**
  (mint one in the SPA under **Project Settings → API keys**)

## Quickstart

Until the tool is published, install from source:

```bash
git clone git@github.com:EastAgile/GitHub-to-EAT.git
cd GitHub-to-EAT
pip install .

cp .env.example .env
# edit .env and set EAT_AGENT_KEY=<your owner-role agent key>

github-to-eat --project <PROJECT_ID> --repo <owner>/<name>
```

## Configuration

Configuration is read from environment variables (a local `.env` is loaded if present):

| Variable        | Required | Description                                                                 |
| --------------- | -------- | --------------------------------------------------------------------------- |
| `EAT_AGENT_KEY` | yes      | Owner-role agent API key for the target EAT project                         |
| `EAT_API_BASE`  | no       | Override the API base URL (default `https://api.eastagiletracker.com/api/v1`) |

## Development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
ruff check .
pytest
```

## License

[MIT](LICENSE)
