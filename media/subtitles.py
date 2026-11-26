"""Pure-domain speaker-dialogue alignment and subtitle formatting (SRT, VTT, ASS, TXT)."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Sequence

from languages import resolve_bcp47_code

DEFAULT_SPEAKER_PREFIX = "Speaker"
NEAREST_TURN_MAX_GAP_SEC = 2.0
WORD_TURN_MIN_OVERLAP_SEC = 0.05
ZERO_WIDTH_CHARS = frozenset({"\u200b", "\u200c", "\u200d", "\ufeff"})
KHMER_COENG = "\u17d2"
KHMER_DEPENDENT_OR_MARK = frozenset(chr(cp) for cp in range(0x17B6, 0x17D2)) | {"\u17d3", "\u17dd"}
KHMER_BREAK_PUNCT = frozenset({"។", "៕", "៖", "!", "?", ",", ";"})

# ASS &HAABBGGRR primary colors for up to 6 distinct speakers (high contrast on video).
SPEAKER_ASS_COLORS = (
    "&H00FFFFFF",  # White
    "&H0078E6FF",  # Warm amber/gold (BGR for #FFE678)
    "&H00FFD2A6",  # Steel ice blue (BGR for #A6D2FF)
    "&H00B5F2A0",  # Mint green (BGR for #A0F2B5)
    "&H009EA6FF",  # Coral rose (BGR for #FFA69E)
    "&H00F2BAEB",  # Soft lavender (BGR for #EBBAF2)
)

ASS_ALIGNMENT_MAP: dict[str, int] = {"bottom": 2, "middle": 5, "top": 8}
ASS_FONT_SCALE_MAP: dict[str, float] = {"small": 0.82, "medium": 1.0, "large": 1.22}
# (BorderStyle, Outline, Shadow, BackColour)
ASS_BACKGROUND_STYLES: dict[str, tuple[int, float, float, str]] = {
    "box": (4, 2.0, 1.0, "&H88000000"),
    "outline": (1, 3.0, 1.5, "&H60000000"),
    "clean": (1, 1.6, 0.8, "&H40000000"),
}


@dataclass(frozen=True)
class SpeakerTurn:
    """One diarized speaking turn interval."""

    start: float
    end: float
    speaker: str


@dataclass(frozen=True)
class SubtitleSegment:
    """One timed subtitle utterance attributed to a speaker."""

    start: float
    end: float
    text: str
    speaker_id: str = "speaker-1"
    translated_text: str = ""
    alt_text: str = ""
    verify_reason: str = ""


def format_timestamp(seconds: float, decimal_sep: str = ",") -> str:
    """Format non-negative seconds as HH:MM:SS{sep}mmm for SRT/VTT."""
    clamped_ms = max(0, round(float(seconds) * 1000))
    hours, rem = divmod(clamped_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{decimal_sep}{millis:03d}"


def format_ass_timestamp(seconds: float) -> str:
    """Format non-negative seconds as H:MM:SS.cc for ASS dialogue lines."""
    clamped_cs = max(0, round(float(seconds) * 100))
    hours, rem = divmod(clamped_cs, 360_000)
    minutes, rem = divmod(rem, 6_000)
    secs, cs = divmod(rem, 100)
    return f"{hours:d}:{minutes:02d}:{secs:02d}.{cs:02d}"


def format_clock_short(seconds: float) -> str:
    """Format non-negative seconds concisely as MM:SS (or HH:MM:SS)."""
    total_secs = max(0, int(round(float(seconds))))
    hours, rem = divmod(total_secs, 3600)
    minutes, secs = divmod(rem, 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def _pick_speaker_for_span(start: float, end: float, turns: Sequence[SpeakerTurn]) -> str | None:
    """Select the raw speaker label with maximum time overlap or nearest proximity."""
    if not turns:
        return None
    best_speaker: str | None = None
    best_overlap = 0.0
    for turn in turns:
        overlap = min(end, turn.end) - max(start, turn.start)
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = turn.speaker
    if best_overlap > 0:
        return best_speaker
    center = (start + end) / 2.0
    nearest = min(turns, key=lambda t: abs(((t.start + t.end) / 2.0) - center))
    gap = min(abs(center - nearest.start), abs(center - nearest.end))
    return nearest.speaker if gap <= NEAREST_TURN_MAX_GAP_SEC else None


def _split_words_by_speaker(segment: dict, turns: Sequence[SpeakerTurn]) -> list[tuple[float, float, str, str | None]]:
    """Split one Whisper segment across speaker switches using word timestamps when available."""
    words = segment.get("words") or []
    if not words or not turns:
        text = (segment.get("text") or "").strip()
        if not text:
            return []
        start, end = float(segment.get("start", 0.0)), float(segment.get("end", 0.0))
        return [(start, end, text, _pick_speaker_for_span(start, end, turns))]
    groups: list[list] = []
    for word in words:
        token = str(word.get("word") or "")
        if not token.strip():
            continue
        w_start = float(word.get("start", segment.get("start", 0.0)))
        w_end = max(w_start + WORD_TURN_MIN_OVERLAP_SEC, float(word.get("end", w_start)))
        raw_spk = _pick_speaker_for_span(w_start, w_end, turns)
        if groups and groups[-1][3] == raw_spk:
            groups[-1][1] = max(groups[-1][1], float(word.get("end", w_start)))
            groups[-1][2] += token
        else:
            groups.append([w_start, float(word.get("end", w_start)), token, raw_spk])
    return [(s, e, txt.strip(), spk) for s, e, txt, spk in groups if txt.strip()]


def align_segments_with_speakers(
    transcript_segments: Iterable[dict],
    speaker_turns: Sequence[SpeakerTurn],
) -> list[SubtitleSegment]:
    """Align Whisper transcript segments with speaker turns and number speakers chronologically."""
    ordered_ids: dict[str, str] = {}
    aligned: list[SubtitleSegment] = []
    for raw_seg in transcript_segments:
        pieces = _split_words_by_speaker(raw_seg, speaker_turns)
        raw_alt = str(raw_seg.get("altText") or "").strip() if len(pieces) == 1 else ""
        raw_reason = str(raw_seg.get("verifyReason") or "").strip() if len(pieces) == 1 else ""
        for start, end, text, raw_spk in pieces:
            key = str(raw_spk) if raw_spk is not None else "0"
            if key not in ordered_ids:
                ordered_ids[key] = f"speaker-{len(ordered_ids) + 1}"
            aligned.append(
                SubtitleSegment(
                    start=max(0.0, start),
                    end=max(start, end),
                    text=text,
                    speaker_id=ordered_ids[key],
                    alt_text=raw_alt,
                    verify_reason=raw_reason,
                )
            )
    return aligned


def resolve_speaker_label(speaker_id: str, speaker_names: dict[str, str] | None = None) -> str:
    """Resolve user-customized display name or default 'Speaker N' label."""
    if speaker_names and speaker_names.get(speaker_id, "").strip():
        return speaker_names[speaker_id].strip()
    suffix = speaker_id.removeprefix("speaker-")
    return f"{DEFAULT_SPEAKER_PREFIX} {suffix}" if suffix.isdigit() else speaker_id


def _display_line_text(segment: SubtitleSegment, use_translation: bool = False, bilingual: bool = False) -> str:
    """Choose translated, original, or stacked bilingual text for display and export."""
    original = segment.text.strip()
    translated = segment.translated_text.strip()
    if bilingual and original and translated and original != translated:
        return f"{original}\n{translated}"
    if use_translation and translated:
        return translated
    return original


def _normalize_cue_text(text: str) -> str:
    """Normalize CRLF line endings, sanitize timing arrows, and collapse internal blank lines."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").replace("-->", "→")
    return re.sub(r"\n(?:[ \t]*\n)+", "\n", normalized).strip()


def _build_vtt_header(language: str) -> str:
    """Build WebVTT header block with sanitized BCP-47 language metadata."""
    bcp47 = resolve_bcp47_code(language)
    if not bcp47:
        return "WEBVTT"
    return f"WEBVTT\nKind: subtitles\nLanguage: {bcp47}"


def align_even_dimensions(width: int, height: int, *, min_size: int = 2) -> tuple[int, int]:
    """Round odd pixel dimensions down to the nearest even numbers required by YUV420p encoders."""
    safe_w = max(min_size, (int(width) // 2) * 2)
    safe_h = max(min_size, (int(height) // 2) * 2)
    return (safe_w, safe_h)


def build_srt(
    segments: Sequence[SubtitleSegment],
    speaker_names: dict[str, str] | None = None,
    include_speaker: bool = True,
    use_translation: bool = False,
    bilingual: bool = False,
) -> str:
    """Render subtitle segments to SubRip (.srt) format."""
    blocks: list[str] = []
    for seg in segments:
        body = _normalize_cue_text(_display_line_text(seg, use_translation=use_translation, bilingual=bilingual))
        if not body:
            continue
        prefix = f"[{_normalize_cue_text(resolve_speaker_label(seg.speaker_id, speaker_names))}] " if include_speaker else ""
        timing = f"{format_timestamp(seg.start, ',')} --> {format_timestamp(seg.end, ',')}"
        blocks.append(f"{len(blocks) + 1}\n{timing}\n{prefix}{body}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def build_vtt(
    segments: Sequence[SubtitleSegment],
    speaker_names: dict[str, str] | None = None,
    include_speaker: bool = True,
    use_translation: bool = False,
    bilingual: bool = False,
    *,
    language: str = "",
) -> str:
    """Render subtitle segments to WebVTT (.vtt) format for HTML5 video preview and external players."""
    blocks: list[str] = [_build_vtt_header(language)]
    for seg in segments:
        body = _normalize_cue_text(_display_line_text(seg, use_translation=use_translation, bilingual=bilingual))
        if not body:
            continue
        prefix = f"{_normalize_cue_text(resolve_speaker_label(seg.speaker_id, speaker_names))}: " if include_speaker else ""
        timing = f"{format_timestamp(seg.start, '.')} --> {format_timestamp(seg.end, '.')}"
        blocks.append(f"{timing}\n{prefix}{body}")
    return "\n\n".join(blocks) + "\n"


def build_dialogue_text(
    segments: Sequence[SubtitleSegment],
    speaker_names: dict[str, str] | None = None,
    include_timestamps: bool = True,
    use_translation: bool = False,
    include_speaker: bool = True,
    bilingual: bool = False,
) -> str:
    """Group consecutive turns per speaker into a readable dialogue script."""
    turns: list[list] = []
    for seg in segments:
        body = _display_line_text(seg, use_translation=use_translation, bilingual=bilingual)
        if not body:
            continue
        if turns and turns[-1][0] == seg.speaker_id:
            turns[-1][2] = max(turns[-1][2], seg.end)
            turns[-1][3].append(body)
        else:
            turns.append([seg.speaker_id, seg.start, seg.end, [body]])
    lines: list[str] = []
    for spk_id, start, end, parts in turns:
        label = resolve_speaker_label(spk_id, speaker_names)
        stamp = f"[{format_clock_short(start)} - {format_clock_short(end)}] " if include_timestamps else ""
        spk_prefix = f"{label}: " if include_speaker else ""
        if bilingual:
            header = f"{stamp}{spk_prefix}".rstrip()
            joined = "\n".join(parts)
            lines.append(f"{header}\n{joined}" if header else joined)
        else:
            lines.append(f"{stamp}{spk_prefix}{' '.join(parts)}")
    return "\n".join(lines)


def _ass_escape(text: str) -> str:
    """Escape braces and line breaks cleanly for ASS Dialogue fields."""
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")


def _speaker_style_index(speaker_id: str) -> int:
    """Map speaker IDs deterministically onto the palette of 6 ASS styles."""
    suffix = speaker_id.removeprefix("speaker-")
    if suffix.isdigit():
        return (max(1, int(suffix)) - 1) % len(SPEAKER_ASS_COLORS)
    return 0


def _is_khmer_consonant_or_indep(ch: str) -> bool:
    """Return True for Khmer base consonants or independent vowels attachable after coeng."""
    return "\u1780" <= ch <= "\u17b3"


def segment_subtitle_clusters(text: str) -> list[str]:
    """Split text into orthographic clusters so Khmer coeng subscripts and vowels never tear apart."""
    clusters: list[str] = []
    for ch in text:
        if not clusters:
            clusters.append(ch)
            continue
        prev = clusters[-1]
        if prev.endswith(KHMER_COENG) and _is_khmer_consonant_or_indep(ch):
            clusters[-1] += ch
        elif ch == KHMER_COENG or ch in KHMER_DEPENDENT_OR_MARK or ch == "\u200d":
            clusters[-1] += ch
        elif unicodedata.category(ch).startswith("M"):
            clusters[-1] += ch
        else:
            clusters.append(ch)
    return clusters


def _visual_len(text: str) -> int:
    """Count visual orthographic clusters while ignoring zero-width spacing controls."""
    return sum(1 for cl in segment_subtitle_clusters(text) if cl not in ZERO_WIDTH_CHARS)


def _slice_cluster_token(token: str, max_visual_chars: int) -> list[str]:
    """Break an unspaced token strictly between orthographic clusters, preferring ZWSP or punctuation."""
    clusters = segment_subtitle_clusters(token)
    lines: list[str] = []
    buf: list[str] = []
    buf_len = 0
    soft_break_idx = -1
    min_soft_len = max(4, max_visual_chars // 2)

    for cl in clusters:
        is_zw = cl in ZERO_WIDTH_CHARS
        step = 0 if is_zw else 1
        if buf and buf_len + step > max_visual_chars:
            cut_idx = soft_break_idx if soft_break_idx >= min_soft_len else len(buf)
            head = "".join(buf[:cut_idx]).strip()
            if head:
                lines.append(head)
            buf = buf[cut_idx:]
            buf_len = sum(0 if item in ZERO_WIDTH_CHARS else 1 for item in buf)
            soft_break_idx = -1
        buf.append(cl)
        buf_len += step
        if is_zw or cl in KHMER_BREAK_PUNCT:
            soft_break_idx = len(buf)
    tail = "".join(buf).strip()
    if tail:
        lines.append(tail)
    return lines


def _wrap_single_paragraph(paragraph: str, max_visual_chars: int) -> list[str]:
    """Wrap one paragraph without breaking Khmer syllables or exceeding `max_visual_chars`."""
    if _visual_len(paragraph) <= max_visual_chars:
        return [paragraph]
    words = [w for w in paragraph.split(" ") if w]
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip() if current else word
        if current and _visual_len(candidate) > max_visual_chars:
            lines.append(current)
            current = word
        else:
            current = candidate
        if _visual_len(current) > max_visual_chars:
            sliced = _slice_cluster_token(current, max_visual_chars)
            if len(sliced) > 1:
                lines.extend(sliced[:-1])
                current = sliced[-1]
    if current:
        lines.append(current)
    return lines


def _wrap_subtitle_text(text: str, max_visual_chars: int) -> str:
    """Wrap subtitle text (preserving explicit line breaks) into cluster-safe lines within `max_visual_chars`."""
    limit = max(8, int(max_visual_chars))
    all_lines: list[str] = []
    for paragraph in text.split("\n"):
        cleaned = paragraph.strip()
        if cleaned:
            all_lines.extend(_wrap_single_paragraph(cleaned, limit))
    return "\n".join(all_lines)


def build_ass(
    segments: Sequence[SubtitleSegment],
    speaker_names: dict[str, str] | None = None,
    *,
    video_size: tuple[int, int] = (1280, 720),
    font_name: str = "Noto Sans Khmer",
    include_speaker: bool = True,
    use_translation: bool = False,
    bilingual: bool = False,
    position: str = "bottom",
    font_scale: str = "medium",
    background_style: str = "box",
) -> str:
    """Render styled multi-speaker ASS subtitles adapting flexibly to Portrait or Landscape video dimensions."""
    width, height = align_even_dimensions(video_size[0], video_size[1], min_size=240)
    is_portrait = height > width
    short_side = min(width, height)
    scale = ASS_FONT_SCALE_MAP.get(font_scale, 1.0)
    font_size = max(16, round(short_side * (0.042 if is_portrait else 0.040) * scale))
    margin_h = max(14, round(width * 0.045))
    margin_v = max(24, round(height * (0.065 if is_portrait else 0.055)))
    alignment = ASS_ALIGNMENT_MAP.get(position, 2)
    border_style, outline, shadow, back_colour = ASS_BACKGROUND_STYLES.get(background_style, ASS_BACKGROUND_STYLES["box"])
    base_max_chars = 36 if is_portrait else 56
    max_chars = max(18, round(base_max_chars / scale))
    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ]
    for idx, color in enumerate(SPEAKER_ASS_COLORS):
        header.append(
            f"Style: Speaker{idx + 1},{font_name},{font_size},{color},&H000000FF,&H00121212,{back_colour},"
            f"1,0,0,0,100,100,0,0,{border_style},{outline:g},{shadow:g},{alignment},{margin_h},{margin_h},{margin_v},1"
        )
    events = ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    for seg in segments:
        body = _display_line_text(seg, use_translation=use_translation, bilingual=bilingual)
        if not body:
            continue
        style_name = f"Speaker{_speaker_style_index(seg.speaker_id) + 1}"
        label = resolve_speaker_label(seg.speaker_id, speaker_names)
        safe_actor = label.replace(",", " ").replace("\r", " ").replace("\n", " ").strip() or DEFAULT_SPEAKER_PREFIX
        prefix = f"{label}: " if include_speaker else ""
        wrapped = _wrap_subtitle_text(prefix + body, max_chars)
        events.append(f"Dialogue: 0,{format_ass_timestamp(seg.start)},{format_ass_timestamp(seg.end)},{style_name},{safe_actor},0,0,0,,{_ass_escape(wrapped)}")
    return "\n".join(header + events) + "\n"
