#!/usr/bin/env python3
"""Deterministic benign process tree for Process Stasis integration tests."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


TASK_NAMES = {
    "root": b"stasis-root",
    "watcher": b"stasis-watch",
    "leaf": b"stasis-leaf",
    "server": b"stasis-server",
}


def set_task_name(name: bytes) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(15, ctypes.c_char_p(name[:15]), 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def read_json_when_ready(path: Path, timeout: float = 5.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            time.sleep(0.02)
    raise TimeoutError(f"timed out waiting for {path.name}")


def install_stop_handlers() -> threading.Event:
    stop_event = threading.Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    return stop_event


def wait_or_child_failure(
    stop_event: threading.Event,
    children: list[subprocess.Popen[bytes]],
) -> int:
    while not stop_event.wait(0.05):
        if any(child.poll() is not None for child in children):
            return 1
    return 0


def stop_children(children: list[subprocess.Popen[bytes]]) -> None:
    for child in children:
        if child.poll() is None:
            try:
                child.terminate()
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 3.0
    for child in children:
        remaining = max(0.0, deadline - time.monotonic())
        try:
            child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=1)


def child_command(runtime: Path, role: str) -> list[str]:
    return [
        sys.executable,
        str(Path(__file__).resolve()),
        "--runtime",
        str(runtime),
        "--role",
        role,
    ]


def run_leaf(runtime: Path) -> int:
    set_task_name(TASK_NAMES["leaf"])
    stop_event = install_stop_handlers()

    deleted_path = runtime / "leaf-deleted-open.txt"
    deleted_path.write_text("benign nested leaf evidence\n", encoding="utf-8")
    deleted_file = deleted_path.open("rb")
    deleted_path.unlink()

    thread_stop = threading.Event()
    helper_thread = threading.Thread(
        target=thread_stop.wait,
        name="benign-leaf-helper",
        daemon=True,
    )
    helper_thread.start()
    write_json_atomic(
        runtime / "leaf.json",
        {"role": "leaf", "pid": os.getpid(), "ppid": os.getppid()},
    )

    stop_event.wait()
    thread_stop.set()
    helper_thread.join(timeout=1)
    deleted_file.close()
    return 0


def run_server(runtime: Path) -> int:
    set_task_name(TASK_NAMES["server"])
    stop_event = install_stop_handlers()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    write_json_atomic(
        runtime / "server.json",
        {
            "role": "server",
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "listen_address": "127.0.0.1",
            "listen_port": listener.getsockname()[1],
        },
    )

    stop_event.wait()
    listener.close()
    return 0


def run_watcher(runtime: Path) -> int:
    set_task_name(TASK_NAMES["watcher"])
    stop_event = install_stop_handlers()
    leaf = subprocess.Popen(
        child_command(runtime, "leaf"),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
    )
    try:
        leaf_record = read_json_when_ready(runtime / "leaf.json")
        if leaf_record["pid"] != leaf.pid or leaf_record["ppid"] != os.getpid():
            raise RuntimeError("leaf identity did not match its launcher")
        write_json_atomic(
            runtime / "watcher.json",
            {
                "role": "watcher",
                "pid": os.getpid(),
                "ppid": os.getppid(),
                "children": [leaf.pid],
            },
        )
        return wait_or_child_failure(stop_event, [leaf])
    finally:
        stop_children([leaf])


def run_root(runtime: Path) -> int:
    set_task_name(TASK_NAMES["root"])
    stop_event = install_stop_handlers()
    watcher = subprocess.Popen(
        child_command(runtime, "watcher"),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
    )
    server = subprocess.Popen(
        child_command(runtime, "server"),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
    )
    children = [watcher, server]
    try:
        watcher_record = read_json_when_ready(runtime / "watcher.json")
        leaf_record = read_json_when_ready(runtime / "leaf.json")
        server_record = read_json_when_ready(runtime / "server.json")
        if watcher_record["pid"] != watcher.pid:
            raise RuntimeError("watcher identity did not match its launcher")
        if server_record["pid"] != server.pid:
            raise RuntimeError("server identity did not match its launcher")

        root_record = {"role": "root", "pid": os.getpid(), "ppid": os.getppid()}
        write_json_atomic(
            runtime / "tree.json",
            {
                "nodes": {
                    "root": root_record,
                    "watcher": watcher_record,
                    "leaf": leaf_record,
                    "server": server_record,
                },
                "edges": [
                    {"parent": "root", "child": "watcher"},
                    {"parent": "watcher", "child": "leaf"},
                    {"parent": "root", "child": "server"},
                ],
            },
        )
        return wait_or_child_failure(stop_event, children)
    finally:
        stop_children(children)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument(
        "--role",
        choices=("root", "watcher", "leaf", "server"),
        default="root",
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()
    args.runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.role == "root":
        markers = ("tree.json", "watcher.json", "leaf.json", "server.json")
        if any((args.runtime / marker).exists() for marker in markers):
            parser.error("runtime contains stale target metadata; use a new directory")

    runners = {
        "root": run_root,
        "watcher": run_watcher,
        "leaf": run_leaf,
        "server": run_server,
    }
    return runners[args.role](args.runtime.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
