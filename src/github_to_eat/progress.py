"""A lightweight elapsed-time progress indicator for long, blocking calls."""

from __future__ import annotations

import sys
import threading
import time
from collections.abc import Callable
from typing import Any

_FRAMES = "|/-\\"


def run_with_progress(
    func: Callable[[], Any],
    message: str,
    *,
    stream: Any = None,
    interval: float = 0.5,
) -> Any:
    """Run ``func()`` while showing elapsed time; return its result.

    Animates a spinner only when ``stream`` is a TTY; otherwise prints a single
    start line. Any exception raised by ``func`` propagates to the caller.
    """
    stream = stream if stream is not None else sys.stderr
    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box["value"] = func()
        except Exception as exc:  # captured, re-raised in the caller thread
            box["error"] = exc

    thread = threading.Thread(target=worker, daemon=True)
    start = time.monotonic()
    thread.start()

    if not (hasattr(stream, "isatty") and stream.isatty()):
        print(f"{message}...", file=stream, flush=True)
        thread.join()
    else:
        i = 0
        while thread.is_alive():
            elapsed = time.monotonic() - start
            stream.write(f"\r{_FRAMES[i % len(_FRAMES)]} {message} ({elapsed:.0f}s) ")
            stream.flush()
            i += 1
            thread.join(timeout=interval)
        stream.write(f"\r{message} — done in {time.monotonic() - start:.0f}s\n")
        stream.flush()

    if "error" in box:
        raise box["error"]
    return box.get("value")
