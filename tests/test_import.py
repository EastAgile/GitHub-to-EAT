import json

import responses

from github_to_eat.cli import main
from github_to_eat.client import EATClient
from github_to_eat.importer import ImportOutcome, run_import
from github_to_eat.mockserver import MockState, run_mock_server

BASE = "https://api.test/api/v1"


@responses.activate
def test_import_github_posts_expected_body_and_key():
    responses.post(
        f"{BASE}/projects/91/import/json",
        json={"imported": 2, "skipped": 0, "errors": []},
        status=200,
    )
    result = EATClient(BASE, "tok").import_github(91, "octocat", "hello", idempotency_key="key-1")
    assert result["imported"] == 2

    req = responses.calls[0].request
    assert req.headers["Idempotency-Key"] == "key-1"
    body = json.loads(req.body)
    assert body == {"source": "github", "owner": "octocat", "repo": "hello"}
    assert "token" not in body  # server uses its platform PAT


class _FakeClient:
    def __init__(self, raw):
        self._raw = raw
        self.calls: list = []

    def import_github(self, project_id, owner, repo, *, idempotency_key):
        self.calls.append((project_id, owner, repo, idempotency_key))
        return self._raw


def test_run_import_normalizes_missing_fields():
    assert run_import(_FakeClient({}), 91, "o", "r", idempotency_key="k") == ImportOutcome(
        imported=0, skipped=0, errors=[]
    )


def test_run_import_reads_counts_and_errors():
    raw = {"imported": 5, "skipped": 1, "errors": ["x"]}
    assert run_import(_FakeClient(raw), 91, "o", "r", idempotency_key="k") == ImportOutcome(
        imported=5, skipped=1, errors=["x"]
    )


def test_full_import_against_mock(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    state = MockState(import_result={"imported": 4, "skipped": 2, "errors": []})
    with run_mock_server(state) as (base, recorded):
        monkeypatch.setenv("EAT_AGENT_KEY", "ea_token")
        monkeypatch.setenv("EAT_API_BASE", base)
        monkeypatch.setenv("EAT_APP_BASE", "https://tracker.example")
        code = main(["--project", "91", "--repo", "octocat/hello-world"])

    out = capsys.readouterr().out
    assert code == 0
    assert "Imported 4" in out
    assert "skipped 2" in out
    assert "https://tracker.example/projects/91" in out

    sent = recorded.imports[0]
    assert sent["body"] == {"source": "github", "owner": "octocat", "repo": "hello-world"}
    assert "token" not in sent["body"]
    assert sent["idempotency_key"]


def test_import_errors_exit_one(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    state = MockState(import_result={"imported": 1, "skipped": 0, "errors": ["issue 5 failed"]})
    with run_mock_server(state) as (base, _recorded):
        monkeypatch.setenv("EAT_AGENT_KEY", "ea_token")
        monkeypatch.setenv("EAT_API_BASE", base)
        code = main(["--project", "91", "--repo", "o/r"])

    err = capsys.readouterr().err
    assert code == 1
    assert "issue 5 failed" in err


def test_dry_run_makes_no_import(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    with run_mock_server() as (base, recorded):
        monkeypatch.setenv("EAT_AGENT_KEY", "ea_token")
        monkeypatch.setenv("EAT_API_BASE", base)
        code = main(["--project", "91", "--repo", "o/r", "--dry-run"])
    assert code == 0
    assert recorded.imports == []
    assert "Dry run" in capsys.readouterr().out
