"""Khmer prose orthography formatting, sentence splitting, and cross-cue context alignment."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Callable, Sequence
import unicodedata

from khmer_dictionary import correct_khmer_word, segment_khmer_words
from subtitles import SubtitleSegment, segment_subtitle_clusters

ZERO_WIDTH_CLEAN_RE = re.compile(r"[\u200b\u200c\ufeff]")
BROKEN_VOWEL_O_RE = re.compile(r"\u17c1\u17b6")
BROKEN_VOWEL_AE_RE = re.compile(r"\u17c1\u17b8")
KHMER_ANY_RE = re.compile(r"[\u1780-\u17ff]")
KHMER_WORD_WITH_PUNCT_RE = re.compile(r"^([\u1780-\u17d3\u17dd]+)([។៕៖ៗ.!?]*)$")
KHMER_COMMA_BEFORE_RE = re.compile(r"(?<=[\u1780-\u17ff\u17d4-\u17da])\s*,\s*")
KHMER_COMMA_AFTER_RE = re.compile(r"\s*,\s*(?=[\u1780-\u17ff])")
CLAUSE_BREAK_MARKER = "\ue001"

CLOSING_NO_SPACE_PREFIX = frozenset("។៕៖ៗ.,!?;:)]}\"”’»")
OPENING_NO_SPACE_SUFFIX = frozenset("([{\"“‘«")
AFTER_PUNCT_SPACE = frozenset("។៕៖,;:.!?")
KHMER_TERMINAL_PUNCT = frozenset("។៕?!៖.")

MAJOR_CLAUSE_CONJUNCTIONS = frozenset({
    "ប៉ុន្តែ", "ក៏ប៉ុន្តែ", "ដូច្នេះ", "ដូចនេះ", "ហេតុនេះ", "ហេតុដូច្នេះ",
    "ទោះបីជា", "ទោះជាយ៉ាងណា", "បន្ទាប់មក", "ចំណែកឯ", "រីឯ", "ម្យ៉ាងទៀត", "លើសពីនេះ", "ផ្ទុយទៅវិញ",
})
MID_SENTENCE_PIVOTS = frozenset({
    "ព្រោះ", "ពីព្រោះ", "ដោយសារ", "គឺ", "គឺជា", "ប្រសិនបើ", "ប្រសិន",
    "ខណៈដែល", "នៅពេលដែល", "ដើម្បី", "ហើយ",
})
CLAUSE_JOINERS = frozenset({"ប៉ុន្តែ", "ក៏ប៉ុន្តែ", "ហើយ", "ឬ", "និង"})
CLAUSE_SUBJECT_TOKENS = frozenset({"ខ្ញុំ", "យើង", "ពួកយើង", "ពួកគេ", "គាត់", "នាង", "លោកអ្នក", "ប្រព័ន្ធ"})
OBJECT_TAKING_LINKERS = frozenset({
    "របស់", "នៃ", "ឱ្យ", "ឲ្យ", "ដល់", "លើ", "ក្នុង", "ជាមួយ", "ចំពោះ", "នូវ",
    "ទៅ", "មក", "ពី", "មើល", "ជួយ", "បន្ទោស", "ប្រាប់", "សួរ", "ហៅ", "ចោទប្រកាន់", "ប្រកាន់",
})
REDISTRIBUTION_BREAK_PREFIXES = MAJOR_CLAUSE_CONJUNCTIONS | MID_SENTENCE_PIVOTS

MIN_RUN_FOR_MAJOR_CONJ = 2
MIN_RUN_FOR_PIVOT = 8
MIN_RUN_FOR_SUBJECT = 12

SENTENCE_BOUNDARY_RE = re.compile(r'([.!?។៕]+["\'\)\]\}]*)\s+')
SENTENCE_NEXT_START_RE = re.compile(r'^(?:["\'\(\[\{“‘«]*[A-Z\u00C0-\u024F\u1780-\u9FFF])')
LATIN_ABBREV_WORDS = frozenset({
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "fig", "no", "e.g", "i.e",
})
LIST_NUM_PREFIX_RE = re.compile(r"(?:^|\s)\d{1,3}$")
SINGLE_UPPER_INITIAL_RE = re.compile(r"(?:^|[\s.])[A-Z]$")

MAX_GROUP_PIECES = 3
MAX_GROUP_CHARS = 240
MAX_GROUP_GAP_SEC = 1.2
SNAP_WINDOW_RATIO = 0.2
SENTENCE_END_CHARS = frozenset(".!?។៕…:")
CONTINUATION_END_CHARS = frozenset(",;—–-")
TRAILING_CONNECTORS = frozenset({
    "and", "or", "but", "because", "that", "which", "who", "to", "of", "in", "on", "for",
    "with", "from", "by", "as", "if", "when", "while", "until", "is", "are", "was", "were",
    "has", "have", "had", "will", "would", "can", "could", "should", "the", "a", "an",
    "its", "their", "our", "my", "your",
})
LEADING_CONTINUATION_RE = re.compile(
    r"^(?:[a-z]|(?:and|or|but|because|so|which|that|until|while|where|when|if|unless|although|though)\b)",
    re.IGNORECASE,
)
TRAILING_WORD_RE = re.compile(r"([A-Za-z]+)$")


@dataclass(frozen=True)
class CueSpan:
    """One sentence-level piece belonging to a specific source subtitle cue."""

    cue_index: int
    start: float
    end: float
    speaker_id: str
    text: str


@dataclass(frozen=True)
class _KhmerTokenPiece:
    """Normalized word piece and boundary metadata used for Khmer clause join decisions."""

    text: str
    is_clause_break: bool
    has_trailing_break: bool


def _is_khmer_letter_or_mark(ch: str) -> bool:
    """Return True for Khmer consonants, vowels, signs, and coeng excluding Khmer digits."""
    return ("\u1780" <= ch <= "\u17d3") or ch == "\u17dd" or ("\u17f0" <= ch <= "\u17ff")


def _is_numeric_token(text: str) -> bool:
    """Return True when `text` consists strictly of Khmer or ASCII digits and numeric separators."""
    return bool(text) and all(("\u17e0" <= ch <= "\u17e9") or ch.isdigit() or ch in ".," for ch in text)


def _cluster_count(text: str) -> int:
    """Count visual orthographic clusters inside `text`."""
    return len(segment_subtitle_clusters(text))


def _correct_khmer_token(token: str) -> str:
    """Apply Khmer dictionary word correction while preserving trailing punctuation."""
    match = KHMER_WORD_WITH_PUNCT_RE.match(token)
    if not match:
        return token
    word, punct = match.groups()
    return f"{correct_khmer_word(word)}{punct}"


def _prepare_khmer_line_tokens(line: str) -> list[_KhmerTokenPiece]:
    """Normalize a Khmer line, convert Khmer-adjacent commas into clause breaks, and tokenize words."""
    marked = KHMER_COMMA_BEFORE_RE.sub(f" {CLAUSE_BREAK_MARKER} ", line.strip())
    marked = KHMER_COMMA_AFTER_RE.sub(f" {CLAUSE_BREAK_MARKER} ", marked)
    pieces: list[_KhmerTokenPiece] = []
    pending_break = False
    for raw_tok in marked.split():
        if raw_tok == CLAUSE_BREAK_MARKER:
            pending_break = bool(pieces)
            continue
        cleaned = _correct_khmer_token(raw_tok.replace(CLAUSE_BREAK_MARKER, ""))
        has_break = raw_tok.endswith(CLAUSE_BREAK_MARKER)
        if cleaned:
            pieces.append(_KhmerTokenPiece(cleaned, pending_break, has_break))
            pending_break = False
        elif has_break and pieces:
            pending_break = True
    return pieces


def _should_insert_khmer_space(
    prev: _KhmerTokenPiece,
    curr: _KhmerTokenPiece,
    run_clusters: int,
) -> bool:
    """Decide whether a visible space belongs between adjacent tokens in Khmer prose."""
    if not curr.text or curr.text[0] in CLOSING_NO_SPACE_PREFIX:
        return False
    if prev.text[-1] in OPENING_NO_SPACE_SUFFIX:
        return False
    if curr.is_clause_break or prev.text[-1] in AFTER_PUNCT_SPACE:
        return True
    if not (_is_khmer_letter_or_mark(prev.text[-1]) and _is_khmer_letter_or_mark(curr.text[0])):
        return True
    if curr.text in MAJOR_CLAUSE_CONJUNCTIONS and run_clusters >= MIN_RUN_FOR_MAJOR_CONJ:
        return True
    if curr.text in MID_SENTENCE_PIVOTS and run_clusters >= MIN_RUN_FOR_PIVOT and prev.text not in CLAUSE_JOINERS:
        return True
    if curr.text in CLAUSE_SUBJECT_TOKENS and run_clusters >= MIN_RUN_FOR_SUBJECT and prev.text not in OBJECT_TAKING_LINKERS:
        return True
    return False


def _format_khmer_line(line: str) -> str:
    """Join tokenized Khmer words into continuous prose with selective clause and Latin spaces."""
    pieces = _prepare_khmer_line_tokens(line)
    if not pieces:
        return ""
    out: list[str] = [pieces[0].text]
    run_clusters = _cluster_count(pieces[0].text) if _is_khmer_letter_or_mark(pieces[0].text[-1]) else 0
    for idx in range(1, len(pieces)):
        prev_piece, curr_piece = pieces[idx - 1], pieces[idx]
        if _should_insert_khmer_space(prev_piece, curr_piece, run_clusters):
            out.append(" ")
            if not (_is_numeric_token(prev_piece.text) or _is_numeric_token(curr_piece.text)):
                run_clusters = 0
        out.append(curr_piece.text)
        if _is_khmer_letter_or_mark(curr_piece.text[-1]):
            run_clusters += _cluster_count(curr_piece.text)
        elif not _is_numeric_token(curr_piece.text):
            run_clusters = 0
        if curr_piece.has_trailing_break:
            run_clusters = MIN_RUN_FOR_SUBJECT
    return "".join(out)


def format_khmer_translation(text: str) -> str:
    """Format word-segmented NLLB Khmer output into natural continuous Khmer prose without ZWSP.

    Inputs: decoded translation text string.
    Outputs: NFC-normalized continuous Khmer string with clause/Latin spacing and no `U+200B`.
    Side effects: initializes the shared Khmer dictionary on first Khmer token encountered.
    Failure modes: returns stripped original text unchanged for empty strings or non-Khmer scripts.
    """
    if not text or not text.strip():
        return ""
    if not KHMER_ANY_RE.search(text):
        return text.strip()
    cleaned = ZERO_WIDTH_CLEAN_RE.sub("", unicodedata.normalize("NFC", text))
    cleaned = BROKEN_VOWEL_AE_RE.sub("\u17be", BROKEN_VOWEL_O_RE.sub("\u17c4", cleaned))
    lines = [_format_khmer_line(ln) for ln in cleaned.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "\n".join(lines).strip()


def _is_non_breaking_period(left: str, right: str) -> bool:
    """Return True when a period in `left` is an abbreviation, initial, number, or lacks sentence follow-up."""
    if not right or not SENTENCE_NEXT_START_RE.match(right):
        return True
    if not left.endswith("."):
        return False
    stem = left[:-1]
    last_word = stem.rsplit(None, 1)[-1].lower() if stem else ""
    if last_word in LATIN_ABBREV_WORDS or LIST_NUM_PREFIX_RE.search(stem):
        return True
    return bool(SINGLE_UPPER_INITIAL_RE.search(stem))


def split_source_sentences(text: str) -> list[str]:
    """Split a multi-sentence cue into single sentences while keeping abbreviations and decimals intact.

    Inputs: source subtitle line string.
    Outputs: ordered list of non-empty sentence strings.
    Side effects: none.
    Failure modes: returns `[]` for blank input; preserves abbreviations like `Dr.` or `U.S.` and `6.2`.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    parts: list[str] = []
    start = 0
    for match in SENTENCE_BOUNDARY_RE.finditer(cleaned):
        candidate_left = cleaned[start : match.start() + len(match.group(1))].strip()
        right_tail = cleaned[match.end() :].lstrip()
        if _is_non_breaking_period(candidate_left, right_tail):
            continue
        if candidate_left:
            parts.append(candidate_left)
            start = match.end()
    tail = cleaned[start:].strip()
    if tail:
        parts.append(tail)
    return parts or [cleaned]


def join_translated_sentences(src_parts: Sequence[str], tr_parts: Sequence[str], is_khmer: bool) -> str:
    """Recombine per-sentence translations, inserting Khmer khan `។` between Khmer sentences.

    Inputs: parallel `src_parts` and `tr_parts` sequences plus `is_khmer` target flag.
    Outputs: joined multi-sentence translation string.
    Side effects: none.
    Failure modes: filters empty `tr_parts` cleanly; falls back gracefully on mismatched lengths.
    """
    paired = [(src_parts[i] if i < len(src_parts) else "", tr.strip()) for i, tr in enumerate(tr_parts) if tr and tr.strip()]
    if not paired:
        return ""
    if not is_khmer or len(paired) == 1:
        return " ".join(tr for _, tr in paired)
    rendered: list[str] = []
    for idx, (src, tr) in enumerate(paired):
        needs_khan = (
            idx < len(paired) - 1
            and src.rstrip().endswith(".")
            and KHMER_ANY_RE.search(tr)
            and tr[-1] not in KHMER_TERMINAL_PUNCT
        )
        rendered.append(f"{tr}។" if needs_khan else tr)
    return " ".join(rendered)


def _has_continuation_signal(prev_text: str, next_text: str) -> bool:
    """Return True when lexical or syntactic cues indicate `next_text` continues `prev_text`."""
    stripped_prev = prev_text.strip()
    stripped_next = next_text.lstrip()
    if not stripped_prev or not stripped_next:
        return False
    if stripped_prev[-1] in SENTENCE_END_CHARS:
        return False
    if stripped_prev[-1] in CONTINUATION_END_CHARS or LEADING_CONTINUATION_RE.match(stripped_next):
        return True
    word_match = TRAILING_WORD_RE.search(stripped_prev)
    return bool(word_match and word_match.group(1).lower() in TRAILING_CONNECTORS)


def _can_merge_spans(group: Sequence[CueSpan], next_span: CueSpan) -> bool:
    """Determine whether `next_span` belongs to the same spoken sentence as `group`."""
    prev_span = group[-1]
    if len(group) >= MAX_GROUP_PIECES or prev_span.cue_index >= next_span.cue_index:
        return False
    if prev_span.speaker_id != next_span.speaker_id:
        return False
    gap = next_span.start - prev_span.end
    if gap < -0.05 or gap > MAX_GROUP_GAP_SEC:
        return False
    combined_len = sum(len(item.text) for item in group) + len(next_span.text) + len(group)
    if combined_len > MAX_GROUP_CHARS:
        return False
    return _has_continuation_signal(prev_span.text, next_span.text)


def _build_grouped_spans(segments: Sequence[SubtitleSegment]) -> list[list[CueSpan]]:
    """Expand segments into sentence spans and group cross-cue continuations together."""
    all_spans: list[CueSpan] = []
    for cue_idx, seg in enumerate(segments):
        for piece in split_source_sentences(seg.text):
            all_spans.append(CueSpan(cue_idx, float(seg.start), float(seg.end), seg.speaker_id, piece))
    groups: list[list[CueSpan]] = []
    for span in all_spans:
        if groups and _can_merge_spans(groups[-1], span):
            groups[-1].append(span)
        else:
            groups.append([span])
    return groups


def _tokenize_khmer_for_split(text: str) -> tuple[list[str], list[int], list[int]]:
    """Segment Khmer sentence text into word units, visual widths, and tiered break priorities (0/1/2)."""
    tokens: list[str] = []
    break_tiers: list[int] = []
    for chunk_idx, chunk in enumerate(text.strip().split()):
        sub_words = segment_khmer_words(chunk) if KHMER_ANY_RE.search(chunk) and not re.search(r"[A-Za-z0-9]", chunk) else [chunk]
        for sub_idx, word in enumerate(w for w in sub_words if w):
            tokens.append(word)
            tier = 2 if word in REDISTRIBUTION_BREAK_PREFIXES else (1 if sub_idx == 0 and chunk_idx > 0 else 0)
            break_tiers.append(tier)
    widths = [_cluster_count(tok) or len(tok) for tok in tokens]
    return tokens, widths, break_tiers


def _tokenize_space_for_split(text: str) -> tuple[list[str], list[int], list[int]]:
    """Split non-Khmer translated sentence on whitespace into redistributable word tokens."""
    tokens = text.strip().split()
    widths = [len(tok) for tok in tokens]
    return tokens, widths, [1] * len(tokens)


def _choose_cut_index(
    cum_widths: Sequence[int],
    break_tiers: Sequence[int],
    bounds: tuple[int, int],
    target_pos: float,
) -> int:
    """Pick the best cut index within `[min_idx, max_idx]`, preferring clause conjunctions over plain spaces."""
    min_idx, max_idx = bounds
    window = max(2.0, cum_widths[-1] * SNAP_WINDOW_RATIO)
    best_fallback = min(range(min_idx, max_idx + 1), key=lambda i: abs(cum_widths[i] - target_pos))
    windowed = [i for i in range(min_idx, max_idx + 1) if i < len(break_tiers) and break_tiers[i] > 0 and abs(cum_widths[i] - target_pos) <= window]
    if not windowed:
        return best_fallback
    return min(windowed, key=lambda i: (-break_tiers[i], abs(cum_widths[i] - target_pos)))


def _partition_tokens_by_weights(
    tokens: Sequence[str],
    widths: Sequence[int],
    break_tiers: Sequence[int],
    weights: Sequence[int],
) -> list[list[str]]:
    """Partition `tokens` into `len(weights)` non-empty spans proportional to `weights`."""
    count = len(weights)
    if len(tokens) <= count:
        slices = [[tokens[i]] if i < len(tokens) else [] for i in range(count)]
        return slices
    cum: list[int] = [0]
    for w in widths:
        cum.append(cum[-1] + w)
    total_src = max(1, sum(weights))
    cuts = [0]
    acc_src = 0
    for slot in range(count - 1):
        acc_src += weights[slot]
        target = cum[-1] * (acc_src / total_src)
        min_idx = cuts[-1] + 1
        max_idx = len(tokens) - (count - 1 - slot)
        cuts.append(_choose_cut_index(cum, break_tiers, (min_idx, max_idx), target))
    cuts.append(len(tokens))
    return [list(tokens[cuts[i] : cuts[i + 1]]) for i in range(count)]


def _redistribute_group_translation(translated: str, group: Sequence[CueSpan], is_khmer: bool) -> list[str]:
    """Split a merged group translation cleanly across its contributing cue spans."""
    if len(group) == 1:
        return [translated.strip()]
    clean = translated.strip()
    if not clean:
        return [""] * len(group)
    tokens, widths, break_flags = _tokenize_khmer_for_split(clean) if is_khmer else _tokenize_space_for_split(clean)
    weights = [max(1, len(item.text)) for item in group]
    slices = _partition_tokens_by_weights(tokens, widths, break_flags, weights)
    return [format_khmer_translation(" ".join(chunk)) if is_khmer else " ".join(chunk) for chunk in slices]


def translate_grouped_segments(
    segments: Sequence[SubtitleSegment],
    line_translator: Callable[[list[str]], list[str]],
    *,
    is_khmer: bool,
) -> list[str]:
    """Translate timed subtitle segments with cross-cue sentence context and natural boundary splits.

    Inputs: ordered `SubtitleSegment` list, batch `line_translator`, and `is_khmer` formatting flag.
    Outputs: translated text list aligned 1:1 with `segments`.
    Side effects: invokes `line_translator` once with grouped source sentences.
    Failure modes: returns empty strings for empty cues; preserves exact segment count on any grouping.
    """
    if not segments:
        return []
    groups = _build_grouped_spans(segments)
    if not groups:
        return [""] * len(segments)
    group_texts = [" ".join(span.text for span in group) for group in groups]
    translated_groups = line_translator(group_texts)
    per_cue_src: list[list[str]] = [[] for _ in segments]
    per_cue_tr: list[list[str]] = [[] for _ in segments]
    for group, tr_group in zip(groups, translated_groups):
        distributed = _redistribute_group_translation(tr_group, group, is_khmer=is_khmer)
        for span, span_tr in zip(group, distributed):
            per_cue_src[span.cue_index].append(span.text)
            per_cue_tr[span.cue_index].append(span_tr)
    return [
        join_translated_sentences(per_cue_src[i], per_cue_tr[i], is_khmer=is_khmer)
        for i in range(len(segments))
    ]
