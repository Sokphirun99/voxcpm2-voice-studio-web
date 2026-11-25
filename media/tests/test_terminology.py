"""Tests for stage-separated terminology enforcement in ASR spelling and NLLB subtitle translation."""

from __future__ import annotations

import pytest

from subtitles import SubtitleSegment
from terminology import (
    apply_spelling_to_segments,
    normalize_entries,
    parse_terminology_form_field,
    select_spelling_rules,
    select_translation_rules,
    translate_with_terminology,
)


class _SentinelAwareTranslator:
    """Fake translator verifying NLLB receives masked sentinels and reverses them cleanly."""

    def __init__(self, *, drop_sentinel_on: str = "") -> None:
        self.calls: list[list[str]] = []
        self.drop_sentinel_on = drop_sentinel_on

    def translate_lines(self, lines: list[str], source_lang: str, target_lang: str = "km") -> list[str]:
        self.calls.append(list(lines))
        outputs: list[str] = []
        for line in lines:
            if self.drop_sentinel_on and self.drop_sentinel_on in line and "VXTRM" in line:
                outputs.append(f"[{target_lang}] corrupted-drop")
            else:
                outputs.append(f"[{target_lang}] {line}")
        return outputs


def test_parse_terminology_form_field_validates_bounds_and_json() -> None:
    assert parse_terminology_form_field("") == []
    parsed = parse_terminology_form_field('[{"category": "spelling", "status": "approved", "term": "VoxCPM"}]')
    assert len(parsed) == 1
    with pytest.raises(ValueError):
        parse_terminology_form_field("{not-json")
    with pytest.raises(ValueError):
        parse_terminology_form_field('{"not": "list"}')


def test_stage_separation_and_approval_gating_on_spelling_and_translation() -> None:
    raw = [
        {
            "id": "draft-1",
            "category": "spelling",
            "status": "draft",
            "term": "DraftOnly",
            "variants": ["draft only"],
        },
        {
            "id": "spell-1",
            "category": "spelling",
            "status": "approved",
            "term": "Phnom Penh",
            "variants": ["Pnom Penh", "Phom Penh"],
            "sourceLanguage": "en",
        },
        {
            "id": "tr-1",
            "category": "translation",
            "status": "approved",
            "term": "Workspace",
            "translation": "កន្លែងធ្វើការ",
            "sourceLanguage": "en",
            "targetLanguage": "khm_Khmr",
        },
        {
            "id": "name-1",
            "category": "name",
            "status": "approved",
            "term": "VoxCPM",
            "variants": ["vox cpm"],
            "preserveInTranslation": True,
            "pronunciation": "SHOULD_NEVER_LEAK_TO_SUBTITLES",
        },
        {
            "id": "pron-1",
            "category": "pronunciation",
            "status": "approved",
            "term": "Workspace",
            "pronunciation": "WERK-SPACE-AUDIO",
        },
    ]

    entries = normalize_entries(raw)
    # Stage 1: Spelling variants fixed cleanly, pronunciation & draft untouched
    spelling = select_spelling_rules(entries, "en")
    assert [s[0] for s in spelling] == ["Pnom Penh", "Phom Penh", "vox cpm"]
    segs = [SubtitleSegment(start=0.0, end=2.0, text="Pnom Penh runs vox cpm draft only Workspace.")]
    corrected = apply_spelling_to_segments(segs, raw, "en")
    assert corrected[0].text == "Phnom Penh runs VoxCPM draft only Workspace."
    assert "SHOULD_NEVER_LEAK" not in corrected[0].text
    assert "WERK-SPACE-AUDIO" not in corrected[0].text

    # Stage 2: Translation masking enforces approved translation & preserved names, ignoring pronunciation & other targets
    assert select_translation_rules(entries, "en", "fra_Latn") == [("VoxCPM", "VoxCPM", False)]
    translator = _SentinelAwareTranslator()
    translated = translate_with_terminology(
        translator,
        ["Open Workspace in VoxCPM now."],
        "en",
        "khm_Khmr",
        raw,
    )
    assert "VXTRM" in translator.calls[0][0]
    assert translated == ["[khm_Khmr] Open កន្លែងធ្វើការ in VoxCPM now."]
    assert "WERK-SPACE-AUDIO" not in translated[0]


def test_translation_falls_back_cleanly_when_model_drops_sentinel() -> None:
    raw = [
        {
            "id": "tr-1",
            "category": "translation",
            "status": "approved",
            "term": "AI",
            "translation": "បញ្ញាសិប្បនិម្មិត",
            "sourceLanguage": "en",
            "targetLanguage": "khm_Khmr",
        }
    ]
    translator = _SentinelAwareTranslator(drop_sentinel_on="VXTRMA")
    lines = ["AI helps students.", "Normal sentence."]
    translated = translate_with_terminology(translator, lines, "en", "khm_Khmr", raw)
    assert len(translator.calls) == 2
    assert translated[0] == "[khm_Khmr] បញ្ញាសិប្បនិម្មិត helps students."
    assert translated[1] == "[khm_Khmr] Normal sentence."


def test_khmer_and_latin_boundaries_and_project_scope_precedence() -> None:
    raw = [
        {
            "id": "g-tr",
            "category": "translation",
            "status": "approved",
            "term": "AI",
            "translation": "GlobalAI",
            "scope": "global",
            "targetLanguage": "km",
        },
        {
            "id": "p-tr",
            "category": "translation",
            "status": "approved",
            "term": "AI",
            "translation": "ProjectAI",
            "scope": "project",
            "targetLanguage": "khm_Khmr",
        },
    ]
    translator = _SentinelAwareTranslator()
    translated = translate_with_terminology(translator, ["MAIN AI test"], "en", "khm_Khmr", raw)
    assert translated[0] == "[khm_Khmr] MAIN ProjectAI test"


import unicodedata
from subtitles import SubtitleSegment
import terminology as term_mod


class _MappingTranslator:
    def __init__(self, transform):
        self._transform = transform

    def translate_lines(self, lines, source_language, target_language):
        return [self._transform(line) for line in lines]


def test_stage2_translation_does_not_rescan_restored_sentinel_targets():
    entries = [
        {
            "id": "t-openai",
            "category": "translation",
            "term": "OpenAI",
            "translation": "Open AI",
            "sourceLanguage": "en",
            "targetLanguage": "km",
            "status": "approved",
            "scope": "global",
        },
        {
            "id": "t-ai",
            "category": "translation",
            "term": "AI",
            "translation": "បញ្ញាសិប្បនិម្មិត",
            "sourceLanguage": "en",
            "targetLanguage": "km",
            "status": "approved",
            "scope": "global",
        },
    ]
    # Simulate translator preserving VXTRMA ("OpenAI") and emitting literal "AI" in surrounding text
    translator = _MappingTranslator(lambda line: f"{line} -> AI" if "VXTRM" in line else line)
    res = term_mod.translate_with_terminology(
        translator,
        ["OpenAI"],
        "en",
        "km",
        entries,
    )
    # "Open AI" must NEVER be re-scanned by the "AI" rule into "Open បញ្ញាសិប្បនិម្មិត"!
    assert res == ["Open AI -> បញ្ញាសិប្បនិម្មិត"]


def test_project_scope_wins_over_alphabetical_id_order_and_nfc_normalization():
    entries = [
        {
            "id": "a-global",
            "category": "spelling",
            "term": "GlobalForm",
            "variants": ["café"],
            "status": "approved",
            "scope": "global",
        },
        {
            "id": "z-project",
            "category": "spelling",
            "term": "ProjectCafe",
            "variants": ["café"],
            "status": "approved",
            "scope": "project",
        },
    ]
    nfd_seg = SubtitleSegment(start=0.0, end=1.0, speaker_id="speaker-1", text=unicodedata.normalize("NFD", "Meet at café"))
    applied = term_mod.apply_spelling_to_segments([nfd_seg], entries)
    assert applied[0].text == "Meet at ProjectCafe"


def test_mixed_case_sensitivity_and_identity_guards():
    entries = [
        {
            "id": "cs",
            "category": "spelling",
            "term": "CARE",
            "variants": ["WHO cares"],
            "caseSensitive": True,
            "status": "approved",
        },
        {
            "id": "ci",
            "category": "spelling",
            "term": "whom",
            "variants": ["who"],
            "caseSensitive": False,
            "status": "approved",
        },
        {
            "id": "name",
            "category": "name",
            "term": "Dr. Sok",
            "variants": ["Sok"],
            "caseSensitive": False,
            "status": "approved",
        },
    ]
    segments = [
        SubtitleSegment(start=0.0, end=1.0, speaker_id="speaker-1", text="who cares"),
        SubtitleSegment(start=1.0, end=2.0, speaker_id="speaker-1", text="Dr. Sok met Sok"),
    ]
    out = term_mod.apply_spelling_to_segments(segments, entries)
    assert out[0].text == "whom cares"
    assert out[1].text == "Dr. Sok met Dr. Sok"
