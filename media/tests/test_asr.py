"""Unit tests for media/asr.py VAD fallback turns, splitting guards, and Qwen batching."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np

from asr import (
    MIN_TURN_SEC,
    SAMPLE_RATE,
    VAD_MIN_SILENCE_SEC,
    KhmerWhisperTranscriber,
    _append_vad_turn,
    _find_quietest_split_sec,
    _merge_vad_regions,
    prepare_speech_turns,
)
from subtitles import SpeakerTurn


def test_prepare_speech_turns_vad_skips_silence_and_splits_pauses() -> None:
    """When diarization is off (turns=None), VAD detects active speech intervals and skips silence."""
    audio = np.zeros(SAMPLE_RATE * 6, dtype=np.float32)
    # Speech burst 1: 1.0s .. 2.2s
    audio[int(SAMPLE_RATE * 1.0) : int(SAMPLE_RATE * 2.2)] = 0.2
    # Speech burst 2: 3.5s .. 5.0s
    audio[int(SAMPLE_RATE * 3.5) : int(SAMPLE_RATE * 5.0)] = 0.2

    turns = prepare_speech_turns(audio, turns=None)
    assert len(turns) == 2
    assert 0.8 <= turns[0].start <= 1.05
    assert 2.15 <= turns[0].end <= 2.4
    assert 3.3 <= turns[1].start <= 3.55
    assert 4.95 <= turns[1].end <= 5.2


def test_prepare_speech_turns_handles_silent_and_near_end_split() -> None:
    """Silent audio returns [] and near-end split points never crash or yield NaN."""
    assert prepare_speech_turns(np.zeros(SAMPLE_RATE * 2, dtype=np.float32), turns=None) == []
    assert prepare_speech_turns(np.zeros(0, dtype=np.float32), turns=None) == []

    short_audio = np.ones(100, dtype=np.float32) * 0.1
    split_val = _find_quietest_split_sec(SpeakerTurn(start=0.0, end=0.005, speaker="0"), short_audio)
    assert np.isfinite(split_val)


def test_khmer_transcriber_batches_qwen_chunks_above_batch_size(tmp_path: Path) -> None:
    """KhmerWhisperTranscriber batches >16 speech turns cleanly without dropping segments."""
    transcriber = KhmerWhisperTranscriber()
    batch_sizes: list[int] = []

    class _FakeQwen:
        def transcribe(self, chunks: list[tuple[np.ndarray, int]]) -> list[SimpleNamespace]:
            batch_sizes.append(len(chunks))
            return [SimpleNamespace(text="សួស្តី") for _ in chunks]

    transcriber._qwen_asr = _FakeQwen()
    audio = np.ones(SAMPLE_RATE * 20, dtype=np.float32) * 0.1
    turns = [SpeakerTurn(start=i * 0.8, end=(i + 1) * 0.8, speaker="0") for i in range(20)]
    segments = transcriber._transcribe_turns_locked(audio, turns)
    assert batch_sizes == [16, 4]
    assert len(segments) == 20
    assert all(seg["text"] == "សួស្តី" for seg in segments)


def test_vad_captures_sparse_speech_loud_sfx_and_quiet_rms_turns() -> None:
    """VAD captures brief speech (<5% of clip), preserves speech alongside loud spikes, and transcribes quiet RMS speech."""
    # 1. Brief 1.2s speech inside a 40s silent clip (<5% of duration)
    sparse = np.zeros(SAMPLE_RATE * 40, dtype=np.float32)
    sparse[SAMPLE_RATE * 10 : int(SAMPLE_RATE * 11.2)] = 0.2
    sparse_turns = prepare_speech_turns(sparse, turns=None)
    assert len(sparse_turns) == 1
    assert 9.8 <= sparse_turns[0].start <= 10.1
    assert 11.1 <= sparse_turns[0].end <= 11.4

    # 2. Loud 0.8s SFX (0.8) alongside quieter speech (0.04) and background hum (0.002)
    mixed = np.ones(SAMPLE_RATE * 10, dtype=np.float32) * 0.002
    mixed[SAMPLE_RATE * 1 : int(SAMPLE_RATE * 1.8)] = 0.8
    mixed[SAMPLE_RATE * 3 : SAMPLE_RATE * 9] = 0.04
    mixed_turns = prepare_speech_turns(mixed, turns=None)
    assert any(t.start <= 3.2 and t.end >= 8.8 for t in mixed_turns)

    # 3. Quiet speech turn with RMS 0.003 (above MIN_RMS_ENERGY 1e-5) is not dropped
    transcriber = KhmerWhisperTranscriber()
    transcriber._qwen_asr = SimpleNamespace(transcribe=lambda chunks: [SimpleNamespace(text="សួស្តី") for _ in chunks])
    quiet_audio = np.ones(SAMPLE_RATE * 2, dtype=np.float32) * 0.003
    segs = transcriber._transcribe_turns_locked(quiet_audio, [SpeakerTurn(start=0.0, end=2.0, speaker="0")])
    assert len(segs) == 1
    assert segs[0]["text"] == "សួស្តី"


def test_merge_vad_regions_and_append_vad_turn_edge_cases() -> None:
    """_merge_vad_regions handles empty, index-0 active, sub-min-turn blips, short/long gaps, and trailing flush."""
    frame_sec = 0.03
    assert _merge_vad_regions(np.zeros(0, dtype=bool), frame_sec, 0.0) == []
    assert _merge_vad_regions(np.zeros(50, dtype=bool), frame_sec, 1.5) == []

    # Sub-MIN_TURN_SEC isolated single-frame blip is ignored by _append_vad_turn (both edge-clamped and interior)
    turns: list[SpeakerTurn] = []
    _append_vad_turn(turns, (5, 5), 0.01, 2.0)
    _append_vad_turn(turns, (50, 50), 0.01, 2.0)
    assert turns == []
    assert (MIN_TURN_SEC - 0.01) > 0

    # Active at frame 0 + brief gap (< VAD_MIN_SILENCE_SEC) merges; long gap splits; trailing active flushes
    active = np.zeros(120, dtype=bool)
    active[0:20] = True
    # Short gap: 3 frames = 0.09s (< VAD_MIN_SILENCE_SEC=0.32s)
    active[23:45] = True
    # Long gap: 20 frames = 0.60s (>= VAD_MIN_SILENCE_SEC)
    gap_frames = int(round(VAD_MIN_SILENCE_SEC / frame_sec)) + 4
    second_start = 45 + gap_frames
    active[second_start:120] = True

    merged = _merge_vad_regions(active, frame_sec, total_sec=3.6)
    assert len(merged) == 2
    assert merged[0].start == 0.0
    assert merged[1].end == 3.6
