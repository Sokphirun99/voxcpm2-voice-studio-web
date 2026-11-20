"""Scoped HuggingFace cache cleanup helper for VoxCPM Voice Studio without touching unrelated projects."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Sequence

from huggingface_hub import HFCacheInfo, constants, scan_cache_dir

BYTES_PER_MIB = 1024 * 1024

UNUSED_BENCHMARK_REPOS: frozenset[tuple[str, str]] = frozenset({
    ("model", "Darayut/omniASR-CTC-1B-km-en"),
    ("model", "metythorn/whisper-large-v3-turbo"),
    ("model", "Vagabond404/khmer-asr-sota"),
    ("dataset", "seanghay/khmer-dictionary-44k"),
    ("model", "phonsobon/khmer-english-spellchecker"),
    ("model", "metythorn/whisper-large-v3"),
    ("model", "Tnaot/whisper-large-v3-khmer-ct2"),
    ("model", "muyleanging/Sota-ASR-Khmer"),
    ("model", "seanghay/Qwen3-ASR-0.6B-Khmer-v4"),
})

ACTIVE_PROJECT_REPOS: frozenset[tuple[str, str]] = frozenset({
    ("model", "openbmb/VoxCPM2"),
    ("model", "facebook/nllb-200-distilled-600M"),
    ("model", "mlx-community/whisper-large-v3-turbo"),
    ("model", "seanghay/Qwen3-ASR-0.6B-Khmer"),
    ("model", "seanghay/whisper-small-khmer-v2"),
})


def select_target_repos(scope: str) -> frozenset[tuple[str, str]]:
    """Return allowed `(repo_type, repo_id)` pairs for `unused` or `all` scope."""
    normalized = scope.strip().lower()
    if normalized == "unused":
        return UNUSED_BENCHMARK_REPOS
    if normalized == "all":
        return UNUSED_BENCHMARK_REPOS | ACTIVE_PROJECT_REPOS
    raise ValueError(f"Unsupported cleanup scope '{scope}'; expected 'unused' or 'all'.")


def _expected_repo_dir_name(repo_type: str, repo_id: str) -> str:
    """Build HuggingFace hub directory name (`models--owner--name`) safely."""
    safe_id = repo_id.replace("/", "--")
    return f"{repo_type}s--{safe_id}"


def _find_matching_repos(cache_info: HFCacheInfo, targets: frozenset[tuple[str, str]]) -> list:
    """Filter cached HuggingFace repo records that strictly belong to `targets`."""
    return [repo for repo in cache_info.repos if (repo.repo_type, repo.repo_id) in targets]


def _prune_empty_stub_dirs(cache_dir: Path, targets: frozenset[tuple[str, str]], dry_run: bool) -> list[str]:
    """Remove leftover stub repo directories under `cache_dir` that match `targets`."""
    removed: list[str] = []
    resolved_root = cache_dir.resolve()
    for repo_type, repo_id in sorted(targets):
        candidate = cache_dir / _expected_repo_dir_name(repo_type, repo_id)
        if not candidate.exists() or candidate.is_symlink():
            continue
        if not candidate.resolve().is_relative_to(resolved_root):
            continue
        removed.append(f"{repo_type}:{repo_id}")
        if not dry_run:
            shutil.rmtree(candidate)
    return removed


def _delete_matched_revisions(cache_info: HFCacheInfo, matched: list, dry_run: bool) -> int:
    """Delete HuggingFace revisions belonging strictly to `matched` and return expected freed bytes."""
    rev_hashes = [rev.commit_hash for repo in matched for rev in repo.revisions]
    if not rev_hashes:
        return 0
    allowed_paths = {repo.repo_path for repo in matched}
    strategy = cache_info.delete_revisions(*rev_hashes)
    if not set(strategy.repos).issubset(allowed_paths):
        raise RuntimeError("Refusing cache deletion spanning outside allowed project repositories.")
    if not dry_run:
        strategy.execute()
    return int(strategy.expected_freed_size)


def cleanup_hf_cache(scope: str, dry_run: bool = True, cache_dir: Path | None = None) -> dict:
    """Delete targeted project HuggingFace repos while preserving unrelated user models.

    Inputs: `scope` ('unused' | 'all'), `dry_run` flag, optional `cache_dir` override.
    Outputs: summary dict with `scope`, `dryRun`, `freedBytes`, `freedMiB`, and `repos`.
    Side effects: deletes matched HuggingFace revisions/blobs and stub folders when `dry_run=False`.
    Failure modes: returns empty report when cache directory does not exist; raises ValueError on bad scope.
    """
    targets = select_target_repos(scope)
    root_dir = Path(cache_dir) if cache_dir is not None else Path(constants.HF_HUB_CACHE)
    if not root_dir.is_dir():
        return {"scope": scope, "dryRun": dry_run, "freedBytes": 0, "freedMiB": 0.0, "repos": []}
    cache_info = scan_cache_dir(root_dir)
    matched = _find_matching_repos(cache_info, targets)
    freed_bytes = _delete_matched_revisions(cache_info, matched, dry_run)
    stub_repos = _prune_empty_stub_dirs(root_dir, targets, dry_run)
    names = sorted({f"{r.repo_type}:{r.repo_id}" for r in matched} | set(stub_repos))
    return {"scope": scope, "dryRun": dry_run, "freedBytes": freed_bytes, "freedMiB": round(freed_bytes / BYTES_PER_MIB, 2), "repos": names}


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse CLI arguments for scoped HuggingFace cache cleanup."""
    parser = argparse.ArgumentParser(description="Clean project-specific HuggingFace model caches safely.")
    parser.add_argument("--scope", required=True, choices=["unused", "all"], help="Clean 'unused' benchmark models or 'all' project models.")
    parser.add_argument("--dry-run", action="store_true", help="Report what would be deleted without removing files.")
    parser.add_argument("--cache-dir", type=Path, default=None, help="Optional custom HuggingFace hub cache directory.")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entrypoint printing JSON cleanup report to stdout."""
    args = parse_args(argv)
    report = cleanup_hf_cache(scope=args.scope, dry_run=args.dry_run, cache_dir=args.cache_dir)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
