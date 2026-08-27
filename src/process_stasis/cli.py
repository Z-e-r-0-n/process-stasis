"""Command-line interface for Process Stasis."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

from process_stasis.bundle import write_bundle
from process_stasis.collector import collect_process


def _positive_pid(value: str) -> int:
    try:
        pid = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("PID must be an integer") from exc
    if pid < 1:
        raise argparse.ArgumentTypeError("PID must be positive")
    return pid


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="stasis",
        description="Defensive Linux process evidence collection",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    inspect_parser = subparsers.add_parser(
        "inspect",
        help="collect a read-only evidence bundle from an authorized PID",
    )
    inspect_parser.add_argument("--pid", required=True, type=_positive_pid)
    inspect_parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="new case directory; its parent must already exist",
    )
    inspect_parser.add_argument(
        "--reason",
        required=True,
        help="short authorization/scope reason stored in the private bundle",
    )
    inspect_parser.add_argument(
        "--ack-authorized",
        required=True,
        action="store_true",
        help="confirm that you are authorized to inspect this process",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command != "inspect":
        return 2

    try:
        manifest = collect_process(args.pid, reason=args.reason)
        destination = write_bundle(args.output, manifest)
    except (OSError, ValueError) as exc:
        print(f"stasis: {exc}", file=sys.stderr)
        return 2

    state = "complete" if manifest["capture"]["complete"] else "partial"
    print(f"Evidence bundle written: {destination} ({state})")
    return 0 if manifest["capture"]["complete"] else 3
