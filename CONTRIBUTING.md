# Contributing

Thanks for helping improve GitHub-to-EAT.

## Dev setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
```

## Two kinds of EAT agent keys — don't mix them

This project touches the East Agile Tracker in two unrelated ways, each with its
own credential:

| Purpose | Env vars (file) | Read by |
| --- | --- | --- |
| **Run the tool** — import a GitHub repo into a target EAT project | `EAT_AGENT_KEY`, `EAT_API_BASE`, `EAT_APP_BASE` (`.env`) | the `github-to-eat` CLI |
| **Track this tool's own development** — file/update its stories on the tool's tracker project | `EAT_DEV_AGENT_KEY`, `EAT_DEV_API_BASE`, `EAT_DEV_PROJECT_ID` (`.env.dev`) | maintainer scripts only — never the CLI |

The CLI reads **only** the runtime `EAT_*` vars; the `EAT_DEV_*` vars are for
maintainers managing the backlog and must stay out of the runtime `.env`. Both
`.env` and `.env.dev` are gitignored. See `.env.example` and `.env.dev.example`.

## Tests and linting

```bash
ruff check .     # lint
pytest           # tests
```

Both run in CI (see `.github/workflows/ci.yml`) on Python 3.10–3.13. Please keep
them green and add tests for new behaviour.

The test suite never touches production EAT: HTTP is stubbed with `responses`
for unit tests, and the bundled mock server (`github_to_eat.mockserver`) backs
the integration tests.

## Project layout

```
src/github_to_eat/
  cli.py          # argument parsing + the run flow
  config.py       # env / .env configuration
  client.py       # EAT HTTP client (X-TrackerToken, error mapping)
  preflight.py    # read-only checks before any writes
  importer.py     # the import call + result normalization
  progress.py     # elapsed-time indicator for the blocking import
  mockserver.py   # in-memory mock of the EAT endpoints (tests + local runs)
tests/            # mirrors the modules above
```

## Conventions

- Match the surrounding style; `ruff` enforces formatting-adjacent lint rules.
- Keep the runtime dependency footprint small (currently just `requests`).
- Behaviour that touches the EAT API should be described in
  [CONTRACT.md](CONTRACT.md); update it when the contract changes.

## Scope

v1 is defined in [CONTRACT.md](CONTRACT.md). v2 items (async import with progress
polling, private-repo import via a GitHub App) are intentionally out of scope
until the corresponding server features land.
