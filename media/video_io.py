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

logger = logging.getLogger(__name__)

FFMPEG_FULL_BIN = Path("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg")
FFPROBE_FULL_BIN = Path("/opt/homebrew/opt/ffmpeg-full/bin/ffprobe")
DEFAULT_VIDEO_SIZE = (1280, 720)
FILTER_ASS_PATTERN = re.compile(r"\bass\b")
FFMPEG_TIMEOUT_SECONDS = 600
AUDIO_ONLY_EXTS = frozenset({".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"})
DUB_AUDIO_MODES = frozenset({"duck", "mute", "keep"})
DUB_DUCK_VOLUME = 0.15
DUB_KEEP_VOLUME = 1.0
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


def extract_audio_16k_wav(video_path: Path, wav_path: Path, ffmpeg_bin: str | None = None) -> None:
    """Extract clean mono 16 kHz PCM audio track from a video file for ASR and diarization."""
    binary = ffmpeg_bin or resolve_ffmpeg_bin()
    plain_cmd = [binary, "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path)]
    proc = subprocess.run(plain_cmd, capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_SECONDS)
    if proc.returncode != 0 or not wav_path.is_file():
        detail = _extract_ffmpeg_error(proc.stderr or "", "Audio extraction failed")
        raise MediaProcessingError(f"Could not extract audio track from video: {detail}")


def _run_burn_cmd(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run an FFmpeg burn-in command cleanly inside the job directory."""
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_SECONDS)


def burn_ass_subtitles(
    video_path: Path,
    ass_path: Path,
    output_mp4_path: Path,
    ffmpeg_bin: str | None = None,
) -> None:
    """Burn styled multi-speaker ASS subtitles into MP4 preserving Portrait or Landscape aspect ratio."""
    binary = ffmpeg_bin or resolve_ffmpeg_bin()
    if not check_burnin_support(binary):
        raise MediaProcessingError("Installed FFmpeg does not support libass subtitle burn-in. Install ffmpeg-full.")
    if video_path.is_file() and not has_video_stream(video_path):
        raise MediaProcessingError("Cannot burn subtitles onto an audio-only file. Upload a video file instead.")
    w, h = probe_video_dimensions(video_path)
    hw_bitrate = "2500k" if (w * h) < 600_000 else "5000k"
    vf_arg = f"scale=trunc(iw/2)*2:trunc(ih/2)*2,ass={ass_path.name},setsar=1"
    hw_cmd = [
        binary, "-y", "-i", str(video_path.resolve()), "-vf", vf_arg,
        "-c:v", "h264_videotoolbox", "-b:v", hw_bitrate, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", str(output_mp4_path.resolve()),
    ]
    proc = _run_burn_cmd(hw_cmd, ass_path.parent)
    if proc.returncode == 0 and output_mp4_path.is_file():
        return
    sw_cmd = [
        binary, "-y", "-i", str(video_path.resolve()), "-vf", vf_arg,
        "-c:v", "libx264", "-crf", "21", "-preset", "fast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", str(output_mp4_path.resolve()),
    ]
    sw_proc = _run_burn_cmd(sw_cmd, ass_path.parent)
    if sw_proc.returncode != 0 or not output_mp4_path.is_file():
        detail = _extract_ffmpeg_error(sw_proc.stderr or proc.stderr or "", "Subtitle burn-in failed")
        raise MediaProcessingError(f"Could not render subtitles onto video: {detail}")


def has_audio_stream(media_path: Path, ffprobe_bin: str | None = None) -> bool:
    """Return True if `media_path` contains at least one audio stream."""
    binary = ffprobe_bin or resolve_ffprobe_bin()
    cmd = [binary, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "json", str(media_path)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except OSError:
        return False
    if proc.returncode != 0:
        return False
    try:
        return len(json.loads(proc.stdout).get("streams") or []) > 0
    except json.JSONDecodeError:
        return False


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
    except (wave.Error, OSError, EOFError):
        pass
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


def _build_dub_clip_filter(input_idx: int, clip_idx: int, start_ms: int, atempo: float | None) -> str:
    """Build one stereo-safe FFmpeg filter chain for a time-aligned dubbed WAV clip."""
    parts = [f"aformat=sample_rates={DUB_SAMPLE_RATE}:channel_layouts=stereo"]
    if atempo is not None:
        parts.append(f"atempo={atempo:.4f}")
    if start_ms > 0:
        parts.append(f"adelay={start_ms}|{start_ms}:all=1")
    return f"[{input_idx}:a]{','.join(parts)}[dub{clip_idx}]"


def _build_dub_filter_complex(
    ordered: Sequence[DubClip],
    clip_durations: Sequence[float],
    original_audio_mode: str,
    include_original: bool,
    video_duration: float,
) -> str:
    """Construct the complete FFmpeg filter_complex graph for time-aligned audio dubbing."""
    chains: list[str] = []
    mix_labels: list[str] = []
    if include_original:
        volume = DUB_DUCK_VOLUME if original_audio_mode == "duck" else DUB_KEEP_VOLUME
        chains.append(f"[0:a]aformat=sample_rates={DUB_SAMPLE_RATE}:channel_layouts=stereo,volume={volume}[orig]")
        mix_labels.append("[orig]")
    for idx, clip in enumerate(ordered):
        start_ms = max(0, int(round(clip.start_seconds * 1000)))
        slot_seconds = _resolve_clip_slot_seconds(ordered, idx)
        atempo = None if clip.allow_overflow else _compute_clip_atempo(clip_durations[idx], slot_seconds)
        chains.append(_build_dub_clip_filter(idx + 1, idx, start_ms, atempo))
        mix_labels.append(f"[dub{idx}]")
    pad_filter = f"apad=whole_dur={video_duration:.3f}" if video_duration > 0 else "apad"
    if len(mix_labels) == 1:
        chains.append(f"{mix_labels[0]}{pad_filter}[aout]")
    else:
        joined = "".join(mix_labels)
        chains.append(f"{joined}amix=inputs={len(mix_labels)}:duration=longest:dropout_transition=0:normalize=0,{pad_filter}[aout]")
    return ";".join(chains)


def _validate_dub_inputs(
    source_video: Path,
    clips: Sequence[DubClip],
    original_audio_mode: str,
    ffprobe_bin: str | None,
) -> list[DubClip]:
    """Validate dubbing mode, source video stream, and clip files/timestamps before launching FFmpeg."""
    if original_audio_mode not in DUB_AUDIO_MODES:
        raise MediaProcessingError(f"Unsupported original_audio_mode '{original_audio_mode}'. Use duck, mute, or keep.")
    if not clips:
        raise MediaProcessingError("At least one dubbed audio clip is required.")
    if not source_video.is_file():
        raise MediaProcessingError("Source video file not found for dubbing.")
    if not has_video_stream(source_video, ffprobe_bin):
        raise MediaProcessingError("Cannot dub audio onto an audio-only file. Upload a video file instead.")
    validated: list[DubClip] = []
    for clip in clips:
        if not _is_finite_timestamp(clip.start_seconds) or not _is_finite_timestamp(clip.end_seconds):
            raise MediaProcessingError("Dubbed clip timestamps must be finite numbers.")
        if clip.start_seconds < 0 or clip.end_seconds < clip.start_seconds:
            raise MediaProcessingError("Dubbed clip timestamps must satisfy 0 <= start <= end.")
        if not clip.wav_path.is_file():
            raise MediaProcessingError(f"Dubbed clip file not found: {clip.wav_path.name}")
        validated.append(clip)
    return sorted(validated, key=lambda c: (c.start_seconds, c.end_seconds))


def mux_dubbed_audio(
    source_video: Path,
    clips: Sequence[DubClip],
    output_mp4: Path,
    original_audio_mode: str = "duck",
    ffmpeg_bin: str | None = None,
    ffprobe_bin: str | None = None,
) -> Path:
    """Mux time-aligned WAV clips onto `source_video` with stream-copied video and mixed AAC audio.

    Inputs: `source_video`, non-empty `clips` (`DubClip` sequence), destination `output_mp4`,
    and `original_audio_mode` in `("duck", "mute", "keep")`.
    Outputs: resolved `output_mp4` path on success.
    Side effects: invokes parameterized FFmpeg/FFprobe subprocesses and writes `output_mp4`.
    Failure modes: raises `MediaProcessingError` on invalid inputs or FFmpeg errors.
    """
    binary = ffmpeg_bin or resolve_ffmpeg_bin()
    ordered = _validate_dub_inputs(source_video, clips, original_audio_mode, ffprobe_bin)
    include_original = original_audio_mode != "mute" and has_audio_stream(source_video, ffprobe_bin)
    video_duration = probe_media_duration(source_video, ffprobe_bin)
    clip_durations = [_probe_wav_duration(clip.wav_path, ffprobe_bin) for clip in ordered]
    filter_complex = _build_dub_filter_complex(ordered, clip_durations, original_audio_mode, include_original, video_duration)
    cmd = [binary, "-y", "-i", str(source_video.resolve())]
    for clip in ordered:
        cmd.extend(["-i", str(clip.wav_path.resolve())])
    cmd.extend([
        "-filter_complex", filter_complex,
        "-map", "0:v:0",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", DUB_AUDIO_BITRATE,
        "-movflags", "+faststart",
        "-shortest",
        str(output_mp4.resolve()),
    ])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        detail = _extract_ffmpeg_error(stderr, f"FFmpeg timed out after {FFMPEG_TIMEOUT_SECONDS} seconds")
        raise MediaProcessingError(f"Could not export dubbed video: {detail}") from exc
    except OSError as exc:
        detail = exc.strerror or "FFmpeg could not be started"
        raise MediaProcessingError(f"Could not export dubbed video: {detail}") from exc
    if proc.returncode != 0 or not output_mp4.is_file():
        detail = _extract_ffmpeg_error(proc.stderr or "", "Dubbed MP4 export failed")
        raise MediaProcessingError(f"Could not export dubbed video: {detail}")
    return output_mp4
