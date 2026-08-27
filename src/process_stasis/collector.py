"""Bounded, read-only collection from Linux procfs."""

from __future__ import annotations

import errno
import hashlib
import os
import platform
import select
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from process_stasis import __version__

MAX_PROC_FILE_BYTES = 1024 * 1024
MAX_FDS = 4096
MAX_NAMESPACES = 64
MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024

STATUS_FIELDS = {
    "Name",
    "State",
    "Tgid",
    "Pid",
    "PPid",
    "TracerPid",
    "Uid",
    "Gid",
    "Groups",
    "NStgid",
    "NSpid",
    "NSpgid",
    "NSsid",
    "VmPeak",
    "VmSize",
    "VmRSS",
    "RssAnon",
    "RssFile",
    "RssShmem",
    "Threads",
    "SigQ",
    "SigPnd",
    "ShdPnd",
    "SigBlk",
    "SigIgn",
    "SigCgt",
    "CapInh",
    "CapPrm",
    "CapEff",
    "CapBnd",
    "CapAmb",
    "NoNewPrivs",
    "Seccomp",
    "Seccomp_filters",
}


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _decode(data: bytes) -> str:
    return data.decode("utf-8", errors="backslashreplace")


def parse_cmdline(data: bytes) -> list[str]:
    """Decode NUL-delimited argv while preserving an empty final argument."""

    if not data:
        return []
    if data.endswith(b"\0"):
        data = data[:-1]
    return [_decode(item) for item in data.split(b"\0")]


def _error_kind(exc: BaseException) -> str:
    if isinstance(exc, PermissionError):
        return "permission_denied"
    if isinstance(exc, FileNotFoundError):
        return "not_found"
    if isinstance(exc, ProcessLookupError):
        return "process_not_found"
    if isinstance(exc, OSError) and exc.errno == errno.EOVERFLOW:
        return "limit_exceeded"
    if isinstance(exc, ValueError):
        return "invalid_data"
    return type(exc).__name__.lower()


def _safe_message(exc: BaseException) -> str:
    if isinstance(exc, OSError) and exc.errno is not None:
        return os.strerror(exc.errno)
    return str(exc)[:300]


def parse_proc_stat(text: str) -> dict[str, Any]:
    """Parse identity fields from /proc/PID/stat, including ')' in comm."""

    left = text.find("(")
    right = text.rfind(")")
    if left <= 0 or right <= left:
        raise ValueError("malformed proc stat comm field")

    pid = int(text[:left].strip())
    comm = text[left + 1 : right]
    remaining = text[right + 1 :].strip().split()
    if len(remaining) <= 19:
        raise ValueError("proc stat has too few fields")

    return {
        "pid": pid,
        "ppid": int(remaining[1]),
        "state": remaining[0],
        "comm": comm,
        "start_time_ticks": int(remaining[19]),
    }


class ProcCollector:
    def __init__(self, pid: int) -> None:
        if pid < 1:
            raise ValueError("PID must be a positive integer")
        self.pid = pid
        self.proc = Path("/proc") / str(pid)
        self.errors: list[dict[str, str]] = []

    def _record_error(self, stage: str, source: str, exc: BaseException) -> None:
        self.errors.append(
            {
                "stage": stage,
                "source": source,
                "kind": _error_kind(exc),
                "message": _safe_message(exc),
            }
        )

    def _observation(
        self,
        stage: str,
        source: str,
        operation: Callable[[], Any],
    ) -> dict[str, Any]:
        try:
            return {"status": "collected", "source": source, "value": operation()}
        except Exception as exc:
            self._record_error(stage, source, exc)
            return {"status": "error", "source": source, "value": None}

    @staticmethod
    def _read_bounded(path: Path, limit: int = MAX_PROC_FILE_BYTES) -> bytes:
        with path.open("rb", buffering=0) as handle:
            data = handle.read(limit + 1)
        if len(data) > limit:
            raise OSError(errno.EOVERFLOW, "bounded read limit exceeded")
        return data

    def read_identity(self, stage: str) -> dict[str, Any] | None:
        source = str(self.proc / "stat")
        try:
            text = _decode(self._read_bounded(self.proc / "stat"))
            return parse_proc_stat(text)
        except Exception as exc:
            self._record_error(stage, source, exc)
            return None

    def read_cmdline(self) -> list[str]:
        return parse_cmdline(self._read_bounded(self.proc / "cmdline"))

    def read_comm(self) -> str:
        comm = _decode(self._read_bounded(self.proc / "comm"))
        return comm[:-1] if comm.endswith("\n") else comm

    def read_link(self, name: str) -> str:
        return os.readlink(self.proc / name)

    def read_status(self) -> dict[str, Any]:
        raw = _decode(self._read_bounded(self.proc / "status"))
        selected: dict[str, str] = {}
        for line in raw.splitlines():
            key, separator, value = line.partition(":")
            if separator and key in STATUS_FIELDS:
                selected[key] = value.strip()
        return {"raw": raw, "selected": selected}

    def read_text(self, name: str) -> str:
        return _decode(self._read_bounded(self.proc / name))

    def read_namespaces(self) -> dict[str, dict[str, Any]]:
        namespace_dir = self.proc / "ns"
        names = sorted(os.listdir(namespace_dir))
        if len(names) > MAX_NAMESPACES:
            raise OSError(errno.EOVERFLOW, "namespace entry limit exceeded")

        observations: dict[str, dict[str, Any]] = {}
        for name in names:
            source = str(namespace_dir / name)
            observations[name] = self._observation(
                "namespace",
                source,
                lambda path=namespace_dir / name: os.readlink(path),
            )
        return observations

    def read_file_descriptors(self) -> list[dict[str, Any]]:
        fd_dir = self.proc / "fd"
        names: list[str] = []
        with os.scandir(fd_dir) as iterator:
            for entry in iterator:
                if entry.name.isdecimal():
                    names.append(entry.name)
                    if len(names) > MAX_FDS:
                        raise OSError(
                            errno.EOVERFLOW, "file descriptor limit exceeded"
                        )

        entries: list[dict[str, Any]] = []
        for name in sorted(names, key=int):
            source = str(fd_dir / name)
            entries.append(
                {
                    "fd": int(name),
                    "target": self._observation(
                        "file_descriptor",
                        source,
                        lambda path=fd_dir / name: os.readlink(path),
                    ),
                }
            )
        return entries

    def hash_executable(self) -> str:
        path = self.proc / "exe"
        digest = hashlib.sha256()
        total = 0
        with path.open("rb", buffering=0) as handle:
            size = os.fstat(handle.fileno()).st_size
            if size > MAX_EXECUTABLE_BYTES:
                raise OSError(errno.EOVERFLOW, "executable hash limit exceeded")
            while chunk := handle.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_EXECUTABLE_BYTES:
                    raise OSError(errno.EOVERFLOW, "executable hash limit exceeded")
                digest.update(chunk)
        return digest.hexdigest()

    def collect_artifacts(self) -> dict[str, Any]:
        return {
            "cmdline": self._observation(
                "cmdline", str(self.proc / "cmdline"), self.read_cmdline
            ),
            "comm": self._observation(
                "comm", str(self.proc / "comm"), self.read_comm
            ),
            "links": {
                name: self._observation(
                    f"link_{name}",
                    str(self.proc / name),
                    lambda link=name: self.read_link(link),
                )
                for name in ("exe", "cwd", "root")
            },
            "status": self._observation(
                "status", str(self.proc / "status"), self.read_status
            ),
            "cgroup": self._observation(
                "cgroup", str(self.proc / "cgroup"), lambda: self.read_text("cgroup")
            ),
            "limits": self._observation(
                "limits", str(self.proc / "limits"), lambda: self.read_text("limits")
            ),
            "namespaces": self._observation(
                "namespaces", str(self.proc / "ns"), self.read_namespaces
            ),
            "file_descriptors": self._observation(
                "file_descriptors", str(self.proc / "fd"), self.read_file_descriptors
            ),
            "executable_sha256": self._observation(
                "executable_hash", str(self.proc / "exe"), self.hash_executable
            ),
        }


def _pidfd_exited(pidfd: int) -> bool:
    poller = select.poll()
    poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
    return bool(poller.poll(0))


def _all_observations_collected(value: Any) -> bool:
    if isinstance(value, dict):
        if set(value) >= {"status", "source", "value"}:
            if value["status"] != "collected":
                return False
            return _all_observations_collected(value["value"])
        return all(_all_observations_collected(item) for item in value.values())
    if isinstance(value, list):
        return all(_all_observations_collected(item) for item in value)
    return True


def collect_process(pid: int, *, reason: str) -> dict[str, Any]:
    if not reason.strip():
        raise ValueError("reason must not be empty")
    if len(reason) > 500:
        raise ValueError("reason must be at most 500 characters")

    started_at = _utc_now()
    started_ns = time.monotonic_ns()
    collector = ProcCollector(pid)
    pidfd: int | None = None
    pidfd_supported = hasattr(os, "pidfd_open")

    if pidfd_supported:
        try:
            pidfd = os.pidfd_open(pid, 0)
        except OSError as exc:
            collector._record_error("pidfd_open", f"pid:{pid}", exc)

    initial_identity = collector.read_identity("initial_identity")
    artifacts = collector.collect_artifacts()
    final_identity = collector.read_identity("final_identity")

    identity_stable = (
        initial_identity is not None
        and final_identity is not None
        and initial_identity["pid"] == final_identity["pid"]
        and initial_identity["start_time_ticks"] == final_identity["start_time_ticks"]
    )
    exited_by_end = _pidfd_exited(pidfd) if pidfd is not None else None
    complete = (
        identity_stable
        and exited_by_end is not True
        and (not pidfd_supported or pidfd is not None)
        and _all_observations_collected(artifacts)
    )

    ended_ns = time.monotonic_ns()
    manifest: dict[str, Any] = {
        "schema_version": "0.1",
        "case": {
            "authorization_acknowledged": True,
            "reason": reason.strip(),
        },
        "capture": {
            "started_at_utc": started_at,
            "ended_at_utc": _utc_now(),
            "duration_monotonic_ns": ended_ns - started_ns,
            "complete": complete,
            "collector": {
                "name": "process-stasis",
                "version": __version__,
                "python": platform.python_version(),
                "platform": sys.platform,
            },
            "pidfd": {
                "supported": pidfd_supported,
                "opened": pidfd is not None,
                "exited_by_end": exited_by_end,
            },
        },
        "target": {
            "requested_pid": pid,
            "initial_identity": initial_identity,
            "final_identity": final_identity,
            "identity_stable": identity_stable,
        },
        "artifacts": artifacts,
        "errors": collector.errors,
    }

    if pidfd is not None:
        os.close(pidfd)
    return manifest
