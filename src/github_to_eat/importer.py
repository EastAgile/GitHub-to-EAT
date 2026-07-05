"""The import flow: call the server import and normalize its result."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .client import EATClient


@dataclass(frozen=True)
class ImportOutcome:
    imported_stories: int
    imported_labels: int
    skipped: int
    errors: list[Any]


def run_import(
    client: EATClient,
    project_id: int,
    owner: str,
    repo: str,
    *,
    idempotency_key: str,
    token: str | None = None,
) -> ImportOutcome:
    """Perform the GitHub import and return a normalized outcome.

    The server returns ``imported`` as a nested object (``{"stories": N,
    "labels": M}``); a flat integer from older/other sources is also tolerated.
    """
    raw = client.import_github(
        project_id, owner, repo, idempotency_key=idempotency_key, token=token
    )
    imported = raw.get("imported")
    if isinstance(imported, dict):
        stories = int(imported.get("stories", 0) or 0)
        labels = int(imported.get("labels", 0) or 0)
    else:
        stories = int(imported or 0)
        labels = 0
    return ImportOutcome(
        imported_stories=stories,
        imported_labels=labels,
        skipped=int(raw.get("skipped", 0) or 0),
        errors=list(raw.get("errors", []) or []),
    )
