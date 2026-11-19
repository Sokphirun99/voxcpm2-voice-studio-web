"""Shared local-first HuggingFace snapshot resolver for offline execution."""

from __future__ import annotations


def resolve_hf_model_path(repo_id: str) -> str:
    """Return local cached snapshot directory when available, else `repo_id` for initial download."""
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(repo_id, local_files_only=True)
    except Exception:
        return repo_id
