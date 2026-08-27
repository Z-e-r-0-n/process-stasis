#!/usr/bin/env python3
"""Benign target with descriptors and metadata useful to collector tests."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import signal
import socket
import time
from pathlib import Path


def set_task_name(name: bytes) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(15, ctypes.c_char_p(name[:15]), 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True, type=Path)
    args = parser.parse_args()
    args.runtime.mkdir(mode=0o700, parents=True, exist_ok=True)

    deleted_path = args.runtime / "deleted-open-evidence.txt"
    deleted_path.write_text("benign Process Stasis target\n", encoding="utf-8")
    deleted_file = deleted_path.open("rb")
    deleted_path.unlink()

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    set_task_name(b"stasis-target")

    stopping = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    ready = args.runtime / "ready.json"
    ready.write_text(
        json.dumps({"pid": os.getpid(), "port": listener.getsockname()[1]}) + "\n",
        encoding="utf-8",
    )

    while not stopping:
        time.sleep(0.05)

    ready.unlink(missing_ok=True)
    listener.close()
    deleted_file.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
