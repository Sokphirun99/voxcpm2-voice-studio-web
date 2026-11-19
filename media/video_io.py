"""FFmpeg/FFprobe media extraction, rotation-aware dimension probing, speech denoising, and subtitle burn-in."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

FFMPEG_FULL_BIN = Path("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg")
FFPROBE_FULL_BIN = Path("/opt/homebrew/opt/ffmpeg-full/bin/ffprobe")
DEFAULT_VIDEO_SIZE = (1280, 720)
FILTER_ASS_PATTERN = re.compile(r"\bass\b")
FFMPEG_TIMEOUT_SECONDS = 600
AUDIO_ONLY_EXTS = frozenset({".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"})
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
