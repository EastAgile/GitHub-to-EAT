"""Preflight checks: read-only validation that runs before any import writes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .client import EATClient


@dataclass(frozen=True)
class PreflightResult:
    project_id: int
    project_title: str
    non_empty: bool


def _project_title(project: dict[str, Any], project_id: int) -> str:
    # EAT returns the project name in ``project_title``; keep title/name as fallbacks.
    for key in ("project_title", "title", "name"):
        value = project.get(key)
        if value:
            return str(value)
    return f"project {project_id}"


def preflight(client: EATClient, project_id: int) -> PreflightResult:
    """Confirm the API/token work and the project is reachable; flag if non-empty.

    Runs the connectivity check first so an invalid token fails fast before we
    touch the project.
    """
    client.get_meta()
    project = client.get_project(project_id)
    return PreflightResult(
        project_id=project_id,
        project_title=_project_title(project, project_id),
        non_empty=client.project_has_stories(project_id),
    )
