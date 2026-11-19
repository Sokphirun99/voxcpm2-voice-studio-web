"""Local Apple Silicon speech-to-text transcription using Qwen3-ASR-0.6B-Khmer, Whisper, and mlx-whisper."""

from __future__ import annotations

import logging
import os
import sys
import threading
import types
from pathlib import Path

import numpy as np

from diarizer import load_mono_16k_float32
from khmer_dictionary import correct_khmer_transcript
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


class KhmerWhisperTranscriber:
    """Thread-safe Khmer ASR transcriber supporting Qwen3-ASR-0.6B-Khmer and fine-tuned Whisper."""

    def __init__(self, model_repo: str = DEFAULT_KHMER_WHISPER_REPO) -> None:
        self._model_repo = model_repo
        self._lock = threading.Lock()
        self._qwen_asr = None
        self._model = None
        self._processor = None
        self._device = "cpu"
        self._dtype = None

    def _ensure_loaded(self) -> None:
        """Lazily load Qwen3-ASR-0.6B-Khmer (or Whisper fallback) from local HuggingFace cache."""
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

        model = AutoModelForSpeechSeq2Seq.from_pretrained(model_dir, dtype=self._dtype, local_files_only=True)
        model.config.use_cache = True
        model.generation_config.use_cache = True
        processor = AutoProcessor.from_pretrained(model_dir, local_files_only=True)
        model.generation_config.forced_decoder_ids = processor.get_decoder_prompt_ids(language="km", task="transcribe")
        self._model = model.to(self._device).eval()
        self._processor = processor

    def _transcribe_whisper_chunk(self, chunk: np.ndarray) -> str:
        """Decode a single speech slice using the fallback HuggingFace Whisper model."""
        import torch

        inputs = self._processor(chunk, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        feats = inputs.input_features.to(device=self._device, dtype=self._dtype)
        with torch.no_grad():
            pred_ids = self._model.generate(feats, max_new_tokens=MAX_NEW_TOKENS, use_cache=True)
        raw = self._processor.batch_decode(pred_ids, skip_special_tokens=True)[0]
        return correct_khmer_transcript(raw)

    def _transcribe_turns_locked(self, audio: np.ndarray, speech_turns: list[SpeakerTurn]) -> list[dict]:
        """Run batched Qwen3-ASR or sequential Whisper inference while holding the model lock."""
        self._ensure_loaded()
        active_turns: list[SpeakerTurn] = []
        slices: list[np.ndarray] = []
        for turn in speech_turns:
            chunk = _slice_turn_audio(audio, turn)
            if chunk.size > 0 and float(np.sqrt(np.mean(np.square(chunk)))) >= MIN_RMS_ENERGY:
                active_turns.append(turn)
                slices.append(chunk)
        if not active_turns:
            return []
        if self._qwen_asr is not None:
            texts: list[str] = []
            for start in range(0, len(slices), QWEN_ASR_BATCH_SIZE):
                batch = [(chunk, SAMPLE_RATE) for chunk in slices[start : start + QWEN_ASR_BATCH_SIZE]]
                results = self._qwen_asr.transcribe(batch)
                texts.extend(correct_khmer_transcript(r.text) for r in results)
        else:
            texts = [self._transcribe_whisper_chunk(chunk) for chunk in slices]
        return [
            {"start": round(t.start, 3), "end": round(t.end, 3), "text": txt}
            for t, txt in zip(active_turns, texts)
            if txt
        ]

    def transcribe(self, wav_path: Path, turns: list[SpeakerTurn] | None = None) -> dict:
        """Transcribe a 16 kHz mono WAV file into timed Khmer segments aligned with speaker turns."""
        audio = load_mono_16k_float32(Path(wav_path))
        speech_turns = prepare_speech_turns(audio, turns)
        logger.info("Transcribing %s with Khmer model %s (%d turns)", Path(wav_path).name, self._model_repo, len(speech_turns))
        with self._lock:
            segments = self._transcribe_turns_locked(audio, speech_turns)
        return {"language": "km", "segments": segments}


class LocalTranscriber:
    """Thread-safe hybrid ASR routing Khmer speech to Qwen3-ASR-0.6B-Khmer and other languages to MLX Whisper."""

    def __init__(
        self,
        model_repo: str = DEFAULT_WHISPER_REPO,
        khmer_model_repo: str = DEFAULT_KHMER_WHISPER_REPO,
    ) -> None:
        self._model_repo = model_repo
        self._khmer = KhmerWhisperTranscriber(khmer_model_repo)
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

    def transcribe(
        self,
        wav_path: Path,
        language: str | None = None,
        turns: list[SpeakerTurn] | None = None,
    ) -> dict:
        """Transcribe a 16 kHz mono WAV file using Khmer fine-tuned ASR for `km` and MLX Whisper otherwise."""
        path = Path(wav_path)
        clean_lang = (language or "").strip().lower() or None
        if clean_lang == "auto":
            clean_lang = None
        if clean_lang == "km":
            return self._khmer.transcribe(path, turns=turns)
        mlx_res = self._transcribe_mlx(path, clean_lang)
        if clean_lang is None and mlx_res.get("language") == "km":
            logger.info("Auto-detected Khmer speech in %s; switching to Khmer ASR", path.name)
            return self._khmer.transcribe(path, turns=turns)
        return mlx_res
