"""Unit tests for speaker-segment alignment and SRT/VTT/ASS/TXT subtitle rendering."""

from __future__ import annotations

from subtitles import (
    SpeakerTurn,
    SubtitleSegment,
    _wrap_subtitle_text,
    align_even_dimensions,
    align_segments_with_speakers,
    build_ass,
    build_dialogue_text,
    build_srt,
    build_vtt,
    segment_subtitle_clusters,
)


def test_align_segments_splits_words_and_numbers_speakers_chronologically() -> None:
    turns = [
        SpeakerTurn(start=0.0, end=2.0, speaker="spk_9"),
        SpeakerTurn(start=2.1, end=5.0, speaker="spk_2"),
    ]
    transcript = [
        {
            "start": 0.0,
            "end": 4.8,
            "text": "Hello everyone. Welcome back!",
            "words": [
                {"start": 0.1, "end": 0.8, "word": "Hello"},
                {"start": 0.9, "end": 1.8, "word": " everyone."},
                {"start": 2.2, "end": 3.2, "word": " Welcome"},
                {"start": 3.3, "end": 4.5, "word": " back!"},
            ],
        }
    ]
    aligned = align_segments_with_speakers(transcript, turns)
    assert len(aligned) == 2
    assert aligned[0].speaker_id == "speaker-1"
    assert aligned[0].text == "Hello everyone."
    assert aligned[1].speaker_id == "speaker-2"
    assert aligned[1].text == "Welcome back!"


def test_formatters_render_srt_vtt_dialogue_and_styled_ass_with_translations() -> None:
    segments = [
        SubtitleSegment(start=1.25, end=3.5, text="Good morning.", speaker_id="speaker-1", translated_text="អរុណសួស្តី។"),
        SubtitleSegment(start=3.6, end=6.0, text="How is the news?", speaker_id="speaker-1", translated_text="ព័ត៌មានយ៉ាងម៉េចដែរ?"),
        SubtitleSegment(start=6.2, end=9.1, text="Everything is ready.", speaker_id="speaker-2", translated_text="អ្វីៗរួចរាល់ហើយ។"),
    ]
    names = {"speaker-1": "ពិធីករ", "speaker-2": "ភ្ញៀវ"}

    srt = build_srt(segments, names, include_speaker=True, use_translation=True)
    assert "00:00:01,250 --> 00:00:03,500\n[ពិធីករ] អរុណសួស្តី។" in srt

    vtt = build_vtt(segments, names, include_speaker=True, use_translation=False)
    assert vtt.startswith("WEBVTT\n\n")
    assert "00:00:06.200 --> 00:00:09.100\nភ្ញៀវ: Everything is ready." in vtt

    dialogue = build_dialogue_text(segments, names, include_timestamps=True, use_translation=True)
    assert dialogue == "[00:01 - 00:06] ពិធីករ: អរុណសួស្តី។ ព័ត៌មានយ៉ាងម៉េចដែរ?\n[00:06 - 00:09] ភ្ញៀវ: អ្វីៗរួចរាល់ហើយ។"

    ass = build_ass(segments, names, video_size=(1920, 1080), use_translation=True)
    assert "PlayResX: 1920" in ass
    assert "Style: Speaker1,Noto Sans Khmer" in ass
    assert "Dialogue: 0,0:00:01.25,0:00:03.50,Speaker1,ពិធីករ,0,0,0,,ពិធីករ: អរុណសួស្តី។" in ass
    assert "Dialogue: 0,0:00:06.20,0:00:09.10,Speaker2,ភ្ញៀវ,0,0,0,,ភ្ញៀវ: អ្វីៗរួចរាល់ហើយ។" in ass


def test_khmer_cluster_wrapping_never_splits_coeng_or_combining_vowels() -> None:
    """Long unspaced Khmer phrases wrap strictly between orthographic syllable clusters."""
    # Repeat multi-codepoint syllables with coengs (\u17d2) and dependent vowels.
    phrase = "ស្ត្រីខ្ញុំប្រាំបីសួស្តីកម្ពុជាប្រជាធិបតេយ្យ" * 3
    clusters = segment_subtitle_clusters(phrase)
    assert clusters[0] == "ស្ត្រី"
    assert clusters[1] == "ខ្ញុំ"

    wrapped = _wrap_subtitle_text(phrase, max_visual_chars=12)
    lines = wrapped.split("\n")
    assert len(lines) >= 2
    for line in lines:
        assert line
        assert not line.endswith("\u17d2")
        assert not ("\u17b6" <= line[0] <= "\u17d3")
        assert "".join(lines) == phrase


def test_ass_style_options_and_bilingual_and_dialogue_without_speaker() -> None:
    """ASS builder supports top/large/outline styling, bilingual cues, and speaker-free dialogue."""
    segments = [
        SubtitleSegment(start=0.5, end=2.5, text="Hello world.", speaker_id="speaker-1", translated_text="សួស្តីពិភពលោក។"),
    ]
    ass = build_ass(
        segments,
        video_size=(1280, 720),
        include_speaker=False,
        use_translation=True,
        bilingual=True,
        position="top",
        font_scale="large",
        background_style="outline",
    )
    assert ",1,3,1.5,8," in ass
    assert "Dialogue: 0,0:00:00.50,0:00:02.50,Speaker1,Speaker 1,0,0,0,,Hello world.\\Nសួស្តីពិភពលោក។" in ass

    dialogue_clean = build_dialogue_text(segments, include_timestamps=False, use_translation=True, include_speaker=False)
    assert dialogue_clean == "សួស្តីពិភពលោក។"

    dialogue_bilingual = build_dialogue_text(segments, include_timestamps=False, use_translation=True, include_speaker=False, bilingual=True)
    assert dialogue_bilingual == "Hello world.\nសួស្តីពិភពលោក។"

    ass_comma = build_ass(segments, speaker_names={"speaker-1": "Host, A"}, include_speaker=True)
    dialogue_line = next(line for line in ass_comma.splitlines() if line.startswith("Dialogue:"))
    fields = dialogue_line.split(",", 9)
    assert fields[4] == "Host  A"
    assert fields[5:9] == ["0", "0", "0", ""]
    assert fields[9].startswith("Host, A: ")


def test_srt_vtt_collapse_crlf_and_blank_lines_and_ass_aligns_odd_video_size() -> None:
    segments = [
        SubtitleSegment(start=0.0, end=0.5, text="  \r\n\t\n  ", speaker_id="speaker-1", translated_text=""),
        SubtitleSegment(
            start=0.5,
            end=2.0,
            text="Line one\r\n\r\nLine two\n  \n\t\n  \nLine three",
            speaker_id="speaker-1",
            translated_text="បន្ទាត់ទី១\r\n\r\n\t\nបន្ទាត់ទី២",
        ),
    ]
    srt = build_srt(segments, include_speaker=False)
    assert srt == "1\n00:00:00,500 --> 00:00:02,000\nLine one\nLine two\nLine three\n"

    vtt = build_vtt(segments, include_speaker=False, use_translation=True, bilingual=True)
    assert vtt == "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nLine one\nLine two\nLine three\nបន្ទាត់ទី១\nបន្ទាត់ទី២\n"

    assert align_even_dimensions(641, 361) == (640, 360)
    odd_ass = build_ass(segments, video_size=(641, 361), include_speaker=False)
    assert "PlayResX: 640" in odd_ass
    assert "PlayResY: 360" in odd_ass
