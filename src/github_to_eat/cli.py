"""Command-line interface for github-to-eat.

Parses arguments, resolves configuration, runs preflight, then performs the
GitHub -> EAT import. See CONTRACT.md for the target behaviour.
"""

from __future__ import annotations

import argparse
import os
import sys
import uuid

from . import __version__
from .client import EATClient, EATError, EATTimeout
from .config import ConfigError, load_config
from .importer import run_import
from .preflight import preflight
from .progress import run_with_progress


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
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="run preflight and show the plan without importing anything",
    )
    parser.add_argument(
        "--token",
        metavar="GITHUB_TOKEN",
        help="GitHub token for a private repo (or set GITHUB_TOKEN); public repos need none",
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

    client = EATClient(config.api_base, config.agent_key)
    try:
        result = preflight(client, args.project)
    except EATError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if result.non_empty:
        print(
            f"warning: project {args.project} ({result.project_title}) already has stories; "
            "import appends, it does not replace.",
            file=sys.stderr,
        )

    if args.dry_run:
        print(
            f"Dry run: would import {owner}/{repo} into project {args.project} "
            f"({result.project_title}). No changes made."
        )
        return 0

    token = args.token or os.environ.get("GITHUB_TOKEN")
    print(
        f"Importing {owner}/{repo} into project {args.project} ({result.project_title})...",
        flush=True,
    )
    try:
        outcome = run_with_progress(
            lambda: run_import(
                client, args.project, owner, repo, idempotency_key=str(uuid.uuid4()), token=token
            ),
            "waiting for the server to import GitHub issues",
        )
    except EATTimeout as exc:
        print(f"error: {exc}", file=sys.stderr)
        print(
            "The server may still be finishing the import — check the board in a "
            "moment, or re-run. (v2 will stream progress for long imports.)",
            file=sys.stderr,
        )
        return 1
    except EATError as exc:
        print(f"error: import failed: {exc}", file=sys.stderr)
        if not token:
            print(
                "  hint: private repo, or the server has no platform PAT? "
                "set GITHUB_TOKEN or pass --token.",
                file=sys.stderr,
            )
        return 1

    print(
        f"Imported {outcome.imported_stories} stories ({outcome.imported_labels} labels), "
        f"skipped {outcome.skipped}, {len(outcome.errors)} error(s)."
    )
    unmatched_total = sum(len(v) for v in outcome.unmatched.values())
    if unmatched_total:
        print(f"note: {unmatched_total} GitHub user(s) could not be matched to members.")
    print(f"Board: {config.app_base}/projects/{args.project}")
    for err in outcome.errors:
        print(f"  - {err}", file=sys.stderr)
    return 1 if outcome.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
