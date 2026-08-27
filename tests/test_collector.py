from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from process_stasis.bundle import write_bundle
from process_stasis.cli import main
from process_stasis.collector import collect_process, parse_cmdline, parse_proc_stat


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TARGET = PROJECT_ROOT / "targets" / "observable_target.py"
SCHEMA = PROJECT_ROOT / "schemas" / "evidence-bundle-v0.1.schema.json"


def wait_for_file(path: Path, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file():
            return
        time.sleep(0.02)
    raise AssertionError(f"target did not create {path}")


def test_parse_proc_stat_handles_closing_parenthesis_in_comm() -> None:
    # The tokens after ')' begin at proc stat field 3. Index 19 is field 22,
    # starttime. A rightmost-parenthesis split is required for this comm value.
    trailing = ["S", "7"] + ["0"] * 17 + ["123456"] + ["0"] * 5
    identity = parse_proc_stat(f"42 (odd ) process) {' '.join(trailing)}\n")
    assert identity == {
        "pid": 42,
        "ppid": 7,
        "state": "S",
        "comm": "odd ) process",
        "start_time_ticks": 123456,
    }


def test_parse_cmdline_preserves_empty_arguments() -> None:
    assert parse_cmdline(b"program\0\0final\0") == ["program", "", "final"]
    assert parse_cmdline(b"program\0\0") == ["program", ""]
    assert parse_cmdline(b"") == []


def test_write_bundle_uses_private_permissions(tmp_path: Path) -> None:
    destination = write_bundle(tmp_path / "case", {"safe": True})
    assert json.loads(destination.read_text(encoding="utf-8")) == {"safe": True}
    assert stat.S_IMODE(destination.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600


def test_write_bundle_refuses_existing_case_directory(tmp_path: Path) -> None:
    case = tmp_path / "case"
    case.mkdir()
    with pytest.raises(FileExistsError):
        write_bundle(case, {"safe": True})


def test_collects_benign_target_without_stopping_it(tmp_path: Path) -> None:
    runtime = tmp_path / "target-runtime"
    process = subprocess.Popen(
        [sys.executable, str(TARGET), "--runtime", str(runtime)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        wait_for_file(runtime / "ready.json")
        manifest = collect_process(process.pid, reason="automated benign integration test")
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(manifest)

        assert manifest["capture"]["complete"] is True
        assert manifest["target"]["identity_stable"] is True
        assert manifest["target"]["initial_identity"]["pid"] == process.pid
        assert manifest["artifacts"]["comm"]["value"] == "stasis-target"
        assert str(TARGET) in manifest["artifacts"]["cmdline"]["value"]
        assert len(manifest["artifacts"]["executable_sha256"]["value"]) == 64

        descriptor_targets = [
            item["target"]["value"]
            for item in manifest["artifacts"]["file_descriptors"]["value"]
            if item["target"]["status"] == "collected"
        ]
        assert any(target.endswith(" (deleted)") for target in descriptor_targets)
        assert any(target.startswith("socket:[") for target in descriptor_targets)
        assert manifest["artifacts"]["namespaces"]["value"]["pid"]["status"] == "collected"

        # Collection is read-only with respect to process execution.
        assert process.poll() is None
        os.kill(process.pid, 0)
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)

    assert process.returncode == 0, process.stderr.read().decode(
        "utf-8", errors="replace"
    )


def test_exited_pid_produces_partial_manifest() -> None:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait(timeout=3)

    manifest = collect_process(process.pid, reason="test exited PID handling")
    assert manifest["capture"]["complete"] is False
    assert manifest["target"]["initial_identity"] is None
    assert manifest["errors"]


def test_cli_writes_a_schema_valid_bundle(tmp_path: Path) -> None:
    output = tmp_path / "cli-case"
    exit_code = main(
        [
            "inspect",
            "--pid",
            str(os.getpid()),
            "--output",
            str(output),
            "--reason",
            "authorized collector CLI test",
            "--ack-authorized",
        ]
    )
    assert exit_code in (0, 3)

    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(manifest)
    assert manifest["target"]["requested_pid"] == os.getpid()
    assert manifest["case"]["authorization_acknowledged"] is True
