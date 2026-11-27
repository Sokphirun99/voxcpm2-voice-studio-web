"""Unit and FFmpeg smoke tests for media audio extraction and ASS subtitle burn-in."""

from __future__ import annotations

import json
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
    resolve_ffprobe_bin,
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

    overflow_graph = _build_dub_filter_complex(
        [DubClip(wav_path=tmp_path / "clip.wav", start_seconds=0.2, end_seconds=1.0, allow_overflow=True)],
        [1.5],
        "duck",
        True,
        3.0,
    )
    assert "atempo=" not in overflow_graph

    overflow_graph = _build_dub_filter_complex(
        [DubClip(wav_path=tmp_path / "clip.wav", start_seconds=0.2, end_seconds=1.0, allow_overflow=True)],
        [1.5],
        "mute",
        False,
        3.0,
    )
    assert "atempo=" not in overflow_graph

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


def _probe_streams(media_path: Path) -> tuple[dict, list[dict]]:
    ffprobe_bin = resolve_ffprobe_bin()
    proc = subprocess.run(
        [ffprobe_bin, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(media_path)],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(proc.stdout)
    return payload.get("format") or {}, payload.get("streams") or []


def test_export_presets_mp4_codecs_duration_language_and_non_mp4_transcoding(tmp_path: Path) -> None:
    ffmpeg_bin = resolve_ffmpeg_bin()
    if not Path(ffmpeg_bin).exists() and not shutil.which(ffmpeg_bin):
        pytest.skip("ffmpeg not installed")

    clip_a = _write_test_wav(tmp_path / "clip.wav", 0.5)

    # 1. Odd dimensions + yuv444p source must transcode cleanly to yuv420p H.264 even dims on dubbing
    odd_mkv = tmp_path / "odd_444.mkv"
    subprocess.run([
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", "color=c=#202020:s=321x241:d=1.4:r=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1.4",
        "-c:v", "libx264", "-pix_fmt", "yuv444p", "-c:a", "aac", "-shortest",
        str(odd_mkv),
    ], check=True, capture_output=True)

    dubbed_mp4 = tmp_path / "dubbed-khmer.mp4"
    mux_dubbed_audio(
        odd_mkv,
        [DubClip(wav_path=clip_a, start_seconds=0.1, end_seconds=0.9, segment_id="seg-1")],
        dubbed_mp4,
        original_audio_mode="duck",
        ffmpeg_bin=ffmpeg_bin,
        audio_language="khm_Khmr",
    )
    fmt, streams = _probe_streams(dubbed_mp4)
    v_stream = next(s for s in streams if s.get("codec_type") == "video")
    a_stream = next(s for s in streams if s.get("codec_type") == "audio")
    assert v_stream["codec_name"] == "h264"
    assert v_stream["pix_fmt"] == "yuv420p"
    assert v_stream["width"] % 2 == 0 and v_stream["height"] % 2 == 0
    assert a_stream["codec_name"] == "aac"
    assert str(a_stream.get("sample_rate")) == "48000"
    assert (a_stream.get("tags") or {}).get("language") == "khm"
    assert 1.1 <= float(fmt["duration"]) <= 1.7

    # 2. Burned MP4 preserves audio language metadata and standard MP4 codecs
    ass_path = tmp_path / "subs.ass"
    ass_path.write_text(
        build_ass([SubtitleSegment(start=0.1, end=1.1, text="សួស្តី", speaker_id="speaker-1")], video_size=(320, 240)),
        encoding="utf-8",
    )
    burned_mp4 = tmp_path / "burned-en.mp4"
    burn_ass_subtitles(odd_mkv, ass_path, burned_mp4, ffmpeg_bin=ffmpeg_bin, audio_language="en-US")
    burn_fmt, burn_streams = _probe_streams(burned_mp4)
    bv = next(s for s in burn_streams if s.get("codec_type") == "video")
    ba = next(s for s in burn_streams if s.get("codec_type") == "audio")
    assert bv["codec_name"] == "h264"
    assert bv["pix_fmt"] == "yuv420p"
    assert bv["width"] == 320 and bv["height"] == 240
    assert ba["codec_name"] == "aac"
    assert str(ba.get("sample_rate")) == "48000"
    assert ba.get("channels") == 2
    assert (ba.get("tags") or {}).get("language") == "eng"
    assert 1.1 <= float(burn_fmt["duration"]) <= 1.7

    # 3. HEVC MKV source stream-copies with hvc1 QuickTime/Safari-compatible tag and silent burn keeps audio_language
    hevc_mkv = tmp_path / "hevc.mkv"
    subprocess.run([
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", "color=c=#181818:s=320x240:d=1.2:r=24",
        "-c:v", "libx265", "-pix_fmt", "yuv420p", "-an",
        str(hevc_mkv),
    ], check=True, capture_output=True)
    silent_burned = tmp_path / "hevc-silent-burned.mp4"
    burn_ass_subtitles(hevc_mkv, ass_path, silent_burned, ffmpeg_bin=ffmpeg_bin, audio_language="km")
    _, sb_streams = _probe_streams(silent_burned)
    assert any(s.get("codec_type") == "video" and s.get("codec_name") == "h264" for s in sb_streams)
    assert not any(s.get("codec_type") == "audio" for s in sb_streams)

    hevc_out = tmp_path / "hevc-dub.mp4"
    mux_dubbed_audio(
        hevc_mkv,
        [DubClip(wav_path=clip_a, start_seconds=0.1, end_seconds=0.8)],
        hevc_out,
        original_audio_mode="mute",
        ffmpeg_bin=ffmpeg_bin,
        audio_language="ja",
    )
    _, hevc_streams = _probe_streams(hevc_out)
    hv = next(s for s in hevc_streams if s.get("codec_type") == "video")
    ha = next(s for s in hevc_streams if s.get("codec_type") == "audio")
    assert hv["codec_name"] == "hevc"
    assert hv["codec_tag_string"] == "hvc1"
    assert (ha.get("tags") or {}).get("language") == "jpn"


def _decode_window_rms(media_path: Path, ffmpeg_bin: str, start_sec: float, end_sec: float) -> float:
    """Decode mono 48 kHz s16le PCM samples from `media_path` and return RMS amplitude in `[start_sec, end_sec]`."""
    import array
    import math

    proc = subprocess.run(
        [ffmpeg_bin, "-v", "error", "-i", str(media_path), "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"],
        capture_output=True,
        check=True,
    )
    samples = array.array("h")
    samples.frombytes(proc.stdout)
    lo = max(0, int(round(start_sec * 48000)))
    hi = min(len(samples), int(round(end_sec * 48000)))
    window = samples[lo:hi]
    assert len(window) > 100
    return math.sqrt(sum(float(x) * float(x) for x in window) / len(window))


def _write_silent_wav(path: Path, duration_seconds: float, sample_rate: int = 48000) -> Path:
    num_frames = int(round(sample_rate * duration_seconds))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * num_frames)
    return path


def test_r309_audio_modes_ducking_gains_and_subtitle_modes_match_selected_output(tmp_path: Path) -> None:
    from video_io import DubAudioMixConfig, VideoSubtitleRenderSpec

    ffmpeg_bin = resolve_ffmpeg_bin()
    if not Path(ffmpeg_bin).exists() and not shutil.which(ffmpeg_bin):
        pytest.skip("ffmpeg not installed")

    src_mp4 = tmp_path / "tone_src.mp4"
    subprocess.run([
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", "color=c=#141414:s=320x240:d=3.0:r=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3.0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest",
        str(src_mp4),
    ], check=True, capture_output=True)

    silent_clip = _write_silent_wav(tmp_path / "silent_dub.wav", 0.8)
    loud_clip = _write_test_wav(tmp_path / "loud_dub.wav", 0.8)
    dub_window = [DubClip(wav_path=silent_clip, start_seconds=0.6, end_seconds=1.5, segment_id="seg-1")]

    # 1. Original mode: keeps original audio only, respects original_volume, rejects clips or silent videos
    orig_full = mux_dubbed_audio(src_mp4, [], tmp_path / "orig_full.mp4", original_audio_mode="original", ffmpeg_bin=ffmpeg_bin)
    orig_half = mux_dubbed_audio(
        src_mp4, [], tmp_path / "orig_half.mp4", original_audio_mode="original", ffmpeg_bin=ffmpeg_bin,
        mix_config=DubAudioMixConfig(mode="original", original_volume=0.5),
    )
    rms_orig_full = _decode_window_rms(orig_full, ffmpeg_bin, 0.7, 1.3)
    rms_orig_half = _decode_window_rms(orig_half, ffmpeg_bin, 0.7, 1.3)
    assert rms_orig_full > 1000
    assert 0.42 <= (rms_orig_half / rms_orig_full) <= 0.58

    with pytest.raises(MediaProcessingError, match="not permitted"):
        mux_dubbed_audio(src_mp4, dub_window, tmp_path / "orig_bad.mp4", original_audio_mode="original", ffmpeg_bin=ffmpeg_bin)

    silent_src = tmp_path / "silent_src.mp4"
    subprocess.run([
        ffmpeg_bin, "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2.0:r=24",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(silent_src),
    ], check=True, capture_output=True)
    with pytest.raises(MediaProcessingError, match="no original audio"):
        mux_dubbed_audio(silent_src, [], tmp_path / "orig_silent_fail.mp4", original_audio_mode="original", ffmpeg_bin=ffmpeg_bin)

    # 2. Replacement (`replace` -> `mute`) mode: zeroes out original audio outside dub window and scales dub_volume
    rep_mp4 = mux_dubbed_audio(
        src_mp4,
        [DubClip(wav_path=loud_clip, start_seconds=0.6, end_seconds=1.5, segment_id="seg-1")],
        tmp_path / "replace.mp4",
        original_audio_mode="replace",
        ffmpeg_bin=ffmpeg_bin,
        mix_config=DubAudioMixConfig(mode="replace", dub_volume=1.25),
    )
    assert _decode_window_rms(rep_mp4, ffmpeg_bin, 0.05, 0.45) < 5.0
    assert _decode_window_rms(rep_mp4, ffmpeg_bin, 0.70, 1.25) > 3500.0
    assert _decode_window_rms(rep_mp4, ffmpeg_bin, 1.80, 2.60) < 5.0

    # 3. Speech-gated ducking (`duck`) vs balanced mix (`mix` -> `keep`)
    duck_15 = mux_dubbed_audio(src_mp4, dub_window, tmp_path / "duck15.mp4", original_audio_mode="duck", ffmpeg_bin=ffmpeg_bin)
    duck_50 = mux_dubbed_audio(
        src_mp4, dub_window, tmp_path / "duck50.mp4", original_audio_mode="duck", ffmpeg_bin=ffmpeg_bin,
        mix_config=DubAudioMixConfig(mode="duck", original_volume=1.0, duck_volume=0.5),
    )
    keep_mp4 = mux_dubbed_audio(src_mp4, dub_window, tmp_path / "mix_keep.mp4", original_audio_mode="mix", ffmpeg_bin=ffmpeg_bin)

    pre_rms = _decode_window_rms(duck_15, ffmpeg_bin, 0.05, 0.40)
    mid_duck15 = _decode_window_rms(duck_15, ffmpeg_bin, 0.75, 1.25)
    post_rms = _decode_window_rms(duck_15, ffmpeg_bin, 1.90, 2.60)
    mid_duck50 = _decode_window_rms(duck_50, ffmpeg_bin, 0.75, 1.25)
    mid_keep = _decode_window_rms(keep_mp4, ffmpeg_bin, 0.75, 1.25)

    assert 0.10 <= (mid_duck15 / pre_rms) <= 0.22
    assert 0.88 <= (post_rms / pre_rms) <= 1.12
    assert 0.42 <= (mid_duck50 / pre_rms) <= 0.58
    assert 0.90 <= (mid_keep / pre_rms) <= 1.10

    # 4. Subtitle modes: `none` strips existing container subtitles (-sn), `soft` preserves full duration + UTF-8 Khmer, `burned` renders ASS with -sn
    srt_file = tmp_path / "khmer.srt"
    srt_file.write_text("1\n00:00:00,200 --> 00:00:01,000\nសួស្តីកម្ពុជា!\nHello Cambodia!\n", encoding="utf-8")

    mkv_with_subs = tmp_path / "with_subs.mkv"
    subprocess.run([
        ffmpeg_bin, "-y", "-i", str(src_mp4), "-i", str(srt_file), "-c", "copy", str(mkv_with_subs),
    ], check=True, capture_output=True)

    no_sub_mp4 = mux_dubbed_audio(
        mkv_with_subs, [], tmp_path / "none_subs.mp4", original_audio_mode="original", ffmpeg_bin=ffmpeg_bin,
        subtitle_spec=VideoSubtitleRenderSpec(mode="none"),
    )
    _, none_streams = _probe_streams(no_sub_mp4)
    assert not any(s.get("codec_type") == "subtitle" for s in none_streams)

    soft_mp4 = mux_dubbed_audio(
        src_mp4,
        [DubClip(wav_path=loud_clip, start_seconds=0.2, end_seconds=1.1, segment_id="seg-1")],
        tmp_path / "soft_subs.mp4",
        original_audio_mode="duck",
        ffmpeg_bin=ffmpeg_bin,
        audio_language="khm_Khmr",
        subtitle_spec=VideoSubtitleRenderSpec(mode="soft", srt_path=srt_file, subtitle_language="khm_Khmr"),
    )
    soft_fmt, soft_streams = _probe_streams(soft_mp4)
    assert 2.8 <= float(soft_fmt["duration"]) <= 3.2
    sub_stream = next(s for s in soft_streams if s.get("codec_type") == "subtitle")
    assert sub_stream["codec_name"] == "mov_text"
    assert (sub_stream.get("tags") or {}).get("language") == "khm"
    roundtrip_srt = subprocess.run(
        [ffmpeg_bin, "-v", "error", "-i", str(soft_mp4), "-map", "0:s:0", "-f", "srt", "-"],
        capture_output=True, text=True, check=True,
    ).stdout
    assert "សួស្តីកម្ពុជា!" in roundtrip_srt
    assert "Hello Cambodia!" in roundtrip_srt

    ass_file = tmp_path / "dub_burn.ass"
    ass_file.write_text(
        build_ass([SubtitleSegment(start=0.2, end=1.2, text="សួស្តីពិភពលោក", speaker_id="speaker-1")], video_size=(320, 240)),
        encoding="utf-8",
    )
    burned_dub_mp4 = mux_dubbed_audio(
        mkv_with_subs,
        [DubClip(wav_path=loud_clip, start_seconds=0.2, end_seconds=1.1, segment_id="seg-1")],
        tmp_path / "burned_dub.mp4",
        original_audio_mode="replace",
        ffmpeg_bin=ffmpeg_bin,
        subtitle_spec=VideoSubtitleRenderSpec(mode="burned", ass_path=ass_file),
    )
    burned_fmt, burned_streams = _probe_streams(burned_dub_mp4)
    assert 2.8 <= float(burned_fmt["duration"]) <= 3.2
    assert any(s.get("codec_type") == "video" and s.get("codec_name") == "h264" for s in burned_streams)
    assert not any(s.get("codec_type") == "subtitle" for s in burned_streams)

    # 5. Strict validation rejects invalid gains, modes, and empty subtitle files
    empty_srt = tmp_path / "empty.srt"
    empty_srt.write_text("", encoding="utf-8")
    with pytest.raises(MediaProcessingError, match="SRT subtitle file"):
        mux_dubbed_audio(src_mp4, [], tmp_path / "bad_srt.mp4", original_audio_mode="original", subtitle_spec=VideoSubtitleRenderSpec(mode="soft", srt_path=empty_srt))
    with pytest.raises(MediaProcessingError, match="duck_volume"):
        mux_dubbed_audio(src_mp4, dub_window, tmp_path / "bad_gain.mp4", mix_config=DubAudioMixConfig(mode="duck", duck_volume=0.95))
    with pytest.raises(MediaProcessingError, match="subtitle mode"):
        mux_dubbed_audio(src_mp4, [], tmp_path / "bad_submode.mp4", original_audio_mode="original", subtitle_spec=VideoSubtitleRenderSpec(mode="vtt"))


def test_r309_120_duck_windows_delayed_audio_pts_multi_audio_disposition_and_ass_escaping(tmp_path: Path) -> None:
    from video_io import VideoSubtitleRenderSpec, probe_primary_audio_index

    ffmpeg_bin = resolve_ffmpeg_bin()
    if not Path(ffmpeg_bin).exists() and not shutil.which(ffmpeg_bin):
        pytest.skip("ffmpeg not installed")

    # 1. 120 disjoint duck windows (`MAX_DUB_CLIPS = 120`) succeed without FFmpeg av_expr_parse ENOMEM
    long_src = tmp_path / "long_125s.mp4"
    subprocess.run([
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", "color=c=#141414:s=160x160:d=122.0:r=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=122.0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(long_src),
    ], check=True, capture_output=True)
    tiny_silent = _write_silent_wav(tmp_path / "tiny_silent.wav", 0.2)
    clips_120 = [
        DubClip(wav_path=tiny_silent, start_seconds=float(i), end_seconds=float(i) + 0.3, segment_id=f"s-{i}")
        for i in range(120)
    ]
    out_120 = mux_dubbed_audio(long_src, clips_120, tmp_path / "out_120.mp4", original_audio_mode="duck", ffmpeg_bin=ffmpeg_bin)
    assert out_120.is_file() and out_120.stat().st_size > 1000
    ducked_rms = _decode_window_rms(out_120, ffmpeg_bin, 100.02, 100.18)
    unducked_rms = _decode_window_rms(out_120, ffmpeg_bin, 100.55, 100.85)
    assert 0.10 <= (ducked_rms / unducked_rms) <= 0.22

    # 2. Delayed original audio stream (`-itsoffset 1.0`) keeps DubClip at 0.2..0.6s instead of shifting to 1.2..1.6s
    delayed_a = tmp_path / "delayed_audio.mp4"
    subprocess.run([
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", "color=c=#222222:s=320x240:d=3.0:r=12",
        "-itsoffset", "1.0", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2.0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        str(delayed_a),
    ], check=True, capture_output=True)
    asr_wav = tmp_path / "delayed_asr.wav"
    extract_audio_16k_wav(delayed_a, asr_wav, ffmpeg_bin)
    with wave.open(str(asr_wav), "rb") as wf:
        assert 2.8 <= (wf.getnframes() / float(wf.getframerate())) <= 3.2

    loud_dub = _write_test_wav(tmp_path / "loud_dub_400ms.wav", 0.4)
    delayed_out = mux_dubbed_audio(
        delayed_a,
        [DubClip(wav_path=loud_dub, start_seconds=0.2, end_seconds=0.8, segment_id="seg-1")],
        tmp_path / "delayed_dubbed.mp4",
        original_audio_mode="duck",
        ffmpeg_bin=ffmpeg_bin,
    )
    assert _decode_window_rms(delayed_out, ffmpeg_bin, 0.02, 0.14) < 10.0
    assert _decode_window_rms(delayed_out, ffmpeg_bin, 0.25, 0.55) > 2500.0

    # 3. Multi-audio-stream `.mkv` where primary dialogue is on `0:a:1` (`disposition.default == 1`)
    dual_mkv = tmp_path / "dual_audio.mkv"
    subprocess.run([
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", "color=c=#222222:s=320x240:d=2.0:r=12",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2.0",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2.0",
        "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
        "-disposition:a:0", "0", "-disposition:a:1", "default",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        str(dual_mkv),
    ], check=True, capture_output=True)
    assert probe_primary_audio_index(dual_mkv) == 1
    dual_orig = mux_dubbed_audio(dual_mkv, [], tmp_path / "dual_orig.mp4", original_audio_mode="original", ffmpeg_bin=ffmpeg_bin)
    assert _decode_window_rms(dual_orig, ffmpeg_bin, 0.2, 1.5) > 1500.0

    # 4. Special filter delimiter characters in ASS filename (`:`, `,`, `[`, `]`) burn cleanly
    special_ass = tmp_path / "sub:1,[khmer].ass"
    special_ass.write_text(
        build_ass([SubtitleSegment(start=0.1, end=1.2, text="សួស្តី", speaker_id="speaker-1")], video_size=(320, 240)),
        encoding="utf-8",
    )
    special_burned = mux_dubbed_audio(
        dual_mkv, [], tmp_path / "special_burned.mp4", original_audio_mode="original", ffmpeg_bin=ffmpeg_bin,
        subtitle_spec=VideoSubtitleRenderSpec(mode="burned", ass_path=special_ass),
    )
    assert special_burned.is_file() and special_burned.stat().st_size > 1000
