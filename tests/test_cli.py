import pytest

from github_to_eat import __version__, cli
from github_to_eat.cli import main, parse_repo
from github_to_eat.client import AuthError
from github_to_eat.importer import ImportOutcome
from github_to_eat.preflight import PreflightResult


def test_parse_repo_valid():
    assert parse_repo("octocat/hello-world") == ("octocat", "hello-world")


@pytest.mark.parametrize("bad", ["", "noslash", "a/b/c", "/name", "owner/"])
def test_parse_repo_invalid(bad):
    with pytest.raises(ValueError):
        parse_repo(bad)


def test_version_action_exits_zero(capsys):
    with pytest.raises(SystemExit) as exc:
        main(["--version"])
    assert exc.value.code == 0
    assert __version__ in capsys.readouterr().out


def test_missing_project_is_usage_error():
    with pytest.raises(SystemExit) as exc:
        main(["--repo", "octocat/hello-world"])
    assert exc.value.code == 2


def test_bad_repo_is_usage_error():
    with pytest.raises(SystemExit) as exc:
        main(["--project", "91", "--repo", "not-a-repo"])
    assert exc.value.code == 2


def test_missing_key_returns_one(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("EAT_AGENT_KEY", raising=False)
    code = main(["--project", "91", "--repo", "octocat/hello-world"])
    assert code == 1
    assert "EAT_AGENT_KEY" in capsys.readouterr().err


def _patch_preflight(monkeypatch, result_or_exc):
    def fake(_client, project_id):
        if isinstance(result_or_exc, Exception):
            raise result_or_exc
        return result_or_exc

    monkeypatch.setattr(cli, "preflight", fake)


def _patch_import(monkeypatch, outcome):
    monkeypatch.setattr(cli, "run_import", lambda *a, **k: outcome)


def test_happy_path_preflight_then_import(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EAT_AGENT_KEY", "key")
    _patch_preflight(monkeypatch, PreflightResult(91, "Demo Board", non_empty=False))
    _patch_import(
        monkeypatch, ImportOutcome(imported_stories=2, imported_labels=0, skipped=0, errors=[])
    )
    code = main(["--project", "91", "--repo", "octocat/hello-world"])
    assert code == 0
    out = capsys.readouterr().out
    assert "Demo Board" in out
    assert "Imported 2" in out


def test_non_empty_project_warns(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EAT_AGENT_KEY", "key")
    _patch_preflight(monkeypatch, PreflightResult(91, "Demo", non_empty=True))
    _patch_import(
        monkeypatch, ImportOutcome(imported_stories=0, imported_labels=0, skipped=0, errors=[])
    )
    code = main(["--project", "91", "--repo", "octocat/hello-world"])
    assert code == 0
    assert "already has stories" in capsys.readouterr().err


def test_preflight_error_returns_one(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EAT_AGENT_KEY", "key")
    _patch_preflight(monkeypatch, AuthError("bad token"))
    code = main(["--project", "91", "--repo", "octocat/hello-world"])
    assert code == 1
    assert "bad token" in capsys.readouterr().err


def test_dry_run_skips_import(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EAT_AGENT_KEY", "key")
    _patch_preflight(monkeypatch, PreflightResult(91, "Demo", non_empty=False))
    called: list = []
    monkeypatch.setattr(cli, "run_import", lambda *a, **k: called.append(1))
    code = main(["--project", "91", "--repo", "octocat/hello-world", "--dry-run"])
    assert code == 0
    assert not called
    assert "Dry run" in capsys.readouterr().out
