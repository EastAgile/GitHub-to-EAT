import pytest

from github_to_eat import __version__
from github_to_eat.cli import main, parse_repo


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


def test_happy_path_prints_plan(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EAT_AGENT_KEY", "key")
    code = main(["--project", "91", "--repo", "octocat/hello-world"])
    assert code == 0
    out = capsys.readouterr().out
    assert "octocat/hello-world" in out
    assert "91" in out
