"""Unit tests for media/diarizer.py."""

from __future__ import annotations

import tarfile
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import diarizer


def _write_pcm16_wav(path: Path, samples: np.ndarray, channels: int = 1, rate: int = 16000) -> None:
    """Write a synthetic PCM-16 WAV file for diarizer input testing."""
    scaled = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(scaled.tobytes())


def test_load_mono_16k_float32_handles_mono_and_stereo(tmp_path: Path) -> None:
    """Mono and stereo PCM-16 WAV files are converted to normalized 1-D float32 arrays."""
    mono_wav = tmp_path / "mono.wav"
    _write_pcm16_wav(mono_wav, np.array([0.0, 0.5, -0.5], dtype=np.float32), channels=1)
    loaded = diarizer.load_mono_16k_float32(mono_wav)
    assert loaded.dtype == np.float32
    assert loaded.shape == (3,)
    assert np.allclose(loaded, [0.0, 0.5, -0.5], atol=1e-3)

    stereo_wav = tmp_path / "stereo.wav"
    _write_pcm16_wav(stereo_wav, np.array([0.4, 0.0, -0.6, 0.2], dtype=np.float32), channels=2)
    stereo_loaded = diarizer.load_mono_16k_float32(stereo_wav)
    assert stereo_loaded.shape == (2,)
    assert np.allclose(stereo_loaded, [0.2, -0.2], atol=1e-3)


def test_short_wav_returns_empty_without_initializing_engine(tmp_path: Path) -> None:
    """Clips shorter than 0.3s skip diarization safely without model download."""
    tiny_wav = tmp_path / "tiny.wav"
    _write_pcm16_wav(tiny_wav, np.zeros(400, dtype=np.float32))
    instance = diarizer.LocalDiarizer(cache_dir=tmp_path / "empty_cache")
    assert instance.diarize(tiny_wav) == []
    assert not diarizer.are_diarization_models_ready(tmp_path / "empty_cache")


def test_safe_extract_tar_bz2_blocks_path_traversal(tmp_path: Path) -> None:
    """Archive extraction rejects traversal entries outside the cache root."""
    bad_tar = tmp_path / "bad.tar.bz2"
    payload = tmp_path / "x.txt"
    payload.write_text("hi", encoding="utf-8")
    with tarfile.open(bad_tar, "w:bz2") as tar:
        tar.add(payload, arcname="../escape.txt")
    with pytest.raises(diarizer.DiarizationError):
        diarizer._safe_extract_tar_bz2(bad_tar, tmp_path / "out")


def test_local_diarizer_maps_sorted_turns(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """LocalDiarizer returns SpeakerTurn objects mapped cleanly from engine output."""
    wav = tmp_path / "clip.wav"
    _write_pcm16_wav(wav, np.zeros(8000, dtype=np.float32))

    fake_result = SimpleNamespace(
        sort_by_start_time=lambda: [
            SimpleNamespace(start=0.0, end=1.2, speaker=0),
            SimpleNamespace(start=1.3, end=2.8, speaker=1),
        ]
    )
    fake_engine = SimpleNamespace(process=lambda samples: fake_result, set_config=lambda cfg: None)
    instance = diarizer.LocalDiarizer(cache_dir=tmp_path)
    monkeypatch.setattr(instance, "_get_engine", lambda n: fake_engine)

    turns = instance.diarize(wav, num_speakers=2)
    assert [(t.start, t.end, t.speaker) for t in turns] == [(0.0, 1.2, "0"), (1.3, 2.8, "1")]
