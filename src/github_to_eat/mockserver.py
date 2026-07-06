"""A minimal in-memory mock of the East Agile Tracker API.

Implements only the endpoints github-to-eat uses, for tests and local runs:

    GET  /meta
    GET  /projects/{id}
    GET  /projects/{id}/stories
    POST /projects/{id}/import/json

Use in tests::

    with run_mock_server() as (base_url, state):
        ...

Run standalone::

    python -m github_to_eat.mockserver --port 8080
"""

from __future__ import annotations

import argparse
import contextlib
import json
import re
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit


@dataclass
class MockState:
    """Configurable state and recorded requests for a mock server instance."""

    projects: dict[int, dict[str, Any]] = field(
        default_factory=lambda: {91: {"id": 91, "title": "Mock Project"}}
    )
    stories: dict[int, list[Any]] = field(default_factory=dict)
    meta: dict[str, Any] = field(
        default_factory=lambda: {"story_types": ["feature", "bug", "chore", "release"]}
    )
    import_result: dict[str, Any] = field(
        default_factory=lambda: {"imported": 3, "skipped": 0, "errors": []}
    )
    imports: list[dict[str, Any]] = field(default_factory=list)


class _Handler(BaseHTTPRequestHandler):
    state: MockState  # bound on a subclass per server

    def log_message(self, *args: Any) -> None:  # silence request logging
        pass

    def _send(self, code: int, payload: Any = None) -> None:
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _authed(self) -> bool:
        if not self.headers.get("X-TrackerToken", ""):
            self._send(401, {"error": "missing token"})
            return False
        return True

    def do_GET(self) -> None:
        if not self._authed():
            return
        path = urlsplit(self.path).path

        if path == "/meta":
            self._send(200, self.state.meta)
            return

        m = re.fullmatch(r"/projects/(\d+)", path)
        if m:
            project = self.state.projects.get(int(m.group(1)))
            self._send(200, project) if project else self._send(404, {"error": "not found"})
            return

        m = re.fullmatch(r"/projects/(\d+)/stories", path)
        if m:
            self._send(200, self.state.stories.get(int(m.group(1)), []))
            return

        self._send(404, {"error": "unknown route"})

    def do_POST(self) -> None:
        if not self._authed():
            return
        path = urlsplit(self.path).path

        m = re.fullmatch(r"/projects/(\d+)/import/json", path)
        if m:
            pid = int(m.group(1))
            if pid not in self.state.projects:
                self._send(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                self._send(400, {"error": "invalid json"})
                return
            self.state.imports.append(
                {
                    "project_id": pid,
                    "body": body,
                    "idempotency_key": self.headers.get("Idempotency-Key"),
                }
            )
            self._send(200, self.state.import_result)
            return

        self._send(404, {"error": "unknown route"})


def _make_server(state: MockState, host: str, port: int) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (_Handler,), {"state": state})
    return ThreadingHTTPServer((host, port), handler)


@contextlib.contextmanager
def run_mock_server(state: MockState | None = None, host: str = "127.0.0.1"):
    """Start a mock server on an ephemeral port; yield ``(base_url, state)``."""
    state = state or MockState()
    server = _make_server(state, host, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        bound_host, port = server.server_address[0], server.server_address[1]
        yield f"http://{bound_host}:{port}", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="github-to-eat-mock", description="Run a mock East Agile Tracker server."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args(argv)

    server = _make_server(MockState(), args.host, args.port)
    print(f"mock EAT server on http://{args.host}:{args.port} (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
