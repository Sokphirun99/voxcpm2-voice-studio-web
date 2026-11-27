"""End-to-end R3-10 integration & external-player compatibility suite for media/."""

from __future__ import annotations

import json
import shutil
import struct
import subprocess
import wave
from pathlib import Path

from fastapi.testclient import TestClient
import numpy as np
import pytest

from jobs import MediaJobStore
from server import MediaServices, create_app
from subtitles import SpeakerTurn
from video_io import probe_media_duration, resolve_ffmpeg_bin, resolve_ffprobe_bin

VLC_BIN = Path("/Applications/VLC.app/Contents/MacOS/VLC")
AFINFO_BIN = Path("/usr/bin/afinfo")
SAMPLE_RATE_HZ = 48000


class _MultilingualTranscriber:
    """Deterministic multilingual + Khmer ASR fake supporting double_check and speech verification."""

    def transcribe(
        self,
        wav_path: Path,
        language: str | None = None,
        turns: list | None = None,
        double_check: bool = False,
    ) -> dict:
        assert wav_path.is_file() and wav_path.stat().st_size > 44
        if (language or "").lower() == "km":
            return {
                "language": "km",
                "segments": [
                    {"start": 0.0, "end": 2.4, "text": "សួស្តី អេស៊ីអិលដាប៊ែលយូ សេវាកម្មសំឡេង"},
                ],
            }
        return {
            "language": "en",
            "segments": [
                {
                    "start": 0.1,
                    "end": 1.15,
                    "text": "Welcome to ACWL Studio tour",
                    "words": [
                        {"word": "Welcome", "start": 0.1, "end": 0.45},
                        {"word": " to ACWL Studio tour", "start": 0.46, "end": 1.15},
                    ],
                },
                {
                    "start": 1.25,
                    "end": 2.25,
                    "text": "Today ACWL saves project takes cleanly",
                    "words": [
                        {"word": "Today", "start": 1.25, "end": 1.5},
                        {"word": " ACWL saves project takes cleanly", "start": 1.51, "end": 2.25},
                    ],
                },
            ],
        }


class _DualSpeakerDiarizer:
    """Two-speaker diarization stub matching realistic interview timing."""

    def diarize(self, wav_path: Path, num_speakers: int = 0) -> list[SpeakerTurn]:
        assert wav_path.is_file()
        return [
            SpeakerTurn(start=0.05, end=1.18, speaker="spk-1"),
            SpeakerTurn(start=1.22, end=2.3, speaker="spk-2"),
        ]


class _KhmerTranslator:
    """Deterministic EN->KM translator preserving literal source markers for terminology testing."""

    def translate_lines(self, lines: list[str], source_lang: str, target_lang: str = "km") -> list[str]:
        return [f"បកប្រែ៖ {line}" for line in lines]


def _make_sample_video(ffmpeg_bin: str, path: Path, duration_sec: float = 2.4) -> None:
    """Generate a 640x360 H.264 yuv420p MP4 with 48 kHz stereo audio tone."""
    cmd = [
        ffmpeg_bin, "-y",
        "-f", "lavfi", "-i", f"color=c=#182026:s=640x360:d={duration_sec}:r=24",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={SAMPLE_RATE_HZ}:duration={duration_sec}",
        "-ac", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", str(SAMPLE_RATE_HZ),
        "-shortest", str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    assert proc.returncode == 0, proc.stderr


def _make_pcm_wav_bytes(duration_sec: float, freq_hz: float = 880.0) -> bytes:
    """Build valid 48 kHz mono 16-bit PCM WAV bytes."""
    frames = max(1, int(round(SAMPLE_RATE_HZ * duration_sec)))
    t = np.arange(frames, dtype=np.float32) / float(SAMPLE_RATE_HZ)
    pcm = (np.sin(2.0 * np.pi * freq_hz * t) * 0.35 * 32767.0).astype(np.int16)
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE_HZ)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def _parse_top_level_mp4_atoms(mp4_path: Path) -> list[tuple[str, int]]:
    """Return `(atom_type, byte_offset)` for top-level ISO BMFF atoms in `mp4_path`."""
    data = mp4_path.read_bytes()
    atoms: list[tuple[str, int]] = []
    offset = 0
    total = len(data)
    while offset + 8 <= total:
        size = struct.unpack(">I", data[offset : offset + 4])[0]
        atom_type = data[offset + 4 : offset + 8].decode("ascii", errors="replace")
        atoms.append((atom_type, offset))
        if size == 1:
            if offset + 16 > total:
                break
            size = struct.unpack(">Q", data[offset + 8 : offset + 16])[0]
        elif size == 0:
            break
        if size < 8:
            break
        offset += size
    return atoms


def _assert_quicktime_faststart(mp4_path: Path) -> None:
    """Verify `ftyp` header exists and `moov` appears before `mdat` for QuickTime streaming."""
    atoms = _parse_top_level_mp4_atoms(mp4_path)
    offsets = {name: pos for name, pos in atoms}
    assert "ftyp" in offsets, f"Missing ftyp atom: {atoms}"
    assert "moov" in offsets, f"Missing moov atom: {atoms}"
    assert "mdat" in offsets, f"Missing mdat atom: {atoms}"
    assert offsets["moov"] < offsets["mdat"], f"moov must precede mdat (+faststart): {atoms}"


def _assert_mp4_streams_and_decode(
    mp4_path: Path,
    ffprobe_bin: str,
    ffmpeg_bin: str,
    *,
    expected_audio_lang: str,
    expected_subtitle_lang: str | None = None,
) -> None:
    """Assert QuickTime/VLC codecs, faststart atom order, zero decode errors, and optional subtitle stream."""
    _assert_quicktime_faststart(mp4_path)
    probe_cmd = [ffprobe_bin, "-v", "error", "-show_streams", "-of", "json", str(mp4_path)]
    streams = json.loads(subprocess.run(probe_cmd, capture_output=True, text=True, check=True).stdout)["streams"]
    video_streams = [s for s in streams if s.get("codec_type") == "video"]
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    sub_streams = [s for s in streams if s.get("codec_type") == "subtitle"]
    assert len(video_streams) == 1
    assert video_streams[0]["codec_name"] in {"h264", "hevc"}
    assert video_streams[0]["pix_fmt"] == "yuv420p"
    assert video_streams[0]["width"] % 2 == 0 and video_streams[0]["height"] % 2 == 0
    assert len(audio_streams) == 1
    assert audio_streams[0]["codec_name"] == "aac"
    assert audio_streams[0]["sample_rate"] == str(SAMPLE_RATE_HZ)
    assert audio_streams[0]["channels"] == 2
    assert (audio_streams[0].get("tags") or {}).get("language") == expected_audio_lang
    if expected_subtitle_lang:
        assert len(sub_streams) == 1
        assert sub_streams[0]["codec_name"] == "mov_text"
        assert (sub_streams[0].get("tags") or {}).get("language") == expected_subtitle_lang
        pkt_cmd = [ffprobe_bin, "-v", "error", "-show_packets", "-select_streams", "s:0", "-of", "json", str(mp4_path)]
        packets = json.loads(subprocess.run(pkt_cmd, capture_output=True, text=True, check=True).stdout).get("packets") or []
        assert len(packets) >= 1
    else:
        assert len(sub_streams) == 0

    decode_proc = subprocess.run([ffmpeg_bin, "-v", "error", "-i", str(mp4_path), "-f", "null", "-"], capture_output=True, text=True, timeout=30)
    assert decode_proc.returncode == 0, decode_proc.stderr
    assert decode_proc.stderr.strip() == ""
    assert 2.0 <= probe_media_duration(mp4_path, ffprobe_bin) <= 2.7


def _assert_external_mac_players_open(mp4_path: Path) -> None:
    """Verify CoreAudio/QuickTime parser (`afinfo`) and headless VLC playback succeed on `mp4_path`."""
    if AFINFO_BIN.is_file():
        af_proc = subprocess.run([str(AFINFO_BIN), str(mp4_path)], capture_output=True, text=True, timeout=20)
        assert af_proc.returncode == 0, af_proc.stderr
        assert "aac" in af_proc.stdout.lower()
    if VLC_BIN.is_file():
        vlc_cmd = [
            str(VLC_BIN),
            "--ignore-config",
            "-I", "dummy",
            "--vout=dummy",
            "--aout=dummy",
            "--play-and-exit",
            str(mp4_path),
        ]
        vlc_proc = subprocess.run(vlc_cmd, capture_output=True, text=True, timeout=30)
        assert vlc_proc.returncode == 0, vlc_proc.stderr


def _build_client(tmp_path: Path) -> TestClient:
    """Build FastAPI TestClient wired with deterministic local media services."""
    services = MediaServices(
        job_store=MediaJobStore(tmp_path / "jobs"),
        transcriber=_MultilingualTranscriber(),
        diarizer=_DualSpeakerDiarizer(),
        translator=_KhmerTranslator(),
    )
    return TestClient(create_app(services))


def _export_dub_case(
    client: TestClient,
    job_id: str,
    out_path: Path,
    *,
    data: dict[str, str],
    clips: list[tuple[str, bytes]],
) -> None:
    """Post one `/dub` scenario and persist the returned MP4 bytes to `out_path`."""
    files = [("files", (name, payload, "audio/wav")) for name, payload in clips]
    res = client.post("/dub", data={"jobId": job_id, **data}, files=files) if files else client.post("/dub", data={"jobId": job_id, **data})
    assert res.status_code == 200, res.text
    out_path.write_bytes(res.content)


def test_r310_media_full_workflow_and_quicktime_vlc_dub_modes(tmp_path: Path) -> None:
    """Validate transcribe->translate->verify->burn->dub across all modes with QuickTime & VLC compatibility."""
    ffmpeg_bin = resolve_ffmpeg_bin()
    ffprobe_bin = resolve_ffprobe_bin()
    if not (Path(ffmpeg_bin).exists() or shutil.which(ffmpeg_bin)):
        pytest.skip("ffmpeg not installed")
    if not (Path(ffprobe_bin).exists() or shutil.which(ffprobe_bin)):
        pytest.skip("ffprobe not installed")

    client = _build_client(tmp_path)
    assert client.get("/health").json()["burnInSupported"] is True

    source_mp4 = tmp_path / "lesson-en.mp4"
    _make_sample_video(ffmpeg_bin, source_mp4, duration_sec=2.4)

    terminology = [
        {"id": "t-spell", "category": "spelling", "status": "approved", "enabled": True, "term": "ACL", "variants": ["ACWL"], "sourceLanguage": "en"},
        {"id": "t-trans", "category": "translation", "status": "approved", "enabled": True, "term": "Studio", "translation": "ស្ទូឌីយោ", "sourceLanguage": "en", "targetLanguage": "km"},
        {"id": "t-pron", "category": "pronunciation", "status": "approved", "enabled": True, "term": "ACL", "pronunciation": "អេស៊ីអិលដាប៊ែលយូ", "sourceLanguage": "km"},
    ]
    with open(source_mp4, "rb") as fh:
        tr = client.post(
            "/transcribe",
            files={"file": ("lesson-en.mp4", fh, "video/mp4")},
            data={
                "language": "en",
                "num_speakers": "2",
                "diarize": "true",
                "translate_to": "khm_Khmr",
                "terminology": json.dumps(terminology),
            },
        )
    assert tr.status_code == 200, tr.text
    tr_body = tr.json()
    job_id = tr_body["jobId"]
    segments = tr_body["segments"]
    assert tr_body["hasAudioStream"] is True
    assert len(segments) >= 2
    assert "ACL" in segments[0]["text"] and "ACWL" not in segments[0]["text"]
    assert "ស្ទូឌីយោ" in segments[0]["translatedText"]
    assert "អេស៊ីអិលដាប៊ែលយូ" not in segments[0]["text"]

    translated = client.post(
        "/translate",
        json={"segments": segments, "sourceLanguage": "en", "targetLanguage": "khm_Khmr", "terminology": terminology},
    )
    assert translated.status_code == 200, translated.text

    khmer_tts_wav = tmp_path / "khmer-tts.wav"
    khmer_tts_wav.write_bytes(_make_pcm_wav_bytes(0.8, 660.0))
    with open(khmer_tts_wav, "rb") as fh:
        verify = client.post(
            "/verify-speech",
            files={"file": ("khmer-tts.wav", fh, "audio/wav")},
            data={"expected_text": "សួស្តី អេស៊ីអិលដាប៊ែលយូ សេវាកម្មសំឡេង", "language": "km"},
        )
    assert verify.status_code == 200, verify.text
    assert verify.json()["verdict"] == "pass"

    burn_res = client.post(
        "/burn",
        json={
            "jobId": job_id,
            "segments": segments,
            "speakerNames": {"speaker-1": "Host", "speaker-2": "Guest"},
            "includeSpeaker": True,
            "useTranslation": True,
            "bilingual": True,
            "audioLanguage": "en",
        },
    )
    assert burn_res.status_code == 200, burn_res.text
    burned_only = tmp_path / "burned-only.mp4"
    burned_only.write_bytes(burn_res.content)
    _assert_mp4_streams_and_decode(burned_only, ffprobe_bin, ffmpeg_bin, expected_audio_lang="eng")

    subtitles_payload = json.dumps({
        "segments": segments,
        "speakerNames": {"speaker-1": "Host", "speaker-2": "Guest"},
        "includeSpeaker": True,
        "useTranslation": True,
        "bilingual": False,
        "subtitleLanguage": "khm_Khmr",
        "videoSize": {"width": 640, "height": 360},
    })
    clip_a = _make_pcm_wav_bytes(0.7, 520.0)
    clip_b = _make_pcm_wav_bytes(0.7, 780.0)
    clip_meta = json.dumps([
        {"segmentId": segments[0]["id"], "start": 0.1, "end": 1.1, "fileIndex": 0},
        {"segmentId": segments[1]["id"], "start": 1.25, "end": 2.2, "fileIndex": 1},
    ])

    scenarios = [
        (
            "dub-original-soft.mp4",
            {"metadata": "[]", "originalAudioMode": "original", "audioLanguage": "en", "originalVolume": "0.9", "subtitleMode": "soft", "subtitles": subtitles_payload},
            [],
            "eng",
            "khm",
        ),
        (
            "dub-replace-burned.mp4",
            {"metadata": clip_meta, "originalAudioMode": "replace", "audioLanguage": "km", "dubVolume": "1.1", "subtitleMode": "burned", "subtitles": subtitles_payload},
            [("c1.wav", clip_a), ("c2.wav", clip_b)],
            "khm",
            None,
        ),
        (
            "dub-duck-none.mp4",
            {"metadata": clip_meta, "originalAudioMode": "duck", "audioLanguage": "km", "duckVolume": "0.15", "originalVolume": "0.95", "dubVolume": "1.0", "subtitleMode": "none"},
            [("c1.wav", clip_a), ("c2.wav", clip_b)],
            "khm",
            None,
        ),
        (
            "dub-mix-soft.mp4",
            {"metadata": clip_meta, "originalAudioMode": "mix", "audioLanguage": "km", "originalVolume": "0.8", "dubVolume": "1.05", "subtitleMode": "soft", "subtitles": subtitles_payload},
            [("c1.wav", clip_a), ("c2.wav", clip_b)],
            "khm",
            "khm",
        ),
    ]

    for filename, form_data, clip_files, audio_lang, sub_lang in scenarios:
        out_mp4 = tmp_path / filename
        _export_dub_case(client, job_id, out_mp4, data=form_data, clips=clip_files)
        _assert_mp4_streams_and_decode(
            out_mp4,
            ffprobe_bin,
            ffmpeg_bin,
            expected_audio_lang=audio_lang,
            expected_subtitle_lang=sub_lang,
        )
        _assert_external_mac_players_open(out_mp4)
