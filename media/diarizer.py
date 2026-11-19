"""Local offline speaker diarization using sherpa-onnx (GTCRN denoiser + Pyannote segmentation + 3D-Speaker)."""

from __future__ import annotations

import logging
import os
import tarfile
import threading
import urllib.request
import wave
from pathlib import Path

import numpy as np

from subtitles import SpeakerTurn

logger = logging.getLogger(__name__)

DEFAULT_DIARIZATION_DIR = Path(
    os.environ.get("MEDIA_DIARIZATION_DIR", str(Path.home() / ".cache" / "voxcpm-media" / "diarization"))
)
SEG_ARCHIVE_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
EMB_MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
)
DENOISER_MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speech-enhancement-models/gtcrn_simple.onnx"
)
SEG_MODEL_REL = Path("sherpa-onnx-pyannote-segmentation-3-0") / "model.onnx"
EMB_MODEL_REL = Path("3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx")
DENOISER_MODEL_REL = Path("gtcrn_simple.onnx")
DOWNLOAD_TIMEOUT_SEC = 120
MIN_AUDIO_SAMPLES = 4800
PCM16_SCALE = 32768.0
MINOR_SPEAKER_MAX_SEC = 3.5
DOMINANT_SPEAKER_MIN_RATIO = 0.88


class DiarizationError(RuntimeError):
    """Raised when speaker diarization setup or inference fails."""


def are_diarization_models_ready(cache_dir: Path = DEFAULT_DIARIZATION_DIR) -> bool:
    """Return True when both offline diarization ONNX models exist locally."""
    return (Path(cache_dir) / SEG_MODEL_REL).is_file() and (Path(cache_dir) / EMB_MODEL_REL).is_file()


def _download_atomic(url: str, dest: Path) -> None:
    """Download a binary asset atomically into `dest` via a .part temp file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part_path = dest.with_name(f"{dest.name}.part")
    logger.info("Downloading diarization asset: %s", url)
    try:
        with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SEC) as resp, open(part_path, "wb") as out:
            while chunk := resp.read(65536):
                out.write(chunk)
        part_path.replace(dest)
    except Exception as exc:
        part_path.unlink(missing_ok=True)
        raise DiarizationError(f"Failed downloading diarization model from {url}: {exc}") from exc


def _safe_extract_tar_bz2(archive_path: Path, target_dir: Path) -> None:
    """Safely extract regular files from a .tar.bz2 archive inside `target_dir`."""
    resolved_root = target_dir.resolve()
    with tarfile.open(archive_path, "r:bz2") as tar:
        for member in tar.getmembers():
            dest = (resolved_root / member.name).resolve()
            if not dest.is_relative_to(resolved_root) or member.issym() or member.islnk():
                raise DiarizationError(f"Unsafe archive entry blocked: {member.name}")
        tar.extractall(resolved_root, filter="data")


def ensure_diarization_models(cache_dir: Path = DEFAULT_DIARIZATION_DIR) -> tuple[Path, Path]:
    """Ensure Pyannote segmentation and 3D-Speaker embedding ONNX models exist locally."""
    root = Path(cache_dir)
    seg_path = root / SEG_MODEL_REL
    emb_path = root / EMB_MODEL_REL
    if not seg_path.is_file():
        archive_path = root / "pyannote-seg-3.0.tar.bz2"
        _download_atomic(SEG_ARCHIVE_URL, archive_path)
        _safe_extract_tar_bz2(archive_path, root)
        archive_path.unlink(missing_ok=True)
    if not emb_path.is_file():
        _download_atomic(EMB_MODEL_URL, emb_path)
    if not (seg_path.is_file() and emb_path.is_file()):
        raise DiarizationError("Diarization ONNX models missing after download.")
    return seg_path, emb_path


def load_mono_16k_float32(wav_path: Path) -> np.ndarray:
    """Load a PCM WAV file as normalized mono float32 samples in [-1.0, 1.0]."""
    with wave.open(str(wav_path), "rb") as wf:
        if wf.getsampwidth() != 2:
            raise DiarizationError(f"Expected 16-bit PCM WAV, got {wf.getsampwidth() * 8}-bit.")
        channels = wf.getnchannels()
        frames = wf.readframes(wf.getnframes())
    if not frames:
        return np.zeros(0, dtype=np.float32)
    pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / PCM16_SCALE
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm


def _build_diarizer_config(seg_path: Path, emb_path: Path, num_speakers: int, threshold: float) -> object:
    """Construct validated sherpa-onnx OfflineSpeakerDiarizationConfig."""
    import sherpa_onnx

    clusters = int(num_speakers) if int(num_speakers) > 0 else -1
    seg_cfg = sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg_path)),
        num_threads=2,
    )
    emb_cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(emb_path), num_threads=2)
    clust_cfg = sherpa_onnx.FastClusteringConfig(num_clusters=clusters, threshold=float(threshold))
    return sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=seg_cfg,
        embedding=emb_cfg,
        clustering=clust_cfg,
        min_duration_on=0.45,
        min_duration_off=0.28,
    )


def consolidate_minor_speaker_blips(turns: list[SpeakerTurn], num_speakers: int = 0) -> list[SpeakerTurn]:
    """Merge short noise-induced speaker blips (<3.5s) into the dominant speaker when auto-detecting."""
    if num_speakers > 0 or len(turns) < 2:
        return turns
    durations: dict[str, float] = {}
    for turn in turns:
        durations[turn.speaker] = durations.get(turn.speaker, 0.0) + max(0.0, turn.end - turn.start)
    total_dur = sum(durations.values())
    if total_dur <= 0.0 or len(durations) <= 1:
        return turns
    dominant_spk, dominant_dur = max(durations.items(), key=lambda kv: kv[1])
    if (dominant_dur / total_dur) < DOMINANT_SPEAKER_MIN_RATIO:
        return turns
    return [
        SpeakerTurn(
            start=t.start,
            end=t.end,
            speaker=dominant_spk if durations.get(t.speaker, 0.0) < MINOR_SPEAKER_MAX_SEC else t.speaker,
        )
        for t in turns
    ]


class LocalDiarizer:
    """Thread-safe lazy sherpa-onnx speaker diarizer with optional GTCRN pre-denoising."""

    def __init__(self, cache_dir: Path = DEFAULT_DIARIZATION_DIR, threshold: float = 0.65) -> None:
        self._cache_dir = Path(cache_dir)
        self._threshold = float(threshold)
        self._lock = threading.Lock()
        self._engine = None
        self._denoiser = None
        self._model_paths: tuple[Path, Path] | None = None

    def _get_engine(self, num_speakers: int) -> object:
        """Lazily load sherpa-onnx diarization engine and apply clustering config."""
        import sherpa_onnx

        if self._model_paths is None:
            self._model_paths = ensure_diarization_models(self._cache_dir)
        cfg = _build_diarizer_config(*self._model_paths, num_speakers, self._threshold)
        if self._engine is None:
            self._engine = sherpa_onnx.OfflineSpeakerDiarization(cfg)
        else:
            self._engine.set_config(cfg)
        return self._engine

    def _denoise_for_segmentation(self, samples: np.ndarray) -> np.ndarray:
        """Apply GTCRN speech enhancement when cached so VAD/diarization ignores plastic/background noise."""
        gtcrn_path = self._cache_dir / DENOISER_MODEL_REL
        if not gtcrn_path.is_file():
            return samples
        try:
            import sherpa_onnx

            if self._denoiser is None:
                m_cfg = sherpa_onnx.OfflineSpeechDenoiserModelConfig(
                    gtcrn=sherpa_onnx.OfflineSpeechDenoiserGtcrnModelConfig(model=str(gtcrn_path)),
                    num_threads=2,
                )
                self._denoiser = sherpa_onnx.OfflineSpeechDenoiser(sherpa_onnx.OfflineSpeechDenoiserConfig(model=m_cfg))
            enhanced = self._denoiser(samples, 16000)
            return np.asarray(enhanced.samples, dtype=np.float32)
        except Exception as exc:
            logger.debug("GTCRN segmentation pre-denoise skipped: %s", exc)
            return samples

    def diarize(self, wav_path: Path, num_speakers: int = 0) -> list[SpeakerTurn]:
        """Identify speaker turns in a 16 kHz mono WAV file."""
        samples = load_mono_16k_float32(Path(wav_path))
        if samples.size < MIN_AUDIO_SAMPLES:
            return []
        with self._lock:
            clean_samples = self._denoise_for_segmentation(samples)
            engine = self._get_engine(num_speakers)
            result = engine.process(clean_samples)
        segments = result.sort_by_start_time()
        raw_turns = [
            SpeakerTurn(start=float(seg.start), end=float(seg.end), speaker=str(seg.speaker))
            for seg in segments
        ]
        return consolidate_minor_speaker_blips(raw_turns, num_speakers=num_speakers)
