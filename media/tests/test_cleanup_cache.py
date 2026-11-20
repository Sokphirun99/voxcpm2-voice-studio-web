"""Unit tests verifying scoped HuggingFace cache cleanup preserves unrelated user models."""

from __future__ import annotations

from pathlib import Path

import pytest

from cleanup_cache import cleanup_hf_cache, select_target_repos


def _create_fake_hf_repo(hub_dir: Path, repo_type: str, repo_id: str, payload_bytes: bytes, commit_hash: str) -> Path:
    """Construct a minimal valid HuggingFace hub cache entry with blob + snapshot symlink."""
    folder = hub_dir / f"{repo_type}s--{repo_id.replace('/', '--')}"
    blobs = folder / "blobs"
    snaps = folder / "snapshots" / commit_hash
    refs = folder / "refs"
    blobs.mkdir(parents=True)
    snaps.mkdir(parents=True)
    refs.mkdir(parents=True)
    blob_file = blobs / ("a" * 64)
    blob_file.write_bytes(payload_bytes)
    (snaps / "weights.bin").symlink_to(blob_file)
    (refs / "main").write_text(commit_hash, encoding="utf-8")
    return folder


def test_select_target_repos_rejects_invalid_scope() -> None:
    assert ("model", "metythorn/whisper-large-v3-turbo") in select_target_repos("unused")
    assert ("model", "openbmb/VoxCPM2") not in select_target_repos("unused")
    assert ("model", "seanghay/whisper-small-khmer-v2") not in select_target_repos("unused")
    assert ("model", "seanghay/whisper-small-khmer-v2") in select_target_repos("all")
    assert ("model", "openbmb/VoxCPM2") in select_target_repos("all")
    with pytest.raises(ValueError):
        select_target_repos("invalid")


def test_cleanup_hf_cache_preserves_unrelated_and_respects_scope(tmp_path: Path) -> None:
    hub_dir = tmp_path / "hub"
    unused_dir = _create_fake_hf_repo(hub_dir, "model", "metythorn/whisper-large-v3-turbo", b"x" * 4096, "1" * 40)
    active_dir = _create_fake_hf_repo(hub_dir, "model", "openbmb/VoxCPM2", b"y" * 8192, "2" * 40)
    personal_dir = _create_fake_hf_repo(hub_dir, "model", "ACE-Step/Ace-Step1.5", b"z" * 4096, "3" * 40)
    stub_dir = hub_dir / "models--metythorn--whisper-large-v3"
    stub_dir.mkdir(parents=True)

    dry = cleanup_hf_cache("unused", dry_run=True, cache_dir=hub_dir)
    assert dry["dryRun"] is True
    assert dry["freedBytes"] == 4096
    assert unused_dir.exists() and stub_dir.exists()

    pruned = cleanup_hf_cache("unused", dry_run=False, cache_dir=hub_dir)
    assert pruned["freedBytes"] == 4096
    assert not unused_dir.exists()
    assert not stub_dir.exists()
    assert active_dir.exists()
    assert personal_dir.exists()

    full = cleanup_hf_cache("all", dry_run=False, cache_dir=hub_dir)
    assert full["freedBytes"] == 8192
    assert not active_dir.exists()
    assert personal_dir.exists()


def test_cleanup_hf_cache_handles_missing_directory(tmp_path: Path) -> None:
    report = cleanup_hf_cache("unused", dry_run=False, cache_dir=tmp_path / "missing")
    assert report == {"scope": "unused", "dryRun": False, "freedBytes": 0, "freedMiB": 0.0, "repos": []}
