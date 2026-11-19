"""Bounded temporary workspace for uploaded videos, extracted audio, and rendered exports."""

from __future__ import annotations

import re
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

JOB_ID_PATTERN = re.compile(r"^[a-f0-9]{16}$")
ALLOWED_VIDEO_EXTS = frozenset({".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"})
DEFAULT_JOB_TTL_SECONDS = 3600
MAX_STORED_JOBS = 12


class JobNotFoundError(FileNotFoundError):
    """Raised when a media job ID is missing or expired."""


class InvalidMediaInputError(ValueError):
    """Raised when a job ID, filename, or upload violates input rules."""


@dataclass(frozen=True)
class MediaJobPaths:
    """File paths associated with one uploaded video processing job."""

    job_id: str
    root: Path
    source_video: Path
    audio_wav: Path
    ass_file: Path
    burned_mp4: Path


def validate_job_id(job_id: str) -> str:
    """Validate hex job ID format to prevent path traversal."""
    cleaned = (job_id or "").strip().lower()
    if not JOB_ID_PATTERN.match(cleaned):
        raise InvalidMediaInputError("Invalid media job identifier.")
    return cleaned


def resolve_video_extension(filename: str | None) -> str:
    """Validate and normalize an uploaded audio/video file extension."""
    suffix = Path(filename or "").suffix.lower()
    if suffix not in ALLOWED_VIDEO_EXTS:
        allowed = ", ".join(sorted(ALLOWED_VIDEO_EXTS))
        raise InvalidMediaInputError(f"Unsupported file extension '{suffix or '(none)'}'. Supported: {allowed}")
    return suffix


class MediaJobStore:
    """Disk-backed bounded job store with age and count eviction."""

    def __init__(self, base_dir: Path, max_jobs: int = MAX_STORED_JOBS, ttl_seconds: int = DEFAULT_JOB_TTL_SECONDS) -> None:
        self._base_dir = Path(base_dir)
        self._max_jobs = max(1, int(max_jobs))
        self._ttl_seconds = max(60, int(ttl_seconds))
        self._base_dir.mkdir(parents=True, exist_ok=True)

    def _build_paths(self, job_id: str, ext: str) -> MediaJobPaths:
        root = (self._base_dir / job_id).resolve()
        return MediaJobPaths(
            job_id=job_id,
            root=root,
            source_video=root / f"source{ext}",
            audio_wav=root / "audio_16k.wav",
            ass_file=root / "subtitles.ass",
            burned_mp4=root / "subtitled.mp4",
        )

    def prune_expired(self, keep_slots: int | None = None) -> None:
        """Evict jobs older than TTL or beyond the bounded directory cap."""
        self._base_dir.mkdir(parents=True, exist_ok=True)
        now = time.time()
        cap = self._max_jobs if keep_slots is None else max(0, keep_slots)
        dirs = sorted((d for d in self._base_dir.iterdir() if d.is_dir()), key=lambda p: p.stat().st_mtime_ns, reverse=True)
        for idx, job_dir in enumerate(dirs):
            too_old = (now - job_dir.stat().st_mtime) > self._ttl_seconds
            over_cap = idx >= cap
            if too_old or over_cap:
                shutil.rmtree(job_dir, ignore_errors=True)

    def create_job(self, filename: str | None) -> MediaJobPaths:
        """Allocate a fresh bounded directory for a validated upload filename."""
        self.prune_expired(keep_slots=self._max_jobs - 1)
        ext = resolve_video_extension(filename)
        job_id = uuid.uuid4().hex[:16]
        paths = self._build_paths(job_id, ext)
        paths.root.mkdir(parents=True, exist_ok=True)
        return paths

    def get_job(self, raw_job_id: str) -> MediaJobPaths:
        """Locate an existing job workspace and refresh its access timestamp."""
        job_id = validate_job_id(raw_job_id)
        job_dir = (self._base_dir / job_id).resolve()
        if not job_dir.is_dir() or job_dir.parent != self._base_dir.resolve():
            raise JobNotFoundError(f"Video session '{job_id}' expired. Please re-upload the video.")
        sources = sorted(job_dir.glob("source.*"))
        if not sources:
            raise JobNotFoundError(f"Source media missing for session '{job_id}'.")
        job_dir.touch()
        return self._build_paths(job_id, sources[0].suffix)
