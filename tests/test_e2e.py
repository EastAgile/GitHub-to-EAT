"""End-to-end test against a real East Agile Tracker.

Opt-in and skipped by default. It exercises the full CLI against a live EAT
project, so it needs configuration the normal suite does not have — and it
depends on the server-side v1 features (owner-role agent keys, agent-callable
import, optional token) that are still in progress. Until those ship (and you
point it at a disposable project), it stays skipped.

Configure via environment to enable:

    EAT_AGENT_KEY     owner-role agent key for the project
    EAT_E2E_PROJECT   id of a disposable EAT project to import into
    EAT_E2E_REPO      public GitHub repo as OWNER/NAME
    EAT_API_BASE      (optional) override the API base URL

Run just this test with:  pytest -m e2e
"""

import os
import time

import pytest

from github_to_eat.cli import main

pytestmark = pytest.mark.e2e

REQUIRED = ("EAT_AGENT_KEY", "EAT_E2E_PROJECT", "EAT_E2E_REPO")


def _require_config() -> None:
    missing = [name for name in REQUIRED if not os.environ.get(name)]
    if missing:
        pytest.skip(f"e2e not configured (missing {', '.join(missing)})")


def test_import_against_real_eat(capsys):
    _require_config()
    project = os.environ["EAT_E2E_PROJECT"]
    repo = os.environ["EAT_E2E_REPO"]

    started = time.monotonic()
    code = main(["--project", project, "--repo", repo])
    elapsed = time.monotonic() - started

    out = capsys.readouterr().out
    # Surfaces how long a real synchronous import takes — input for the v2
    # async-import decision.
    print(f"[e2e] import of {repo} took {elapsed:.1f}s")

    assert code == 0, out
    assert "Imported" in out
    assert "Board:" in out
