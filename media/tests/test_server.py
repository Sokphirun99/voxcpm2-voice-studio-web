"""FastAPI integration tests for media/server.py using real FFmpeg media files."""

from __future__ import annotations

import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from jobs import MediaJobStore
from server import MediaServices, create_app
from subtitles import SpeakerTurn
from video_io import probe_video_dimensions, resolve_ffmpeg_bin


class _FakeTranscriber:
    def transcribe(self, wav_path: Path, language: str | None = None) -> dict:
        assert wav_path.is_file() and wav_path.stat().st_size > 100
        return {
            "language": "en" if language in (None, "", "auto") else language,
            "segments": [
                {
                    "start": 0.0,
                    "end": 1.6,
                    "text": "Good evening. Today we check the news.",
                    "words": [
                        {"word": "Good", "start": 0.0, "end": 0.35},
                        {"word": " evening.", "start": 0.36, "end": 0.8},
                        {"word": " Today", "start": 0.9, "end": 1.15},
                        {"word": " we check the news.", "start": 1.16, "end": 1.6},
                    ],
                }
            ],
        }


class _FakeDiarizer:
    def diarize(self, wav_path: Path, num_speakers: int = 0) -> list[SpeakerTurn]:
        return [
            SpeakerTurn(start=0.0, end=0.85, speaker="spk-A"),
            SpeakerTurn(start=0.86, end=1.6, speaker="spk-B"),
        ]


class _FakeTranslator:
    def translate_lines(self, lines: list[str], source_lang: str, target_lang: str = "km") -> list[str]:
        return [f"[{target_lang}] {line}" for line in lines]


def _make_sample_mp4(path: Path) -> None:
    """Generate a tiny 2-second 640x360 MP4 with silent AAC audio using ffmpeg-full."""
    ffmpeg = resolve_ffmpeg_bin()
    cmd = [
        ffmpeg, "-y",
        "-f", "lavfi", "-i", "color=c=black:s=640x360:d=2:r=24",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr


def _make_client(tmp_path: Path) -> TestClient:
    services = MediaServices(
        job_store=MediaJobStore(tmp_path / "jobs"),
        transcriber=_FakeTranscriber(),
        diarizer=_FakeDiarizer(),
        translator=_FakeTranslator(),
    )
    return TestClient(create_app(services))


def test_health_endpoint_reports_capabilities(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert isinstance(body["pid"], int) and body["pid"] > 0
    assert isinstance(body["startedAt"], str) and body["startedAt"].endswith("Z")
    assert body["burnInSupported"] is True
    assert "whisperModel" in body


def test_transcribe_translate_and_burn_roundtrip(tmp_path: Path) -> None:
    sample_mp4 = tmp_path / "sample.mp4"
    _make_sample_mp4(sample_mp4)
    client = _make_client(tmp_path)

    with open(sample_mp4, "rb") as fh:
        res = client.post(
            "/transcribe",
            files={"file": ("news.mp4", fh, "video/mp4")},
            data={"language": "auto", "num_speakers": "2", "diarize": "true", "translate_to": "km"},
        )
    assert res.status_code == 200
    payload = res.json()
    assert payload["speakers"] == ["speaker-1", "speaker-2"]
    assert payload["videoSize"] == {"width": 640, "height": 360}
    assert len(payload["segments"]) == 2
    assert payload["segments"][0]["translatedText"].startswith("[km] ")

    tr_res = client.post(
        "/translate",
        json={"segments": payload["segments"], "sourceLanguage": "en", "targetLanguage": "km"},
    )
    assert tr_res.status_code == 200
    assert tr_res.json()["segments"][1]["translatedText"] == "[km] Today we check the news."

    burn_res = client.post(
        "/burn",
        json={
            "jobId": payload["jobId"],
            "segments": payload["segments"],
            "speakerNames": {"speaker-1": "ពិធីករ", "speaker-2": "ភ្ញៀវ"},
            "includeSpeaker": True,
            "useTranslation": True,
            "videoSize": payload["videoSize"],
        },
    )
    assert burn_res.status_code == 200
    assert burn_res.headers["content-type"] == "video/mp4"
    out_mp4 = tmp_path / "burned.mp4"
    out_mp4.write_bytes(burn_res.content)
    assert probe_video_dimensions(out_mp4) == (640, 360)


def test_transcribe_and_burn_validation_errors(tmp_path: Path) -> None:
    client = _make_client(tmp_path)
    bad_ext = client.post("/transcribe", files={"file": ("bad.exe", b"123", "application/octet-stream")})
    assert bad_ext.status_code == 400

    empty_file = client.post("/transcribe", files={"file": ("empty.mp4", b"", "video/mp4")})
    assert empty_file.status_code == 400

    bad_job = client.post("/burn", json={"jobId": "not-hex", "segments": []})
    assert bad_job.status_code == 400

    missing_job = client.post("/burn", json={"jobId": "abcdef0123456789", "segments": [{"id": "1", "start": 0, "end": 1, "speakerId": "speaker-1", "text": "hi"}]})
    assert missing_job.status_code == 404


def test_khmer_transcribe_skips_self_translation_and_splits_long_turns(tmp_path: Path) -> None:
    import numpy as np
    from asr import LocalTranscriber, prepare_speech_turns
    from khmer_dictionary import correct_khmer_transcript

    audio = np.ones(16000 * 14, dtype=np.float32) * 0.1
    audio[16000 * 6 : 16000 * 7] = 0.0
    turns = prepare_speech_turns(audio, [SpeakerTurn(start=0.0, end=14.0, speaker="spk-1")])
    assert len(turns) >= 2
    assert all((t.end - t.start) <= 11.0 for t in turns)

    fixed = correct_khmer_transcript("ដើម្បបី ចូល ប្រើប្រាស់ កម្មវិធី ថ្នារ កំពារ សង្គម ឌីជីថរ ជំនាន់ ទី ពីរ ចុច សូន្យ")
    assert fixed == "ដើម្បី ចូល ប្រើប្រាស់ កម្មវិធី ថ្នាល គាំពារ សង្គម ឌីជីថល ជំនាន់ ទី ២.០"
    assert correct_khmer_transcript("មួយ បញ្ចូល ឈ្មោះ កនោនី របស់ លោក អ្នក") == "១. បញ្ចូល ឈ្មោះ គណនី របស់ លោក អ្នក"
    assert correct_khmer_transcript("ពីរបញ្ចូល ពាក្យសម្ងាត្រ") == "២. បញ្ចូល ពាក្យសម្ងាត់"

    transcriber = LocalTranscriber()
    transcriber._khmer.transcribe = lambda path, turns=None: {
        "language": "km",
        "segments": [{"start": 0.0, "end": 1.5, "text": "សួស្តីកម្ពុជា"}],
    }
    res_km = transcriber.transcribe(tmp_path / "dummy.wav", language="km", turns=turns)
    assert res_km["language"] == "km"
    assert res_km["segments"][0]["text"] == "សួស្តីកម្ពុជា"

    sample_mp4 = tmp_path / "khmer.mp4"
    _make_sample_mp4(sample_mp4)
    client = _make_client(tmp_path)
    with open(sample_mp4, "rb") as fh:
        res = client.post(
            "/transcribe",
            files={"file": ("khmer.mp4", fh, "video/mp4")},
            data={"language": "km", "num_speakers": "1", "diarize": "true", "translate_to": "km"},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["language"] == "km"
    assert body["segments"][0]["translatedText"] == ""


def test_transcribe_diarize_false_skips_diarizer_and_audio_only_blocks_burn(tmp_path: Path) -> None:
    """diarize=false skips diarization cleanly and /burn rejects audio-only files with HTTP 400."""
    import wave
    import numpy as np

    wav_path = tmp_path / "voice.wav"
    samples = (np.ones(16000, dtype=np.float32) * 0.1 * 32767).astype(np.int16)
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(samples.tobytes())

    diarize_called = False

    class _CountingDiarizer:
        def diarize(self, wav_p: Path, num_speakers: int = 0) -> list[SpeakerTurn]:
            nonlocal diarize_called
            diarize_called = True
            return []

    services = MediaServices(
        job_store=MediaJobStore(tmp_path / "jobs"),
        transcriber=_FakeTranscriber(),
        diarizer=_CountingDiarizer(),
        translator=_FakeTranslator(),
    )
    client = TestClient(create_app(services))
    with open(wav_path, "rb") as fh:
        res = client.post(
            "/transcribe",
            files={"file": ("voice.wav", fh, "audio/wav")},
            data={"language": "en", "num_speakers": "1", "diarize": "false", "translate_to": ""},
        )
    assert res.status_code == 200
    body = res.json()
    assert diarize_called is False
    assert body["speakers"] == ["speaker-1"]
    assert body["isAudioOnly"] is True
    assert body["videoSize"] is None

    burn_res = client.post(
        "/burn",
        json={
            "jobId": body["jobId"],
            "segments": body["segments"],
            "includeSpeaker": False,
            "subtitleStyle": {"position": "top", "fontScale": "large", "backgroundStyle": "outline"},
        },
    )
    assert burn_res.status_code == 400
    assert "video files" in burn_res.json()["detail"].lower()

    flac_path = tmp_path / "voice.flac"
    ffmpeg = resolve_ffmpeg_bin()
    subprocess.run([ffmpeg, "-y", "-i", str(wav_path), str(flac_path)], check=True, capture_output=True, timeout=15)
    with open(flac_path, "rb") as fh:
        flac_res = client.post(
            "/transcribe",
            files={"file": ("voice.flac", fh, "audio/flac")},
            data={"language": "en", "diarize": "false"},
        )
    assert flac_res.status_code == 200
    assert flac_res.json()["isAudioOnly"] is True


def test_burn_supports_subtitle_style_and_bilingual_mode(tmp_path: Path) -> None:
    sample_mp4 = tmp_path / "bilingual.mp4"
    _make_sample_mp4(sample_mp4)
    client = _make_client(tmp_path)
    with open(sample_mp4, "rb") as fh:
        tr = client.post(
            "/transcribe",
            files={"file": ("bilingual.mp4", fh, "video/mp4")},
            data={"language": "en", "diarize": "false", "translate_to": "km"},
        )
    assert tr.status_code == 200
    payload = tr.json()
    assert payload["isAudioOnly"] is False

    burn_res = client.post(
        "/burn",
        json={
            "jobId": payload["jobId"],
            "segments": payload["segments"],
            "includeSpeaker": False,
            "useTranslation": True,
            "bilingual": True,
            "subtitleStyle": {"position": "top", "fontScale": "large", "backgroundStyle": "clean"},
        },
    )
    assert burn_res.status_code == 200
    assert burn_res.headers["content-type"] == "video/mp4"


def test_transcribe_runs_off_event_loop_without_blocking_health(tmp_path: Path) -> None:
    """Slow /transcribe runs via asyncio.to_thread so concurrent /health checks return immediately."""
    import asyncio
    import threading
    import httpx

    sample_mp4 = tmp_path / "slow.mp4"
    _make_sample_mp4(sample_mp4)
    started = threading.Event()
    release = threading.Event()

    class _BlockingTranscriber:
        def transcribe(self, wav_path: Path, language: str | None = None) -> dict:
            started.set()
            assert release.wait(timeout=5.0)
            return {"language": "en", "segments": [{"start": 0.0, "end": 1.0, "text": "Hello"}]}

    services = MediaServices(
        job_store=MediaJobStore(tmp_path / "jobs"),
        transcriber=_BlockingTranscriber(),
        diarizer=_FakeDiarizer(),
        translator=_FakeTranslator(),
    )
    app = create_app(services)

    async def exercise() -> None:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            with open(sample_mp4, "rb") as fh:
                content = fh.read()
            tr_task = asyncio.create_task(
                client.post(
                    "/transcribe",
                    files={"file": ("slow.mp4", content, "video/mp4")},
                    data={"language": "en", "diarize": "false"},
                )
            )
            while not started.is_set():
                await asyncio.sleep(0.01)
            health_res = await asyncio.wait_for(client.get("/health"), timeout=1.0)
            assert health_res.status_code == 200
            assert health_res.json()["ok"] is True
            release.set()
            tr_res = await tr_task
            assert tr_res.status_code == 200

    asyncio.run(exercise())


def test_burn_aligns_odd_video_size_cleanly(tmp_path: Path) -> None:
    odd_mp4 = tmp_path / "odd_server.mp4"
    ffmpeg = resolve_ffmpeg_bin()
    cmd = [
        ffmpeg, "-y",
        "-f", "lavfi", "-i", "color=c=black:s=641x361:d=1:r=24",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv444p", "-c:a", "aac", "-shortest",
        str(odd_mp4),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr

    client = _make_client(tmp_path)
    with open(odd_mp4, "rb") as fh:
        tr = client.post("/transcribe", files={"file": ("odd.mp4", fh, "video/mp4")}, data={"language": "en", "diarize": "false"})
    assert tr.status_code == 200
    payload = tr.json()
    assert payload["videoSize"] == {"width": 641, "height": 361}

    burn_res = client.post(
        "/burn",
        json={
            "jobId": payload["jobId"],
            "segments": payload["segments"],
            "videoSize": {"width": 641, "height": 361},
        },
    )
    assert burn_res.status_code == 200
    out_mp4 = tmp_path / "odd_burned.mp4"
    out_mp4.write_bytes(burn_res.content)
    assert probe_video_dimensions(out_mp4) == (640, 360)
