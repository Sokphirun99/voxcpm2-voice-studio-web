"""FFmpeg/FFprobe media extraction, rotation-aware dimension probing, speech denoising, and subtitle burn-in."""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import wave
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from languages import UNDETERMINED_ISO639_2, resolve_iso639_2_code

logger = logging.getLogger(__name__)

FFMPEG_FULL_BIN = Path("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg")
FFPROBE_FULL_BIN = Path("/opt/homebrew/opt/ffmpeg-full/bin/ffprobe")
DEFAULT_VIDEO_SIZE = (1280, 720)
FILTER_ASS_PATTERN = re.compile(r"\bass\b")
FFMPEG_TIMEOUT_SECONDS = 600
AUDIO_ONLY_EXTS = frozenset({".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"})
DUB_AUDIO_MODES = frozenset({"duck", "mute", "keep", "replace", "mix", "original"})
CANONICAL_AUDIO_MODES = {
    "duck": "duck",
    "mute": "mute",
    "replace": "mute",
    "keep": "keep",
    "mix": "keep",
    "original": "original",
}
VIDEO_SUBTITLE_MODES = frozenset({"none", "burned", "soft"})
DUB_DUCK_VOLUME = 0.15
DUB_KEEP_VOLUME = 1.0
DEFAULT_ORIGINAL_VOLUME = 1.0
MIN_ORIGINAL_VOLUME = 0.05
MAX_ORIGINAL_VOLUME = 1.5
DEFAULT_DUB_VOLUME = 1.0
MIN_DUB_VOLUME = 0.25
MAX_DUB_VOLUME = 1.5
MIN_DUCK_VOLUME = 0.05
MAX_DUCK_VOLUME = 0.85
DUCK_PRE_ROLL_SECONDS = 0.05
DUCK_POST_ROLL_SECONDS = 0.12
DUCK_MERGE_GAP_SECONDS = 0.35
MAX_DUCK_WINDOWS_PER_EXPR = 40
DUB_LIMITER_CEILING = 0.98
DUB_MIN_ATEMPO = 0.85
DUB_MAX_ATEMPO = 1.25
DUB_ATEMPO_TOLERANCE = 0.01
DUB_MIN_SLOT_SECONDS = 0.05
DUB_SAMPLE_RATE = 48000
DUB_AUDIO_BITRATE = "192k"
_FFMPEG_BOILERPLATE_PATTERNS = (
    "conversion failed",
    "nothing was written into output file",
    "terminating thread with return code",
    "task finished with error code",
)
_FFMPEG_CASCADE_PATTERNS = (
    "error sending frames to consumers",
    "error filtering frame",
    "error reinitializing filters",
    "error initializing filters",
    "error while opening encoder",
    "could not open encoder before eof",
    "error opening output file",
)
_FFMPEG_PROGRESS_PATTERN = re.compile(r"^(?:frame|size)=\s*")
_FFMPEG_ERROR_KEYWORDS = (
    "error",
    "invalid",
    "not divisible",
    "unable",
    "failed",
    "no such",
    "cannot",
    "permission",
    "missing",
    "unrecognized",
    "unknown",
)


class MediaProcessingError(RuntimeError):
    """Structured error raised when FFmpeg or FFprobe fails."""


@dataclass(frozen=True)
class DubClip:
    """One time-aligned WAV voiceover clip placed onto a video timeline."""

    wav_path: Path
    start_seconds: float
    end_seconds: float
    segment_id: str = ""
    allow_overflow: bool = False


@dataclass(frozen=True)
class DubAudioMixConfig:
    """Validated audio mode and mixing/ducking gain levels for video dubbing export."""

    mode: str = "duck"
    original_volume: float = DEFAULT_ORIGINAL_VOLUME
    dub_volume: float = DEFAULT_DUB_VOLUME
    duck_volume: float = DUB_DUCK_VOLUME


@dataclass(frozen=True)
class VideoSubtitleRenderSpec:
    """Validated subtitle rendering specification (`none`, `burned` ASS, or `soft` MP4 mov_text)."""

    mode: str = "none"
    ass_path: Path | None = None
    srt_path: Path | None = None
    subtitle_language: str = ""


def resolve_ffmpeg_bin() -> str:
    """Resolve the preferred FFmpeg binary, favoring Homebrew ffmpeg-full with libass."""
    explicit = os.environ.get("MEDIA_FFMPEG_BIN", "").strip()
    if explicit:
        return explicit
    if FFMPEG_FULL_BIN.is_file():
        return str(FFMPEG_FULL_BIN)
    return shutil.which("ffmpeg") or "ffmpeg"


def resolve_ffprobe_bin() -> str:
    """Resolve the preferred FFprobe binary paired with FFmpeg."""
    explicit = os.environ.get("MEDIA_FFPROBE_BIN", "").strip()
    if explicit:
        return explicit
    if FFPROBE_FULL_BIN.is_file():
        return str(FFPROBE_FULL_BIN)
    return shutil.which("ffprobe") or "ffprobe"


def check_burnin_support(ffmpeg_bin: str | None = None) -> bool:
    """Verify whether the resolved FFmpeg build supports the libass subtitle filter."""
    binary = ffmpeg_bin or resolve_ffmpeg_bin()
    try:
        proc = subprocess.run([binary, "-hide_banner", "-filters"], capture_output=True, text=True, timeout=15)
    except OSError:
        return False
    return proc.returncode == 0 and bool(FILTER_ASS_PATTERN.search(proc.stdout or ""))


def _extract_rotation_degrees(stream: dict) -> int:
    """Extract display rotation degrees (0, 90, 180, 270) from stream tags or side_data_list."""
    tags = stream.get("tags") or {}
    if "rotate" in tags:
        try:
            return int(round(float(tags["rotate"]))) % 360
        except (ValueError, TypeError) as exc:
            logger.debug("Ignoring invalid stream rotate tag %r: %s", tags.get("rotate"), exc)
    for item in stream.get("side_data_list") or []:
        if "rotation" in item:
            try:
                return int(round(float(item["rotation"]))) % 360
            except (ValueError, TypeError) as exc:
                logger.debug("Ignoring invalid stream side_data rotation %r: %s", item.get("rotation"), exc)
    return 0


def has_video_stream(media_path: Path, ffprobe_bin: str | None = None) -> bool:
    """Return True if `media_path` contains at least one video stream."""
    if media_path.suffix.lower() in AUDIO_ONLY_EXTS:
        return False
    binary = ffprobe_bin or resolve_ffprobe_bin()
    cmd = [binary, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "json", str(media_path)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except OSError:
        return False
    if proc.returncode != 0:
        return False
    try:
        streams = json.loads(proc.stdout).get("streams") or []
        return len(streams) > 0
    except json.JSONDecodeError:
        return False


def probe_video_dimensions(video_path: Path, ffprobe_bin: str | None = None) -> tuple[int, int]:
    """Return display (width, height) using FFprobe, accounting for 90/270 degree rotation metadata."""
    binary = ffprobe_bin or resolve_ffprobe_bin()
    cmd = [
        binary, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:stream_tags=rotate:stream_side_data=rotation",
        "-of", "json", str(video_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        return DEFAULT_VIDEO_SIZE
    try:
        streams = json.loads(proc.stdout).get("streams") or []
        if not streams:
            return DEFAULT_VIDEO_SIZE
        w = int(streams[0].get("width") or DEFAULT_VIDEO_SIZE[0])
        h = int(streams[0].get("height") or DEFAULT_VIDEO_SIZE[1])
        if w <= 0 or h <= 0:
            return DEFAULT_VIDEO_SIZE
        if _extract_rotation_degrees(streams[0]) in (90, 270):
            return (h, w)
        return (w, h)
    except (ValueError, TypeError, json.JSONDecodeError):
        return DEFAULT_VIDEO_SIZE


def _extract_ffmpeg_error(stderr: str, fallback: str) -> str:
    """Pick the most informative root-cause line from FFmpeg stderr, skipping generic tail boilerplate."""
    lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
    meaningful = [
        line for line in lines
        if not _FFMPEG_PROGRESS_PATTERN.match(line)
        and not any(pat in line.lower() for pat in _FFMPEG_BOILERPLATE_PATTERNS)
    ]
    if not meaningful:
        return fallback
    specific = [line for line in meaningful if not any(pat in line.lower() for pat in _FFMPEG_CASCADE_PATTERNS)]
    for pool in (specific, meaningful):
        for line in reversed(pool):
            if any(tok in line.lower() for tok in _FFMPEG_ERROR_KEYWORDS):
                return line[:240]
    return meaningful[-1][:240]


_FILTER_OPTION_SPECIALS = re.compile(r"([\\':])")
_FILTERGRAPH_SPECIALS = re.compile(r"([\\'\[\],;])")


def _escape_ffmpeg_filter_value(raw_value: str) -> str:
    """Escape an option value (e.g. ASS filename) for both FFmpeg parsing levels.

    FFmpeg first splits the filtergraph (`[ ] , ; ' \\`), then each filter's `key=value`
    options (`: ' \\`), so the option-level escape must itself be graph-escaped.
    """
    option_escaped = _FILTER_OPTION_SPECIALS.sub(r"\\\1", raw_value)
    return _FILTERGRAPH_SPECIALS.sub(r"\\\1", option_escaped)


def extract_audio_16k_wav(video_path: Path, wav_path: Path, ffmpeg_bin: str | None = None) -> None:
    """Extract clean mono 16 kHz PCM audio track from a video file for ASR and diarization."""
    binary = ffmpeg_bin or resolve_ffmpeg_bin()
    plain_cmd = [
        binary, "-y", "-i", str(video_path),
        "-vn", "-af", "aresample=async=1:first_pts=0",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path),
    ]
    proc = subprocess.run(plain_cmd, capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_SECONDS)
    if proc.returncode != 0 or not wav_path.is_file():
        detail = _extract_ffmpeg_error(proc.stderr or "", "Audio extraction failed")
        raise MediaProcessingError(f"Could not extract audio track from video: {detail}")


MP4_SAFE_VIDEO_CODECS = frozenset({"h264", "hevc"})
MP4_SAFE_PIX_FMTS = frozenset({"yuv420p", "nv12"})


def _build_audio_language_args(audio_language: str) -> list[str]:
    """Build FFmpeg `-metadata:s:a:0` arguments when `audio_language` resolves to a known code."""
    iso_code = resolve_iso639_2_code(audio_language)
    if iso_code == UNDETERMINED_ISO639_2:
        return []
    return ["-metadata:s:a:0", f"language={iso_code}"]


def _run_burn_cmd(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run an FFmpeg burn-in command cleanly inside the job directory."""
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_SECONDS)


def _has_non_empty_file(path: Path) -> bool:
    """Return True when `path` exists as a regular file with at least one byte."""
    return path.is_file() and path.stat().st_size > 0


def burn_ass_subtitles(
    video_path: Path,
    ass_path: Path,
    output_mp4_path: Path,
    ffmpeg_bin: str | None = None,
    *,
    audio_language: str = "",
) -> None:
    """Burn styled multi-speaker ASS subtitles into MP4 preserving Portrait or Landscape aspect ratio."""
    binary = ffmpeg_bin or resolve_ffmpeg_bin()
    if not check_burnin_support(binary):
        raise MediaProcessingError("Installed FFmpeg does not support libass subtitle burn-in. Install ffmpeg-full.")
    if video_path.is_file() and not has_video_stream(video_path):
        raise MediaProcessingError("Cannot burn subtitles onto an audio-only file. Upload a video file instead.")
    w, h = probe_video_dimensions(video_path)
    hw_bitrate = "2500k" if (w * h) < 600_000 else "5000k"
    safe_ass_name = _escape_ffmpeg_filter_value(ass_path.name)
    vf_arg = f"scale=trunc(iw/2)*2:trunc(ih/2)*2,ass={safe_ass_name},setsar=1"
    lang_args = _build_audio_language_args(audio_language)
    tail = [
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", DUB_AUDIO_BITRATE, "-ar", str(DUB_SAMPLE_RATE), "-ac", "2",
        *lang_args, "-movflags", "+faststart", str(output_mp4_path.resolve()),
    ]
    hw_cmd = [binary, "-y", "-i", str(video_path.resolve()), "-vf", vf_arg, "-c:v", "h264_videotoolbox", "-b:v", hw_bitrate, *tail]
    proc = _run_burn_cmd(hw_cmd, ass_path.parent)
    if proc.returncode == 0 and _has_non_empty_file(output_mp4_path):
        return
    sw_cmd = [binary, "-y", "-i", str(video_path.resolve()), "-vf", vf_arg, "-c:v", "libx264", "-crf", "21", "-preset", "fast", *tail]
    sw_proc = _run_burn_cmd(sw_cmd, ass_path.parent)
    if sw_proc.returncode != 0 or not _has_non_empty_file(output_mp4_path):
        detail = _extract_ffmpeg_error(sw_proc.stderr or proc.stderr or "", "Subtitle burn-in failed")
        raise MediaProcessingError(f"Could not render subtitles onto video: {detail}")


def probe_primary_audio_index(media_path: Path, ffprobe_bin: str | None = None) -> int | None:
    """Return zero-based audio stream index preferring `disposition.default == 1`, or None if silent."""
    binary = ffprobe_bin or resolve_ffprobe_bin()
    cmd = [
        binary, "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=codec_type:stream_disposition=default",
        "-of", "json", str(media_path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        streams = json.loads(proc.stdout).get("streams") or [] if proc.returncode == 0 else []
    except (OSError, json.JSONDecodeError):
        return None
    if not streams:
        return None
    for idx, stream in enumerate(streams):
        if (stream.get("disposition") or {}).get("default") == 1:
            return idx
    return 0


def has_audio_stream(media_path: Path, ffprobe_bin: str | None = None) -> bool:
    """Return True if `media_path` contains at least one audio stream."""
    return probe_primary_audio_index(media_path, ffprobe_bin) is not None


def probe_media_duration(media_path: Path, ffprobe_bin: str | None = None) -> float:
    """Return container duration in seconds via FFprobe, or 0.0 when unavailable."""
    binary = ffprobe_bin or resolve_ffprobe_bin()
    cmd = [binary, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(media_path)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except OSError:
        return 0.0
    if proc.returncode != 0:
        return 0.0
    try:
        raw = (json.loads(proc.stdout).get("format") or {}).get("duration")
        value = float(raw)
        return value if math.isfinite(value) and value > 0 else 0.0
    except (ValueError, TypeError, json.JSONDecodeError):
        return 0.0


def probe_wav_duration(wav_path: Path, ffprobe_bin: str | None = None) -> float:
    """Read WAV duration cheaply via stdlib `wave`, falling back to FFprobe for non-PCM headers."""
    try:
        with wave.open(str(wav_path), "rb") as wf:
            rate = wf.getframerate()
            frames = wf.getnframes()
            if rate > 0 and frames > 0:
                return frames / float(rate)
    except (wave.Error, OSError, EOFError) as exc:
        logger.debug("Stdlib wave probe skipped for %s (%s); falling back to ffprobe", wav_path.name, exc)
    return probe_media_duration(wav_path, ffprobe_bin)


_probe_wav_duration = probe_wav_duration


def _compute_clip_atempo(clip_duration: float, slot_seconds: float) -> float | None:
    """Return a gently clamped atempo in [0.85, 1.25] only when `clip_duration` exceeds `slot_seconds`."""
    if clip_duration <= 0.0 or slot_seconds <= DUB_MIN_SLOT_SECONDS:
        return None
    if clip_duration <= slot_seconds * (1.0 + DUB_ATEMPO_TOLERANCE):
        return None
    ratio = clip_duration / slot_seconds
    clamped = min(DUB_MAX_ATEMPO, max(DUB_MIN_ATEMPO, ratio))
    return round(clamped, 4)


def _is_finite_timestamp(value: object) -> bool:
    """Accept finite real timestamps but reject booleans and values too large to convert safely."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _resolve_clip_slot_seconds(ordered: Sequence[DubClip], index: int) -> float:
    """Return the cue window only when this clip does not overlap any other cue."""
    clip = ordered[index]
    declared = clip.end_seconds - clip.start_seconds
    if declared <= DUB_MIN_SLOT_SECONDS:
        return 0.0
    overlaps = any(
        other_index != index
        and other.start_seconds < clip.end_seconds
        and other.end_seconds > clip.start_seconds
        for other_index, other in enumerate(ordered)
    )
    return 0.0 if overlaps else declared


def canonicalize_dub_audio_mode(raw_mode: str) -> str:
    """Normalize supported audio mode aliases (`replace`->`mute`, `mix`->`keep`) or raise `MediaProcessingError`."""
    cleaned = str(raw_mode or "").strip().lower()
    if cleaned not in CANONICAL_AUDIO_MODES:
        raise MediaProcessingError(f"Unsupported original_audio_mode '{raw_mode}'. Use original, replace, mute, duck, keep, or mix.")
    return CANONICAL_AUDIO_MODES[cleaned]


def _assert_gain_in_range(value: object, field_name: str, low: float, high: float) -> float:
    """Validate a finite numeric audio gain within `[low, high]`."""
    if not _is_finite_timestamp(value):
        raise MediaProcessingError(f"{field_name} must be a finite number.")
    numeric = float(value)  # type: ignore[arg-type]
    if numeric < low - 1e-6 or numeric > high + 1e-6:
        raise MediaProcessingError(f"{field_name} must be between {low:g} and {high:g}.")
    return round(numeric, 4)


def validate_dub_mix_config(config: DubAudioMixConfig) -> DubAudioMixConfig:
    """Validate audio mode and mixing/ducking gain bounds without silent coercion."""
    mode = canonicalize_dub_audio_mode(config.mode)
    orig = _assert_gain_in_range(config.original_volume, "original_volume", MIN_ORIGINAL_VOLUME, MAX_ORIGINAL_VOLUME)
    dub = _assert_gain_in_range(config.dub_volume, "dub_volume", MIN_DUB_VOLUME, MAX_DUB_VOLUME)
    duck = _assert_gain_in_range(config.duck_volume, "duck_volume", MIN_DUCK_VOLUME, MAX_DUCK_VOLUME)
    return DubAudioMixConfig(mode=mode, original_volume=orig, dub_volume=dub, duck_volume=duck)


def validate_subtitle_render_spec(spec: VideoSubtitleRenderSpec | None, ffmpeg_bin: str) -> VideoSubtitleRenderSpec:
    """Validate requested subtitle output mode (`none`, `burned`, or `soft`) and required subtitle files."""
    if spec is None:
        return VideoSubtitleRenderSpec(mode="none")
    mode = str(spec.mode or "").strip().lower()
    if mode not in VIDEO_SUBTITLE_MODES:
        raise MediaProcessingError(f"Unsupported subtitle mode '{spec.mode}'. Use none, burned, or soft.")
    if mode == "burned":
        if not check_burnin_support(ffmpeg_bin):
            raise MediaProcessingError("Installed FFmpeg does not support libass subtitle burn-in. Install ffmpeg-full.")
        if spec.ass_path is None or not _has_non_empty_file(spec.ass_path):
            raise MediaProcessingError("ASS subtitle file is required for burned subtitle mode.")
    elif mode == "soft" and (spec.srt_path is None or not _has_non_empty_file(spec.srt_path)):
        raise MediaProcessingError("SRT subtitle file is required for soft embedded subtitle mode.")
    return VideoSubtitleRenderSpec(mode=mode, ass_path=spec.ass_path, srt_path=spec.srt_path, subtitle_language=spec.subtitle_language)


def _compute_speech_duck_windows(ordered: Sequence[DubClip], clip_durations: Sequence[float]) -> list[tuple[float, float]]:
    """Compute merged speech intervals `[start, end]` so background audio ducks smoothly without pumping."""
    raw_spans: list[tuple[float, float]] = []
    for idx, clip in enumerate(ordered):
        slot_sec = _resolve_clip_slot_seconds(ordered, idx)
        atempo = None if clip.allow_overflow else _compute_clip_atempo(clip_durations[idx], slot_sec)
        raw_dur = clip_durations[idx] if idx < len(clip_durations) and clip_durations[idx] > 0 else max(0.2, clip.end_seconds - clip.start_seconds)
        played_dur = raw_dur / atempo if atempo and atempo > 0 else raw_dur
        start = max(0.0, clip.start_seconds - DUCK_PRE_ROLL_SECONDS)
        end = max(start + 0.05, clip.start_seconds + played_dur + DUCK_POST_ROLL_SECONDS)
        raw_spans.append((start, end))
    merged: list[tuple[float, float]] = []
    for start, end in sorted(raw_spans):
        if merged and start <= merged[-1][1] + DUCK_MERGE_GAP_SECONDS:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _append_chunked_duck_filters(parts: list[str], duck_volume: float, duck_windows: Sequence[tuple[float, float]]) -> None:
    """Append bounded-depth `volume=...:enable='...'` stages so 100+ cues never hit FFmpeg av_expr_parse limits."""
    if not duck_windows:
        parts.append(f"volume={duck_volume:g}")
        return
    for offset in range(0, len(duck_windows), MAX_DUCK_WINDOWS_PER_EXPR):
        chunk = duck_windows[offset : offset + MAX_DUCK_WINDOWS_PER_EXPR]
        expr = "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in chunk)
        parts.append(f"volume={duck_volume:g}:enable='{expr}'")


def _build_original_audio_filter(
    mix: DubAudioMixConfig,
    duck_windows: Sequence[tuple[float, float]],
    audio_stream_index: int = 0,
) -> str:
    """Build timeline-aligned, stereo-normalized primary original audio filter chain with optional ducking."""
    parts = [
        "aresample=async=1:first_pts=0",
        f"aformat=sample_rates={DUB_SAMPLE_RATE}:channel_layouts=stereo",
    ]
    if mix.mode == "duck":
        if abs(mix.original_volume - DEFAULT_ORIGINAL_VOLUME) > 1e-4:
            parts.append(f"volume={mix.original_volume:g}")
        _append_chunked_duck_filters(parts, mix.duck_volume, duck_windows)
    else:
        parts.append(f"volume={mix.original_volume:g}")
    return f"[0:a:{max(0, int(audio_stream_index))}]{','.join(parts)}[orig]"


def _build_dub_clip_filter(
    input_idx: int,
    clip_idx: int,
    start_ms: int,
    atempo_and_gain: float | tuple[float | None, float] | None = None,
) -> str:
    """Build one stereo-safe FFmpeg filter chain for a time-aligned dubbed WAV clip."""
    atempo, dub_vol = atempo_and_gain if isinstance(atempo_and_gain, tuple) else (atempo_and_gain, DEFAULT_DUB_VOLUME)
    parts = [f"aformat=sample_rates={DUB_SAMPLE_RATE}:channel_layouts=stereo"]
    if abs(dub_vol - DEFAULT_DUB_VOLUME) > 1e-4:
        parts.append(f"volume={dub_vol:g}")
    if atempo is not None:
        parts.append(f"atempo={atempo:.4f}")
    if start_ms > 0:
        parts.append(f"adelay={start_ms}|{start_ms}:all=1")
    return f"[{input_idx}:a:0]{','.join(parts)}[dub{clip_idx}]"


def _resolve_audio_pad_filter(video_duration: float, subtitle_mode: str = "none") -> str:
    """Bound `[aout]` explicitly to `video_duration` so soft subtitle EOF never truncates MP4 output."""
    if video_duration > 0:
        return f"apad=whole_dur={video_duration:.3f},atrim=0:{video_duration:.3f}"
    return "anull" if subtitle_mode == "soft" else "apad"


def _format_audio_master_tail(mix_labels: Sequence[str], mix: DubAudioMixConfig, pad_filter: str) -> str:
    """Format final `[aout]` mixdown + peak limiter + duration pad stage."""
    if not mix_labels:
        raise MediaProcessingError("No audio streams available to build dubbing filtergraph.")
    limiter = f"alimiter=limit={DUB_LIMITER_CEILING}:level=false,"
    if len(mix_labels) == 1:
        guard = limiter if (mix.original_volume > 1.0 or mix.dub_volume > 1.0) else ""
        return f"{mix_labels[0]}{guard}{pad_filter}[aout]"
    joined = "".join(mix_labels)
    return f"{joined}amix=inputs={len(mix_labels)}:duration=longest:dropout_transition=0:normalize=0,{limiter}{pad_filter}[aout]"


# Retains 5-arg positional signature for R3-04 test compatibility while accepting optional mix_config/subtitle_mode.
def _build_dub_filter_complex(
    ordered: Sequence[DubClip],
    clip_durations: Sequence[float],
    original_audio_mode: str,
    include_original: bool,
    video_duration: float,
    *,
    mix_config: DubAudioMixConfig | None = None,
    subtitle_mode: str = "none",
    primary_audio_index: int = 0,
) -> str:
    """Construct the complete FFmpeg filter_complex graph for original, replacement, or mixed audio."""
    effective_mix = validate_dub_mix_config(mix_config or DubAudioMixConfig(mode=original_audio_mode))
    chains: list[str] = []
    mix_labels: list[str] = []
    if include_original:
        duck_windows = _compute_speech_duck_windows(ordered, clip_durations) if effective_mix.mode == "duck" else ()
        chains.append(_build_original_audio_filter(effective_mix, duck_windows, primary_audio_index))
        mix_labels.append("[orig]")
    for idx, clip in enumerate(ordered):
        start_ms = max(0, int(round(clip.start_seconds * 1000)))
        slot_seconds = _resolve_clip_slot_seconds(ordered, idx)
        atempo = None if clip.allow_overflow else _compute_clip_atempo(clip_durations[idx], slot_seconds)
        chains.append(_build_dub_clip_filter(idx + 1, idx, start_ms, (atempo, effective_mix.dub_volume)))
        mix_labels.append(f"[dub{idx}]")
    pad_filter = _resolve_audio_pad_filter(video_duration, subtitle_mode)
    chains.append(_format_audio_master_tail(mix_labels, effective_mix, pad_filter))
    return ";".join(chains)


def _validate_clip_record(clip: DubClip) -> DubClip:
    """Validate timestamps and WAV file existence for a single `DubClip`."""
    if not _is_finite_timestamp(clip.start_seconds) or not _is_finite_timestamp(clip.end_seconds):
        raise MediaProcessingError("Dubbed clip timestamps must be finite numbers.")
    if clip.start_seconds < 0 or clip.end_seconds < clip.start_seconds:
        raise MediaProcessingError("Dubbed clip timestamps must satisfy 0 <= start <= end.")
    if not clip.wav_path.is_file():
        raise MediaProcessingError(f"Dubbed clip file not found: {clip.wav_path.name}")
    return clip


def _validate_dub_inputs(
    source_video: Path,
    clips: Sequence[DubClip],
    original_audio_mode: str,
    ffprobe_bin: str | None,
) -> list[DubClip]:
    """Validate dubbing mode, source video stream, and clip files/timestamps before launching FFmpeg."""
    canonical_mode = canonicalize_dub_audio_mode(original_audio_mode)
    if not source_video.is_file():
        raise MediaProcessingError("Source video file not found for dubbing.")
    if not has_video_stream(source_video, ffprobe_bin):
        raise MediaProcessingError("Cannot dub audio onto an audio-only file. Upload a video file instead.")
    if canonical_mode == "original":
        if clips:
            raise MediaProcessingError("Dubbed audio clips are not permitted when original_audio_mode is 'original'.")
        if not has_audio_stream(source_video, ffprobe_bin):
            raise MediaProcessingError("Source video has no original audio track for 'original' audio mode.")
        return []
    if not clips:
        raise MediaProcessingError("At least one dubbed audio clip is required.")
    return sorted((_validate_clip_record(clip) for clip in clips), key=lambda c: (c.start_seconds, c.end_seconds))


def _build_subtitle_language_args(subtitle_language: str) -> list[str]:
    """Build FFmpeg `-metadata:s:s:0` arguments when `subtitle_language` resolves to a known code."""
    iso_code = resolve_iso639_2_code(subtitle_language)
    if iso_code == UNDETERMINED_ISO639_2:
        return []
    return ["-metadata:s:s:0", f"language={iso_code}"]


def probe_video_stream_profile(video_path: Path, ffprobe_bin: str | None = None) -> tuple[str, str, int, int]:
    """Probe `(codec_name, pix_fmt, width, height)` for the first video stream, returning empty defaults on failure."""
    binary = ffprobe_bin or resolve_ffprobe_bin()
    cmd = [binary, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,width,height", "-of", "json", str(video_path)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        stream = (json.loads(proc.stdout).get("streams") or [{}])[0] if proc.returncode == 0 else {}
        codec = str(stream.get("codec_name") or "").lower()
        pix = str(stream.get("pix_fmt") or "").lower()
        return (codec, pix, int(stream.get("width") or 0), int(stream.get("height") or 0))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return ("", "", 0, 0)


def _resolve_dub_video_args(source_video: Path, ffprobe_bin: str | None) -> list[str]:
    """Choose `-c:v copy` (with `hvc1` tag for HEVC) when MP4-compatible or H.264 `yuv420p` transcoding."""
    codec, pix_fmt, width, height = probe_video_stream_profile(source_video, ffprobe_bin)
    if not codec:
        return ["-map", "0:v:0", "-c:v", "copy"]
    even_dims = width > 0 and height > 0 and (width % 2 == 0) and (height % 2 == 0)
    if codec in MP4_SAFE_VIDEO_CODECS and pix_fmt in MP4_SAFE_PIX_FMTS and even_dims:
        tag_args = ["-tag:v", "hvc1"] if codec == "hevc" else []
        return ["-map", "0:v:0", "-c:v", "copy", *tag_args]
    return [
        "-map", "0:v:0",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
        "-c:v", "libx264", "-crf", "21", "-preset", "fast", "-pix_fmt", "yuv420p",
    ]


def _run_dub_ffmpeg(cmd: list[str], output_mp4: Path, cwd: Path | None = None) -> None:
    """Execute FFmpeg dub muxing subprocess and translate failures into `MediaProcessingError`."""
    try:
        run_kwargs = {"cwd": str(cwd)} if cwd is not None else {}
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_SECONDS, **run_kwargs)
    except subprocess.TimeoutExpired as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        detail = _extract_ffmpeg_error(stderr, f"FFmpeg timed out after {FFMPEG_TIMEOUT_SECONDS} seconds")
        raise MediaProcessingError(f"Could not export dubbed video: {detail}") from exc
    except OSError as exc:
        raise MediaProcessingError(f"Could not export dubbed video: {exc.strerror or 'FFmpeg could not be started'}") from exc
    if proc.returncode != 0 or not _has_non_empty_file(output_mp4):
        detail = _extract_ffmpeg_error(proc.stderr or "", "Dubbed MP4 export failed")
        raise MediaProcessingError(f"Could not export dubbed video: {detail}")


def _run_burned_dub_ffmpeg(
    base_cmd: list[str],
    audio_filter: str,
    tail_args: list[str],
    render_ctx: tuple[Path, Path, str],
) -> None:
    """Render burned ASS subtitles + mixed/dubbed audio, trying VideoToolbox before libx264 fallback."""
    ass_path, output_mp4, hw_bitrate = render_ctx
    safe_ass_name = _escape_ffmpeg_filter_value(ass_path.name)
    vf_chain = f"[0:v:0]scale=trunc(iw/2)*2:trunc(ih/2)*2,ass={safe_ass_name},setsar=1[vout]"
    full_fc = f"{vf_chain};{audio_filter}"
    common = ["-filter_complex", full_fc, "-map", "[vout]", "-map", "[aout]", "-sn"]
    hw_cmd = [*base_cmd, *common, "-c:v", "h264_videotoolbox", "-b:v", hw_bitrate, "-pix_fmt", "yuv420p", *tail_args]
    hw_proc = _run_burn_cmd(hw_cmd, ass_path.parent)
    if hw_proc.returncode == 0 and _has_non_empty_file(output_mp4):
        return
    sw_cmd = [*base_cmd, *common, "-c:v", "libx264", "-crf", "21", "-preset", "fast", "-pix_fmt", "yuv420p", *tail_args]
    sw_proc = _run_burn_cmd(sw_cmd, ass_path.parent)
    if sw_proc.returncode != 0 or not _has_non_empty_file(output_mp4):
        detail = _extract_ffmpeg_error(sw_proc.stderr or hw_proc.stderr or "", "Dubbed subtitle burn-in failed")
        raise MediaProcessingError(f"Could not export dubbed video: {detail}")


def _build_dub_input_and_tail_args(
    binary: str,
    source_video: Path,
    ordered: Sequence[DubClip],
    tail_ctx: tuple[Path, str, float, str],
) -> tuple[list[str], list[str]]:
    """Build FFmpeg `-i` input arguments and AAC MP4 output tail arguments."""
    output_mp4, audio_language, video_duration, sub_mode = tail_ctx
    base_cmd = [binary, "-y", "-i", str(source_video.resolve())]
    for clip in ordered:
        base_cmd.extend(["-i", str(clip.wav_path.resolve())])
    shortest_args = ["-shortest"] if (video_duration <= 0 and sub_mode != "soft") else []
    audio_tail = [
        "-c:a", "aac", "-b:a", DUB_AUDIO_BITRATE, *_build_audio_language_args(audio_language),
        "-movflags", "+faststart", *shortest_args, str(output_mp4.resolve()),
    ]
    return base_cmd, audio_tail


def _build_unburned_dub_cmd(
    base_cmd: list[str],
    filter_complex: str,
    video_args: list[str],
    sub_ctx: tuple[VideoSubtitleRenderSpec, int, list[str]],
) -> list[str]:
    """Assemble FFmpeg command for `none` (`-sn`) or `soft` (`mov_text`) subtitle modes."""
    sub_spec, clip_count, audio_tail = sub_ctx
    inputs = list(base_cmd)
    if sub_spec.mode == "soft" and sub_spec.srt_path is not None:
        sub_idx = 1 + clip_count
        inputs.extend(["-i", str(sub_spec.srt_path.resolve())])
        sub_args = ["-map", f"{sub_idx}:s:0", "-c:s", "mov_text", "-disposition:s:0", "default", *_build_subtitle_language_args(sub_spec.subtitle_language)]
    else:
        sub_args = ["-sn"]
    return [*inputs, "-filter_complex", filter_complex, *video_args, "-map", "[aout]", *sub_args, *audio_tail]


# Retains optional keyword parameters for R3-08/R3-09 compatibility with existing callers.
def mux_dubbed_audio(
    source_video: Path,
    clips: Sequence[DubClip],
    output_mp4: Path,
    original_audio_mode: str = "duck",
    ffmpeg_bin: str | None = None,
    ffprobe_bin: str | None = None,
    *,
    audio_language: str = "",
    mix_config: DubAudioMixConfig | None = None,
    subtitle_spec: VideoSubtitleRenderSpec | None = None,
) -> Path:
    """Mux original, replacement, or mixed/ducked audio and optional burned/soft subtitles onto `source_video`.

    Inputs: `source_video`, `clips` (`DubClip` sequence; empty when `original_audio_mode=='original'`),
    `output_mp4`, `original_audio_mode`, optional `audio_language`, `mix_config`, and `subtitle_spec`.
    Outputs: resolved `output_mp4` path on success.
    Side effects: invokes parameterized FFmpeg/FFprobe subprocesses and writes `output_mp4`.
    Failure modes: raises `MediaProcessingError` on invalid inputs, missing streams/libass, or FFmpeg errors.
    """
    binary = ffmpeg_bin or resolve_ffmpeg_bin()
    effective_mix = validate_dub_mix_config(mix_config or DubAudioMixConfig(mode=original_audio_mode))
    sub_spec = validate_subtitle_render_spec(subtitle_spec, binary)
    ordered = _validate_dub_inputs(source_video, clips, effective_mix.mode, ffprobe_bin)
    primary_audio_idx = probe_primary_audio_index(source_video, ffprobe_bin) if effective_mix.mode != "mute" else None
    include_original = primary_audio_idx is not None
    video_duration = probe_media_duration(source_video, ffprobe_bin)
    clip_durations = [_probe_wav_duration(clip.wav_path, ffprobe_bin) for clip in ordered]
    filter_complex = _build_dub_filter_complex(
        ordered, clip_durations, effective_mix.mode, include_original, video_duration,
        mix_config=effective_mix, subtitle_mode=sub_spec.mode, primary_audio_index=primary_audio_idx or 0,
    )
    base_cmd, audio_tail = _build_dub_input_and_tail_args(binary, source_video, ordered, (output_mp4, audio_language, video_duration, sub_spec.mode))
    if sub_spec.mode == "burned" and sub_spec.ass_path is not None:
        w, h = probe_video_dimensions(source_video, ffprobe_bin)
        hw_bitrate = "2500k" if (w * h) < 600_000 else "5000k"
        _run_burned_dub_ffmpeg(base_cmd, filter_complex, audio_tail, (sub_spec.ass_path, output_mp4, hw_bitrate))
        return output_mp4
    video_args = _resolve_dub_video_args(source_video, ffprobe_bin)
    cmd = _build_unburned_dub_cmd(base_cmd, filter_complex, video_args, (sub_spec, len(ordered), audio_tail))
    _run_dub_ffmpeg(cmd, output_mp4)
    return output_mp4
