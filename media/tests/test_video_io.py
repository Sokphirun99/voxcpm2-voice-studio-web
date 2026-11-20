"""Unit and FFmpeg smoke tests for media audio extraction and ASS subtitle burn-in."""

from __future__ import annotations

import shutil
import subprocess
import wave
from pathlib import Path

import pytest

import video_io
from subtitles import SubtitleSegment, build_ass
from video_io import (
    DubClip,
    MediaProcessingError,
    _build_dub_filter_complex,
    _compute_clip_atempo,
    _extract_ffmpeg_error,
    _resolve_clip_slot_seconds,
    burn_ass_subtitles,
    check_burnin_support,
    extract_audio_16k_wav,
    has_audio_stream,
    has_video_stream,
    mux_dubbed_audio,
    probe_media_duration,
    probe_video_dimensions,
    resolve_ffmpeg_bin,
)


def test_ffmpeg_full_supports_ass_filter_and_burns_real_sample_clip(tmp_path: Path) -> None:
    ffmpeg_bin = resolve_ffmpeg_bin()
    if not Path(ffmpeg_bin).exists() and not shutil.which(ffmpeg_bin):
        pytest.skip("ffmpeg not installed")
    assert check_burnin_support(ffmpeg_bin) is True

    sample_mp4 = tmp_path / "sample.mp4"
    gen_cmd = [
        ffmpeg_bin,
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=#161616:s=640x360:d=1.5",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=1.5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        str(sample_mp4),
    ]
    subprocess.run(gen_cmd, check=True, capture_output=True)

    assert probe_video_dimensions(sample_mp4) == (640, 360)

    wav_out = tmp_path / "audio.wav"
    extract_audio_16k_wav(sample_mp4, wav_out, ffmpeg_bin)
    assert wav_out.is_file() and wav_out.stat().st_size > 1000

    ass_path = tmp_path / "subs.ass"
    ass_path.write_text(
        build_ass([SubtitleSegment(start=0.1, end=1.4, text="សួស្តីអ្នកទាំងអស់គ្នា!", speaker_id="speaker-1")], video_size=(640, 360)),
        encoding="utf-8",
    )
    burned_mp4 = tmp_path / "burned.mp4"
    burn_ass_subtitles(sample_mp4, ass_path, burned_mp4, ffmpeg_bin)
    assert burned_mp4.is_file() and burned_mp4.stat().st_size > 1000


def test_burn_fails_loudly_when_ffmpeg_lacks_libass(tmp_path: Path) -> None:
    fake_ffmpeg = tmp_path / "fake_ffmpeg"
    fake_ffmpeg.write_text("#!/bin/sh\necho ' .. anull A->A'\n", encoding="utf-8")
    fake_ffmpeg.chmod(0o755)
    with pytest.raises(MediaProcessingError, match="libass"):
        burn_ass_subtitles(tmp_path / "in.mp4", tmp_path / "s.ass", tmp_path / "out.mp4", str(fake_ffmpeg))


def test_burn_handles_odd_video_dimensions_with_yuv420p(tmp_path: Path) -> None:
    ffmpeg_bin = resolve_ffmpeg_bin()
    if not Path(ffmpeg_bin).exists() and not shutil.which(ffmpeg_bin):
        pytest.skip("ffmpeg not installed")

    odd_mp4 = tmp_path / "odd.mp4"
    gen_cmd = [
        ffmpeg_bin,
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=#161616:s=641x361:d=1.0",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=1.0",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv444p",
        "-c:a",
        "aac",
        str(odd_mp4),
    ]
    subprocess.run(gen_cmd, check=True, capture_output=True)
    assert probe_video_dimensions(odd_mp4) == (641, 361)

    ass_path = tmp_path / "odd.ass"
    ass_path.write_text(
        build_ass([SubtitleSegment(start=0.0, end=0.9, text="Odd dimensions test", speaker_id="speaker-1")], video_size=(641, 361)),
        encoding="utf-8",
    )
    burned_mp4 = tmp_path / "odd-burned.mp4"
    burn_ass_subtitles(odd_mp4, ass_path, burned_mp4, ffmpeg_bin)
    assert burned_mp4.is_file() and burned_mp4.stat().st_size > 1000
    assert probe_video_dimensions(burned_mp4) == (640, 360)


def test_extract_ffmpeg_error_skips_generic_conversion_failed_and_dead_constant_removed(tmp_path: Path) -> None:
    assert not hasattr(video_io, "SPEECH_AUDIO_FILTER")

    stderr = "\n".join([
        "[libx264 @ 0x100] width not divisible by 2 (641x360)",
        "[vost#0:0/libx264 @ 0x100] Error while opening encoder - maybe incorrect parameters",
        "[vf#0:0 @ 0x100] Error sending frames to consumers: Generic error in an encoder",
        "[out#0/mp4 @ 0x100] Nothing was written into output file",
        "Conversion failed!",
    ])
    detail = _extract_ffmpeg_error(stderr, "Subtitle burn-in failed")
    assert "width not divisible by 2" in detail
    assert "Conversion failed!" not in detail

    filter_stderr = "\n".join([
        "[Parsed_ass_0 @ 0x100] ass_read_file(/tmp/bad.ass): fopen failed",
        "[Parsed_ass_0 @ 0x100] Could not create a libass track when reading file '/tmp/bad.ass'",
        "[AVFilterGraph @ 0x100] Error initializing filters",
        "Error opening output file /tmp/out.mp4.",
        "Error opening output files: Invalid argument",
    ])
    assert "fopen failed" in _extract_ffmpeg_error(filter_stderr, "Subtitle burn-in failed")

    perm_stderr = "\n".join([
        "Error opening output file /readonly/out.mp4.",
        "Error opening output files: Permission denied",
    ])
    assert "Permission denied" in _extract_ffmpeg_error(perm_stderr, "Subtitle burn-in failed")

    progress_only = "frame=    0 fps=0.0 q=0.0 Lsize=       0KiB time=N/A bitrate=N/A speed=N/A\nConversion failed!"
    assert _extract_ffmpeg_error(progress_only, "Subtitle burn-in failed") == "Subtitle burn-in failed"

    fake_ffmpeg = tmp_path / "fake_fail_ffmpeg"
    fake_ffmpeg.write_text(
        "#!/bin/sh\n"
        "if [ \"$2\" = \"-filters\" ]; then echo ' .. ass V->V'; exit 0; fi\n"
        "echo '[in#0 @ 0x1] Invalid data found when processing input' >&2\n"
        "echo 'Conversion failed!' >&2\n"
        "exit 1\n",
        encoding="utf-8",
    )
    fake_ffmpeg.chmod(0o755)
    with pytest.raises(MediaProcessingError, match="Invalid data found when processing input"):
        extract_audio_16k_wav(tmp_path / "bad.mp4", tmp_path / "out.wav", str(fake_ffmpeg))


def _write_test_wav(path: Path, duration_seconds: float, sample_rate: int = 48000) -> Path:
    """Create a valid mono 16-bit PCM WAV clip with audible tone."""
    num_frames = int(round(sample_rate * duration_seconds))
    samples = bytearray()
    for i in range(num_frames):
        val = 4000 if (i // 40) % 2 == 0 else -4000
        samples.extend(int(val).to_bytes(2, "little", signed=True))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(bytes(samples))
    return path


def test_mux_dubbed_audio_supports_duck_mute_keep_atempo_and_validation(tmp_path: Path) -> None:
    ffmpeg_bin = resolve_ffmpeg_bin()
    if not Path(ffmpeg_bin).exists() and not shutil.which(ffmpeg_bin):
        pytest.skip("ffmpeg not installed")

    # Unit checks for gentle atempo clamping [0.85, 1.25]
    assert _compute_clip_atempo(1.0, 1.5) is None
    assert _compute_clip_atempo(1.15, 1.0) == 1.15
    assert _compute_clip_atempo(2.5, 1.0) == 1.25
    overlapping = [
        DubClip(wav_path=tmp_path / "overlap-a.wav", start_seconds=0.0, end_seconds=1.2),
        DubClip(wav_path=tmp_path / "overlap-b.wav", start_seconds=0.8, end_seconds=1.5),
    ]
    assert _resolve_clip_slot_seconds(overlapping, 0) == 0.0
    assert _compute_clip_atempo(2.0, _resolve_clip_slot_seconds(overlapping, 0)) is None
    graph = _build_dub_filter_complex(
        [DubClip(wav_path=tmp_path / "clip.wav", start_seconds=0.2, end_seconds=1.0)],
        [0.5],
        "duck",
        True,
        2.0,
    )
    assert "adelay=200|200:all=1" in graph
    assert "volume=0.15" in graph
    assert "amix=inputs=2:duration=longest:dropout_transition=0:normalize=0" in graph

    sample_mp4 = tmp_path / "source.mp4"
    subprocess.run([
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", "color=c=#161616:s=640x360:d=2.5:r=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2.5",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(sample_mp4),
    ], check=True, capture_output=True)

    clip_a = _write_test_wav(tmp_path / "clip_a.wav", 0.4)
    clip_b = _write_test_wav(tmp_path / "clip_b.wav", 1.2)  # exceeds 0.6s slot -> clamped atempo=1.25
    clips = [
        DubClip(wav_path=clip_a, start_seconds=0.2, end_seconds=0.8, segment_id="seg-1"),
        DubClip(wav_path=clip_b, start_seconds=1.0, end_seconds=1.6, segment_id="seg-2"),
    ]

    for mode in ("duck", "mute", "keep"):
        out_mp4 = tmp_path / f"dubbed-{mode}.mp4"
        result = mux_dubbed_audio(sample_mp4, clips, out_mp4, original_audio_mode=mode, ffmpeg_bin=ffmpeg_bin)
        assert result == out_mp4
        assert out_mp4.is_file() and out_mp4.stat().st_size > 1000
        assert has_video_stream(out_mp4) is True
        assert has_audio_stream(out_mp4) is True
        assert probe_video_dimensions(out_mp4) == (640, 360)
        assert 2.0 <= probe_media_duration(out_mp4) <= 2.8

    # Silent source video (no audio track) succeeds even in duck mode
    silent_mp4 = tmp_path / "silent.mp4"
    subprocess.run([
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", "color=c=#222222:s=320x240:d=1.5:r=24",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
        str(silent_mp4),
    ], check=True, capture_output=True)
    silent_out = tmp_path / "silent-dubbed.mp4"
    mux_dubbed_audio(silent_mp4, [DubClip(wav_path=clip_a, start_seconds=0.1, end_seconds=0.8)], silent_out, original_audio_mode="duck", ffmpeg_bin=ffmpeg_bin)
    assert has_audio_stream(silent_out) is True
    assert probe_video_dimensions(silent_out) == (320, 240)

    # Validation & FFmpeg error extraction
    with pytest.raises(MediaProcessingError, match="original_audio_mode"):
        mux_dubbed_audio(sample_mp4, clips, tmp_path / "bad-mode.mp4", original_audio_mode="boost")
    with pytest.raises(MediaProcessingError, match="At least one"):
        mux_dubbed_audio(sample_mp4, [], tmp_path / "no-clips.mp4")
    with pytest.raises(MediaProcessingError, match="audio-only"):
        mux_dubbed_audio(clip_a, clips, tmp_path / "audio-only.mp4")

    fake_fail = tmp_path / "fake_dub_fail"
    fake_fail.write_text("#!/bin/sh\necho '[AVFilterGraph @ 0x1] Invalid filter parameter' >&2\necho 'Conversion failed!' >&2\nexit 1\n", encoding="utf-8")
    fake_fail.chmod(0o755)
    with pytest.raises(MediaProcessingError, match="Invalid filter parameter"):
        mux_dubbed_audio(sample_mp4, clips, tmp_path / "fail.mp4", ffmpeg_bin=str(fake_fail))
