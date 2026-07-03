"""Command-line interface for github-to-eat.

Parses arguments and resolves configuration, then hands off to the import flow.
The preflight and import steps are implemented in later stories; see CONTRACT.md.
"""

from __future__ import annotations

import argparse
import sys

from . import __version__
from .config import ConfigError, load_config


def parse_repo(value: str) -> tuple[str, str]:
    """Split an ``owner/name`` string into ``(owner, name)``.

    Raises :class:`ValueError` if the value is not exactly two non-empty parts.
    """
    parts = value.strip().split("/")
    if len(parts) != 2 or not all(parts):
        raise ValueError(f"invalid repository {value!r}; expected the form OWNER/NAME")
    return parts[0], parts[1]


def _repo_arg(value: str) -> tuple[str, str]:
    try:
        return parse_repo(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="github-to-eat",
        description="Onboard a public GitHub repo's issues into an East Agile Tracker project.",
    )
    parser.add_argument(
        "-V", "--version", action="version", version=f"github-to-eat {__version__}"
    )
    parser.add_argument(
        "--project",
        required=True,
        type=int,
        metavar="ID",
        help="target East Agile Tracker project id",
    )
    parser.add_argument(
        "--repo",
        required=True,
        type=_repo_arg,
        metavar="OWNER/NAME",
        help="public GitHub repository, e.g. octocat/hello-world",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    owner, repo = args.repo

    try:
        config = load_config()
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    # Preflight + import are wired in the next stories (26490, 26491).
    print(f"Ready to import {owner}/{repo} into project {args.project}.")
    print(f"API base: {config.api_base}")
    print("(preflight and import are not yet implemented)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
