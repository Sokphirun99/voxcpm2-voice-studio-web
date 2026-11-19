"""Integration tests for the root setup.sh fresh-machine bootstrap script."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
SETUP_SCRIPT = ROOT_DIR / "setup.sh"
UPDATE_SCRIPT = ROOT_DIR / "update-engine.sh"


def _git(cwd: Path, *args: str) -> str:
    """Run git in `cwd`, asserting exit 0 and returning stripped stdout."""
    proc = subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"git {' '.join(args)} failed: {proc.stderr}"
    return proc.stdout.strip()


def _init_two_commit_upstream(tmp_path: Path) -> tuple[Path, str, str]:
    """Create a local bare upstream engine repo with two commits (v1 and v2)."""
    bare = tmp_path / "upstream.git"
    seed = tmp_path / "seed"
    bare.mkdir()
    seed.mkdir()
    _git(bare, "init", "--bare", "-b", "main")
    _git(seed, "init", "-b", "main")
    _git(seed, "config", "user.name", "Tester")
    _git(seed, "config", "user.email", "tester@example.com")

    (seed / "app.py").write_text("print('v1')\n", encoding="utf-8")
    _git(seed, "add", "app.py")
    _git(seed, "commit", "-m", "init engine v1")
    sha_v1 = _git(seed, "rev-parse", "HEAD")

    (seed / "app.py").write_text("print('v2')\n", encoding="utf-8")
    _git(seed, "add", "app.py")
    _git(seed, "commit", "-m", "feat: engine v2")
    sha_v2 = _git(seed, "rev-parse", "HEAD")

    _git(seed, "remote", "add", "origin", str(bare))
    _git(seed, "push", "-u", "origin", "main")
    return bare, sha_v1, sha_v2


def _run_setup(env_overrides: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    """Execute setup.sh with isolated fixture paths and heavy installers mocked off."""
    env = {
        **os.environ,
        "SKIP_PREREQS": "1",
        "SKIP_BREW": "1",
        "SKIP_SYNC": "1",
        "SKIP_WEB_NPM": "1",
        **env_overrides,
    }
    return subprocess.run(
        ["bash", str(SETUP_SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def test_setup_help_and_bad_args() -> None:
    """--help prints usage cleanly and unknown options exit non-zero."""
    help_res = _run_setup({}, "--help")
    assert help_res.returncode == 0
    assert "--latest" in help_res.stdout
    assert "--no-start" in help_res.stdout
    assert "--check" in help_res.stdout

    bad = _run_setup({}, "--invalid-flag")
    assert bad.returncode != 0
    assert "Unknown option" in bad.stderr


def test_setup_pins_verified_commit_and_stays_compatible_with_update_engine(tmp_path: Path) -> None:
    """Default setup pins ENGINE_COMMIT on tracking branch `main` so update-engine.sh fast-forwards cleanly."""
    bare, sha_v1, sha_v2 = _init_two_commit_upstream(tmp_path)
    engine_dir = tmp_path / "engine"

    res = _run_setup(
        {
            "ENGINE_DIR": str(engine_dir),
            "ENGINE_REPO_URL": str(bare),
            "ENGINE_COMMIT": sha_v1,
        },
        "--no-start",
    )
    assert res.returncode == 0, res.stderr
    assert _git(engine_dir, "rev-parse", "HEAD") == sha_v1
    assert _git(engine_dir, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    assert (engine_dir / "app.py").read_text(encoding="utf-8") == "print('v1')\n"

    # Re-running setup.sh is idempotent on a clean clone.
    rerun = _run_setup(
        {
            "ENGINE_DIR": str(engine_dir),
            "ENGINE_REPO_URL": str(bare),
            "ENGINE_COMMIT": sha_v1,
        },
        "--no-start",
    )
    assert rerun.returncode == 0, rerun.stderr
    assert "already cloned" in rerun.stdout
    assert _git(engine_dir, "rev-parse", "HEAD") == sha_v1

    # update-engine.sh must immediately see 1 incoming commit and fast-forward cleanly to v2.
    upd_env = {**os.environ, "ENGINE_DIR": str(engine_dir), "SKIP_SYNC": "1", "SKIP_CHECKS": "1"}
    check_proc = subprocess.run(
        ["bash", str(UPDATE_SCRIPT), "--check"],
        capture_output=True,
        text=True,
        env=upd_env,
        timeout=30,
    )
    assert check_proc.returncode == 0, check_proc.stderr
    assert "1 incoming commit(s)" in check_proc.stdout

    upd_proc = subprocess.run(
        ["bash", str(UPDATE_SCRIPT), "--no-restart"],
        capture_output=True,
        text=True,
        env=upd_env,
        timeout=30,
    )
    assert upd_proc.returncode == 0, upd_proc.stderr
    assert _git(engine_dir, "rev-parse", "HEAD") == sha_v2


def test_setup_latest_flag_and_dirty_clone_guard(tmp_path: Path) -> None:
    """--latest clones upstream HEAD directly, and dirty existing engine/ fails loudly."""
    bare, sha_v1, sha_v2 = _init_two_commit_upstream(tmp_path)
    engine_dir = tmp_path / "engine-latest"

    res = _run_setup(
        {
            "ENGINE_DIR": str(engine_dir),
            "ENGINE_REPO_URL": str(bare),
            "ENGINE_COMMIT": sha_v1,
        },
        "--latest",
        "--no-start",
    )
    assert res.returncode == 0, res.stderr
    assert _git(engine_dir, "rev-parse", "HEAD") == sha_v2

    # Dirty engine/ must be rejected without clobbering local files.
    (engine_dir / "untracked.txt").write_text("dirty\n", encoding="utf-8")
    dirty_res = _run_setup(
        {
            "ENGINE_DIR": str(engine_dir),
            "ENGINE_REPO_URL": str(bare),
            "ENGINE_COMMIT": sha_v1,
        },
        "--no-start",
    )
    assert dirty_res.returncode != 0
    assert "local modifications" in dirty_res.stderr


def test_setup_check_detects_libass_ffmpeg_without_sigpipe() -> None:
    """setup.sh --check succeeds cleanly on the configured workspace without SIGPIPE under pipefail."""
    proc = subprocess.run(
        ["bash", str(SETUP_SCRIPT), "--check"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "[ok] ffmpeg (libass):" in proc.stdout
    assert "[ok] engine/ cloned at" in proc.stdout
