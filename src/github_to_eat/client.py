"""HTTP client for the East Agile Tracker API.

Wraps ``requests`` with the ``X-TrackerToken`` header, base-URL joining, and
error mapping to a small exception hierarchy.
"""

from __future__ import annotations

from typing import Any

import requests

DEFAULT_IMPORT_TIMEOUT = 300.0


class EATError(Exception):
    """Base class for East Agile Tracker client errors."""


class AuthError(EATError):
    """Authentication or authorization failed (HTTP 401/403)."""


class NotFoundError(EATError):
    """The requested resource does not exist (HTTP 404)."""


class EATTimeout(EATError):
    """The request exceeded its timeout."""


class EATClient:
    """Thin client for the subset of EAT endpoints this tool uses."""

    def __init__(
        self,
        api_base: str,
        agent_key: str,
        *,
        session: requests.Session | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.timeout = timeout
        self._session = session or requests.Session()
        self._session.headers.update(
            {"X-TrackerToken": agent_key, "Accept": "application/json"}
        )

    def _request(
        self, method: str, path: str, *, timeout: float | None = None, **kwargs: Any
    ) -> requests.Response:
        url = f"{self.api_base}{path}"
        try:
            resp = self._session.request(
                method, url, timeout=timeout or self.timeout, **kwargs
            )
        except requests.Timeout as exc:
            raise EATTimeout(
                f"request to {path} timed out after {timeout or self.timeout:.0f}s"
            ) from exc
        except requests.RequestException as exc:
            raise EATError(f"could not reach {url}: {exc}") from exc

        if resp.status_code in (401, 403):
            raise AuthError(
                "authentication failed — check EAT_AGENT_KEY and its access to the project"
            )
        if resp.status_code == 404:
            raise NotFoundError(f"not found: {path}")
        if resp.status_code >= 400:
            raise EATError(f"request to {path} failed ({resp.status_code}): {resp.text[:200]}")
        return resp

    def get_meta(self) -> dict[str, Any]:
        """Fetch ``/meta`` — used to confirm reachability and a valid token."""
        return self._request("GET", "/meta").json()

    def get_project(self, project_id: int) -> dict[str, Any]:
        """Fetch a project by id."""
        return self._request("GET", f"/projects/{project_id}").json()

    def project_has_stories(self, project_id: int) -> bool:
        """Return True if the project already contains at least one story."""
        resp = self._request("GET", f"/projects/{project_id}/stories", params={"limit": 1})
        data = resp.json()
        # With ?limit, EAT returns a cursor page {"items": [...], "next_cursor": ...};
        # a bare array (no query) is also tolerated.
        if isinstance(data, dict):
            items = data.get("items", data.get("stories", []))
        else:
            items = data
        return bool(items)

    def import_github(
        self,
        project_id: int,
        owner: str,
        repo: str,
        *,
        idempotency_key: str,
        token: str | None = None,
        timeout: float = DEFAULT_IMPORT_TIMEOUT,
    ) -> dict[str, Any]:
        """Trigger a GitHub import for a project.

        With no ``token`` the server fetches GitHub using its platform PAT (public
        repos). Supplying a ``token`` (a GitHub PAT) lets the server read a private
        repo, or work when no platform PAT is configured. The Idempotency-Key lets a
        retried request replay instead of double-importing.
        """
        body: dict[str, Any] = {"source": "github", "owner": owner, "repo": repo}
        if token:
            body["token"] = token
        resp = self._request(
            "POST",
            f"/projects/{project_id}/import/json",
            json=body,
            headers={"Idempotency-Key": idempotency_key},
            timeout=timeout,
        )
        return resp.json()
