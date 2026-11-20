"""Shared local-first HuggingFace snapshot resolver and offline model readiness inspector."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final

from diarizer import are_diarization_models_ready

MODEL_CACHE_REPOS: Final[dict[str, str]] = {
    "whisper": "mlx-community/whisper-large-v3-turbo",
    "khmerAsr": "seanghay/Qwen3-ASR-0.6B-Khmer",
    "translator": "facebook/nllb-200-distilled-600M",
}


def _default_hf_cache_dir() -> Path:
    """Resolve the HuggingFace hub cache path from environment without importing huggingface_hub."""
    explicit = os.environ.get("HF_HUB_CACHE", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    hf_home = os.environ.get("HF_HOME", "").strip()
    base = Path(hf_home).expanduser() if hf_home else Path.home() / ".cache" / "huggingface"
    return base / "hub"


def _repo_is_cached(cache_root: Path, repo_id: str) -> bool:
    """Return True when `repo_id` has at least one non-empty snapshot directory."""
    snapshots = cache_root / f"models--{repo_id.replace('/', '--')}" / "snapshots"
    if not snapshots.is_dir():
        return False
    try:
        return any(snapshot.is_dir() and any(snapshot.iterdir()) for snapshot in snapshots.iterdir())
    except OSError:
        return False


def inspect_model_readiness(cache_dir: Path | None = None) -> dict[str, bool]:
    """Report cached readiness for each project model strictly from local disk.

    Inputs: optional HuggingFace cache root (defaults to `HF_HUB_CACHE`/`HF_HOME`).
    Outputs: `{whisper, khmerAsr, translator, diarization}` booleans.
    Side effects: none; performs only local directory checks and no network I/O.
    """
    root = Path(cache_dir) if cache_dir is not None else _default_hf_cache_dir()
    readiness = {key: _repo_is_cached(root, repo) for key, repo in MODEL_CACHE_REPOS.items()}
    readiness["diarization"] = are_diarization_models_ready()
    return readiness


def resolve_hf_model_path(repo_id: str) -> str:
    """Return local cached snapshot directory when available, else `repo_id` for initial download."""
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(repo_id, local_files_only=True)
    except Exception:
        return repo_id
