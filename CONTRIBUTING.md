# Contributing

Thanks for helping improve GitHub-to-EAT.

## Dev setup

```bash
npm install
```

That installs the dev toolchain only (Biome, TypeScript for type checking); the
CLI itself has **zero runtime dependencies** — it uses the Node.js standard
library (global `fetch`, `util.parseArgs`, `node:http`).

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

## Tests, types, and linting

```bash
npm run lint       # Biome (lint + format)
npm run typecheck  # tsc --noEmit over the JSDoc annotations
npm test           # node --test
```

All three run in CI (see `.github/workflows/ci.yml`) on Node 22 and 24. Please
keep them green and add tests for new behaviour.

The test suite never touches production EAT: unit tests spin up throwaway local
HTTP servers, and the bundled mock server (`src/mockserver.js`) backs the
integration tests. Run it standalone with `npm run mockserver` (or
`node src/mockserver.js --port 8080`).

## Project layout

```
bin/github-to-eat.js  # executable entry point (the package "bin")
src/
  cli.js          # argument parsing + the run flow
  config.js       # env / .env configuration
  client.js       # EAT HTTP client (X-TrackerToken, error mapping)
  preflight.js    # read-only checks before any writes
  importer.js     # the import call + result normalization
  progress.js     # elapsed-time indicator for the blocking import
  mockserver.js   # in-memory mock of the EAT endpoints (tests + local runs)
  version.js      # tool version, read from package.json
tests/            # mirrors the modules above (node:test)
```

## Conventions

- Match the surrounding style; Biome enforces formatting and lint rules.
- Plain ESM JavaScript with JSDoc type annotations, checked by `tsc` — there is
  no build step; the repo is what runs.
- Keep the runtime dependency footprint at **zero** (Node stdlib only).
- Behaviour that touches the EAT API should be described in
  [CONTRACT.md](CONTRACT.md); update it when the contract changes.

## Scope

v1 is defined in [CONTRACT.md](CONTRACT.md). v2 items (async import with progress
polling, private-repo import via a GitHub App) are intentionally out of scope
until the corresponding server features land.
