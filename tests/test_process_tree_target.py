from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from process_stasis.cli import main


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TREE_TARGET = PROJECT_ROOT / "targets" / "process_tree_target.py"
SCHEMA = PROJECT_ROOT / "schemas" / "evidence-bundle-v0.1.schema.json"


def wait_for_json(path: Path, timeout: float = 5.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            time.sleep(0.02)
    raise AssertionError(f"target did not create {path}")


def descriptor_targets(manifest: dict[str, Any]) -> list[str]:
    return [
        item["target"]["value"]
        for item in manifest["artifacts"]["file_descriptors"]["value"]
        if item["target"]["status"] == "collected"
    ]


def wait_for_processes_to_exit(pids: list[int], timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if all(not Path(f"/proc/{pid}").exists() for pid in pids):
            return
        time.sleep(0.02)
    remaining = [pid for pid in pids if Path(f"/proc/{pid}").exists()]
    raise AssertionError(f"target processes did not exit: {remaining}")


def test_cli_collects_every_node_in_benign_process_tree(tmp_path: Path) -> None:
    runtime = tmp_path / "tree-runtime"
    root = subprocess.Popen(
        [sys.executable, str(TREE_TARGET), "--runtime", str(runtime)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    target_pids: list[int] = []
    try:
        tree = wait_for_json(runtime / "tree.json")
        nodes = tree["nodes"]
        target_pids = [record["pid"] for record in nodes.values()]
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        manifests: dict[str, dict[str, Any]] = {}

        for role, record in nodes.items():
            output = tmp_path / f"case-{role}"
            exit_code = main(
                [
                    "inspect",
                    "--pid",
                    str(record["pid"]),
                    "--output",
                    str(output),
                    "--reason",
                    f"authorized benign tree test: {role}",
                    "--ack-authorized",
                ]
            )
            assert exit_code == 0
            manifest = json.loads(
                (output / "manifest.json").read_text(encoding="utf-8")
            )
            Draft202012Validator(schema).validate(manifest)
            manifests[role] = manifest

        identities = {
            role: manifest["target"]["initial_identity"]
            for role, manifest in manifests.items()
        }
        assert identities["root"]["pid"] == root.pid
        assert identities["watcher"]["ppid"] == identities["root"]["pid"]
        assert identities["leaf"]["ppid"] == identities["watcher"]["pid"]
        assert identities["server"]["ppid"] == identities["root"]["pid"]

        assert manifests["root"]["artifacts"]["comm"]["value"] == "stasis-root"
        assert manifests["watcher"]["artifacts"]["comm"]["value"] == "stasis-watch"
        assert manifests["leaf"]["artifacts"]["comm"]["value"] == "stasis-leaf"
        assert manifests["server"]["artifacts"]["comm"]["value"] == "stasis-server"

        leaf_threads = int(
            manifests["leaf"]["artifacts"]["status"]["value"]["selected"][
                "Threads"
            ]
        )
        assert leaf_threads >= 2
        assert any(
            target.endswith("leaf-deleted-open.txt (deleted)")
            for target in descriptor_targets(manifests["leaf"])
        )
        assert any(
            target.startswith("socket:[")
            for target in descriptor_targets(manifests["server"])
        )

        # The current collector operates on one PID at a time. The known tree is
        # reconstructed here from each node's PPID, not emitted as one bundle yet.
        assert all("descendants" not in manifest["artifacts"] for manifest in manifests.values())
        for pid in target_pids:
            os.kill(pid, 0)
    finally:
        if root.poll() is None:
            root.terminate()
        try:
            root.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(root.pid, signal.SIGKILL)
            root.wait(timeout=2)

    wait_for_processes_to_exit(target_pids)
    assert root.returncode == 0, root.stderr.read().decode("utf-8", errors="replace")
