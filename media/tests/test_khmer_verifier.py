"""Unit tests for pure-domain Khmer ASR quality scoring, Whisper arbitration, and TTS round-trip verification."""

from __future__ import annotations

from khmer_verifier import (
    CandidatePair,
    assess_khmer_turn_quality,
    compare_khmer_speech_texts,
    compute_khmer_oov_ratio,
    detect_repetition_loop,
    reconcile_khmer_candidates,
)


def test_detect_repetition_loop_catches_spaced_and_unspaced_loops_without_false_positives() -> None:
    """Repetition detector flags >=3 consecutive repeats while allowing normal Khmer doubles."""
    assert detect_repetition_loop("") is False
    assert detect_repetition_loop("សួស្តី កម្ពុជា ថ្ងៃនេះ មាន ព័ត៌មាន ថ្មី") is False
    assert detect_repetition_loop("បាទ បាទ ល្អ ណាស់") is False
    assert detect_repetition_loop("បាទ បាទ បាទ") is True
    assert detect_repetition_loop("សួស្តី អ្នក ទាំងអស់ គ្នា សួស្តី អ្នក ទាំងអស់ គ្នា") is False
    assert detect_repetition_loop("ទៅ ផ្សារ ទៅ ផ្សារ ទៅ ផ្សារ") is True
    assert detect_repetition_loop("សួស្តីសួស្តីសួស្តី") is True


def test_assess_khmer_turn_quality_flags_empty_loop_and_high_oov_only() -> None:
    """Quality scorer marks empty, looping, and high-OOV turns suspicious while passing clean Khmer."""
    known = {"សួស្តី", "កម្ពុជា", "ថ្ងៃនេះ", "ព័ត៌មាន"}
    clean = assess_khmer_turn_quality("សួស្តី កម្ពុជា ថ្ងៃនេះ ព័ត៌មាន", is_known_fn=lambda w: w in known)
    assert clean.is_suspicious is False
    assert clean.reason == ""

    empty = assess_khmer_turn_quality("   ", is_known_fn=lambda w: w in known)
    assert empty.is_suspicious is True and empty.reason == "empty"

    loop = assess_khmer_turn_quality("អរគុណ អរគុណ អរគុណ", is_known_fn=lambda w: w in known)
    assert loop.is_suspicious is True and loop.reason == "repetition_loop"

    # Single OOV proper noun should NOT trigger suspicion (MIN_OOV_TOKENS_FOR_SUSPICION=2)
    single_oov = assess_khmer_turn_quality("សួស្តី កខគឃងចឆ", is_known_fn=lambda w: w in known)
    assert single_oov.is_suspicious is False

    high_oov = assess_khmer_turn_quality("កខគឃង ចឆជឈញ ដឋឌឍណ", is_known_fn=lambda w: w in known)
    assert high_oov.is_suspicious is True and high_oov.reason == "high_oov"
    ratio, oov_cnt, total = compute_khmer_oov_ratio("កខគឃង ចឆជឈញ ដឋឌឍណ", is_known_fn=lambda w: w in known)
    assert ratio == 1.0 and oov_cnt == 3 and total == 3


def test_compare_khmer_speech_texts_is_spacing_invariant_and_reports_missing_terms() -> None:
    """Khmer spacing and punctuation differences do not penalize CER; dropped/mispronounced words do."""
    same_spacing = compare_khmer_speech_texts("សួស្តី កម្ពុជា!", "សួស្តីកម្ពុជា")
    assert same_spacing.verdict == "pass"
    assert same_spacing.similarity == 1.0
    assert same_spacing.cer == 0.0
    assert same_spacing.missing_terms == ()

    partial = compare_khmer_speech_texts(
        "សួស្តី អ្នកទាំងអស់គ្នា ថ្ងៃនេះ យើង ពិនិត្យ សំឡេង ភាសាខ្មែរ",
        "សួស្តី អ្នកទាំងអស់គ្នា ថ្ងៃនេះ យើង សំឡេង",
    )
    assert partial.verdict in ("warn", "fail")
    assert partial.similarity < 0.85
    assert "ពិនិត្យ" in partial.missing_terms
    assert "ភាសាខ្មែរ" in partial.missing_terms

    silent = compare_khmer_speech_texts("សួស្តី កម្ពុជា", "")
    assert silent.verdict == "fail" and silent.cer == 1.0 and silent.similarity == 0.0
    assert "សួស្តី" in silent.missing_terms


def test_reconcile_khmer_candidates_recovers_failures_and_never_blindly_overwrites_clean_text() -> None:
    """Reconciler adopts Whisper on empty/loop failure, suggests non-destructively on diffs, and ignores tiny diffs."""
    known = {"សួស្តី", "កម្ពុជា", "ថ្ងៃនេះ", "ព័ត៌មាន", "សង្គម"}
    is_known = lambda w: w in known

    # 1. Empty primary recovered by clean secondary Whisper
    q_empty = assess_khmer_turn_quality("", is_known_fn=is_known)
    q_clean = assess_khmer_turn_quality("សួស្តី កម្ពុជា", is_known_fn=is_known)
    rec_empty = reconcile_khmer_candidates(CandidatePair("", "សួស្តី កម្ពុជា", q_empty, q_clean))
    assert rec_empty.used_fallback is True
    assert rec_empty.text == "សួស្តី កម្ពុជា"
    assert rec_empty.verify_reason == "whisper_fallback"

    # 2. Loop primary recovered by clean secondary Whisper, keeping raw loop in alt_text
    q_loop = assess_khmer_turn_quality("បាទ បាទ បាទ", is_known_fn=is_known)
    rec_loop = reconcile_khmer_candidates(CandidatePair("បាទ បាទ បាទ", "សួស្តី កម្ពុជា", q_loop, q_clean))
    assert rec_loop.used_fallback is True
    assert rec_loop.text == "សួស្តី កម្ពុជា"
    assert rec_loop.alt_text == "បាទ បាទ បាទ"

    # 3. High-OOV readable primary keeps primary text and attaches Whisper as alt_text suggestion
    q_oov = assess_khmer_turn_quality("កខគឃង ចឆជឈញ", is_known_fn=is_known)
    rec_oov = reconcile_khmer_candidates(CandidatePair("កខគឃង ចឆជឈញ", "សួស្តី កម្ពុជា", q_oov, q_clean))
    assert rec_oov.used_fallback is False
    assert rec_oov.text == "កខគឃង ចឆជឈញ"
    assert rec_oov.alt_text == "សួស្តី កម្ពុជា"
    assert rec_oov.verify_reason == "high_oov"

    # 4. Double-check on clean text with trivial spacing difference suppresses noisy alt_text
    rec_same = reconcile_khmer_candidates(
        CandidatePair("សួស្តី កម្ពុជា", "សួស្តីកម្ពុជា", q_clean, q_clean),
        force_double_check=True,
    )
    assert rec_same.alt_text == "" and rec_same.verify_reason == ""

    # 5. Double-check on clean text with substantial difference exposes alt_text without overwriting primary
    q_other = assess_khmer_turn_quality("ថ្ងៃនេះ ព័ត៌មាន សង្គម", is_known_fn=is_known)
    rec_diff = reconcile_khmer_candidates(
        CandidatePair("សួស្តី កម្ពុជា", "ថ្ងៃនេះ ព័ត៌មាន សង្គម", q_clean, q_other),
        force_double_check=True,
    )
    assert rec_diff.used_fallback is False
    assert rec_diff.text == "សួស្តី កម្ពុជា"
    assert rec_diff.alt_text == "ថ្ងៃនេះ ព័ត៌មាន សង្គម"
    assert rec_diff.verify_reason == "double_check"
