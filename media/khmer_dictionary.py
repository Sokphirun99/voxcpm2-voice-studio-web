"""Three-layer local Khmer lexicon (Wiktionary + RAC + Frequency, Colloquial Spoken Khmer, and Custom Glossary)."""

from __future__ import annotations

import difflib
import json
import logging
import re
import threading
import unicodedata
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

LEXICON_DIR = Path(__file__).resolve().parent / "lexicon"
FORMAL_DICT_PATH = LEXICON_DIR / "formal_dictionary.tsv"
COLLOQUIAL_JSON_PATH = LEXICON_DIR / "spoken_colloquial_khmer.json"
CUSTOM_GLOSSARY_PATH = LEXICON_DIR / "custom_glossary.json"

KHMER_WORD_RE = re.compile(r"^[\u1780-\u17ff]+$")
STRIP_MARKS_RE = re.compile(r"[\u17c6-\u17d3\u17dd\ufffd]")

CONSONANT_PHONETIC_MAP = str.maketrans({
    "ខ": "ក", "គ": "ក", "ឃ": "ក",
    "ឆ": "ច", "ជ": "ច", "ឈ": "ច",
    "ដ": "ត", "ឋ": "ត", "ឌ": "ត", "ឍ": "ត", "ថ": "ត", "ទ": "ត", "ធ": "ត",
    "ណ": "ន",
    "ផ": "ប", "ព": "ប", "ភ": "ប",
    "ញ": "ង",
    "ឡ": "ល",
    "ហ": "ស",
})


def compute_phonetic_skeleton(word: str) -> str:
    """Reduce a Khmer word to its consonant + vowel skeleton mapped to canonical phonetic series."""
    clean = unicodedata.normalize("NFC", word).replace("-", "").replace("\u200b", "")
    return STRIP_MARKS_RE.sub("", clean).translate(CONSONANT_PHONETIC_MAP)


def _is_valid_or_compound(token: str, valid_words: set[str]) -> bool:
    """Return True if `token` is in `valid_words` or segments cleanly into valid dictionary words."""
    if token in valid_words:
        return True
    n = len(token)
    dp = [False] * (n + 1)
    dp[0] = True
    for i in range(1, n + 1):
        for j in range(max(0, i - 14), i - 1):
            if dp[j] and token[j:i] in valid_words:
                dp[i] = True
                break
    return dp[n]


def _compile_json_patterns(items: list[dict[str, Any]]) -> list[tuple[re.Pattern[str], str]]:
    """Compile regex replacement rules from JSON pattern objects."""
    compiled: list[tuple[re.Pattern[str], str]] = []
    for item in items:
        pat = str(item.get("pattern") or "")
        rep = str(item.get("replacement") or "")
        flags = re.IGNORECASE if "i" in str(item.get("flags") or "").lower() else 0
        if pat:
            compiled.append((re.compile(pat, flags), rep))
    return compiled


def _load_layer1_formal(tsv_path: Path) -> tuple[set[str], dict[str, int], dict[str, list[str]]]:
    """Load Layer 1 unified formal dictionary (`formal_dictionary.tsv`: RAC + Wiktionary + Frequency)."""
    valid: set[str] = set()
    ranks: dict[str, int] = {}
    skeletons: dict[str, set[str]] = {}
    if not tsv_path.is_file():
        return valid, ranks, {}
    for line in tsv_path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) < 3:
            continue
        word = unicodedata.normalize("NFC", cols[0].strip())
        freq = int(cols[2]) if cols[2].isdigit() else 5000
        valid.add(word)
        ranks[word] = freq
        for form in [word, *cols[1].split("|")]:
            skel = compute_phonetic_skeleton(form)
            if len(skel) >= 3:
                skeletons.setdefault(skel, set()).add(word)
    sorted_skels = {
        k: sorted(words, key=lambda w: ranks.get(w, 0), reverse=True)[:10]
        for k, words in skeletons.items()
    }
    return valid, ranks, sorted_skels


def _load_layer2_colloquial(json_path: Path) -> list[tuple[re.Pattern[str], str]]:
    """Load Layer 2 spoken colloquial Khmer normalization rules (`spoken_colloquial_khmer.json`)."""
    if not json_path.is_file():
        return []
    data = json.loads(json_path.read_text(encoding="utf-8"))
    return _compile_json_patterns(data.get("patterns") or [])


def _load_layer3_glossary(json_path: Path) -> tuple[list[str], list[tuple[re.Pattern[str], str]]]:
    """Load Layer 3 custom domain words and replacement patterns (`custom_glossary.json`)."""
    if not json_path.is_file():
        return [], []
    data = json.loads(json_path.read_text(encoding="utf-8"))
    words = [unicodedata.normalize("NFC", str(w).strip()) for w in (data.get("words") or []) if str(w).strip()]
    patterns = _compile_json_patterns(data.get("replacements") or [])
    return words, patterns


class KhmerDictionaryCorrector:
    """Thread-safe 3-layer Khmer orthography, Wiktionary+RAC lexicon, and colloquial spell-corrector."""

    def __init__(
        self,
        formal_path: Path = FORMAL_DICT_PATH,
        colloquial_path: Path = COLLOQUIAL_JSON_PATH,
        glossary_path: Path = CUSTOM_GLOSSARY_PATH,
    ) -> None:
        self._formal_path = formal_path
        self._colloquial_path = colloquial_path
        self._glossary_path = glossary_path
        self._lock = threading.Lock()
        self._loaded = False
        self._valid_words: set[str] = set()
        self._ranks: dict[str, int] = {}
        self._skeleton_map: dict[str, list[str]] = {}
        self._patterns: list[tuple[re.Pattern[str], str]] = []
        self._custom_words: list[str] = []

    def reload(self) -> dict[str, int]:
        """Force reload of all 3 lexicon layers from disk and return entry statistics."""
        with self._lock:
            valid, ranks, skels = _load_layer1_formal(self._formal_path)
            colloquial_pats = _load_layer2_colloquial(self._colloquial_path)
            custom_words, custom_pats = _load_layer3_glossary(self._glossary_path)
            for word in custom_words:
                valid.add(word)
                ranks[word] = max(ranks.get(word, 0), 200_000)
            self._valid_words = valid
            self._ranks = ranks
            self._skeleton_map = skels
            self._patterns = [*custom_pats, *colloquial_pats]
            self._custom_words = custom_words
            self._loaded = True
            return self.stats()

    def _ensure_loaded(self) -> None:
        """Lazily initialize all 3 lexicon layers on first use."""
        if not self._loaded:
            self.reload()

    def stats(self) -> dict[str, int]:
        """Return entry counts across the 3 local lexicon layers."""
        self._ensure_loaded()
        return {
            "formalWords": len(self._valid_words),
            "colloquialPatterns": len(self._patterns),
            "customGlossaryWords": len(self._custom_words),
        }

    def is_known_khmer_token(self, token: str) -> bool:
        """Return True when `token` matches a dictionary word or valid compound of known Khmer words."""
        self._ensure_loaded()
        return _is_valid_or_compound(token, self._valid_words)

    def _correct_token(self, token: str) -> str:
        """Correct a single out-of-vocabulary Khmer token when a high-confidence phonetic match exists."""
        if len(token) < 4 or not KHMER_WORD_RE.match(token):
            return token
        if _is_valid_or_compound(token, self._valid_words):
            return token
        skel = compute_phonetic_skeleton(token)
        candidates = self._skeleton_map.get(skel, [])
        best_word = token
        best_score = 0.84
        for cand in candidates:
            if abs(len(cand) - len(token)) > 2:
                continue
            ratio = difflib.SequenceMatcher(None, token, cand).ratio()
            if ratio > best_score:
                best_score = ratio
                best_word = cand
        return best_word

    def correct_sentence(self, text: str) -> str:
        """Apply Unicode NFC normalization, Layer 2/3 phrase patterns, and Layer 1 dictionary spell-check."""
        if not text or not text.strip():
            return ""
        self._ensure_loaded()
        normalized = " ".join(unicodedata.normalize("NFC", text).strip().split())
        for pattern, replacement in self._patterns:
            normalized = pattern.sub(replacement, normalized)
        tokens = [self._correct_token(tok) for tok in normalized.split(" ") if tok]
        joined = " ".join(tokens)
        for pattern, replacement in self._patterns:
            joined = pattern.sub(replacement, joined)
        return " ".join(joined.split())


_DEFAULT_CORRECTOR = KhmerDictionaryCorrector()


def correct_khmer_transcript(text: str) -> str:
    """Correct a Khmer ASR transcript line using the shared 3-layer local Khmer lexicon."""
    return _DEFAULT_CORRECTOR.correct_sentence(text)


def get_lexicon_stats() -> dict[str, int]:
    """Return statistics of the active 3-layer local Khmer lexicon."""
    return _DEFAULT_CORRECTOR.stats()


def is_known_khmer_word(token: str) -> bool:
    """Check whether a Khmer token belongs to the active 3-layer local Khmer lexicon."""
    return _DEFAULT_CORRECTOR.is_known_khmer_token(token)
