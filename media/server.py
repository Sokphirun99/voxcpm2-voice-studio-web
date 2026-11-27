"""FastAPI HTTP service for offline video transcription, speaker diarization, Khmer translation, and ASS subtitle burn-in."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import math
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Sequence

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field, ValidationError

from asr import DEFAULT_KHMER_WHISPER_REPO, DEFAULT_WHISPER_REPO, LocalTranscriber
from diarizer import LocalDiarizer, are_diarization_models_ready
from jobs import InvalidMediaInputError, JobNotFoundError, MediaJobPaths, MediaJobStore
from khmer_dictionary import get_lexicon_stats
from khmer_verifier import (
    DEFAULT_KHMER_VERIFIER_REPO,
    MAX_VERIFY_TEXT_CHARS,
    compare_khmer_speech_texts,
)
from languages import (
    UNSUPPORTED_WHISPER_TRANSLATION_CODES,
    UnsupportedLanguageError,
    is_same_translation_language,
    resolve_nllb_lang_code,
)
from model_cache import inspect_model_readiness
from subtitles import (
    SPEAKER_ASS_COLORS,
    SubtitleSegment,
    align_even_dimensions,
    align_segments_with_speakers,
    build_ass,
    build_srt,
)
from terminology import (
    apply_spelling_to_segments,
    parse_terminology_form_field,
    translate_segments_with_terminology,
)
from translator import DEFAULT_NLLB_MODEL_ID, LocalTranslator
from video_io import (
    DEFAULT_DUB_VOLUME,
    DEFAULT_ORIGINAL_VOLUME,
    DUB_AUDIO_MODES,
    DUB_DUCK_VOLUME,
    MAX_DUB_VOLUME,
    MAX_DUCK_VOLUME,
    MAX_ORIGINAL_VOLUME,
    MIN_DUB_VOLUME,
    MIN_DUCK_VOLUME,
    MIN_ORIGINAL_VOLUME,
    VIDEO_SUBTITLE_MODES,
    DubAudioMixConfig,
    DubClip,
    MediaProcessingError,
    VideoSubtitleRenderSpec,
    burn_ass_subtitles,
    canonicalize_dub_audio_mode,
    check_burnin_support,
    extract_audio_16k_wav,
    has_audio_stream,
    has_video_stream,
    mux_dubbed_audio,
    probe_media_duration,
    probe_video_dimensions,
    probe_wav_duration,
)

SERVICE_NAME = "voxcpm-media-studio"
DEFAULT_PORT = 8810
DEFAULT_JOB_DIR = Path(os.environ.get("MEDIA_JOB_DIR", "/tmp/voxcpm-media-jobs"))
MAX_UPLOAD_BYTES = int(os.environ.get("MEDIA_MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))
MAX_DUB_CLIPS = 120
MAX_DUB_CLIP_BYTES = 25 * 1024 * 1024
MAX_DUB_TOTAL_BYTES = 200 * 1024 * 1024
MAX_DUB_METADATA_CHARS = 64 * 1024
MAX_DUB_SUBTITLES_CHARS = 512 * 1024
DUB_TIMESTAMP_TOLERANCE_SECONDS = 0.05
MIN_WAV_BYTES = 44
UPLOAD_CHUNK_BYTES = 1024 * 1024

logger = logging.getLogger(SERVICE_NAME)


def _log_json(level: int, request_id: str, message: str, extra: dict[str, Any] | None = None) -> None:
    """Emit a single structured JSON log record with timestamp, severity, and request ID."""
    payload = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "severity": logging.getLevelName(level),
        "service": SERVICE_NAME,
        "requestId": request_id,
        "message": message,
    }
    if extra:
        payload.update(extra)
    logger.log(level, json.dumps(payload, ensure_ascii=False))


class SegmentPayload(BaseModel):
    """Serialized subtitle cue exchanged between frontend and backend."""

    id: str = "seg-1"
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)
    speakerId: str = "speaker-1"
    text: str = ""
    translatedText: str = ""


class TranslateRequest(BaseModel):
    """Request payload for batch subtitle translation."""

    segments: list[SegmentPayload] = Field(default_factory=list)
    sourceLanguage: str = "en"
    targetLanguage: str = "km"
    terminology: list[dict[str, Any]] = Field(default_factory=list)


class VideoSizePayload(BaseModel):
    """Video pixel dimensions for accurate subtitle scaling."""

    width: int = Field(default=1280, ge=160)
    height: int = Field(default=720, ge=160)


class SubtitleStylePayload(BaseModel):
    """ASS rendering style preferences for burned-in subtitles."""

    position: Literal["bottom", "middle", "top"] = "bottom"
    fontScale: Literal["small", "medium", "large"] = "medium"
    backgroundStyle: Literal["box", "outline", "clean"] = "box"


class BurnRequest(BaseModel):
    """Request payload for rendering ASS subtitles permanently onto video."""

    jobId: str
    segments: list[SegmentPayload] = Field(default_factory=list)
    speakerNames: dict[str, str] = Field(default_factory=dict)
    includeSpeaker: bool = False
    useTranslation: bool = False
    bilingual: bool = False
    subtitleStyle: SubtitleStylePayload | None = None
    videoSize: VideoSizePayload | None = None
    audioLanguage: str = ""


class DubSubtitlesPayload(BaseModel):
    """Optional subtitle rendering payload submitted alongside `POST /dub` when `subtitleMode != 'none'`."""

    segments: list[SegmentPayload] = Field(default_factory=list)
    speakerNames: dict[str, str] = Field(default_factory=dict)
    includeSpeaker: bool = False
    useTranslation: bool = False
    bilingual: bool = False
    subtitleStyle: SubtitleStylePayload | None = None
    videoSize: VideoSizePayload | None = None
    subtitleLanguage: str = ""


@dataclass(frozen=True)
class DubFormOptions:
    """Validated multipart form fields for `POST /dub`."""

    job_id: str
    raw_metadata: str
    mode: str
    audio_language: str
    mix_config: DubAudioMixConfig
    has_custom_mix: bool
    subtitle_mode: str
    raw_subtitles: str


def _parse_optional_gain(raw_value: str, field_name: str, default_val: float, bounds: tuple[float, float]) -> tuple[float, bool]:
    """Parse an optional multipart numeric gain field within `bounds`, returning `(value, was_provided)`."""
    cleaned = (raw_value or "").strip()
    if not cleaned:
        return default_val, False
    try:
        numeric = float(cleaned)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} must be a valid number.") from exc
    low, high = bounds
    if not math.isfinite(numeric) or numeric < low - 1e-6 or numeric > high + 1e-6:
        raise HTTPException(status_code=400, detail=f"{field_name} must be between {low:g} and {high:g}.")
    return round(numeric, 4), True


# FastAPI form parser requires one parameter per multipart form field.
def _parse_dub_form_options(
    jobId: str = Form(...),
    metadata: str = Form("[]"),
    originalAudioMode: str = Form("duck"),
    audioLanguage: str = Form(""),
    originalVolume: str = Form(""),
    dubVolume: str = Form(""),
    duckVolume: str = Form(""),
    subtitleMode: str = Form("none"),
    subtitles: str = Form(""),
) -> DubFormOptions:
    """Parse and validate multipart form options for `POST /dub`."""
    raw_mode = str(originalAudioMode or "").strip().lower()
    if raw_mode not in DUB_AUDIO_MODES:
        raise HTTPException(status_code=400, detail="originalAudioMode must be 'original', 'replace', 'mute', 'duck', 'keep', or 'mix'.")
    canonical_mode = canonicalize_dub_audio_mode(raw_mode)
    clean_sub_mode = str(subtitleMode or "").strip().lower()
    if clean_sub_mode not in VIDEO_SUBTITLE_MODES:
        raise HTTPException(status_code=400, detail="subtitleMode must be 'none', 'burned', or 'soft'.")
    if clean_sub_mode == "none" and (subtitles or "").strip():
        raise HTTPException(status_code=400, detail="Subtitle payload is not allowed when subtitleMode is 'none'.")
    orig_vol, has_orig = _parse_optional_gain(originalVolume, "originalVolume", DEFAULT_ORIGINAL_VOLUME, (MIN_ORIGINAL_VOLUME, MAX_ORIGINAL_VOLUME))
    dub_vol, has_dub = _parse_optional_gain(dubVolume, "dubVolume", DEFAULT_DUB_VOLUME, (MIN_DUB_VOLUME, MAX_DUB_VOLUME))
    duck_vol, has_duck = _parse_optional_gain(duckVolume, "duckVolume", DUB_DUCK_VOLUME, (MIN_DUCK_VOLUME, MAX_DUCK_VOLUME))
    mix = DubAudioMixConfig(mode=canonical_mode, original_volume=orig_vol, dub_volume=dub_vol, duck_volume=duck_vol)
    return DubFormOptions(
        job_id=jobId,
        raw_metadata=metadata,
        mode=canonical_mode,
        audio_language=str(audioLanguage or "").strip(),
        mix_config=mix,
        has_custom_mix=has_orig or has_dub or has_duck,
        subtitle_mode=clean_sub_mode,
        raw_subtitles=subtitles or "",
    )


@dataclass(frozen=True)
class TranscribeFormOptions:
    """Validated multipart form options for /transcribe."""

    language: str
    num_speakers: int
    diarize: bool
    translate_to: str
    double_check: bool = False
    terminology: list[dict[str, Any]] = field(default_factory=list)


def _parse_transcribe_options(
    language: str = Form("auto"),
    num_speakers: int = Form(0),
    diarize: bool = Form(True),
    translate_to: str = Form(""),
    double_check: bool = Form(False),
    terminology: str = Form(""),
) -> TranscribeFormOptions:
    """Parse multipart form fields into an immutable option object."""
    try:
        parsed_terminology = parse_terminology_form_field(terminology)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return TranscribeFormOptions(
        language=(language or "auto").strip(),
        num_speakers=max(0, min(12, int(num_speakers))),
        diarize=bool(diarize),
        translate_to=(translate_to or "").strip(),
        double_check=bool(double_check),
        terminology=parsed_terminology,
    )


@dataclass(frozen=True)
class MediaServices:
    """Injected domain adapters for the FastAPI media application."""

    job_store: MediaJobStore
    transcriber: Any
    diarizer: Any
    translator: Any


def build_default_services(job_dir: Path = DEFAULT_JOB_DIR) -> MediaServices:
    """Create production media services backed by local MLX, sherpa-onnx, and NLLB models."""
    return MediaServices(
        job_store=MediaJobStore(job_dir),
        transcriber=LocalTranscriber(),
        diarizer=LocalDiarizer(),
        translator=LocalTranslator(),
    )


async def _save_bounded_upload(
    upload: UploadFile,
    dest: Path,
    max_bytes: int = MAX_UPLOAD_BYTES,
    upload_label: str = "Video",
) -> int:
    """Stream multipart upload safely to disk while enforcing a strict maximum byte limit."""
    written = 0
    try:
        with open(dest, "wb") as handle:
            while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(status_code=413, detail=f"{upload_label} exceeds max upload limit ({max_bytes // (1024 * 1024)} MB).")
                handle.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    if written == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Uploaded media file is empty.")
    return written


def _serialize_segments(segments: list[SubtitleSegment], translations: list[str] | None = None) -> tuple[list[dict], list[str]]:
    """Serialize aligned SubtitleSegment records and ordered speaker IDs for JSON response."""
    speakers: list[str] = []
    items: list[dict] = []
    for idx, seg in enumerate(segments, start=1):
        if seg.speaker_id not in speakers:
            speakers.append(seg.speaker_id)
        tr_text = translations[idx - 1] if translations and idx - 1 < len(translations) else seg.translated_text
        items.append({
            "id": f"seg-{idx}",
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "speakerId": seg.speaker_id,
            "text": seg.text,
            "translatedText": tr_text,
            "altText": seg.alt_text,
            "verifyReason": seg.verify_reason,
        })
    return items, speakers


def _build_ass_color_map(speakers: list[str]) -> dict[str, str]:
    """Expose deterministic ASS speaker palette mapping for UI inspection."""
    return {spk: SPEAKER_ASS_COLORS[idx % len(SPEAKER_ASS_COLORS)] for idx, spk in enumerate(speakers)}


def _to_domain_segments(payloads: list[SegmentPayload]) -> list[SubtitleSegment]:
    """Validate and convert JSON segment payloads into SubtitleSegment dataclasses."""
    converted: list[SubtitleSegment] = []
    for idx, item in enumerate(payloads):
        text = item.text.strip()
        tr_text = item.translatedText.strip()
        if not (text or tr_text):
            continue
        start, end = float(item.start), float(item.end)
        if not (_is_valid_finite_number(start) and _is_valid_finite_number(end)) or start < 0.0 or end <= start:
            raise HTTPException(status_code=400, detail=f"Subtitle segment #{idx + 1} must satisfy 0 <= start < end.")
        converted.append(
            SubtitleSegment(
                start=start,
                end=end,
                text=text,
                speaker_id=(item.speakerId or "speaker-1").strip() or "speaker-1",
                translated_text=tr_text,
            )
        )
    return converted


def _run_diarization_safe(services: MediaServices, wav_path: Path, num_speakers: int, request_id: str) -> list:
    """Run offline speaker diarization and degrade safely to empty turns if diarizer fails."""
    try:
        return services.diarizer.diarize(wav_path, num_speakers=num_speakers)
    except Exception as exc:
        _log_json(logging.WARNING, request_id, "Speaker diarization skipped cleanly", {"error": str(exc)})
        return []


def _create_job_safe(job_store: MediaJobStore, filename: str | None) -> MediaJobPaths:
    """Allocate a job directory or map validation failure into HTTP 400."""
    try:
        return job_store.create_job(filename)
    except InvalidMediaInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _resolve_job_safe(job_store: MediaJobStore, job_id: str) -> MediaJobPaths:
    """Look up an active job directory or map invalid/missing IDs into HTTP 400/404."""
    try:
        return job_store.get_job(job_id)
    except InvalidMediaInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _maybe_translate_aligned(
    services: MediaServices,
    aligned: list[SubtitleSegment],
    detected_lang: str,
    translate_to: str,
    terminology: Sequence[dict[str, Any]] | None = None,
) -> list[str] | None:
    """Translate extracted segment texts when `translate_to` target language differs from `detected_lang`."""
    target = (translate_to or "").strip()
    if not target or not aligned:
        return None
    resolve_nllb_lang_code(target, strict=True)
    if (detected_lang or "").strip().lower() in UNSUPPORTED_WHISPER_TRANSLATION_CODES:
        return None
    if is_same_translation_language(detected_lang, target):
        return None
    return translate_segments_with_terminology(
        services.translator,
        aligned,
        detected_lang,
        target,
        terminology,
    )


def _transcriber_call_kwargs(method: Any, language: str, turns: list, double_check: bool) -> dict[str, Any]:
    """Build transcriber kwargs from its declared signature without catching inference errors."""
    try:
        parameters = inspect.signature(method).parameters
    except (TypeError, ValueError):
        parameters = {}
        accepts_arbitrary_keywords = True
    else:
        accepts_arbitrary_keywords = any(
            parameter.kind is inspect.Parameter.VAR_KEYWORD
            for parameter in parameters.values()
        )
    kwargs: dict[str, Any] = {"language": language}
    for name, value in (("turns", turns), ("double_check", double_check)):
        parameter = parameters.get(name)
        if accepts_arbitrary_keywords or (
            parameter is not None
            and parameter.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
        ):
            kwargs[name] = value
    return kwargs


def _run_transcriber(
    transcriber: Any,
    wav_path: Path,
    language: str,
    turns: list,
    double_check: bool = False,
) -> dict:
    """Invoke transcriber once, passing only supported optional keyword arguments."""
    method = transcriber.transcribe
    kwargs = _transcriber_call_kwargs(method, language, turns, double_check)
    return method(wav_path, **kwargs)


def _run_audio_verifier(transcriber: Any, wav_path: Path, language: str) -> tuple[str, str]:
    """Decode generated speech via `verify_audio` (Whisper Khmer verifier) or fallback `transcribe`."""
    if hasattr(transcriber, "verify_audio"):
        return transcriber.verify_audio(wav_path, language=language)
    res = _run_transcriber(transcriber, wav_path, language, [])
    heard = " ".join(str(s.get("text") or "").strip() for s in (res.get("segments") or []) if str(s.get("text") or "").strip())
    return heard, DEFAULT_KHMER_VERIFIER_REPO if language == "km" else DEFAULT_WHISPER_REPO


def _execute_verify_speech_pipeline(
    services: MediaServices,
    job: MediaJobPaths,
    expected_text: str,
    language: str,
) -> dict[str, Any]:
    """Extract 16 kHz mono WAV, run Whisper verification ASR, and score similarity against `expected_text`."""
    extract_audio_16k_wav(job.source_video, job.audio_wav)
    heard_text, used_model = _run_audio_verifier(services.transcriber, job.audio_wav, language)
    score = compare_khmer_speech_texts(expected_text, heard_text)
    return {
        "verdict": score.verdict,
        "similarity": score.similarity,
        "cer": score.cer,
        "expectedText": expected_text,
        "heardText": heard_text,
        "model": used_model,
        "language": language,
        "missingTerms": list(score.missing_terms),
    }


def _build_silent_video_transcribe_result(job: MediaJobPaths, opts: TranscribeFormOptions) -> dict[str, Any]:
    """Return a clean 0-segment job descriptor for silent videos (`hasAudioStream=False`) so burn-in and replacement dubbing work."""
    duration = probe_media_duration(job.source_video)
    width, height = probe_video_dimensions(job.source_video)
    lang = opts.language if (opts.language and opts.language != "auto") else "en"
    return {
        "jobId": job.job_id,
        "duration": round(duration, 3) if duration > 0 else 0.0,
        "language": lang,
        "translatedLanguage": "",
        "speakers": [],
        "segments": [],
        "isAudioOnly": False,
        "hasAudioStream": False,
        "videoSize": {"width": width, "height": height},
        "assColorMap": {},
        "verificationSummary": {"checked": 0, "fallbackApplied": 0, "suggestions": 0, "model": ""},
    }


def _execute_transcribe_pipeline(
    services: MediaServices,
    job: MediaJobPaths,
    opts: TranscribeFormOptions,
    request_id: str,
) -> dict[str, Any]:
    """Run FFmpeg extraction, speaker diarization, Whisper ASR, and optional translation."""
    has_video = has_video_stream(job.source_video)
    has_audio = has_audio_stream(job.source_video)
    if has_video and not has_audio:
        return _build_silent_video_transcribe_result(job, opts)
    extract_audio_16k_wav(job.source_video, job.audio_wav)
    duration = probe_wav_duration(job.audio_wav) or probe_media_duration(job.source_video)
    width, height = probe_video_dimensions(job.source_video) if has_video else (0, 0)
    turns = _run_diarization_safe(services, job.audio_wav, opts.num_speakers, request_id) if opts.diarize else []
    transcript = _run_transcriber(services.transcriber, job.audio_wav, opts.language, turns, opts.double_check)
    detected_lang = str(transcript.get("language") or opts.language or "en")
    aligned = align_segments_with_speakers(transcript.get("segments") or [], turns)
    if opts.terminology:
        aligned = apply_spelling_to_segments(aligned, opts.terminology, detected_lang)
    translations = _maybe_translate_aligned(services, aligned, detected_lang, opts.translate_to, opts.terminology)
    serialized, speakers = _serialize_segments(aligned, translations)
    summary = transcript.get("verificationSummary") or {"checked": 0, "fallbackApplied": 0, "suggestions": 0, "model": ""}
    return {
        "jobId": job.job_id,
        "duration": round(duration, 3) if duration > 0 else 0.0,
        "language": detected_lang,
        "translatedLanguage": opts.translate_to if translations is not None else "",
        "speakers": speakers,
        "segments": serialized,
        "isAudioOnly": not has_video,
        "hasAudioStream": has_audio,
        "videoSize": {"width": width, "height": height} if has_video else None,
        "assColorMap": _build_ass_color_map(speakers),
        "verificationSummary": summary,
    }


def _resolve_video_dimensions(req: BurnRequest | DubSubtitlesPayload, source_video: Path) -> tuple[int, int]:
    """Resolve even-aligned pixel resolution for ASS styling from request payload or FFprobe."""
    raw_w, raw_h = (req.videoSize.width, req.videoSize.height) if req.videoSize is not None else probe_video_dimensions(source_video)
    return align_even_dimensions(raw_w, raw_h, min_size=160)


def _is_valid_finite_number(value: Any) -> bool:
    """Return True when `value` is a finite int or float (excluding booleans)."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _parse_dub_metadata_entry(entry: Any, idx: int, file_count: int) -> dict[str, Any]:
    """Validate a single dubbing metadata item `{segmentId, start, end, fileIndex}`."""
    if not isinstance(entry, dict):
        raise HTTPException(status_code=400, detail=f"Dub metadata entry #{idx + 1} must be an object.")
    raw_start, raw_end, raw_index = entry.get("start"), entry.get("end"), entry.get("fileIndex")
    if not _is_valid_finite_number(raw_start) or not _is_valid_finite_number(raw_end):
        raise HTTPException(status_code=400, detail=f"Dub metadata entry #{idx + 1} has invalid start/end timestamps.")
    start, end = float(raw_start), float(raw_end)
    if start < 0.0 or end < start:
        raise HTTPException(status_code=400, detail=f"Dub metadata entry #{idx + 1} must satisfy 0 <= start <= end.")
    if not isinstance(raw_index, int) or isinstance(raw_index, bool) or raw_index < 0 or raw_index >= file_count:
        raise HTTPException(status_code=400, detail=f"Dub metadata entry #{idx + 1} has an out-of-range fileIndex.")
    seg_id = str(entry.get("segmentId") or f"seg-{idx + 1}").strip()[:64] or f"seg-{idx + 1}"
    raw_allow = entry.get("allowOverflow", False)
    if not isinstance(raw_allow, bool):
        raise HTTPException(status_code=400, detail=f"Dub metadata entry #{idx + 1} allowOverflow must be a boolean.")
    return {"segmentId": seg_id, "start": start, "end": end, "fileIndex": raw_index, "allowOverflow": raw_allow}


def _parse_dub_metadata(raw_metadata: str, file_count: int) -> list[dict[str, Any]]:
    """Parse and validate the JSON metadata array submitted to `POST /dub`."""
    if len(raw_metadata or "") > MAX_DUB_METADATA_CHARS:
        raise HTTPException(status_code=400, detail="Dub metadata exceeds the allowed size.")
    try:
        parsed = json.loads(raw_metadata or "")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Dub metadata must be valid JSON.") from exc
    if not isinstance(parsed, list) or not parsed:
        raise HTTPException(status_code=400, detail="Dub metadata must be a non-empty JSON array.")
    if len(parsed) > MAX_DUB_CLIPS:
        raise HTTPException(status_code=400, detail=f"Dub metadata exceeds maximum of {MAX_DUB_CLIPS} clips.")
    return [_parse_dub_metadata_entry(item, idx, file_count) for idx, item in enumerate(parsed)]


def _has_wav_magic_bytes(header: bytes) -> bool:
    """Verify standard RIFF/WAVE magic header bytes."""
    return len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE"


async def _save_validated_dub_wavs(files: list[UploadFile], work_dir: Path) -> list[Path]:
    """Stream uploaded WAV clips to `work_dir`, enforcing per-clip/total limits and RIFF/WAVE headers."""
    saved: list[Path] = []
    total_bytes = 0
    for idx, upload in enumerate(files):
        dest = work_dir / f"clip-{idx:03d}.wav"
        remaining_total = MAX_DUB_TOTAL_BYTES - total_bytes
        if remaining_total <= 0:
            raise HTTPException(status_code=413, detail=f"Combined dub clips exceed limit ({MAX_DUB_TOTAL_BYTES // (1024 * 1024)} MB).")
        written = await _save_bounded_upload(
            upload,
            dest,
            max_bytes=min(MAX_DUB_CLIP_BYTES, remaining_total),
            upload_label="Dubbed audio clip",
        )
        total_bytes += written
        with open(dest, "rb") as handle:
            header = handle.read(12)
        if written < MIN_WAV_BYTES or not _has_wav_magic_bytes(header):
            raise HTTPException(status_code=400, detail=f"Uploaded clip #{idx + 1} is not a valid WAV file.")
        saved.append(dest)
    return saved


def _validate_dub_overflow_bounds(clips: list[DubClip], source_duration: float) -> None:
    """Reject `allow_overflow` clips that extend past video end or collide with subsequent dubbed clips."""
    ordered = sorted(clips, key=lambda c: (c.start_seconds, c.end_seconds))
    for idx, clip in enumerate(ordered):
        if not clip.allow_overflow:
            continue
        speech_end = clip.start_seconds + probe_wav_duration(clip.wav_path)
        if source_duration > 0 and speech_end > source_duration + DUB_TIMESTAMP_TOLERANCE_SECONDS:
            raise HTTPException(status_code=400, detail=f"Approved overflow clip '{clip.segment_id}' exceeds source video duration.")
        if idx < len(ordered) - 1 and speech_end > ordered[idx + 1].start_seconds + DUB_TIMESTAMP_TOLERANCE_SECONDS:
            raise HTTPException(status_code=400, detail=f"Approved overflow clip '{clip.segment_id}' collides with the next dubbed clip.")


@dataclass(frozen=True)
class DubExecutionSpec:
    """Validated execution parameters forwarded to `mux_dubbed_audio`."""

    mode: str
    audio_language: str
    mix_config: DubAudioMixConfig
    has_custom_mix: bool
    subtitle_spec: VideoSubtitleRenderSpec


def _parse_dub_subtitles_payload(raw_subtitles: str) -> DubSubtitlesPayload:
    """Parse and validate JSON subtitle payload submitted to `POST /dub`."""
    if len(raw_subtitles or "") > MAX_DUB_SUBTITLES_CHARS:
        raise HTTPException(status_code=400, detail="Dub subtitle payload exceeds maximum allowed size.")
    if not (raw_subtitles or "").strip():
        raise HTTPException(status_code=400, detail="Subtitle payload is required when subtitleMode is 'burned' or 'soft'.")
    try:
        return DubSubtitlesPayload.model_validate_json(raw_subtitles)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail="Dub subtitle payload must be valid JSON matching the subtitle schema.") from exc


def _prepare_dub_subtitle_spec(opts: DubFormOptions, source_video: Path, work_dir: Path) -> VideoSubtitleRenderSpec:
    """Build ASS or SRT subtitle files inside `work_dir` when `opts.subtitle_mode` is `'burned'` or `'soft'`."""
    if opts.subtitle_mode == "none":
        return VideoSubtitleRenderSpec(mode="none")
    payload = _parse_dub_subtitles_payload(opts.raw_subtitles)
    domain_segs = _to_domain_segments(payload.segments)
    if not domain_segs:
        raise HTTPException(status_code=400, detail="At least one non-empty subtitle segment is required for video subtitles.")
    clean_sub_lang = (payload.subtitleLanguage or "").strip()
    if opts.subtitle_mode == "burned":
        style = payload.subtitleStyle or SubtitleStylePayload()
        video_size = _resolve_video_dimensions(payload, source_video)
        ass_content = build_ass(
            domain_segs,
            speaker_names=payload.speakerNames,
            video_size=video_size,
            include_speaker=payload.includeSpeaker,
            use_translation=payload.useTranslation,
            bilingual=payload.bilingual,
            position=style.position,
            font_scale=style.fontScale,
            background_style=style.backgroundStyle,
        )
        if "Dialogue:" not in ass_content:
            raise HTTPException(status_code=400, detail="At least one non-empty subtitle segment is required for video subtitles.")
        ass_path = work_dir / "subtitles.ass"
        ass_path.write_text(ass_content, encoding="utf-8")
        return VideoSubtitleRenderSpec(mode="burned", ass_path=ass_path, subtitle_language=clean_sub_lang)
    srt_content = build_srt(
        domain_segs,
        speaker_names=payload.speakerNames,
        include_speaker=payload.includeSpeaker,
        use_translation=payload.useTranslation,
        bilingual=payload.bilingual,
    )
    if not srt_content.strip():
        raise HTTPException(status_code=400, detail="At least one non-empty subtitle segment is required for video subtitles.")
    srt_path = work_dir / "subtitles.srt"
    srt_path.write_text(srt_content, encoding="utf-8")
    return VideoSubtitleRenderSpec(mode="soft", srt_path=srt_path, subtitle_language=clean_sub_lang)


def _validate_original_mode_no_clips(raw_metadata: str, files: list[UploadFile]) -> None:
    """Ensure no dubbed clips or non-empty metadata are passed when `mode == 'original'`."""
    if files:
        raise HTTPException(status_code=400, detail="Dubbed audio clips are not allowed when originalAudioMode is 'original'.")
    trimmed = (raw_metadata or "").strip()
    if not trimmed:
        return
    try:
        parsed = json.loads(trimmed)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Dub metadata must be valid JSON.") from exc
    if not isinstance(parsed, list) or len(parsed) > 0:
        raise HTTPException(status_code=400, detail="Dub metadata must be empty when originalAudioMode is 'original'.")


def _validate_dub_entries_for_mode(opts: DubFormOptions, files: list[UploadFile], source_duration: float) -> list[dict[str, Any]]:
    """Validate uploaded clip count and metadata entries against `opts.mode` and `source_duration`."""
    if opts.mode == "original":
        _validate_original_mode_no_clips(opts.raw_metadata, files)
        return []
    if not files or len(files) > MAX_DUB_CLIPS:
        raise HTTPException(status_code=400, detail=f"Upload between 1 and {MAX_DUB_CLIPS} WAV audio clips.")
    entries = _parse_dub_metadata(opts.raw_metadata, len(files))
    if source_duration > 0 and any(
        item["start"] > source_duration + DUB_TIMESTAMP_TOLERANCE_SECONDS
        or item["end"] > source_duration + DUB_TIMESTAMP_TOLERANCE_SECONDS
        for item in entries
    ):
        raise HTTPException(status_code=400, detail="Dub timestamps must fall within the source video duration.")
    return entries


def _execute_dub_pipeline(
    job: MediaJobPaths,
    clips: list[DubClip],
    tmp_mp4: Path,
    exec_spec: DubExecutionSpec,
) -> Path:
    """Mux dubbed/original audio and optional subtitles onto `job.source_video` into an isolated MP4 path."""
    kwargs: dict[str, Any] = {"original_audio_mode": exec_spec.mode}
    if exec_spec.audio_language:
        kwargs["audio_language"] = exec_spec.audio_language
    if exec_spec.has_custom_mix:
        kwargs["mix_config"] = exec_spec.mix_config
    if exec_spec.subtitle_spec.mode != "none":
        kwargs["subtitle_spec"] = exec_spec.subtitle_spec
    mux_dubbed_audio(job.source_video, clips, tmp_mp4, **kwargs)
    isolated_mp4 = job.root / f"export-{uuid.uuid4().hex[:8]}.mp4"
    os.replace(tmp_mp4, isolated_mp4)
    return isolated_mp4


def create_app(services: MediaServices | None = None) -> FastAPI:
    """Build configured FastAPI application with injected or default local AI services."""
    active_services = services or build_default_services()
    started_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    app = FastAPI(title="VoxCPM Media Subtitle Studio", version="0.1.0")

    @app.middleware("http")
    async def attach_request_id(request: Request, call_next):
        req_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        request.state.request_id = req_id
        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        _log_json(logging.INFO, req_id, f"{request.method} {request.url.path}", {"status": response.status_code, "ms": elapsed_ms})
        response.headers["X-Request-Id"] = req_id
        return response

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "pid": os.getpid(),
            "startedAt": started_at,
            "burnInSupported": check_burnin_support(),
            "diarizationReady": are_diarization_models_ready(),
            "models": inspect_model_readiness(),
            "whisperModel": DEFAULT_WHISPER_REPO,
            "khmerWhisperModel": DEFAULT_KHMER_WHISPER_REPO,
            "khmerVerifierModel": DEFAULT_KHMER_VERIFIER_REPO,
            "translatorModel": DEFAULT_NLLB_MODEL_ID,
            "khmerLexicon": get_lexicon_stats(),
        }

    @app.post("/transcribe")
    async def transcribe(
        request: Request,
        file: UploadFile = File(...),
        opts: TranscribeFormOptions = Depends(_parse_transcribe_options),
    ) -> dict[str, Any]:
        req_id = getattr(request.state, "request_id", "-")
        try:
            if opts.translate_to:
                resolve_nllb_lang_code(opts.translate_to, strict=True)
            job = _create_job_safe(active_services.job_store, file.filename)
            await _save_bounded_upload(file, job.source_video)
            return await asyncio.to_thread(_execute_transcribe_pipeline, active_services, job, opts, req_id)
        except HTTPException:
            raise
        except UnsupportedLanguageError as exc:
            _log_json(logging.WARNING, req_id, "Unsupported translation language during transcribe", {"error": str(exc)})
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except MediaProcessingError as exc:
            _log_json(logging.ERROR, req_id, "Media processing failed during transcribe", {"error": str(exc)})
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            _log_json(logging.ERROR, req_id, "Unexpected transcription error", {"error": str(exc)})
            raise HTTPException(status_code=500, detail="Video subtitle extraction failed unexpectedly.") from exc

    @app.post("/verify-speech")
    async def verify_speech(
        request: Request,
        file: UploadFile = File(...),
        expected_text: str = Form(""),
        language: str = Form("km"),
    ) -> dict[str, Any]:
        req_id = getattr(request.state, "request_id", "-")
        clean_expected = (expected_text or "").strip()
        if not clean_expected:
            raise HTTPException(status_code=400, detail="Expected script text is required to verify speech.")
        if len(clean_expected) > MAX_VERIFY_TEXT_CHARS:
            raise HTTPException(status_code=400, detail=f"Expected script exceeds {MAX_VERIFY_TEXT_CHARS} characters.")
        clean_lang = (language or "km").strip().lower() or "km"
        job: MediaJobPaths | None = None
        try:
            job = _create_job_safe(active_services.job_store, file.filename or "speech.wav")
            await _save_bounded_upload(file, job.source_video)
            return await asyncio.to_thread(_execute_verify_speech_pipeline, active_services, job, clean_expected, clean_lang)
        except HTTPException:
            raise
        except MediaProcessingError as exc:
            _log_json(logging.ERROR, req_id, "Media processing failed during verify-speech", {"error": str(exc)})
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            _log_json(logging.ERROR, req_id, "Unexpected speech verification error", {"error": str(exc)})
            raise HTTPException(status_code=500, detail="Speech verification failed unexpectedly.") from exc
        finally:
            if job is not None:
                shutil.rmtree(job.root, ignore_errors=True)

    @app.post("/translate")
    async def translate(request: Request, payload: TranslateRequest) -> dict[str, Any]:
        req_id = getattr(request.state, "request_id", "-")
        try:
            resolve_nllb_lang_code(payload.targetLanguage, strict=True)
            resolve_nllb_lang_code(payload.sourceLanguage)
            seg_models = [
                SubtitleSegment(
                    start=float(seg.start),
                    end=float(seg.end),
                    text=seg.text,
                    speaker_id=(seg.speakerId or "speaker-1").strip() or "speaker-1",
                )
                for seg in payload.segments
            ]
            translated = await asyncio.to_thread(
                translate_segments_with_terminology,
                active_services.translator,
                seg_models,
                payload.sourceLanguage,
                payload.targetLanguage,
                payload.terminology,
            )
            updated = [seg.model_copy(update={"translatedText": tr}).model_dump() for seg, tr in zip(payload.segments, translated)]
            return {"segments": updated, "targetLanguage": payload.targetLanguage}
        except UnsupportedLanguageError as exc:
            _log_json(logging.WARNING, req_id, "Unsupported translation language", {"error": str(exc)})
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            _log_json(logging.ERROR, req_id, "Translation error", {"error": str(exc)})
            raise HTTPException(status_code=500, detail="Offline subtitle translation failed.") from exc

    @app.post("/burn")
    def burn(request: Request, payload: BurnRequest) -> FileResponse:
        req_id = getattr(request.state, "request_id", "-")
        job = _resolve_job_safe(active_services.job_store, payload.jobId)
        if not has_video_stream(job.source_video):
            raise HTTPException(status_code=400, detail="MP4 subtitle burn-in is only supported for video files.")
        domain_segs = _to_domain_segments(payload.segments)
        if not domain_segs:
            raise HTTPException(status_code=400, detail="At least one non-empty subtitle segment is required to burn video.")
        style = payload.subtitleStyle or SubtitleStylePayload()
        try:
            video_size = _resolve_video_dimensions(payload, job.source_video)
            ass_content = build_ass(
                domain_segs,
                speaker_names=payload.speakerNames,
                video_size=video_size,
                include_speaker=payload.includeSpeaker,
                use_translation=payload.useTranslation,
                bilingual=payload.bilingual,
                position=style.position,
                font_scale=style.fontScale,
                background_style=style.backgroundStyle,
            )
            job.ass_file.write_text(ass_content, encoding="utf-8")
            clean_burn_lang = (payload.audioLanguage or "").strip()
            burn_kwargs = {"audio_language": clean_burn_lang} if clean_burn_lang else {}
            burn_ass_subtitles(job.source_video, job.ass_file, job.burned_mp4, **burn_kwargs)
            return FileResponse(path=job.burned_mp4, media_type="video/mp4", filename=f"{job.job_id}-subtitled.mp4")
        except MediaProcessingError as exc:
            _log_json(logging.ERROR, req_id, "FFmpeg burn-in failed", {"error": str(exc)})
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            _log_json(logging.ERROR, req_id, "Unexpected burn-in error", {"error": str(exc)})
            raise HTTPException(status_code=500, detail="Video subtitle burn-in failed unexpectedly.") from exc

    @app.post("/dub")
    async def dub_video(
        request: Request,
        opts: DubFormOptions = Depends(_parse_dub_form_options),
        files: list[UploadFile] = File(default=[]),
    ) -> FileResponse:
        req_id = getattr(request.state, "request_id", "-")
        job = _resolve_job_safe(active_services.job_store, opts.job_id)
        if not await asyncio.to_thread(has_video_stream, job.source_video):
            raise HTTPException(status_code=400, detail="Dubbed MP4 export is only supported for video files.")
        if opts.mode != "mute" and not await asyncio.to_thread(has_audio_stream, job.source_video):
            raise HTTPException(
                status_code=422,
                detail="Source video has no original audio track; select replacement dubbing ('mute' or 'replace') instead.",
            )
        source_duration = await asyncio.to_thread(probe_media_duration, job.source_video)
        entries = _validate_dub_entries_for_mode(opts, files, source_duration)
        work_dir = job.root / f"dub-{uuid.uuid4().hex[:8]}"
        work_dir.mkdir(parents=True, exist_ok=True)
        try:
            subtitle_spec = await asyncio.to_thread(_prepare_dub_subtitle_spec, opts, job.source_video, work_dir)
            saved_wavs = await _save_validated_dub_wavs(files, work_dir) if files else []
            dub_clips = [
                DubClip(
                    wav_path=saved_wavs[item["fileIndex"]],
                    start_seconds=item["start"],
                    end_seconds=item["end"],
                    segment_id=item["segmentId"],
                    allow_overflow=item["allowOverflow"],
                )
                for item in entries
            ]
            if dub_clips:
                await asyncio.to_thread(_validate_dub_overflow_bounds, dub_clips, source_duration)
            exec_spec = DubExecutionSpec(
                mode=opts.mode,
                audio_language=opts.audio_language,
                mix_config=opts.mix_config,
                has_custom_mix=opts.has_custom_mix,
                subtitle_spec=subtitle_spec,
            )
            out_mp4 = await asyncio.to_thread(_execute_dub_pipeline, job, dub_clips, work_dir / "dubbed.mp4", exec_spec)
            cleanup = BackgroundTask(out_mp4.unlink, missing_ok=True)
            return FileResponse(path=out_mp4, media_type="video/mp4", filename=f"{job.job_id}-dubbed.mp4", background=cleanup)
        except HTTPException:
            raise
        except MediaProcessingError as exc:
            _log_json(logging.ERROR, req_id, "FFmpeg dubbing export failed", {"error": str(exc)})
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            _log_json(logging.ERROR, req_id, "Unexpected dubbed export error", {"error": str(exc)})
            raise HTTPException(status_code=500, detail="Dubbed video export failed unexpectedly.") from exc
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    @app.exception_handler(HTTPException)
    async def structured_http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    return app


app = create_app()
