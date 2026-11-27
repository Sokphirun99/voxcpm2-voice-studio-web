"""Unit and regression tests for Khmer orthography formatting, sentence splitting, and cross-cue grouping."""

from __future__ import annotations

from khmer_dictionary import correct_khmer_word, segment_khmer_words
from khmer_orthography import (
    format_khmer_translation,
    join_translated_sentences,
    split_source_sentences,
    translate_grouped_segments,
)
from subtitles import SubtitleSegment


def test_format_khmer_translation_produces_natural_prose_with_latin_and_clause_spaces() -> None:
    """Word-segmented NLLB Khmer fuses into continuous prose while keeping Latin, numbers, and clause breaks spaced."""
    cue_1 = "និង រហូត ដល់ ថ្ងៃ ទី ១ ខែ ធ្នូ គឺ ជា ម៉ូដែល ដែល មាន តម្លៃ ថ្លៃ ជាង គេ បំផុត នៅ ក្នុង ក្រុម Gemini 4 ទាំង មូល។"
    out_1 = format_khmer_translation(cue_1)
    assert out_1 == "និងរហូតដល់ថ្ងៃទី ១ ខែធ្នូ គឺជាម៉ូដែលដែលមានតម្លៃថ្លៃជាងគេបំផុតនៅក្នុងក្រុម Gemini 4 ទាំងមូល។"
    assert "\u200b" not in out_1

    cue_2 = "វា ជា ម៉ូដែល Gemini 4 ទី ៤ របស់ Google ក្នុង រយៈពេល ៧ សប្តាហ៍ ប៉ុន្តែ ប្រសិន បើ អ្នក បាត់បង់ វា, ខ្ញុំ មិន បន្ទោស អ្នក ទេ"
    out_2 = format_khmer_translation(cue_2)
    assert out_2 == "វាជាម៉ូដែល Gemini 4 ទី ៤ របស់ Google ក្នុងរយៈពេល ៧ សប្ដាហ៍ ប៉ុន្តែប្រសិនបើអ្នកបាត់បង់វា ខ្ញុំមិនបន្ទោសអ្នកទេ"
    assert "\u200b" not in out_2

    cue_3 = "OpenAI បាន បញ្ជូន GPT 6.2 Astra និង Sol"
    assert format_khmer_translation(cue_3) == "OpenAI បានបញ្ជូន GPT 6.2 Astra និង Sol"

    long_pivot = "យើង បាន រចនា ឧបករណ៍ នេះ ដើម្បី ឲ្យ អ្នក បង្កើត វីដេអូ អាច បម្លែង វីដេអូ ព្រោះ វា រហ័ស"
    formatted_pivot = format_khmer_translation(long_pivot)
    assert " ព្រោះ" in formatted_pivot
    assert "\u200b" not in formatted_pivot


def test_khmer_word_correction_and_segmentation_clean_triple_consonants() -> None:
    """Dictionary word corrector fixes triple-consonant NLLB glitches and segments unspaced Khmer cleanly."""
    assert correct_khmer_word("ពពពក") == "ពពក"
    assert format_khmer_translation("បញ្ជូន ទៅ ពពពក។") == "បញ្ជូនទៅពពក។"

    segmented = segment_khmer_words("ប្រព័ន្ធនឹងបង្ហាញវីដេអូ")
    assert "ប្រព័ន្ធ" in segmented
    assert "វីដេអូ" in segmented
    assert "".join(segmented) == "ប្រព័ន្ធនឹងបង្ហាញវីដេអូ"


def test_split_and_join_sentences_preserve_decimals_abbreviations_and_khmer_khan() -> None:
    """Multi-sentence cues split cleanly for NLLB while decimals and abbreviations remain intact."""
    line = "because last week was literally hell. OpenAI shipped GPT 6.2 Astra and Sol,"
    parts = split_source_sentences(line)
    assert parts == [
        "because last week was literally hell.",
        "OpenAI shipped GPT 6.2 Astra and Sol,",
    ]
    assert split_source_sentences("Dr. Smith tested U.S. v2.1 today. Next step runs now.") == [
        "Dr. Smith tested U.S. v2.1 today.",
        "Next step runs now.",
    ]

    joined_km = join_translated_sentences(
        parts,
        ["ពីព្រោះសប្តាហ៍មុនពិតជាលំបាកណាស់", "OpenAI បានបញ្ជូន GPT 6.2 Astra និង Sol"],
        is_khmer=True,
    )
    assert joined_km == "ពីព្រោះសប្តាហ៍មុនពិតជាលំបាកណាស់។ OpenAI បានបញ្ជូន GPT 6.2 Astra និង Sol"


def test_translate_grouped_segments_merges_split_clauses_and_respects_boundaries() -> None:
    """Adjacent incomplete cues of one speaker translate together; speaker switches, pauses, and period ends do not merge."""
    seen_batches: list[list[str]] = []

    def fake_translate(batch: list[str]) -> list[str]:
        seen_batches.append(list(batch))
        mapping = {
            "It's Google's fourth Gemini 4 model in seven weeks, but if you missed it, I don't blame you, because last week was literally hell.": (
                "វាជាម៉ូដែល Gemini 4 ទី ៤ របស់ Google ក្នុងរយៈពេល ៧ សប្តាហ៍ ប៉ុន្តែប្រសិនបើអ្នកខកខាន ខ្ញុំមិនបន្ទោសអ្នកទេ ព្រោះសប្តាហ៍មុនគឺលំបាកណាស់។"
            ),
            "OpenAI shipped GPT 6.2 Astra and Sol,": "OpenAI បានបញ្ជូន GPT 6.2 Astra និង Sol",
            "Speaker two starts here,": "អ្នកនិយាយទីពីរចាប់ផ្តើមនៅទីនេះ",
            "and pauses too long.": "ហើយឈប់យូរពេក។",
        }
        return [mapping[item] for item in batch]

    segments = [
        SubtitleSegment(
            start=15.0,
            end=19.0,
            speaker_id="speaker-1",
            text="It's Google's fourth Gemini 4 model in seven weeks, but if you missed it, I don't blame you,",
        ),
        SubtitleSegment(
            start=19.05,
            end=24.0,
            speaker_id="speaker-1",
            text="because last week was literally hell. OpenAI shipped GPT 6.2 Astra and Sol,",
        ),
        SubtitleSegment(start=24.1, end=26.0, speaker_id="speaker-2", text="Speaker two starts here,"),
        SubtitleSegment(start=29.0, end=31.0, speaker_id="speaker-2", text="and pauses too long."),
    ]

    results = translate_grouped_segments(segments, fake_translate, is_khmer=True)
    assert len(results) == 4
    assert seen_batches == [[
        "It's Google's fourth Gemini 4 model in seven weeks, but if you missed it, I don't blame you, because last week was literally hell.",
        "OpenAI shipped GPT 6.2 Astra and Sol,",
        "Speaker two starts here,",
        "and pauses too long.",
    ]]
    assert "Google" in results[0] and "ខ្ញុំមិនបន្ទោសអ្នកទេ" in results[0]
    assert "OpenAI បានបញ្ជូន GPT 6.2 Astra និង Sol" in results[1]
    assert "។" in results[1]
    assert all("\u200b" not in item for item in results)
    assert results[2] == "អ្នកនិយាយទីពីរចាប់ផ្តើមនៅទីនេះ"
    assert results[3] == "ហើយឈប់យូរពេក។"
