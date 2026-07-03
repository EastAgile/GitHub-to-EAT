"""Command-line entry point.

This is a scaffold stub. Argument parsing and the preflight/import flow are
implemented in later stories; see CONTRACT.md for the target behaviour.
"""

from __future__ import annotations

import sys

from . import __version__


def main(argv: list[str] | None = None) -> int:
    """Entry point for the ``github-to-eat`` command."""
    args = list(sys.argv[1:] if argv is None else argv)

    if args and args[0] in ("-V", "--version"):
        print(f"github-to-eat {__version__}")
        return 0

    print(f"github-to-eat {__version__}")
    print("Not yet implemented — see CONTRACT.md for the planned behaviour.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
