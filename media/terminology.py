"""Stage-separated project terminology enforcement for ASR spelling normalization and subtitle translation."""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, replace
from typing import Any, Iterable, Sequence

from khmer_orthography import format_khmer_translation, translate_grouped_segments
from languages import UnsupportedLanguageError, is_same_translation_language, resolve_nllb_lang_code
from subtitles import SubtitleSegment

MAX_TERMINOLOGY_FORM_BYTES = 512 * 1024
MAX_TERMINOLOGY_TERMS = 500
_VALID_CATEGORIES = frozenset({"spelling", "translation", "name", "pronunciation"})
_LATIN_EDGE = re.compile(r"[A-Za-z0-9]")
_KHMER_EDGE = re.compile(r"[\u1780-\u17D3]")
_NOT_AFTER_LATIN = r"(?<![A-Za-z0-9])"
_NOT_BEFORE_LATIN = r"(?![A-Za-z0-9])"
_NOT_AFTER_COENG = r"(?<!\u17D2)"
_NOT_BEFORE_KHMER_MARK = r"(?![\u17B6-\u17D3\u17DD])"
_SENTINEL_PREFIX = "VXTRM"


@dataclass(frozen=True)
class TerminologyEntry:
    """Validated stage-agnostic terminology item sent from the Voice Studio project."""

    term_id: str
    category: str
    status: str
    enabled: bool
    term: str
    variants: tuple[str, ...]
    translation: str
    preserve_in_translation: bool
    source_language: str
    target_language: str
    case_sensitive: bool
    scope: str = "global"
    is_disabled_in_project: bool = False


@dataclass(frozen=True)
class _ScanRule:
    """Internal scan rule supporting mixed case sensitivity and identity guards."""

    source: str
    target: str
    case_sensitive: bool
    priority: int
    is_identity_guard: bool = False


def parse_terminology_form_field(raw: str) -> list[dict[str, Any]]:
    """Decode optional multipart form JSON for `terminology` safely with strict bounds."""
    cleaned = (raw or "").strip()
    if not cleaned:
        return []
    if len(cleaned.encode("utf-8")) > MAX_TERMINOLOGY_FORM_BYTES:
        raise ValueError("Terminology payload exceeds maximum size.")
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid terminology JSON payload.") from exc
    if not isinstance(parsed, list):
        raise ValueError("Terminology form payload must be a JSON array.")
    if len(parsed) > MAX_TERMINOLOGY_TERMS:
        raise ValueError(f"Keep terminology entries to {MAX_TERMINOLOGY_TERMS} or fewer.")
    return [item for item in parsed if isinstance(item, dict)]


def _clean_text(value: Any) -> str:
    return unicodedata.normalize("NFC", value).strip() if isinstance(value, str) else ""


def _clean_lang(value: Any) -> str:
    cleaned = _clean_text(value)
    return "" if cleaned.lower() in {"", "any", "all", "auto"} else cleaned


def _parse_single_entry(raw: Any, idx: int) -> TerminologyEntry | None:
    """Validate and convert one raw dict or model into a TerminologyEntry, or None if invalid."""
    data = raw.model_dump() if hasattr(raw, "model_dump") else (raw if isinstance(raw, dict) else {})
    category = _clean_text(data.get("category")).lower()
    term = _clean_text(data.get("term"))
    if category not in _VALID_CATEGORIES or not term:
        return None
    raw_variants = data.get("variants") if isinstance(data.get("variants"), list) else []
    variants = tuple(v for v in (_clean_text(x) for x in raw_variants) if v and v != term)
    return TerminologyEntry(
        term_id=_clean_text(data.get("id")) or f"term-{idx + 1}",
        category=category,
        status=_clean_text(data.get("status")).lower() or "draft",
        enabled=bool(data.get("enabled", True)),
        term=term,
        variants=variants,
        translation=_clean_text(data.get("translation")),
        preserve_in_translation=bool(data.get("preserveInTranslation", False)),
        source_language=_clean_lang(data.get("sourceLanguage")),
        target_language=_clean_lang(data.get("targetLanguage")),
        case_sensitive=bool(data.get("caseSensitive", False)),
        scope=_clean_text(data.get("scope")).lower() or "global",
        is_disabled_in_project=bool(data.get("isDisabledInProject", False)),
    )


def normalize_entries(raw_entries: Sequence[Any] | None) -> tuple[TerminologyEntry, ...]:
    """Normalize raw dict or Pydantic terminology payloads into project-first frozen entries."""
    if not raw_entries:
        return ()
    parsed = [_parse_single_entry(raw, idx) for idx, raw in enumerate(raw_entries[:MAX_TERMINOLOGY_TERMS])]
    entries = [entry for entry in parsed if entry is not None]
    project_scoped = [entry for entry in entries if entry.scope == "project"]
    other_scoped = [entry for entry in entries if entry.scope != "project"]
    return tuple([*project_scoped, *other_scoped])


def _does_lang_match(rule_lang: str, active_lang: str) -> bool:
    clean_rule = _clean_lang(rule_lang)
    if not clean_rule:
        return True
    clean_active = _clean_lang(active_lang)
    if not clean_active:
        return False
    if clean_rule.lower() == clean_active.lower():
        return True
    try:
        return is_same_translation_language(clean_rule, clean_active)
    except UnsupportedLanguageError:
        return False


def _build_term_pattern(term: str) -> str:
    leading = _NOT_AFTER_LATIN if _LATIN_EDGE.match(term[0]) else (_NOT_AFTER_COENG if _KHMER_EDGE.match(term[0]) else "")
    trailing = _NOT_BEFORE_LATIN if _LATIN_EDGE.match(term[-1]) else (_NOT_BEFORE_KHMER_MARK if _KHMER_EDGE.match(term[-1]) else "")
    return f"{leading}{re.escape(term)}{trailing}"


def _active_approved(entries: Iterable[TerminologyEntry]) -> list[TerminologyEntry]:
    return [
        entry
        for entry in entries
        if entry.status == "approved" and entry.enabled and not entry.is_disabled_in_project
    ]


def _with_target_identity_guards(rules: Sequence[tuple[str, str, bool]]) -> list[_ScanRule]:
    """Attach identity guards for target phrases not already matched by an explicit source rule."""
    cs_sources = {src for src, _, sensitive in rules if sensitive}
    ci_sources = {src.lower() for src, _, sensitive in rules if not sensitive}
    scan_rules = [_ScanRule(src, tgt, sensitive, idx) for idx, (src, tgt, sensitive) in enumerate(rules)]
    seen_guards: set[str] = set()
    for _, target, sensitive in rules:
        if not target:
            continue
        key = target if sensitive else target.lower()
        if target in cs_sources or target.lower() in ci_sources or key in seen_guards:
            continue
        seen_guards.add(key)
        scan_rules.append(_ScanRule(target, target, sensitive, len(scan_rules), is_identity_guard=True))
    return scan_rules


def _collect_group_matches(
    text: str,
    group: Sequence[_ScanRule],
    case_sensitive: bool,
) -> list[tuple[int, int, str, _ScanRule]]:
    if not group:
        return []
    ordered = sorted(group, key=lambda r: (-len(r.source), r.priority))
    pattern = re.compile("|".join(_build_term_pattern(r.source) for r in ordered), flags=0 if case_sensitive else re.IGNORECASE)
    hits: list[tuple[int, int, str, _ScanRule]] = []
    for match in pattern.finditer(text):
        matched = match.group(0)
        rule = next((r for r in ordered if (r.source == matched if case_sensitive else r.source.lower() == matched.lower())), None)
        if rule:
            hits.append((match.start(), match.end(), matched, rule))
    return hits


def _apply_accepted_matches(text: str, candidates: list[tuple[int, int, str, _ScanRule]]) -> str:
    candidates.sort(key=lambda item: (item[0], -(item[1] - item[0]), item[3].priority))
    parts: list[str] = []
    cursor = 0
    for start, end, matched, rule in candidates:
        if start < cursor:
            continue
        parts.append(text[cursor:start])
        parts.append(matched if rule.is_identity_guard else rule.target)
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts)


def _single_pass_replace(
    text: str,
    rules: Sequence[tuple[str, str, bool]],
    *,
    guard_targets: bool = False,
) -> str:
    if not text or not rules:
        return text
    normalized_text = unicodedata.normalize("NFC", text)
    scan_rules = _with_target_identity_guards(rules) if guard_targets else [
        _ScanRule(src, tgt, sensitive, idx) for idx, (src, tgt, sensitive) in enumerate(rules)
    ]
    cs_group = [r for r in scan_rules if r.case_sensitive]
    ci_group = [r for r in scan_rules if not r.case_sensitive]
    candidates = [*_collect_group_matches(normalized_text, cs_group, True), *_collect_group_matches(normalized_text, ci_group, False)]
    return _apply_accepted_matches(normalized_text, candidates) if candidates else normalized_text


def select_spelling_rules(entries: Sequence[TerminologyEntry], source_language: str = "") -> list[tuple[str, str, bool]]:
    """Stage 1 selector: approved `spelling` and `name` variants -> canonical `term`. Never reads translation or pronunciation."""
    rules: list[tuple[str, str, bool]] = []
    seen: set[str] = set()
    for entry in _active_approved(entries):
        if entry.category not in {"spelling", "name"} or not entry.variants:
            continue
        if not _does_lang_match(entry.source_language, source_language):
            continue
        for variant in entry.variants:
            key = variant if entry.case_sensitive else variant.lower()
            if key in seen:
                continue
            seen.add(key)
            rules.append((variant, entry.term, entry.case_sensitive))
    return rules


def apply_spelling_to_segments(
    segments: Sequence[SubtitleSegment],
    raw_entries: Sequence[Any] | None,
    source_language: str = "",
) -> list[SubtitleSegment]:
    """Apply Stage 1 spelling/name corrections onto extracted ASR `text` without touching translations."""
    entries = normalize_entries(raw_entries)
    rules = select_spelling_rules(entries, source_language)
    if not rules:
        return list(segments)
    return [replace(seg, text=_single_pass_replace(seg.text, rules, guard_targets=True)) for seg in segments]


def select_translation_rules(
    entries: Sequence[TerminologyEntry],
    source_language: str = "",
    target_language: str = "",
) -> list[tuple[str, str, bool]]:
    """Stage 2 selector: approved `translation` and qualifying `name` entries -> target translation or preserved name."""
    rules: list[tuple[str, str, bool]] = []
    seen: set[str] = set()
    for entry in _active_approved(entries):
        if entry.category not in {"translation", "name"}:
            continue
        target_text = entry.translation or (entry.term if entry.category == "name" and entry.preserve_in_translation else "")
        if not target_text or not _does_lang_match(entry.source_language, source_language) or not _does_lang_match(entry.target_language, target_language):
            continue
        key = entry.term if entry.case_sensitive else entry.term.lower()
        if key in seen:
            continue
        seen.add(key)
        rules.append((entry.term, target_text, entry.case_sensitive))
    return rules


def _make_sentinel_token(index: int, forbidden_lower: str) -> str:
    """Create a pure uppercase Latin token without digits/punctuation so NLLB-200 preserves it verbatim."""
    num = index
    while True:
        letters: list[str] = []
        n = num
        while True:
            letters.append(chr(ord("A") + (n % 26)))
            n = (n // 26) - 1
            if n < 0:
                break
        candidate = f"{_SENTINEL_PREFIX}{''.join(reversed(letters))}"
        if candidate.lower() not in forbidden_lower:
            return candidate
        num += 1


def _mask_line_for_translation(
    text: str,
    ordered_rules: Sequence[tuple[str, str, bool]],
    counter_start: int,
    forbidden_targets: str = "",
) -> tuple[str, list[tuple[str, str]], int]:
    if not text or not ordered_rules:
        return text, [], counter_start
    normalized = unicodedata.normalize("NFC", text)
    scan_rules = [_ScanRule(src, tgt, sensitive, idx) for idx, (src, tgt, sensitive) in enumerate(ordered_rules)]
    cs_hits = _collect_group_matches(normalized, [r for r in scan_rules if r.case_sensitive], True)
    ci_hits = _collect_group_matches(normalized, [r for r in scan_rules if not r.case_sensitive], False)
    candidates = sorted([*cs_hits, *ci_hits], key=lambda item: (item[0], -(item[1] - item[0]), item[3].priority))
    if not candidates:
        return normalized, [], counter_start
    return _emit_masked_line(normalized, candidates, counter_start, f"{normalized}\0{forbidden_targets}".lower())


def _emit_masked_line(
    text: str,
    candidates: Sequence[tuple[int, int, str, _ScanRule]],
    counter_start: int,
    forbidden_lower: str,
) -> tuple[str, list[tuple[str, str]], int]:
    parts: list[str] = []
    mapping: list[tuple[str, str]] = []
    cursor, next_idx = 0, counter_start
    for start, end, _, rule in candidates:
        if start < cursor:
            continue
        token = _make_sentinel_token(next_idx, forbidden_lower)
        next_idx += 1
        mapping.append((token, rule.target))
        parts.append(text[cursor:start])
        parts.append(token)
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts), mapping, next_idx


def _restore_masked_translation(
    translated: str,
    mapping: Sequence[tuple[str, str]],
    rules: Sequence[tuple[str, str, bool]],
) -> tuple[str, bool]:
    """Restore masked sentinels in one pass without re-scanning inserted target terms."""
    if not mapping:
        return _single_pass_replace(translated, rules, guard_targets=True), True
    token_map = {token.lower(): target for token, target in mapping}
    combined = re.compile("|".join(_build_term_pattern(token) for token, _ in mapping), flags=re.IGNORECASE)
    found_tokens: set[str] = set()
    parts: list[str] = []
    cursor = 0
    for match in combined.finditer(translated):
        key = match.group(0).lower()
        found_tokens.add(key)
        parts.append(_single_pass_replace(translated[cursor:match.start()], rules, guard_targets=True))
        parts.append(token_map[key])
        cursor = match.end()
    if len(found_tokens) < len(token_map):
        return translated, False
    parts.append(_single_pass_replace(translated[cursor:], rules, guard_targets=True))
    return "".join(parts), True


def _reconcile_translated_outputs(
    translator: Any,
    lines: Sequence[str],
    masked_outputs: Sequence[str],
    line_mappings: Sequence[Sequence[tuple[str, str]]],
    rules_context: tuple[str, str, Sequence[tuple[str, str, bool]]],
) -> list[str]:
    source_language, target_language, ordered = rules_context
    results = list(masked_outputs)
    fallback_indices: list[int] = []
    for idx, (translated, mapping) in enumerate(zip(masked_outputs, line_mappings)):
        restored, ok = _restore_masked_translation(translated, mapping, ordered)
        if ok:
            results[idx] = restored
        else:
            fallback_indices.append(idx)
    if fallback_indices:
        fallback_outputs = translator.translate_lines([lines[idx] for idx in fallback_indices], source_language, target_language)
        for idx, fallback_tr in zip(fallback_indices, fallback_outputs):
            results[idx] = _single_pass_replace(fallback_tr, ordered, guard_targets=True)
    return results


def _is_khmer_target(target_language: str) -> bool:
    """Return True when `target_language` resolves to Khmer (`khm_Khmr`)."""
    try:
        return resolve_nllb_lang_code(target_language, strict=True) == "khm_Khmr"
    except UnsupportedLanguageError:
        return (target_language or "").strip().lower() in {"km", "khm", "khm_khmr"}


def translate_with_terminology(
    translator: Any,
    lines: Sequence[str],
    source_language: str,
    target_language: str,
    raw_entries: Sequence[Any] | None = None,
) -> list[str]:
    """Translate lines enforcing approved Stage 2 translation/name terminology with safe fallback if sentinels drop."""
    if not lines:
        return []
    is_khmer = _is_khmer_target(target_language)
    entries = normalize_entries(raw_entries)
    rules = select_translation_rules(entries, source_language, target_language)
    if not rules:
        raw_out = translator.translate_lines(list(lines), source_language, target_language)
        return [format_khmer_translation(item) for item in raw_out] if is_khmer else raw_out
    forbidden_targets = "\0".join(tgt for _, tgt, _ in rules)
    masked_lines: list[str] = []
    line_mappings: list[list[tuple[str, str]]] = []
    counter = 0
    for line in lines:
        masked, mapping, counter = _mask_line_for_translation(line, rules, counter, forbidden_targets)
        masked_lines.append(masked)
        line_mappings.append(mapping)
    raw_translated = translator.translate_lines(masked_lines, source_language, target_language)
    reconciled = _reconcile_translated_outputs(translator, lines, raw_translated, line_mappings, (source_language, target_language, rules))
    return [format_khmer_translation(item) for item in reconciled] if is_khmer else reconciled


def translate_segments_with_terminology(
    translator: Any,
    segments: Sequence[SubtitleSegment],
    source_language: str,
    target_language: str,
    raw_entries: Sequence[Any] | None = None,
) -> list[str]:
    """Translate timed subtitle segments with cross-cue sentence context and approved Stage 2 terminology.

    Inputs: translator, ordered `SubtitleSegment` list, source/target codes, and optional terminology entries.
    Outputs: translated text list aligned 1:1 with `segments`.
    Side effects: delegates batched translation to `translator`.
    Failure modes: returns empty strings for blank cues while preserving segment count.
    """
    return translate_grouped_segments(
        segments,
        lambda batch: translate_with_terminology(translator, batch, source_language, target_language, raw_entries),
        is_khmer=_is_khmer_target(target_language),
    )
