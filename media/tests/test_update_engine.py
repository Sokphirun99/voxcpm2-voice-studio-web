"""Integration tests for the root update-engine.sh upstream updater script."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
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


def _init_upstream_and_clone(tmp_path: Path) -> tuple[Path, Path, str]:
    """Create a local bare upstream repo and clean engine clone with one baseline commit."""
    bare = tmp_path / "upstream.git"
    seed = tmp_path / "seed"
    clone = tmp_path / "engine"
    bare.mkdir()
    seed.mkdir()
    _git(bare, "init", "--bare", "-b", "main")
    _git(seed, "init", "-b", "main")
    _git(seed, "config", "user.name", "Tester")
    _git(seed, "config", "user.email", "tester@example.com")
    (seed / "app.py").write_text("print('v1')\n", encoding="utf-8")
    _git(seed, "add", "app.py")
    _git(seed, "commit", "-m", "init engine v1")
    _git(seed, "remote", "add", "origin", str(bare))
    _git(seed, "push", "-u", "origin", "main")
    subprocess.run(["git", "clone", str(bare), str(clone)], capture_output=True, text=True, check=True)
    _git(clone, "config", "user.name", "Tester")
    _git(clone, "config", "user.email", "tester@example.com")
    base_sha = _git(clone, "rev-parse", "--short", "HEAD")
    return seed, clone, base_sha


def _run_updater(engine_dir: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Execute update-engine.sh against a fixture engine repo with sync/checks mocked off."""
    env = {
        **os.environ,
        "ENGINE_DIR": str(engine_dir),
        "SKIP_SYNC": "1",
        "SKIP_CHECKS": "1",
    }
    return subprocess.run(
        ["bash", str(UPDATE_SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def test_update_engine_help_and_bad_args(tmp_path: Path) -> None:
    """--help exits cleanly and unknown flags or missing rollback SHA fail loudly."""
    help_res = _run_updater(tmp_path, "--help")
    assert help_res.returncode == 0
    assert "--check" in help_res.stdout
    assert "--rollback" in help_res.stdout

    bad_flag = _run_updater(tmp_path, "--bogus")
    assert bad_flag.returncode != 0
    assert "Unknown option" in bad_flag.stderr

    missing_sha = _run_updater(tmp_path, "--rollback")
    assert missing_sha.returncode != 0
    assert "--rollback requires a commit SHA" in missing_sha.stderr


def test_update_engine_check_update_and_rollback(tmp_path: Path) -> None:
    """--check previews incoming contract diffs, update fast-forwards, and --rollback restores baseline."""
    seed, clone, base_sha = _init_upstream_and_clone(tmp_path)

    # Push an upstream change touching contract-sensitive app.py.
    (seed / "app.py").write_text("print('v2')\n", encoding="utf-8")
    _git(seed, "add", "app.py")
    _git(seed, "commit", "-m", "feat: upstream v2")
    _git(seed, "push", "origin", "main")

    # --check must report 1 incoming commit + contract warning without moving HEAD.
    check_res = _run_updater(clone, "--check")
    assert check_res.returncode == 0, check_res.stderr
    assert "1 incoming commit(s)" in check_res.stdout
    assert "Contract-sensitive upstream files changed" in check_res.stdout
    assert "app.py" in check_res.stdout
    assert _git(clone, "rev-parse", "--short", "HEAD") == base_sha

    # Default update fast-forwards HEAD and keeps rollback guidance visible.
    upd_res = _run_updater(clone, "--no-restart")
    assert upd_res.returncode == 0, upd_res.stderr
    new_sha = _git(clone, "rev-parse", "--short", "HEAD")
    assert new_sha != base_sha
    assert f"Updated engine/ cleanly: {base_sha} -> {new_sha}" in upd_res.stdout
    assert (clone / "app.py").read_text(encoding="utf-8") == "print('v2')\n"

    # --rollback restores the exact baseline commit cleanly.
    rb_res = _run_updater(clone, "--rollback", base_sha, "--no-restart")
    assert rb_res.returncode == 0, rb_res.stderr
    assert _git(clone, "rev-parse", "--short", "HEAD") == base_sha
    assert (clone / "app.py").read_text(encoding="utf-8") == "print('v1')\n"


def test_update_engine_rejects_dirty_clone(tmp_path: Path) -> None:
    """Updater refuses to pull when engine/ has local untracked or edited files."""
    _, clone, _ = _init_upstream_and_clone(tmp_path)
    (clone / "local_edit.txt").write_text("dirty\n", encoding="utf-8")

    res = _run_updater(clone, "--check")
    assert res.returncode != 0
    assert "local modifications" in res.stderr
