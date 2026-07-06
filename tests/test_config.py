import os

import pytest

from github_to_eat.config import (
    DEFAULT_API_BASE,
    Config,
    ConfigError,
    load_config,
    load_dotenv,
)


def test_load_dotenv_sets_missing_vars(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text('EAT_AGENT_KEY="abc123"\n# comment\nEAT_API_BASE=https://x/api\n')
    monkeypatch.delenv("EAT_AGENT_KEY", raising=False)
    monkeypatch.delenv("EAT_API_BASE", raising=False)
    load_dotenv(env_file)
    assert os.environ["EAT_AGENT_KEY"] == "abc123"
    assert os.environ["EAT_API_BASE"] == "https://x/api"


def test_load_dotenv_does_not_override_existing(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("EAT_AGENT_KEY=fromfile\n")
    monkeypatch.setenv("EAT_AGENT_KEY", "fromenv")
    load_dotenv(env_file)
    assert os.environ["EAT_AGENT_KEY"] == "fromenv"


def test_load_dotenv_missing_file_is_noop(tmp_path):
    load_dotenv(tmp_path / "does-not-exist")  # should not raise


def test_load_config_reads_env(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # no .env here
    monkeypatch.setenv("EAT_AGENT_KEY", "key")
    monkeypatch.delenv("EAT_API_BASE", raising=False)
    assert load_config() == Config(agent_key="key", api_base=DEFAULT_API_BASE)


def test_load_config_missing_key_raises(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("EAT_AGENT_KEY", raising=False)
    with pytest.raises(ConfigError):
        load_config()


def test_load_config_strips_trailing_slash(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EAT_AGENT_KEY", "key")
    monkeypatch.setenv("EAT_API_BASE", "https://host/api/")
    assert load_config().api_base == "https://host/api"
