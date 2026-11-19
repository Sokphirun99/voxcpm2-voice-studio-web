"""Pure-domain Khmer ASR quality scoring, selective Whisper arbitration, and TTS round-trip verification."""

from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from typing import Callable

from khmer_dictionary import KHMER_WORD_RE, is_known_khmer_word

DEFAULT_KHMER_VERIFIER_REPO = os.environ.get("MEDIA_KHMER_VERIFIER_MODEL", "seanghay/whisper-small-khmer-v2")

OOV_SUSPICION_RATIO = 0.45
MIN_OOV_TOKENS_FOR_SUSPICION = 2
MIN_KHMER_TOKEN_LEN = 4
MIN_REPEAT_COUNT = 3
MIN_UNSPACED_REPEAT_CHARS = 3
SIGNIFICANT_DIFF_THRESHOLD = 0.12
VERDICT_PASS_SIMILARITY = 0.85
VERDICT_WARN_SIMILARITY = 0.65
MAX_MISSING_TERMS = 8
MAX_VERIFY_TEXT_CHARS = 5000

_ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\ufeff]")
_PUNCT_AND_SPACE_RE = re.compile(r"[\s.,!?;:\"'“”‘’()\[\]{}…—–\-/\\|។៕៖ៗ៘៙៚]+")
_UNSPACED_REPEAT_RE = re.compile(r"(.{3,24}?)\1{2,}")
_KHMER_TOKEN_SPLIT_RE = re.compile(r"[\s.,!?;:\"'()\[\]{}។៕៖\-/]+")


@dataclass(frozen=True)
class TurnQuality:
    """Quality assessment for one Khmer ASR segment output."""

    is_suspicious: bool
    reason: str
    oov_ratio: float
    oov_count: int


@dataclass(frozen=True)
class CandidatePair:
    """Primary and secondary Khmer ASR candidates paired with their quality evaluations."""

    primary_text: str
    secondary_text: str
    primary_quality: TurnQuality
    secondary_quality: TurnQuality


@dataclass(frozen=True)
class ReconciledSegmentText:
    """Reconciled primary subtitle text plus optional Whisper second-opinion metadata."""

    text: str
    alt_text: str
    verify_reason: str
    used_fallback: bool


@dataclass(frozen=True)
class SpeechVerificationScore:
    """Round-trip comparison metrics between expected TTS script and ASR-heard text."""

    verdict: str
    similarity: float
    cer: float
    missing_terms: tuple[str, ...]


def _normalize_for_comparison(text: str) -> str:
    """Normalize text into spacing- and punctuation-free lowercase NFC form for Khmer-safe CER."""
    nfc = unicodedata.normalize("NFC", text or "").lower()
    no_zw = _ZERO_WIDTH_RE.sub("", nfc)
    return _PUNCT_AND_SPACE_RE.sub("", no_zw)


def _has_repeated_spaced_tokens(tokens: list[str]) -> bool:
    """Return True when the same word or 2-word phrase repeats consecutively >= MIN_REPEAT_COUNT times."""
    if len(tokens) < MIN_REPEAT_COUNT:
        return False
    run = 1
    for idx in range(1, len(tokens)):
        run = run + 1 if tokens[idx] == tokens[idx - 1] else 1
        if run >= MIN_REPEAT_COUNT:
            return True
    for idx in range(len(tokens) - 5):
        pair = (tokens[idx], tokens[idx + 1])
        if pair == (tokens[idx + 2], tokens[idx + 3]) == (tokens[idx + 4], tokens[idx + 5]):
            return True
    return False


def detect_repetition_loop(text: str) -> bool:
    """Detect degenerate consecutive token or unspaced substring repetition loops in ASR output.

    Inputs: raw or normalized transcript string `text`.
    Outputs: True when a repetition loop (>= 3 consecutive repeats) is detected.
    Side effects: none.
    Failure modes: returns False for blank strings.
    """
    cleaned = _ZERO_WIDTH_RE.sub("", unicodedata.normalize("NFC", text or "")).strip()
    if not cleaned:
        return False
    tokens = [tok for tok in _KHMER_TOKEN_SPLIT_RE.split(cleaned) if tok]
    if _has_repeated_spaced_tokens(tokens):
        return True
    compact = _PUNCT_AND_SPACE_RE.sub("", cleaned)
    return len(compact) >= MIN_UNSPACED_REPEAT_CHARS * MIN_REPEAT_COUNT and bool(_UNSPACED_REPEAT_RE.search(compact))


def compute_khmer_oov_ratio(
    text: str,
    is_known_fn: Callable[[str], bool] = is_known_khmer_word,
) -> tuple[float, int, int]:
    """Compute out-of-vocabulary ratio across multi-character Khmer tokens in `text`.

    Inputs: `text` transcript and `is_known_fn` lexicon predicate.
    Outputs: `(oov_ratio, oov_count, total_khmer_tokens)`.
    Side effects: loads the local Khmer lexicon lazily when using the default predicate.
    Failure modes: returns `(0.0, 0, 0)` when no eligible Khmer tokens exist.
    """
    cleaned = _ZERO_WIDTH_RE.sub("", unicodedata.normalize("NFC", text or ""))
    tokens = [
        tok for tok in _KHMER_TOKEN_SPLIT_RE.split(cleaned)
        if len(tok) >= MIN_KHMER_TOKEN_LEN and KHMER_WORD_RE.match(tok)
    ]
    if not tokens:
        return 0.0, 0, 0
    oov_count = sum(1 for tok in tokens if not is_known_fn(tok))
    return round(oov_count / len(tokens), 4), oov_count, len(tokens)


def assess_khmer_turn_quality(
    text: str,
    is_known_fn: Callable[[str], bool] = is_known_khmer_word,
) -> TurnQuality:
    """Evaluate a Khmer ASR turn for objective failure signals (`empty`, `repetition_loop`, `high_oov`).

    Inputs: decoded turn `text` and optional lexicon lookup function.
    Outputs: immutable `TurnQuality` record.
    Side effects: none beyond lazy lexicon load on default predicate.
    Failure modes: treats whitespace-only strings as `empty`.
    """
    stripped = (text or "").strip()
    if not stripped:
        return TurnQuality(is_suspicious=True, reason="empty", oov_ratio=1.0, oov_count=0)
    if detect_repetition_loop(stripped):
        return TurnQuality(is_suspicious=True, reason="repetition_loop", oov_ratio=1.0, oov_count=0)
    oov_ratio, oov_count, _ = compute_khmer_oov_ratio(stripped, is_known_fn=is_known_fn)
    is_high_oov = oov_count >= MIN_OOV_TOKENS_FOR_SUSPICION and oov_ratio >= OOV_SUSPICION_RATIO
    return TurnQuality(
        is_suspicious=is_high_oov,
        reason="high_oov" if is_high_oov else "",
        oov_ratio=oov_ratio,
        oov_count=oov_count,
    )


def _levenshtein_distance(source: str, target: str) -> int:
    """Compute character-level Levenshtein edit distance in O(min(m, n)) memory."""
    if source == target:
        return 0
    if not source:
        return len(target)
    if not target:
        return len(source)
    if len(source) < len(target):
        source, target = target, source
    prev = list(range(len(target) + 1))
    for i, ch_s in enumerate(source, start=1):
        curr = [i]
        for j, ch_t in enumerate(target, start=1):
            cost = 0 if ch_s == ch_t else 1
            curr.append(min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost))
        prev = curr
    return prev[-1]


def _extract_missing_terms(expected: str, heard_compact: str) -> tuple[str, ...]:
    """Identify expected terms absent from the compact normalized heard transcript."""
    raw_terms = [tok for tok in _KHMER_TOKEN_SPLIT_RE.split(unicodedata.normalize("NFC", expected or "")) if tok]
    missing: list[str] = []
    seen: set[str] = set()
    for term in raw_terms:
        compact_term = _normalize_for_comparison(term)
        if len(compact_term) < 2 or compact_term in seen:
            continue
        seen.add(compact_term)
        if compact_term not in heard_compact:
            missing.append(term)
            if len(missing) >= MAX_MISSING_TERMS:
                break
    return tuple(missing)


def _resolve_verdict(similarity: float) -> str:
    """Map normalized similarity ratio into `'pass'`, `'warn'`, or `'fail'`."""
    if similarity >= VERDICT_PASS_SIMILARITY:
        return "pass"
    if similarity >= VERDICT_WARN_SIMILARITY:
        return "warn"
    return "fail"


def compare_khmer_speech_texts(expected: str, heard: str) -> SpeechVerificationScore:
    """Compare expected TTS script against ASR-heard text using Khmer-spacing-invariant CER.

    Inputs: `expected` script text and `heard` ASR transcript.
    Outputs: immutable `SpeechVerificationScore` with `verdict`, `similarity`, `cer`, and `missing_terms`.
    Side effects: none.
    Failure modes: returns `fail` with `cer=1.0` when `expected` is non-empty and `heard` is blank.
    """
    exp_compact = _normalize_for_comparison(expected)
    heard_compact = _normalize_for_comparison(heard)
    if not exp_compact:
        return SpeechVerificationScore(verdict="fail", similarity=0.0, cer=1.0, missing_terms=())
    if not heard_compact:
        return SpeechVerificationScore(
            verdict="fail", similarity=0.0, cer=1.0, missing_terms=_extract_missing_terms(expected, "")
        )
    distance = _levenshtein_distance(exp_compact, heard_compact)
    cer = min(1.0, round(distance / max(1, len(exp_compact)), 4))
    similarity = round(max(0.0, 1.0 - cer), 4)
    return SpeechVerificationScore(
        verdict=_resolve_verdict(similarity),
        similarity=similarity,
        cer=cer,
        missing_terms=_extract_missing_terms(expected, heard_compact),
    )


def _should_adopt_fallback(pair: CandidatePair) -> bool:
    """Return True when primary failed (`empty` or `repetition_loop`) and secondary is clean."""
    if pair.primary_quality.reason not in ("empty", "repetition_loop"):
        return False
    if not pair.secondary_text.strip():
        return False
    return pair.secondary_quality.reason not in ("empty", "repetition_loop")


def reconcile_khmer_candidates(
    pair: CandidatePair,
    force_double_check: bool = False,
) -> ReconciledSegmentText:
    """Arbitrate between primary Qwen3-ASR and secondary Whisper Khmer candidates without accuracy regression.

    Inputs: `CandidatePair` and `force_double_check` flag.
    Outputs: `ReconciledSegmentText` keeping primary text on readable turns and surfacing non-trivial Whisper diffs as `alt_text`.
    Side effects: none.
    Failure modes: preserves primary text untouched if secondary output is blank or degenerate.
    """
    primary = (pair.primary_text or "").strip()
    secondary = (pair.secondary_text or "").strip()
    if _should_adopt_fallback(pair):
        return ReconciledSegmentText(
            text=secondary, alt_text=primary, verify_reason="whisper_fallback", used_fallback=True
        )
    if not secondary or pair.secondary_quality.reason in ("empty", "repetition_loop"):
        return ReconciledSegmentText(text=primary, alt_text="", verify_reason="", used_fallback=False)
    diff = compare_khmer_speech_texts(primary, secondary)
    if diff.cer < SIGNIFICANT_DIFF_THRESHOLD:
        return ReconciledSegmentText(text=primary, alt_text="", verify_reason="", used_fallback=False)
    reason = pair.primary_quality.reason or ("double_check" if force_double_check else "")
    return ReconciledSegmentText(text=primary, alt_text=secondary, verify_reason=reason, used_fallback=False)
