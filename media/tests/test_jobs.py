"""Unit tests for bounded temporary media job store and validation."""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from jobs import InvalidMediaInputError, JobNotFoundError, MediaJobStore, resolve_video_extension, validate_job_id


def test_validate_job_id_and_extension_reject_traversal_and_bad_types() -> None:
    assert validate_job_id("0123456789ABCDEF") == "0123456789abcdef"
    with pytest.raises(InvalidMediaInputError):
        validate_job_id("../etc/passwd")
    with pytest.raises(InvalidMediaInputError):
        resolve_video_extension("malware.exe")
    assert resolve_video_extension("NewsClip.MP4") == ".mp4"
    for audio_ext in (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"):
        assert resolve_video_extension(f"clip{audio_ext}") == audio_ext


def test_job_store_enforces_cap_and_ttl(tmp_path: Path) -> None:
    store = MediaJobStore(tmp_path, max_jobs=2, ttl_seconds=60)
    j1 = store.create_job("a.mp4")
    j1.source_video.write_bytes(b"v1")
    old_ts = time.time() - 120
    os.utime(j1.root, (old_ts, old_ts))

    j2 = store.create_job("b.mp4")
    j2.source_video.write_bytes(b"v2")
    assert not j1.root.exists()

    j3 = store.create_job("c.mp4")
    j3.source_video.write_bytes(b"v3")
    j4 = store.create_job("d.mp4")
    j4.source_video.write_bytes(b"v4")

    with pytest.raises(JobNotFoundError):
        store.get_job(j2.job_id)
    assert store.get_job(j4.job_id).source_video.read_bytes() == b"v4"


def test_job_store_recovers_when_base_dir_deleted_at_runtime(tmp_path: Path) -> None:
    import shutil

    base_dir = tmp_path / "jobs"
    store = MediaJobStore(base_dir, max_jobs=2, ttl_seconds=60)
    shutil.rmtree(base_dir)
    assert not base_dir.exists()

    recovered = store.create_job("clip.mp4")
    assert recovered.root.is_dir()
    with pytest.raises(JobNotFoundError):
        store.get_job("0123456789abcdef")
