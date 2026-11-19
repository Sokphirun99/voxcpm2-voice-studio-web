"""Offline multilingual-to-Khmer (and 200-language) subtitle translation using Meta NLLB-200."""

from __future__ import annotations

from dataclasses import dataclass
import logging
import re
import threading
from typing import Any, Mapping, Sequence
import unicodedata

from model_cache import resolve_hf_model_path

logger = logging.getLogger(__name__)

DEFAULT_NLLB_MODEL_ID = "facebook/nllb-200-distilled-600M"
DEFAULT_BATCH_SIZE = 8
MAX_INPUT_TOKENS = 256
MIN_OUTPUT_TOKENS = 32
MAX_OUTPUT_TOKENS = 256
OUTPUT_TOKEN_MULTIPLIER = 3
NUM_BEAMS = 2
REPETITION_PENALTY = 1.15
NO_REPEAT_NGRAM_SIZE = 5

MAX_PHRASE_REPEAT_SPAN = 16
MIN_PHRASE_REPEATS = 2
MIN_WORD_LOOP_REPEATS = 3
MIN_SOURCE_UNSPACED_SPAN = 6
MIN_OUTPUT_UNSPACED_SPAN = 4
# Empirical NLLB-200 Khmer beam decoding can emit 3-codepoint unspaced loops like "អូនអូនអូន" for "bye bye".
MIN_NON_ASCII_OUTPUT_UNSPACED_SPAN = 3
MIN_SPACELESS_OUTPUT_SPAN = 6
MAX_UNSPACED_SPAN = 128
MAX_COLLAPSE_PASSES = 6
MIN_DISTINCT_CHARS = 2

ZERO_WIDTH_SPACE = "\u200b"
ZERO_WIDTH_JOINER = "\u200d"
KHMER_COENG = "\u17d2"
OUTER_STRIP_CHARS = f" \t\r\n\f\v{ZERO_WIDTH_SPACE}"
WORD_SEP_RE = re.compile(rf"([ \t\r\n\f\v{ZERO_WIDTH_SPACE}]+)")

EDGE_PUNCT_CHARS = ".,!?;:\"'“”‘’()[]{}…—–-។៕៖"
CLAUSE_END_PUNCT_STR = ".,!?;:…។៕៖"
WEAK_PAUSE_PUNCT = frozenset({",", ";", ":"})
CLOSING_WRAPPERS = ")]}\"”’"
WRAPPER_PAIRS = (("(", ")"), ("[", "]"), ("{", "}"), ('"', '"'), ("“", "”"), ("‘", "’"))

SPACELESS_SCRIPT_RANGES = (
    (0x0E00, 0x0E7F),  # Thai
    (0x0E80, 0x0EFF),  # Lao
    (0x1000, 0x109F),  # Myanmar
    (0x1780, 0x17FF),  # Khmer
    (0x3040, 0x30FF),  # Hiragana & Katakana
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
)

ISO_TO_NLLB: dict[str, str] = {
    "km": "khm_Khmr",
    "en": "eng_Latn",
    "zh": "zho_Hans",
    "yue": "yue_Hant",
    "ja": "jpn_Jpan",
    "ko": "kor_Hang",
    "th": "tha_Thai",
    "vi": "vie_Latn",
    "lo": "lao_Laoo",
    "my": "mya_Mymr",
    "id": "ind_Latn",
    "ms": "zsm_Latn",
    "tl": "tgl_Latn",
    "fr": "fra_Latn",
    "de": "deu_Latn",
    "es": "spa_Latn",
    "pt": "por_Latn",
    "it": "ita_Latn",
    "ru": "rus_Cyrl",
    "ar": "arb_Arab",
    "hi": "hin_Deva",
}


@dataclass(frozen=True)
class _RepeatPolicy:
    """Thresholds controlling word- and character-level repetition collapsing."""

    min_phrase_repeats: int
    min_word_repeats: int
    min_unspaced_span: int
    min_non_ascii_unspaced_span: int
    min_word_distinct: int
    require_non_ascii_unspaced: bool = False
    drop_truncated_tail: bool = False
    collapse_spaceless_scripts: bool = False


_SOURCE_REPEAT_POLICY = _RepeatPolicy(
    min_phrase_repeats=MIN_PHRASE_REPEATS,
    min_word_repeats=MIN_WORD_LOOP_REPEATS,
    min_unspaced_span=MIN_SOURCE_UNSPACED_SPAN,
    min_non_ascii_unspaced_span=MIN_SOURCE_UNSPACED_SPAN,
    min_word_distinct=1,
    require_non_ascii_unspaced=True,
    drop_truncated_tail=False,
    collapse_spaceless_scripts=False,
)

_OUTPUT_REPEAT_POLICY = _RepeatPolicy(
    min_phrase_repeats=MIN_WORD_LOOP_REPEATS,
    min_word_repeats=MIN_WORD_LOOP_REPEATS,
    min_unspaced_span=MIN_OUTPUT_UNSPACED_SPAN,
    min_non_ascii_unspaced_span=MIN_NON_ASCII_OUTPUT_UNSPACED_SPAN,
    min_word_distinct=MIN_DISTINCT_CHARS,
    require_non_ascii_unspaced=False,
    drop_truncated_tail=True,
    collapse_spaceless_scripts=True,
)


def resolve_nllb_lang_code(lang: str) -> str:
    """Resolve an ISO 639-1 code or Flores-200 tag into an NLLB language code; pure, defaults to 'eng_Latn'."""
    cleaned = (lang or "").strip()
    if "_" in cleaned:
        return cleaned
    return ISO_TO_NLLB.get(cleaned.lower(), "eng_Latn")


def _normalize_sep(sep: str) -> str:
    """Collapse a whitespace or ZWSP run into a canonical single delimiter preserving newlines and Khmer ZWSP."""
    if "\n" in sep:
        return "\n"
    if ZERO_WIDTH_SPACE in sep and not any(ch in sep for ch in " \t\r\f\v"):
        return ZERO_WIDTH_SPACE
    return " "


def _tokenize_with_seps(text: str) -> tuple[list[str], list[str]]:
    """Split `text` on whitespace and Khmer ZWSP into aligned `(tokens, trailing_seps)` lists."""
    stripped = text.strip(OUTER_STRIP_CHARS)
    if not stripped:
        return [], []
    parts = WORD_SEP_RE.split(stripped)
    tokens = parts[0::2]
    seps = [_normalize_sep(sep) for sep in parts[1::2]]
    seps.append("")
    return tokens, seps


def _join_with_seps(tokens: Sequence[str], seps: Sequence[str]) -> str:
    """Reassemble `tokens` using `seps`, omitting any trailing separator after the final token."""
    if not tokens:
        return ""
    last_idx = len(tokens) - 1
    return "".join(tok + (seps[idx] if idx < last_idx else "") for idx, tok in enumerate(tokens))


def _token_key(token: str) -> str:
    """Normalize a word token by stripping edge punctuation and lowercasing while keeping standalone punct distinct."""
    stripped = token.strip(EDGE_PUNCT_CHARS)
    return stripped.lower() if stripped else token


def _has_meaningful_letters(text: str, min_distinct: int = MIN_DISTINCT_CHARS) -> bool:
    """Return True when `text` contains letters and >= `min_distinct` non-whitespace chars."""
    non_space = {ch for ch in text if not ch.isspace() and ch != ZERO_WIDTH_SPACE}
    return len(non_space) >= min_distinct and any(ch.isalpha() for ch in non_space)


def _split_trailing_wrapper(token: str) -> tuple[str, str]:
    """Separate trailing closing quote/bracket wrappers from a token."""
    body = token.rstrip(CLOSING_WRAPPERS)
    return body, token[len(body) :]


def _adopted_closing_wrapper(first_tokens: Sequence[str], head_close: str, last_close: str) -> str:
    """Adopt a closing wrapper from `last_token` only when `first_tokens` has a matching unclosed opener."""
    if head_close:
        return head_close
    if not last_close:
        return ""
    for op, cl in WRAPPER_PAIRS:
        if last_close[0] != cl:
            continue
        is_unclosed = (
            sum(t.count(op) for t in first_tokens) % 2 == 1
            if op == cl
            else sum(t.count(op) for t in first_tokens) > sum(t.count(cl) for t in first_tokens)
        )
        if is_unclosed:
            return last_close
    return ""


def _merge_collapsed_tail(first_tokens: list[str], last_token: str) -> list[str]:
    """Preserve strong terminal clause punctuation and balanced wrappers from the final collapsed repetition."""
    head_body, head_close = _split_trailing_wrapper(first_tokens[-1])
    last_body, last_close = _split_trailing_wrapper(last_token)
    close_wrap = _adopted_closing_wrapper(first_tokens, head_close, last_close)
    if head_body and head_body[-1] not in CLAUSE_END_PUNCT_STR and not head_body[-1].isalnum() and not unicodedata.category(head_body[-1]).startswith("M"):
        first_tokens[-1] = head_body + close_wrap
        return first_tokens
    core = head_body.rstrip(CLAUSE_END_PUNCT_STR)
    head_trail = head_body[len(core) :]
    last_trail = last_body[len(last_body.rstrip(CLAUSE_END_PUNCT_STR)) :]
    merged_punct = last_trail or ("" if head_trail in WEAK_PAUSE_PUNCT else head_trail)
    first_tokens[-1] = core + merged_punct + close_wrap
    return first_tokens


def _count_matching_chunks(seq: Sequence[str] | str, idx: int, span: int, unit: Sequence[str] | str) -> int:
    """Count consecutive occurrences of `unit` of width `span` starting at `idx`."""
    count = 1
    pos = idx + span
    while pos + span <= len(seq) and seq[pos : pos + span] == unit:
        count += 1
        pos += span
    return count


def _find_word_repeat(keys: list[str], idx: int, policy: _RepeatPolicy) -> tuple[int, int] | None:
    """Find the shortest repeating word span starting at `idx` meeting `policy` thresholds."""
    remaining = len(keys) - idx
    max_span = min(MAX_PHRASE_REPEAT_SPAN, remaining // 2)
    for span in range(1, max_span + 1):
        needed = policy.min_word_repeats if span == 1 else policy.min_phrase_repeats
        if remaining < span * needed:
            continue
        unit = keys[idx : idx + span]
        if any(not k for k in unit) or not _has_meaningful_letters(" ".join(unit), policy.min_word_distinct):
            continue
        count = _count_matching_chunks(keys, idx, span, unit)
        if count >= needed:
            return (span, count)
    return None


def _is_truncated_word_tail(keys: list[str], idx: int, span: int, end_idx: int) -> bool:
    """Return True when remaining tokens form a strict prefix of the looped phrase at text end."""
    tail = keys[end_idx:]
    return 0 < len(tail) < span and keys[idx : idx + len(tail)] == tail


def _collapse_word_repeats_once(tokens: list[str], seps: list[str], policy: _RepeatPolicy) -> tuple[str, bool]:
    """Run one pass collapsing consecutive repeated word spans in `tokens` while keeping delimiters."""
    keys = [_token_key(tok) for tok in tokens]
    out_toks: list[str] = []
    out_seps: list[str] = []
    idx, changed = 0, False
    while idx < len(tokens):
        match = _find_word_repeat(keys, idx, policy)
        if not match:
            out_toks.append(tokens[idx])
            out_seps.append(seps[idx])
            idx += 1
            continue
        span, count = match
        end_idx = idx + span * count
        out_toks.extend(_merge_collapsed_tail(list(tokens[idx : idx + span]), tokens[end_idx - 1]))
        out_seps.extend([*seps[idx : idx + span - 1], seps[end_idx - 1]])
        changed = True
        idx = len(tokens) if policy.drop_truncated_tail and _is_truncated_word_tail(keys, idx, span, end_idx) else end_idx
    return (_join_with_seps(out_toks, out_seps), changed)


def _collapse_word_repeats(text: str, policy: _RepeatPolicy) -> str:
    """Iteratively collapse repeated space-, ZWSP-, or newline-delimited word spans in `text`."""
    current = text.strip(OUTER_STRIP_CHARS)
    if not current:
        return ""
    for _ in range(MAX_COLLAPSE_PASSES):
        tokens, seps = _tokenize_with_seps(current)
        if len(tokens) < 2:
            break
        collapsed, changed = _collapse_word_repeats_once(tokens, seps, policy)
        if not changed:
            break
        current = collapsed
    return current


def _is_mid_cluster(text: str, idx: int) -> bool:
    """Return True when `idx` falls inside an orthographic cluster (combining mark, ZWJ, or post-coeng)."""
    if idx < 0 or idx >= len(text):
        return False
    ch = text[idx]
    return unicodedata.category(ch).startswith("M") or ch == ZERO_WIDTH_JOINER or (idx > 0 and text[idx - 1] in (KHMER_COENG, ZERO_WIDTH_JOINER))


def _count_unspaced_repeats(text: str, idx: int, span: int) -> int:
    """Count consecutive cluster-aligned copies of `text[idx : idx + span]` starting at `idx`."""
    unit = text[idx : idx + span]
    count = 1
    pos = idx + span
    while pos + span <= len(text) and text[pos : pos + span] == unit and not _is_mid_cluster(text, pos + span):
        count += 1
        pos += span
    return count


def _find_unspaced_repeat(text: str, idx: int, policy: _RepeatPolicy) -> tuple[int, int] | None:
    """Find the shortest unspaced repeating substring starting at `idx` meeting `policy` thresholds."""
    if text[idx].isspace() or text[idx] == ZERO_WIDTH_SPACE or _is_mid_cluster(text, idx):
        return None
    min_span = min(policy.min_unspaced_span, policy.min_non_ascii_unspaced_span)
    max_span = min(MAX_UNSPACED_SPAN, (len(text) - idx) // MIN_WORD_LOOP_REPEATS)
    for span in range(min_span, max_span + 1):
        unit = text[idx : idx + span]
        if any(ch.isspace() or ch == ZERO_WIDTH_SPACE for ch in unit):
            break
        is_ascii = unit.isascii()
        if (policy.require_non_ascii_unspaced and is_ascii) or (is_ascii and span < policy.min_unspaced_span):
            continue
        if _is_mid_cluster(text, idx + span) or not _has_meaningful_letters(unit, MIN_DISTINCT_CHARS):
            continue
        count = _count_unspaced_repeats(text, idx, span)
        if count >= MIN_WORD_LOOP_REPEATS:
            return (span, count)
    return None


def _append_truncated_unspaced_tail(out: list[str], unit: str, tail: str) -> bool:
    """Drop a strict prefix of `unit` at the end of decoded output while keeping trailing clause punct."""
    tail_core = tail.rstrip(CLAUSE_END_PUNCT_STR)
    if 0 < len(tail_core) < len(unit) and unit.startswith(tail_core):
        tail_punct = tail[len(tail_core) :]
        if tail_punct:
            out.append(tail_punct)
        return True
    return False


def _collapse_unspaced_repeats(text: str, policy: _RepeatPolicy) -> str:
    """Collapse consecutive repeated non-whitespace character substrings in `text`."""
    min_len = min(policy.min_unspaced_span, policy.min_non_ascii_unspaced_span) * MIN_WORD_LOOP_REPEATS
    if len(text) < min_len:
        return text
    out: list[str] = []
    idx = 0
    while idx < len(text):
        match = _find_unspaced_repeat(text, idx, policy)
        if not match:
            out.append(text[idx])
            idx += 1
            continue
        span, count = match
        unit = text[idx : idx + span]
        out.append(unit)
        end_idx = idx + span * count
        idx = len(text) if policy.drop_truncated_tail and _append_truncated_unspaced_tail(out, unit, text[end_idx:]) else end_idx
    return "".join(out)


def _is_spaceless_script_char(ch: str) -> bool:
    """Return True for letters/marks in Southeast Asian or CJK scripts that treat spaces as optional."""
    code = ord(ch)
    if not any(lo <= code <= hi for lo, hi in SPACELESS_SCRIPT_RANGES):
        return False
    return unicodedata.category(ch).startswith(("L", "M"))


def _build_compact_script_index(text: str) -> tuple[str, list[int]]:
    """Collapse optional spaces/ZWSP solely between spaceless-script characters and map compact->original indices."""
    compact: list[str] = []
    orig_indices: list[int] = []
    for idx, ch in enumerate(text):
        if ch in (" ", ZERO_WIDTH_SPACE) and compact and _is_spaceless_script_char(compact[-1]):
            rest = text[idx:].lstrip(" " + ZERO_WIDTH_SPACE)
            if rest and _is_spaceless_script_char(rest[0]):
                continue
        compact.append(ch)
        orig_indices.append(idx)
    return "".join(compact), orig_indices


def _find_spaceless_script_repeat(compact: str, idx: int) -> tuple[int, int] | None:
    """Find a >=6-char spaceless-script clause repeated >=3 times regardless of internal spacing."""
    if not _is_spaceless_script_char(compact[idx]) or _is_mid_cluster(compact, idx):
        return None
    max_span = min(MAX_UNSPACED_SPAN, (len(compact) - idx) // MIN_WORD_LOOP_REPEATS)
    for span in range(MIN_SPACELESS_OUTPUT_SPAN, max_span + 1):
        unit = compact[idx : idx + span]
        if not all(_is_spaceless_script_char(ch) for ch in unit):
            break
        if _is_mid_cluster(compact, idx + span) or not _has_meaningful_letters(unit, MIN_DISTINCT_CHARS):
            continue
        count = _count_unspaced_repeats(compact, idx, span)
        if count >= MIN_WORD_LOOP_REPEATS:
            return (span, count)
    return None


def _collapse_spaceless_script_repeats(text: str) -> str:
    """Collapse decoded Khmer/SEA/CJK repetition loops whose copies vary only by optional internal spaces."""
    compact, orig_indices = _build_compact_script_index(text)
    if len(compact) < MIN_SPACELESS_OUTPUT_SPAN * MIN_WORD_LOOP_REPEATS:
        return text
    out: list[str] = []
    c_idx, prev_orig = 0, 0
    while c_idx < len(compact):
        match = _find_spaceless_script_repeat(compact, c_idx)
        if not match:
            c_idx += 1
            continue
        span, count = match
        out.append(text[prev_orig : orig_indices[c_idx + span - 1] + 1])
        end_c = c_idx + span * count
        prev_orig = orig_indices[end_c - 1] + 1
        if _append_truncated_unspaced_tail(out, compact[c_idx : c_idx + span], compact[end_c:]):
            return "".join(out)
        c_idx = end_c
    return "".join([*out, text[prev_orig:]])


def _apply_repeat_policy(text: str, policy: _RepeatPolicy) -> str:
    """Apply word-level, unspaced, and optional space-agnostic repetition collapsing to `text`."""
    if not text or not text.strip(OUTER_STRIP_CHARS):
        return ""
    step1 = _collapse_word_repeats(text, policy)
    if not step1:
        return ""
    step2 = _collapse_unspaced_repeats(step1, policy)
    if policy.collapse_spaceless_scripts:
        step2 = _collapse_spaceless_script_repeats(step2)
    return _collapse_word_repeats(step2, policy) if step2 != step1 else step2


def normalize_source_repeats(text: str) -> str:
    """Collapse repeated source clauses, stutters, and unspaced non-ASCII loops; pure, returns stripped text."""
    return _apply_repeat_policy(text, _SOURCE_REPEAT_POLICY)


def sanitize_repetitive_translation(text: str) -> str:
    """Collapse residual spaced or unspaced repetition loops in decoded NLLB text; pure, preserves numbers/punct."""
    return _apply_repeat_policy(text, _OUTPUT_REPEAT_POLICY)


def _build_generate_kwargs(encoded: Mapping[str, Any], forced_bos_id: int) -> dict[str, Any]:
    """Assemble repetition-safe NLLB beam-search generation arguments."""
    src_tokens = int(encoded["input_ids"].shape[1])
    max_new_tokens = min(MAX_OUTPUT_TOKENS, max(MIN_OUTPUT_TOKENS, src_tokens * OUTPUT_TOKEN_MULTIPLIER))
    return {
        "forced_bos_token_id": forced_bos_id,
        "max_new_tokens": max_new_tokens,
        "num_beams": NUM_BEAMS,
        "early_stopping": True,
        "repetition_penalty": REPETITION_PENALTY,
        "no_repeat_ngram_size": NO_REPEAT_NGRAM_SIZE,
    }


class LocalTranslator:
    """Thread-safe lazy loader around Meta NLLB-200 for offline subtitle translation."""

    def __init__(self, model_id: str = DEFAULT_NLLB_MODEL_ID) -> None:
        """Initialize lazy translator state for `model_id` without loading weights upfront."""
        self._model_id = model_id
        self._lock = threading.Lock()
        self._tokenizer = None
        self._model = None
        self._device = "cpu"

    def _ensure_loaded(self) -> tuple[object, object]:
        """Lazily load NLLB tokenizer and seq2seq weights once."""
        with self._lock:
            if self._model is not None and self._tokenizer is not None:
                return self._tokenizer, self._model
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

            model_source = resolve_hf_model_path(self._model_id)
            logger.info("Loading local NLLB translator: %s", model_source)
            tokenizer = AutoTokenizer.from_pretrained(model_source)
            model = AutoModelForSeq2SeqLM.from_pretrained(model_source, use_safetensors=False)
            device = "mps" if torch.backends.mps.is_available() else "cpu"
            model = model.to(device).eval()
            self._tokenizer = tokenizer
            self._model = model
            self._device = device
            return tokenizer, model

    def _translate_batch(self, batch: Sequence[str], src_code: str, tgt_code: str) -> list[str]:
        """Translate one bounded batch of subtitle lines preserving order."""
        if not batch:
            return []
        import torch

        tokenizer, model = self._ensure_loaded()
        tokenizer.src_lang = src_code
        encoded = tokenizer(
            list(batch), return_tensors="pt", padding=True, truncation=True, max_length=MAX_INPUT_TOKENS
        ).to(self._device)
        gen_kwargs = _build_generate_kwargs(encoded, tokenizer.convert_tokens_to_ids(tgt_code))
        with torch.inference_mode():
            generated = model.generate(**encoded, **gen_kwargs)
        decoded = tokenizer.batch_decode(generated, skip_special_tokens=True)
        return [sanitize_repetitive_translation(out.strip()) for out in decoded]

    def translate_lines(self, lines: Sequence[str], source_lang: str, target_lang: str = "km") -> list[str]:
        """Translate `lines` from `source_lang` to `target_lang` (default Khmer), returning same-length list; loads model once."""
        src_code = resolve_nllb_lang_code(source_lang)
        tgt_code = resolve_nllb_lang_code(target_lang)
        if src_code == tgt_code:
            return [(line or "").strip() for line in lines]
        results = [""] * len(lines)
        non_empty = [(idx, cleaned) for idx, text in enumerate(lines) if (cleaned := normalize_source_repeats(text))]
        for start in range(0, len(non_empty), DEFAULT_BATCH_SIZE):
            chunk = non_empty[start : start + DEFAULT_BATCH_SIZE]
            translated = self._translate_batch([item[1] for item in chunk], src_code, tgt_code)
            for (orig_idx, _), tr_text in zip(chunk, translated):
                results[orig_idx] = sanitize_repetitive_translation(tr_text)
        return results
