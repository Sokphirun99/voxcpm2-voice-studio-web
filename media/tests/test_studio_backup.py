"""Integration tests for `studio.sh backup` and `studio.sh restore`."""

from __future__ import annotations

import io
import os
import subprocess
import tarfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
STUDIO_SCRIPT = ROOT_DIR / "studio.sh"

FAKE_DOCKER = """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${DOCKER_CALL_LOG:?DOCKER_CALL_LOG must be set}"
case "${1:-}" in
  info|volume) exit 0 ;;
  compose)
    if [[ "$*" == *" ps -q storage"* ]]; then printf 'fake-storage-id\\n'; fi
    exit 0
    ;;
  run)
    if [[ "$*" == *" ls -A /data"* ]]; then printf 'characters.json\\n'; fi
    if [[ "$*" == *" tar -czf -"* ]]; then printf 'fake-tarball-bytes'; fi
    exit 0
    ;;
esac
exit 0
"""


def _write_archive(path: Path, names: list[str]) -> Path:
    """Create a gzip tarball whose entry names are used verbatim."""
    with tarfile.open(path, "w:gz") as archive:
        for name in names:
            payload = b"test\n"
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return path


def _run_studio(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run studio.sh non-interactively and capture its output."""
    return subprocess.run(
        ["bash", str(STUDIO_SCRIPT), *args],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        env=env,
        timeout=120,
        check=False,
    )


def _fake_docker_env(tmp_path: Path) -> tuple[dict[str, str], Path]:
    """Install a docker stub on PATH and return the environment plus call log."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER, encoding="utf-8")
    docker.chmod(0o755)
    call_log = tmp_path / "docker-calls.log"
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
        "DOCKER_CALL_LOG": str(call_log),
    }
    return env, call_log


def test_help_lists_backup_and_restore() -> None:
    result = _run_studio("--help")
    assert result.returncode == 0
    assert "backup" in result.stdout
    assert "restore" in result.stdout


def test_restore_requires_archive_path() -> None:
    result = _run_studio("restore")
    assert result.returncode != 0
    assert "restore <backup.tar.gz>" in result.stderr


def test_unknown_flags_fail_loudly(tmp_path: Path) -> None:
    env, call_log = _fake_docker_env(tmp_path)
    for args in (("backup", "--bogus"), ("restore", "missing.tar.gz", "--bogus")):
        result = _run_studio(*args, env=env)
        assert result.returncode != 0
        assert "Unknown" in result.stderr
    assert not call_log.exists()


def test_restore_rejects_parent_and_absolute_entries(tmp_path: Path) -> None:
    env, call_log = _fake_docker_env(tmp_path)
    for index, name in enumerate(("../evil", "/etc/passwd")):
        archive = _write_archive(tmp_path / f"unsafe-{index}.tar.gz", [name])
        result = _run_studio("restore", str(archive), env=env)
        assert result.returncode != 0, result.stdout
        assert "Unsafe path" in result.stderr
    assert not call_log.exists()


def test_restore_rejects_invalid_archive(tmp_path: Path) -> None:
    archive = tmp_path / "broken.tar.gz"
    archive.write_bytes(b"not a tarball")
    result = _run_studio("restore", str(archive))
    assert result.returncode != 0
    assert "Not a valid .tar.gz archive" in result.stderr


def test_restore_without_yes_rejects_non_interactive_overwrite(tmp_path: Path) -> None:
    archive = _write_archive(tmp_path / "backup.tar.gz", ["./characters.json"])
    env, call_log = _fake_docker_env(tmp_path)
    result = _run_studio("restore", str(archive), env=env)
    assert result.returncode != 0
    assert "--yes" in result.stderr
    calls = call_log.read_text(encoding="utf-8")
    assert "compose" not in calls


def test_restore_yes_replaces_volume_and_restarts_storage(tmp_path: Path) -> None:
    archive = _write_archive(tmp_path / "backup.tar.gz", ["./characters.json"])
    env, call_log = _fake_docker_env(tmp_path)
    result = _run_studio("restore", str(archive), "--yes", env=env)
    assert result.returncode == 0, result.stderr
    calls = call_log.read_text(encoding="utf-8")
    assert " ps -q storage" in calls
    assert " stop storage" in calls
    assert "sh -c rm -rf /data/*" in calls
    assert "tar -xzf - -C /data" in calls
    assert " up -d storage" in calls


def test_backup_streams_volume_read_only(tmp_path: Path) -> None:
    output = tmp_path / "manual.tar.gz"
    env, call_log = _fake_docker_env(tmp_path)
    result = _run_studio("backup", str(output), env=env)
    assert result.returncode == 0, result.stderr
    assert output.read_text(encoding="utf-8") == "fake-tarball-bytes"
    calls = call_log.read_text(encoding="utf-8")
    assert "voxcpm_voice_studio_data:/data:ro" in calls
    assert " tar -czf -" in calls
