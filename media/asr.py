"""Local Apple Silicon speech-to-text transcription using Qwen3-ASR-0.6B-Khmer, Whisper Khmer verifier, and mlx-whisper."""

from __future__ import annotations

import inspect
import logging
import os
import sys
import threading
import types
from pathlib import Path

import numpy as np

from diarizer import load_mono_16k_float32
from khmer_dictionary import correct_khmer_transcript
from khmer_verifier import (
    DEFAULT_KHMER_VERIFIER_REPO,
    CandidatePair,
    assess_khmer_turn_quality,
    reconcile_khmer_candidates,
)
from model_cache import resolve_hf_model_path
from subtitles import SpeakerTurn

logger = logging.getLogger(__name__)

DEFAULT_WHISPER_REPO = os.environ.get("MEDIA_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
DEFAULT_KHMER_WHISPER_REPO = os.environ.get("MEDIA_KHMER_WHISPER_MODEL", "seanghay/Qwen3-ASR-0.6B-Khmer")
SAMPLE_RATE = 16000
MAX_TURN_SEC = 11.0
VAD_MAX_TURN_SEC = 8.0
MIN_TURN_SEC = 0.3
PAD_TURN_SEC = 0.2
MIN_RMS_ENERGY = 1e-5
MAX_NEW_TOKENS = 320
QWEN_ASR_BATCH_SIZE = 16
VAD_FRAME_MS = 30
VAD_MIN_SILENCE_SEC = 0.32
VAD_EDGE_PAD_SEC = 0.14


def _find_quietest_split_sec(turn: SpeakerTurn, audio: np.ndarray) -> float:
    """Locate the lowest-energy timestamp near the midpoint of a long speech turn."""
    duration = turn.end - turn.start
    mid = (turn.start + turn.end) / 2.0
    half = min(1.5, duration * 0.25)
    win = int(0.08 * SAMPLE_RATE)
    step = max(1, int(0.02 * SAMPLE_RATE))
    max_valid_start = max(0, len(audio) - win)
    start_idx = min(max_valid_start, max(0, int((mid - half) * SAMPLE_RATE)))
    end_idx = min(max_valid_start + 1, max(start_idx + 1, int((mid + half) * SAMPLE_RATE)))
    if len(audio) < win or start_idx >= end_idx:
        return round(mid, 3)
    best_idx = min(range(start_idx, end_idx, step), key=lambda i: float(np.mean(np.square(audio[i : i + win]))))
    return round((best_idx + win // 2) / SAMPLE_RATE, 3)


def split_long_turn(turn: SpeakerTurn, audio: np.ndarray, max_sec: float = MAX_TURN_SEC) -> list[SpeakerTurn]:
    """Recursively split a speaker turn at silence valleys so each subtitle cue stays <= `max_sec`."""
    if (turn.end - turn.start) <= max_sec:
        return [turn]
    split_t = _find_quietest_split_sec(turn, audio)
    if split_t <= turn.start + MIN_TURN_SEC or split_t >= turn.end - MIN_TURN_SEC:
        split_t = round((turn.start + turn.end) / 2.0, 3)
    left = SpeakerTurn(start=turn.start, end=split_t, speaker=turn.speaker)
    right = SpeakerTurn(start=split_t, end=turn.end, speaker=turn.speaker)
    return split_long_turn(left, audio, max_sec) + split_long_turn(right, audio, max_sec)


def _compute_frame_rms(audio: np.ndarray, frame_samples: int) -> np.ndarray:
    """Compute per-frame RMS energy across non-overlapping audio frames."""
    usable = (len(audio) // frame_samples) * frame_samples
    if usable <= 0:
        return np.zeros(0, dtype=np.float32)
    frames = audio[:usable].reshape(-1, frame_samples)
    return np.sqrt(np.mean(np.square(frames), axis=1))


def _append_vad_turn(
    turns: list[SpeakerTurn],
    frame_span: tuple[int, int],
    frame_sec: float,
    total_sec: float,
) -> None:
    """Pad an active VAD frame span and append it when duration meets `MIN_TURN_SEC`."""
    start_frame, last_active_frame = frame_span
    start_sec = max(0.0, round(start_frame * frame_sec - VAD_EDGE_PAD_SEC, 3))
    end_sec = min(total_sec, round((last_active_frame + 1) * frame_sec + VAD_EDGE_PAD_SEC, 3))
    if (end_sec - start_sec) >= MIN_TURN_SEC:
        turns.append(SpeakerTurn(start=start_sec, end=end_sec, speaker="0"))


def _merge_vad_regions(active: np.ndarray, frame_sec: float, total_sec: float) -> list[SpeakerTurn]:
    """Merge contiguous active VAD frames into padded SpeakerTurn intervals."""
    turns: list[SpeakerTurn] = []
    min_gap_frames = max(1, int(round(VAD_MIN_SILENCE_SEC / frame_sec)))
    start_frame, last_active_frame, silent_run = None, 0, 0
    for idx, is_speech in enumerate(active):
        if is_speech:
            start_frame = idx if start_frame is None else start_frame
            last_active_frame, silent_run = idx, 0
            continue
        if start_frame is None:
            continue
        silent_run += 1
        if silent_run >= min_gap_frames:
            _append_vad_turn(turns, (start_frame, last_active_frame), frame_sec, total_sec)
            start_frame, silent_run = None, 0
    if start_frame is not None:
        _append_vad_turn(turns, (start_frame, last_active_frame), frame_sec, total_sec)
    return turns


def _resolve_vad_peak_level(rms: np.ndarray, noise_floor: float) -> float:
    """Resolve a spike-resistant speech peak level that still captures brief utterances in long silent clips."""
    p80 = float(np.percentile(rms, 80))
    p95 = float(np.percentile(rms, 95))
    max_level = float(np.max(rms))
    if p95 <= max(MIN_RMS_ENERGY, noise_floor * 1.25):
        return max_level
    if p80 > max(MIN_RMS_ENERGY * 2.0, noise_floor * 1.5):
        return min(p95, p80 * 2.0)
    return p95


def _detect_vad_turns(audio: np.ndarray, max_sec: float = VAD_MAX_TURN_SEC) -> list[SpeakerTurn]:
    """Detect natural speech turns using adaptive RMS energy VAD when diarization is disabled."""
    total_sec = round(len(audio) / SAMPLE_RATE, 3)
    if total_sec < MIN_TURN_SEC:
        return []
    frame_samples = int(SAMPLE_RATE * VAD_FRAME_MS / 1000)
    rms = _compute_frame_rms(audio, frame_samples)
    if rms.size == 0:
        if float(np.sqrt(np.mean(np.square(audio)))) < MIN_RMS_ENERGY:
            return []
        return [SpeakerTurn(start=0.0, end=total_sec, speaker="0")]
    if float(np.max(rms)) <= MIN_RMS_ENERGY:
        return []
    noise_floor = float(np.percentile(rms, 15))
    peak_level = _resolve_vad_peak_level(rms, noise_floor)
    if (peak_level - noise_floor) <= peak_level * 0.2:
        raw_turns = [SpeakerTurn(start=0.0, end=total_sec, speaker="0")]
    else:
        threshold = max(MIN_RMS_ENERGY * 2.0, noise_floor + (peak_level - noise_floor) * 0.14)
        raw_turns = _merge_vad_regions(rms >= threshold, frame_samples / SAMPLE_RATE, total_sec)
        if not raw_turns:
            raw_turns = [SpeakerTurn(start=0.0, end=total_sec, speaker="0")]
    split_turns: list[SpeakerTurn] = []
    for turn in raw_turns:
        split_turns.extend(split_long_turn(turn, audio, max_sec=max_sec))
    return split_turns


def _build_fallback_turns(audio: np.ndarray, max_sec: float = VAD_MAX_TURN_SEC) -> list[SpeakerTurn]:
    """Build speech-aware turns via energy VAD when diarization turns are unavailable."""
    return _detect_vad_turns(audio, max_sec=max_sec)


def prepare_speech_turns(audio: np.ndarray, turns: list[SpeakerTurn] | None = None) -> list[SpeakerTurn]:
    """Normalize and split speech turns into concise, non-silent subtitle windows."""
    source_turns = turns if turns else _build_fallback_turns(audio)
    prepared: list[SpeakerTurn] = []
    for turn in source_turns:
        for sub in split_long_turn(turn, audio, max_sec=MAX_TURN_SEC):
            if (sub.end - sub.start) >= MIN_TURN_SEC:
                prepared.append(sub)
    return prepared


def _slice_turn_audio(audio: np.ndarray, turn: SpeakerTurn) -> np.ndarray:
    """Slice a single padded mono 16 kHz float32 audio segment for `turn`."""
    s_idx = max(0, int((turn.start - PAD_TURN_SEC) * SAMPLE_RATE))
    e_idx = min(len(audio), int((turn.end + PAD_TURN_SEC) * SAMPLE_RATE))
    return audio[s_idx:e_idx]


def _collect_active_slices(audio: np.ndarray, speech_turns: list[SpeakerTurn]) -> tuple[list[SpeakerTurn], list[np.ndarray]]:
    """Filter non-silent speaker turns and slice padded 16 kHz mono audio chunks."""
    active_turns: list[SpeakerTurn] = []
    slices: list[np.ndarray] = []
    for turn in speech_turns:
        chunk = _slice_turn_audio(audio, turn)
        if chunk.size > 0 and float(np.sqrt(np.mean(np.square(chunk)))) >= MIN_RMS_ENERGY:
            active_turns.append(turn)
            slices.append(chunk)
    return active_turns, slices


def _build_segment_payload(turn: SpeakerTurn, text: str, alt_text: str = "", verify_reason: str = "") -> dict:
    """Assemble one timed ASR segment dictionary with optional Whisper verification metadata."""
    seg: dict = {"start": round(turn.start, 3), "end": round(turn.end, 3), "text": text}
    if alt_text:
        seg["altText"] = alt_text
    if verify_reason:
        seg["verifyReason"] = verify_reason
    return seg


def _join_segment_texts(segments: list[dict]) -> str:
    """Join non-empty segment text fields into a single normalized transcript string."""
    return " ".join(str(seg.get("text") or "").strip() for seg in segments if str(seg.get("text") or "").strip())


class KhmerWhisperTranscriber:
    """Thread-safe Khmer ASR transcriber supporting Qwen3-ASR-0.6B-Khmer and fine-tuned Whisper."""

    def __init__(
        self,
        model_repo: str = DEFAULT_KHMER_WHISPER_REPO,
        verifier: KhmerWhisperTranscriber | None = None,
    ) -> None:
        self._model_repo = model_repo
        self._verifier = verifier
        self._lock = threading.Lock()
        self._qwen_asr = None
        self._model = None
        self._processor = None
        self._device = "cpu"
        self._dtype = None

    @property
    def model_repo(self) -> str:
        """Return configured HuggingFace model repository ID."""
        return self._model_repo

    def _ensure_loaded(self) -> None:
        """Lazily load Qwen3-ASR-0.6B-Khmer (or Whisper model) from cache or HuggingFace Hub."""
        if self._qwen_asr is not None or self._model is not None:
            return
        import torch

        model_dir = resolve_hf_model_path(self._model_repo)
        self._device = "mps" if torch.backends.mps.is_available() else "cpu"
        self._dtype = torch.float16 if self._device == "mps" else torch.float32
        if "qwen3-asr" in self._model_repo.lower():
            sys.modules.setdefault("nagisa", types.ModuleType("nagisa"))
            sys.modules.setdefault("soynlp", types.ModuleType("soynlp"))
            from qwen_asr import Qwen3ASRModel

            self._qwen_asr = Qwen3ASRModel.from_pretrained(
                model_dir, dtype=self._dtype, device_map=self._device, max_new_tokens=MAX_NEW_TOKENS
            )
            return
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

        is_local = Path(model_dir).is_dir()
        model = AutoModelForSpeechSeq2Seq.from_pretrained(model_dir, dtype=self._dtype, local_files_only=is_local)
        model.config.use_cache = True
        model.generation_config.use_cache = True
        processor = AutoProcessor.from_pretrained(model_dir, local_files_only=is_local)
        model.generation_config.forced_decoder_ids = processor.get_decoder_prompt_ids(language="km", task="transcribe")
        self._model = model.to(self._device).eval()
        self._processor = processor

    def _transcribe_whisper_chunk(self, chunk: np.ndarray) -> str:
        """Decode a single speech slice using the HuggingFace Whisper model."""
        import torch

        inputs = self._processor(chunk, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        feats = inputs.input_features.to(device=self._device, dtype=self._dtype)
        with torch.no_grad():
            pred_ids = self._model.generate(feats, max_new_tokens=MAX_NEW_TOKENS, use_cache=True)
        raw = self._processor.batch_decode(pred_ids, skip_special_tokens=True)[0]
        return correct_khmer_transcript(raw)

    def _decode_slices_locked(self, slices: list[np.ndarray]) -> list[str]:
        """Decode audio slices via batched Qwen3-ASR or sequential Whisper while holding `self._lock`."""
        self._ensure_loaded()
        if not slices:
            return []
        if self._qwen_asr is not None:
            texts: list[str] = []
            for start in range(0, len(slices), QWEN_ASR_BATCH_SIZE):
                batch = [(chunk, SAMPLE_RATE) for chunk in slices[start : start + QWEN_ASR_BATCH_SIZE]]
                results = self._qwen_asr.transcribe(batch)
                texts.extend(correct_khmer_transcript(r.text) for r in results)
            return texts
        return [self._transcribe_whisper_chunk(chunk) for chunk in slices]

    def transcribe_slices(self, slices: list[np.ndarray]) -> list[str]:
        """Thread-safely decode pre-sliced 16 kHz mono speech chunks into corrected Khmer strings."""
        if not slices:
            return []
        with self._lock:
            return self._decode_slices_locked(slices)

    def _transcribe_turns_locked(self, audio: np.ndarray, speech_turns: list[SpeakerTurn]) -> list[dict]:
        """Run batched Qwen3-ASR or sequential Whisper inference while holding the model lock."""
        active_turns, slices = _collect_active_slices(audio, speech_turns)
        if not active_turns:
            return []
        texts = self._decode_slices_locked(slices)
        return [_build_segment_payload(turn, txt) for turn, txt in zip(active_turns, texts) if txt]

    def _run_verifier_safe(self, slices: list[np.ndarray]) -> list[str] | None:
        """Invoke secondary Khmer Whisper verifier safely, degrading cleanly on load/runtime errors."""
        if self._verifier is None or not slices:
            return None
        try:
            logger.info("Running secondary Khmer verifier %s on %d turn(s)", self._verifier.model_repo, len(slices))
            return self._verifier.transcribe_slices(slices)
        except Exception as exc:
            logger.warning("Secondary Khmer verifier %s skipped cleanly: %s", self._verifier.model_repo, exc)
            return None

    def _reconcile_verified_turns(
        self,
        active_turns: list[SpeakerTurn],
        slices: list[np.ndarray],
        primary_texts: list[str],
        double_check: bool,
    ) -> tuple[list[dict], dict]:
        """Run selective (or full optional) secondary Whisper verification and reconcile results."""
        qualities = [assess_khmer_turn_quality(txt) for txt in primary_texts]
        target_indices = [idx for idx, qual in enumerate(qualities) if double_check or qual.is_suspicious]
        secondary_map: dict[int, str] = {}
        verifier_model = self._verifier.model_repo if self._verifier is not None else ""
        if target_indices and self._verifier is not None:
            decoded = self._run_verifier_safe([slices[idx] for idx in target_indices])
            if decoded is not None and len(decoded) == len(target_indices):
                secondary_map = dict(zip(target_indices, decoded))
        segments, fallback_count, suggestion_count = _merge_verified_outputs(
            active_turns, primary_texts, qualities, secondary_map, double_check
        )
        summary = {
            "checked": len(secondary_map),
            "fallbackApplied": fallback_count,
            "suggestions": suggestion_count,
            "model": verifier_model if secondary_map else "",
        }
        return segments, summary

    def transcribe(
        self,
        wav_path: Path,
        turns: list[SpeakerTurn] | None = None,
        double_check: bool = False,
    ) -> dict:
        """Transcribe a 16 kHz mono WAV file into timed Khmer segments with selective Whisper verification."""
        audio = load_mono_16k_float32(Path(wav_path))
        speech_turns = prepare_speech_turns(audio, turns)
        active_turns, slices = _collect_active_slices(audio, speech_turns)
        logger.info("Transcribing %s with Khmer model %s (%d turns)", Path(wav_path).name, self._model_repo, len(active_turns))
        if not active_turns:
            return {"language": "km", "segments": [], "verificationSummary": {"checked": 0, "fallbackApplied": 0, "suggestions": 0, "model": ""}}
        with self._lock:
            primary_texts = self._decode_slices_locked(slices)
        segments, summary = self._reconcile_verified_turns(active_turns, slices, primary_texts, double_check)
        return {"language": "km", "segments": segments, "verificationSummary": summary}


def _merge_verified_outputs(
    active_turns: list[SpeakerTurn],
    primary_texts: list[str],
    qualities: list,
    secondary_map: dict[int, str],
    double_check: bool,
) -> tuple[list[dict], int, int]:
    """Combine primary and optional secondary decodes into final segment dicts and counters."""
    segments: list[dict] = []
    fallback_count = 0
    suggestion_count = 0
    for idx, (turn, primary_text, primary_quality) in enumerate(zip(active_turns, primary_texts, qualities)):
        if idx in secondary_map:
            sec_text = secondary_map[idx]
            pair = CandidatePair(primary_text, sec_text, primary_quality, assess_khmer_turn_quality(sec_text))
            reconciled = reconcile_khmer_candidates(pair, force_double_check=double_check)
            if reconciled.used_fallback:
                fallback_count += 1
            elif reconciled.alt_text:
                suggestion_count += 1
            if reconciled.text:
                segments.append(_build_segment_payload(turn, reconciled.text, reconciled.alt_text, reconciled.verify_reason))
        elif primary_text:
            segments.append(_build_segment_payload(turn, primary_text))
    return segments, fallback_count, suggestion_count


class LocalTranscriber:
    """Thread-safe hybrid ASR routing Khmer speech to Qwen3-ASR (+ selective Whisper verifier) and other languages to MLX Whisper."""

    def __init__(
        self,
        model_repo: str = DEFAULT_WHISPER_REPO,
        khmer_model_repo: str = DEFAULT_KHMER_WHISPER_REPO,
        khmer_verifier_repo: str = DEFAULT_KHMER_VERIFIER_REPO,
    ) -> None:
        self._model_repo = model_repo
        clean_verifier = (khmer_verifier_repo or "").strip()
        self._khmer_verifier = (
            KhmerWhisperTranscriber(clean_verifier) if clean_verifier and clean_verifier != khmer_model_repo else None
        )
        self._khmer = KhmerWhisperTranscriber(khmer_model_repo, verifier=self._khmer_verifier)
        self._lock = threading.Lock()

    def _transcribe_mlx(self, wav_path: Path, clean_lang: str | None) -> dict:
        """Run general multilingual MLX Whisper transcription with word timestamps."""
        import mlx_whisper

        model_path = resolve_hf_model_path(self._model_repo)
        kwargs = {"path_or_hf_repo": model_path, "word_timestamps": True}
        if clean_lang:
            kwargs["language"] = clean_lang
        logger.info("Transcribing %s with %s (lang=%s)", wav_path.name, self._model_repo, clean_lang or "auto")
        with self._lock:
            result = mlx_whisper.transcribe(str(wav_path), **kwargs)
        return {
            "language": result.get("language") or clean_lang or "en",
            "segments": result.get("segments") or [],
        }

    def _transcribe_khmer(self, path: Path, turns: list[SpeakerTurn] | None, double_check: bool) -> dict:
        """Invoke the primary Khmer transcriber with the requested verification mode."""
        method = self._khmer.transcribe
        try:
            parameters = inspect.signature(method).parameters
        except (TypeError, ValueError):
            supports_double_check = True
        else:
            supports_double_check = "double_check" in parameters or any(
                parameter.kind is inspect.Parameter.VAR_KEYWORD
                for parameter in parameters.values()
            )
        kwargs = {"turns": turns}
        if supports_double_check:
            kwargs["double_check"] = double_check
        return method(path, **kwargs)

    def transcribe(
        self,
        wav_path: Path,
        language: str | None = None,
        turns: list[SpeakerTurn] | None = None,
        double_check: bool = False,
    ) -> dict:
        """Transcribe a 16 kHz mono WAV file using Khmer fine-tuned ASR for `km` and MLX Whisper otherwise."""
        path = Path(wav_path)
        clean_lang = (language or "").strip().lower() or None
        if clean_lang == "auto":
            clean_lang = None
        if clean_lang == "km":
            return self._transcribe_khmer(path, turns, double_check)
        mlx_res = self._transcribe_mlx(path, clean_lang)
        if clean_lang is None and mlx_res.get("language") == "km":
            logger.info("Auto-detected Khmer speech in %s; switching to Khmer ASR", path.name)
            return self._transcribe_khmer(path, turns, double_check)
        return mlx_res

    def verify_audio(self, wav_path: Path, language: str = "km") -> tuple[str, str]:
        """Transcribe generated TTS audio for round-trip word QA using `whisper-small-khmer-v2` for Khmer.

        Inputs: 16 kHz mono WAV path and target language (`'km'` or ISO code / `'auto'`).
        Outputs: `(heard_text, model_repo_used)`.
        Side effects: lazily loads the verifier model on first use.
        Failure modes: falls back to primary Khmer ASR if `whisper-small-khmer-v2` fails to load.
        """
        path = Path(wav_path)
        clean_lang = (language or "km").strip().lower() or "km"
        if clean_lang == "km":
            if self._khmer_verifier is not None:
                try:
                    res = self._khmer_verifier.transcribe(path, turns=None, double_check=False)
                    return _join_segment_texts(res.get("segments") or []), self._khmer_verifier.model_repo
                except Exception as exc:
                    logger.warning("Khmer verifier %s failed during TTS QA; falling back to primary ASR: %s", self._khmer_verifier.model_repo, exc)
            res = self._transcribe_khmer(path, None, False)
            return _join_segment_texts(res.get("segments") or []), self._khmer.model_repo
        mlx_res = self._transcribe_mlx(path, None if clean_lang == "auto" else clean_lang)
        return _join_segment_texts(mlx_res.get("segments") or []), self._model_repo
