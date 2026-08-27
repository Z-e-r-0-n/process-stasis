"""Private, atomic evidence-bundle output."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def write_bundle(case_directory: Path, manifest: dict[str, Any]) -> Path:
    case_directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    os.chmod(case_directory, 0o700)

    temporary = case_directory / ".manifest.json.tmp"
    destination = case_directory / "manifest.json"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=True) as handle:
            json.dump(manifest, handle, ensure_ascii=True, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
        directory_fd = os.open(case_directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination
