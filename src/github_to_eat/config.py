"""Configuration loading: read settings from the environment (and an optional .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_API_BASE = "https://api.eastagiletracker.com/api/v1"


class ConfigError(Exception):
    """Raised when required configuration is missing or invalid."""


@dataclass(frozen=True)
class Config:
    """Resolved runtime configuration."""

    agent_key: str
    api_base: str = DEFAULT_API_BASE


def load_dotenv(path: str | Path = ".env") -> None:
    """Load ``KEY=VALUE`` pairs from a .env file into ``os.environ``.

    Existing environment variables are never overridden. Blank lines and lines
    starting with ``#`` are ignored; surrounding single/double quotes on values
    are stripped. A missing file is a no-op.
    """
    p = Path(path)
    if not p.is_file():
        return
    for raw in p.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_config(dotenv_path: str | Path = ".env") -> Config:
    """Build a :class:`Config` from the environment, loading .env first if present."""
    load_dotenv(dotenv_path)
    agent_key = os.environ.get("EAT_AGENT_KEY", "").strip()
    if not agent_key:
        raise ConfigError(
            "EAT_AGENT_KEY is not set. Add it to your environment or a .env file "
            "(see .env.example)."
        )
    api_base = os.environ.get("EAT_API_BASE", "").strip() or DEFAULT_API_BASE
    return Config(agent_key=agent_key, api_base=api_base.rstrip("/"))
