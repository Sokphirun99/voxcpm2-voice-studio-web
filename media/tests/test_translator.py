"""Unit and regression tests for media/translator.py repetition guards and NLLB decoding config."""

from __future__ import annotations

from typing import Any

import torch

from translator import (
    DEFAULT_BATCH_SIZE,
    MAX_OUTPUT_TOKENS,
    MIN_OUTPUT_TOKENS,
    NO_REPEAT_NGRAM_SIZE,
    NUM_BEAMS,
    REPETITION_PENALTY,
    LocalTranslator,
    normalize_source_repeats,
    resolve_nllb_lang_code,
    sanitize_repetitive_translation,
)


class _FakeEncodedBatch(dict):
    """Minimal BatchEncoding-compatible dict supporting `.to(device)`."""

    def to(self, device: str) -> _FakeEncodedBatch:
        return self


class _FakeTokenizer:
    """Deterministic lightweight tokenizer stub recording source language and token lengths."""

    def __init__(self, seq_len: int = 8) -> None:
        self.src_lang = ""
        self.seq_len = seq_len
        self.last_texts: list[str] = []
        self._decoded_outputs: list[str] = []

    def __call__(
        self,
        texts: list[str],
        *,
        return_tensors: str,
        padding: bool,
        truncation: bool,
        max_length: int,
    ) -> _FakeEncodedBatch:
        self.last_texts = list(texts)
        return _FakeEncodedBatch(
            input_ids=torch.ones((len(texts), self.seq_len), dtype=torch.long),
            attention_mask=torch.ones((len(texts), self.seq_len), dtype=torch.long),
        )

    def convert_tokens_to_ids(self, code: str) -> int:
        return 256092 if code == "khm_Khmr" else 256047

    def batch_decode(self, generated: Any, skip_special_tokens: bool = True) -> list[str]:
        return list(self._decoded_outputs)


class _FakeSeq2SeqModel:
    """Seq2Seq model stub capturing `generate` kwargs without loading weights."""

    def __init__(self) -> None:
        self.generate_calls: list[dict[str, Any]] = []

    def generate(self, **kwargs: Any) -> torch.Tensor:
        self.generate_calls.append(kwargs)
        batch_size = int(kwargs["input_ids"].shape[0])
        return torch.ones((batch_size, 4), dtype=torch.long)


def test_normalize_source_repeats_collapses_repeated_clauses_and_preserves_valid_doubles() -> None:
    """Multi-word lyric/dialogue loops collapse while single lines and 2-word doubles stay intact."""
    repeated = "I'll always be there for you I'll always be there for you I'll always be there for you"
    assert normalize_source_repeats(repeated) == "I'll always be there for you"

    prefixed = "Sorry I'll always be there for you I'll always be there for you I'll always be there for you"
    assert normalize_source_repeats(prefixed) == "Sorry I'll always be there for you"

    punct_case = "I'll always be there for you, i'll always be there for you! I'LL ALWAYS BE THERE FOR YOU."
    assert normalize_source_repeats(punct_case) == "I'll always be there for you."

    normal = "I'll always be there for you Girl, I have no shame"
    assert normalize_source_repeats(normal) == normal

    assert normalize_source_repeats("I know that that had had to happen, bye bye") == "I know that that had had to happen, bye bye"
    assert normalize_source_repeats("Wait, wait, wait, let me explain") == "Wait, let me explain"
    assert normalize_source_repeats("Wait, wait, wait...") == "Wait..."
    assert normalize_source_repeats("Yes, yes, yes") == "Yes"
    assert normalize_source_repeats("(Wait) wait wait") == "(Wait)"
    assert normalize_source_repeats("(Wait, wait, wait)") == "(Wait)"
    assert normalize_source_repeats("(I'll always be there for you, I'll always be there for you!)") == "(I'll always be there for you!)"
    assert normalize_source_repeats('"I love you, I love you"') == '"I love you"'
    assert normalize_source_repeats("I'll go (I'll go)") == "I'll go"
    assert normalize_source_repeats("Yes ! Yes ! Yes !") == "Yes !"
    assert normalize_source_repeats("( wait ) wait") == "( wait ) wait"


def test_normalize_source_repeats_handles_unspaced_non_ascii_and_edge_cases() -> None:
    """Unspaced non-ASCII >=6-char phrases, multi-line/ZWSP repeats, 16-word bounds, and safe blanks."""
    assert normalize_source_repeats("សួស្តីកម្ពុជាសួស្តីកម្ពុជាសួស្តីកម្ពុជា") == "សួស្តីកម្ពុជា"
    assert normalize_source_repeats("abcdeabcdeabcde") == "abcdeabcdeabcde"
    assert normalize_source_repeats("123456123456123456") == "123456123456123456"
    assert normalize_source_repeats("100 100 100") == "100 100 100"
    assert normalize_source_repeats("... ... ...") == "... ... ..."
    assert normalize_source_repeats("! ! !") == "! ! !"
    assert normalize_source_repeats("   \t  ") == ""
    assert normalize_source_repeats("\u200b\u200b") == ""
    assert normalize_source_repeats("") == ""
    assert normalize_source_repeats("Line one\nLine two") == "Line one\nLine two"

    assert (
        normalize_source_repeats("I'll always be there for you\nI'll always be there for you\nI'll always be there for you")
        == "I'll always be there for you"
    )
    assert (
        normalize_source_repeats("Sorry\nI'll always be there for you\nI'll always be there for you\nI'll always be there for you")
        == "Sorry\nI'll always be there for you"
    )
    assert normalize_source_repeats("Line A\nLine B\nLine A\nLine B") == "Line A\nLine B"
    assert normalize_source_repeats("សួស្តី\u200bសួស្តី\u200bសួស្តី") == "សួស្តី"
    assert normalize_source_repeats("សួស្តី\u200bសួស្តី") == "សួស្តី\u200bសួស្តី"
    assert normalize_source_repeats("ខ្ញុំ\u200bនឹង\u200bនៅ\u200bខ្ញុំ\u200bនឹង\u200bនៅ\u200bខ្ញុំ\u200bនឹង\u200bនៅ") == "ខ្ញុំ\u200bនឹង\u200bនៅ"

    span_16 = " ".join(f"w{i}" for i in range(16))
    assert normalize_source_repeats(f"{span_16} {span_16}") == span_16
    span_17 = " ".join(f"w{i}" for i in range(17))
    assert normalize_source_repeats(f"{span_17} {span_17}") == f"{span_17} {span_17}"


def test_sanitize_repetitive_translation_cleans_spaced_and_unspaced_khmer_loops() -> None:
    """Post-decode guard removes spaced/unspaced/mixed-space Khmer loops and truncated tails without harming digits/punct."""
    assert sanitize_repetitive_translation("នៅ តែ នៅ តែ នៅ តែ") == "នៅ តែ"
    assert sanitize_repetitive_translation("នៅ តែ នៅ តែ នៅ តែ...") == "នៅ តែ..."
    assert sanitize_repetitive_translation("នៅ តែ នៅ តែ នៅ តែ នៅ") == "នៅ តែ"
    assert (
        sanitize_repetitive_translation("អ្នក ជា មួយ អ្នក ជា មួយ អ្នក ជា មួយ ជា ដដែល ជា ដដែល ជា ដដែល")
        == "អ្នក ជា មួយ ជា ដដែល"
    )
    assert sanitize_repetitive_translation("នៅ តែ នៅ តែ") == "នៅ តែ នៅ តែ"

    unspaced = "ខ្ញុំនឹងនៅជាមួយអ្នកខ្ញុំនឹងនៅជាមួយអ្នកខ្ញុំនឹងនៅជាមួយអ្នក"
    assert sanitize_repetitive_translation(unspaced) == "ខ្ញុំនឹងនៅជាមួយអ្នក"
    assert sanitize_repetitive_translation(unspaced + "ខ្ញុំនឹង") == "ខ្ញុំនឹងនៅជាមួយអ្នក"
    assert sanitize_repetitive_translation(unspaced + "ខ្ញុំនឹង...") == "ខ្ញុំនឹងនៅជាមួយអ្នក..."
    assert sanitize_repetitive_translation("សួស្តី " + unspaced + "...") == "សួស្តី ខ្ញុំនឹងនៅជាមួយអ្នក..."
    assert sanitize_repetitive_translation("អូនអូនអូន") == "អូន"
    assert sanitize_repetitive_translation("abcdabcdabcd") == "abcd"
    assert (
        sanitize_repetitive_translation("សូមទោស ខ្ញុំ នឹង នៅ ជាមួយ អ្នក ខ្ញុំនឹងនៅជាមួយអ្នក ខ្ញុំ នឹង នៅ ជាមួយ អ្នក")
        == "សូមទោស ខ្ញុំ នឹង នៅ ជាមួយ អ្នក"
    )
    assert sanitize_repetitive_translation("នៅ តែ នៅតែ") == "នៅ តែ នៅតែ"

    # Combining mark on the 3rd phrase makes it distinct from the first two; must not tear Khmer clusters.
    assert sanitize_repetitive_translation("កាលេកាលេកាលេ៉") == "កាលេកាលេកាលេ៉"

    for untouched in (
        "100000",
        "123412341234",
        "១២៣៤៥៦១២៣៤៥៦១២៣៤៥៦",
        "...",
        "... ... ...",
        "100 100 100",
        "a a a",
        "aaaaaaaaaaaa",
        "abcabcabc",
    ):
        assert sanitize_repetitive_translation(untouched) == untouched


def test_translate_batch_uses_repetition_safe_decoding_and_bounded_max_new_tokens() -> None:
    """_translate_batch forwards beam search, penalties, n-gram blocking, dynamic token cap, and output sanitization."""
    translator = LocalTranslator()
    tokenizer = _FakeTokenizer(seq_len=5)
    tokenizer._decoded_outputs = ["នៅ តែ នៅ តែ នៅ តែ"]
    model = _FakeSeq2SeqModel()
    translator._tokenizer = tokenizer
    translator._model = model

    # Empty batch returns early without hitting model.
    assert translator._translate_batch([], "eng_Latn", "khm_Khmr") == []
    assert model.generate_calls == []

    # Short input (5 tokens -> 15) clamps up to MIN_OUTPUT_TOKENS (32).
    out_short = translator._translate_batch(["Sorry"], "eng_Latn", "khm_Khmr")
    assert out_short == ["នៅ តែ"]
    call_short = model.generate_calls[-1]
    assert call_short["num_beams"] == NUM_BEAMS == 2
    assert call_short["early_stopping"] is True
    assert call_short["repetition_penalty"] == REPETITION_PENALTY == 1.15
    assert call_short["no_repeat_ngram_size"] == NO_REPEAT_NGRAM_SIZE == 5
    assert call_short["forced_bos_token_id"] == 256092
    assert call_short["max_new_tokens"] == MIN_OUTPUT_TOKENS == 32

    # Medium input (24 tokens -> 72).
    tokenizer.seq_len = 24
    tokenizer._decoded_outputs = ["សួស្តី"]
    translator._translate_batch(["Hello world"], "eng_Latn", "khm_Khmr")
    assert model.generate_calls[-1]["max_new_tokens"] == 72

    # Long input (150 tokens -> 450) clamps down to MAX_OUTPUT_TOKENS (256).
    tokenizer.seq_len = 150
    tokenizer._decoded_outputs = ["អត្ថបទវែង"]
    translator._translate_batch(["Long input"], "eng_Latn", "khm_Khmr")
    assert model.generate_calls[-1]["max_new_tokens"] == MAX_OUTPUT_TOKENS == 256


def test_translate_lines_normalizes_source_sanitizes_output_and_batches_cleanly() -> None:
    """translate_lines normalizes repeats pre-decode, sanitizes outputs post-decode, and skips same-lang/blanks."""
    translator = LocalTranslator()
    seen_batches: list[list[str]] = []

    def fake_translate_batch(batch: list[str], src_code: str, tgt_code: str) -> list[str]:
        seen_batches.append(list(batch))
        return [
            "នៅ តែ នៅ តែ នៅ តែ" if idx == 0 else f"[{tgt_code}] {item}"
            for idx, item in enumerate(batch)
        ]

    translator._translate_batch = fake_translate_batch  # type: ignore[method-assign]

    lines = [
        "Sorry I'll always be there for you I'll always be there for you I'll always be there for you",
        "   ",
        *[f"Line {i}" for i in range(DEFAULT_BATCH_SIZE + 1)],
    ]
    translated = translator.translate_lines(lines, source_lang="en", target_lang="km")

    assert seen_batches[0][0] == "Sorry I'll always be there for you"
    assert len(seen_batches) == 2
    assert len(seen_batches[0]) == DEFAULT_BATCH_SIZE
    assert len(seen_batches[1]) == 2
    assert translated[0] == "នៅតែ"
    assert translated[1] == ""
    assert translated[-1] == "[khm_Khmr] Line 8"

    # Same source and target language bypasses model and preserves stripped lines.
    assert resolve_nllb_lang_code("km") == "khm_Khmr"
    assert translator.translate_lines(["  សួស្តី  ", "នៅ តែ នៅ តែ នៅ តែ"], "km", "km") == [
        "សួស្តី",
        "នៅ តែ នៅ តែ នៅ តែ",
    ]


def test_full_multilingual_catalog_resolution_and_strict_validation() -> None:
    """All 202 NLLB-200 targets and 97 Whisper-to-NLLB mappings resolve accurately; invalid or unsupported codes fail loudly."""
    import pytest
    from languages import (
        ISO_TO_NLLB,
        SUPPORTED_NLLB_CODES,
        UNSUPPORTED_WHISPER_TRANSLATION_CODES,
        UnsupportedLanguageError,
        is_same_translation_language,
    )

    assert len(SUPPORTED_NLLB_CODES) == 202
    for code in SUPPORTED_NLLB_CODES:
        assert resolve_nllb_lang_code(code, strict=True) == code
        assert resolve_nllb_lang_code(code.lower(), strict=True) == code

    for iso_code, nllb_code in ISO_TO_NLLB.items():
        assert nllb_code in SUPPORTED_NLLB_CODES
        assert resolve_nllb_lang_code(iso_code, strict=True) == nllb_code

    assert resolve_nllb_lang_code("zh-TW", strict=True) == "zho_Hant"
    assert resolve_nllb_lang_code("zh_CN", strict=True) == "zho_Hans"
    assert resolve_nllb_lang_code("tr", strict=True) == "tur_Latn"
    assert resolve_nllb_lang_code("uk", strict=True) == "ukr_Cyrl"
    assert resolve_nllb_lang_code("pl", strict=True) == "pol_Latn"
    assert resolve_nllb_lang_code("nl", strict=True) == "nld_Latn"
    assert resolve_nllb_lang_code("ja", strict=True) == "jpn_Jpan"
    assert resolve_nllb_lang_code("yue", strict=True) == "yue_Hant"

    assert is_same_translation_language("en", "eng_Latn") is True
    assert is_same_translation_language("km", "khm_Khmr") is True
    assert is_same_translation_language("km", "eng_Latn") is False
    assert is_same_translation_language("zh-TW", "zho_Hant") is True
    assert is_same_translation_language("zh-CN", "zho_Hant") is False

    for invalid in ("", "   ", "xx_Invalid", "klingon"):
        with pytest.raises(UnsupportedLanguageError):
            resolve_nllb_lang_code(invalid, strict=True)

    for unsupported_src in UNSUPPORTED_WHISPER_TRANSLATION_CODES:
        with pytest.raises(UnsupportedLanguageError):
            resolve_nllb_lang_code(unsupported_src)

    translator = LocalTranslator()
    tokenizer = _FakeTokenizer(seq_len=5)
    tokenizer.unk_token_id = 3  # type: ignore[attr-defined]
    tokenizer.convert_tokens_to_ids = lambda _code: 3  # type: ignore[method-assign]
    translator._tokenizer = tokenizer
    translator._model = _FakeSeq2SeqModel()
    with pytest.raises(UnsupportedLanguageError):
        translator._translate_batch(["Hello"], "eng_Latn", "jpn_Jpan")
