"""FastAPI HTTP service for offline video transcription, speaker diarization, Khmer translation, and ASS subtitle burn-in."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

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
from subtitles import (
    SPEAKER_ASS_COLORS,
    SubtitleSegment,
    align_even_dimensions,
    align_segments_with_speakers,
    build_ass,
)
from translator import DEFAULT_NLLB_MODEL_ID, LocalTranslator
from video_io import (
    MediaProcessingError,
    burn_ass_subtitles,
    check_burnin_support,
    extract_audio_16k_wav,
    has_video_stream,
    probe_video_dimensions,
)

SERVICE_NAME = "voxcpm-media-studio"
DEFAULT_PORT = 8810
DEFAULT_JOB_DIR = Path(os.environ.get("MEDIA_JOB_DIR", "/tmp/voxcpm-media-jobs"))
MAX_UPLOAD_BYTES = int(os.environ.get("MEDIA_MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))
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


@dataclass(frozen=True)
class TranscribeFormOptions:
    """Validated multipart form options for /transcribe."""

    language: str
    num_speakers: int
    diarize: bool
    translate_to: str
    double_check: bool = False


def _parse_transcribe_options(
    language: str = Form("auto"),
    num_speakers: int = Form(0),
    diarize: bool = Form(True),
    translate_to: str = Form(""),
    double_check: bool = Form(False),
) -> TranscribeFormOptions:
    """Parse multipart form fields into an immutable option object."""
    return TranscribeFormOptions(
        language=(language or "auto").strip(),
        num_speakers=max(0, min(12, int(num_speakers))),
        diarize=bool(diarize),
        translate_to=(translate_to or "").strip(),
        double_check=bool(double_check),
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


async def _save_bounded_upload(upload: UploadFile, dest: Path, max_bytes: int = MAX_UPLOAD_BYTES) -> int:
    """Stream multipart upload safely to disk while enforcing a strict maximum byte limit."""
    written = 0
    try:
        with open(dest, "wb") as handle:
            while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(status_code=413, detail=f"Video exceeds max upload limit ({max_bytes // (1024 * 1024)} MB).")
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
    for item in payloads:
        text = item.text.strip()
        tr_text = item.translatedText.strip()
        if not (text or tr_text):
            continue
        converted.append(
            SubtitleSegment(
                start=max(0.0, float(item.start)),
                end=max(float(item.start), float(item.end)),
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
    return services.translator.translate_lines([s.text for s in aligned], detected_lang, target)


def _run_transcriber(
    transcriber: Any,
    wav_path: Path,
    language: str,
    turns: list,
    double_check: bool = False,
) -> dict:
    """Invoke transcriber with optional double-check and speaker turns, degrading cleanly for stub signatures."""
    try:
        return transcriber.transcribe(wav_path, language=language, turns=turns, double_check=double_check)
    except TypeError:
        try:
            return transcriber.transcribe(wav_path, language=language, turns=turns)
        except TypeError:
            return transcriber.transcribe(wav_path, language=language)


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


def _execute_transcribe_pipeline(
    services: MediaServices,
    job: MediaJobPaths,
    opts: TranscribeFormOptions,
    request_id: str,
) -> dict[str, Any]:
    """Run FFmpeg extraction, speaker diarization, Whisper ASR, and optional translation."""
    extract_audio_16k_wav(job.source_video, job.audio_wav)
    has_video = has_video_stream(job.source_video)
    width, height = probe_video_dimensions(job.source_video) if has_video else (0, 0)
    turns = _run_diarization_safe(services, job.audio_wav, opts.num_speakers, request_id) if opts.diarize else []
    transcript = _run_transcriber(services.transcriber, job.audio_wav, opts.language, turns, opts.double_check)
    detected_lang = str(transcript.get("language") or opts.language or "en")
    aligned = align_segments_with_speakers(transcript.get("segments") or [], turns)
    translations = _maybe_translate_aligned(services, aligned, detected_lang, opts.translate_to)
    serialized, speakers = _serialize_segments(aligned, translations)
    summary = transcript.get("verificationSummary") or {"checked": 0, "fallbackApplied": 0, "suggestions": 0, "model": ""}
    return {
        "jobId": job.job_id,
        "language": detected_lang,
        "translatedLanguage": opts.translate_to if translations is not None else "",
        "speakers": speakers,
        "segments": serialized,
        "isAudioOnly": not has_video,
        "videoSize": {"width": width, "height": height} if has_video else None,
        "assColorMap": _build_ass_color_map(speakers),
        "verificationSummary": summary,
    }


def _resolve_video_dimensions(req: BurnRequest, source_video: Path) -> tuple[int, int]:
    """Resolve even-aligned pixel resolution for ASS styling from request payload or FFprobe."""
    raw_w, raw_h = (req.videoSize.width, req.videoSize.height) if req.videoSize is not None else probe_video_dimensions(source_video)
    return align_even_dimensions(raw_w, raw_h, min_size=160)


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
            texts = [seg.text for seg in payload.segments]
            translated = await asyncio.to_thread(
                active_services.translator.translate_lines,
                texts,
                payload.sourceLanguage,
                payload.targetLanguage,
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
            burn_ass_subtitles(job.source_video, job.ass_file, job.burned_mp4)
            return FileResponse(path=job.burned_mp4, media_type="video/mp4", filename=f"{job.job_id}-subtitled.mp4")
        except MediaProcessingError as exc:
            _log_json(logging.ERROR, req_id, "FFmpeg burn-in failed", {"error": str(exc)})
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            _log_json(logging.ERROR, req_id, "Unexpected burn-in error", {"error": str(exc)})
            raise HTTPException(status_code=500, detail="Video subtitle burn-in failed unexpectedly.") from exc

    @app.exception_handler(HTTPException)
    async def structured_http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    return app


app = create_app()
