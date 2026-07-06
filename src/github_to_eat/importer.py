"""The import flow: call the server import and normalize its result."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .client import EATClient


@dataclass(frozen=True)
class ImportOutcome:
    imported: int
    skipped: int
    errors: list[Any]


def run_import(
    client: EATClient,
    project_id: int,
    owner: str,
    repo: str,
    *,
    idempotency_key: str,
) -> ImportOutcome:
    """Perform the GitHub import and return a normalized outcome."""
    raw = client.import_github(project_id, owner, repo, idempotency_key=idempotency_key)
    return ImportOutcome(
        imported=int(raw.get("imported", 0)),
        skipped=int(raw.get("skipped", 0)),
        errors=list(raw.get("errors", []) or []),
    )
