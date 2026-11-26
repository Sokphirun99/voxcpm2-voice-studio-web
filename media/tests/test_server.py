"""FastAPI integration tests for media/server.py using real FFmpeg media files."""

from __future__ import annotations

import subprocess
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from jobs import MediaJobStore
from model_cache import MODEL_CACHE_REPOS, inspect_model_readiness
from server import MediaServices, create_app
from subtitles import SpeakerTurn
from video_io import has_audio_stream, probe_video_dimensions, resolve_ffmpeg_bin


def test_run_transcriber_does_not_retry_internal_type_error() -> None:
    """A TypeError from inference must propagate instead of retrying without double-check options."""
    import server as server_mod

    calls: list[bool] = []

    class _BrokenTranscriber:
        def transcribe(self, wav_path: Path, language: str, turns: list, double_check: bool) -> dict:
            calls.append(double_check)
            raise TypeError("inference implementation failed")

    with pytest.raises(TypeError, match="inference implementation failed"):
        server_mod._run_transcriber(_BrokenTranscriber(), Path("audio.wav"), "km", [], double_check=True)
    assert calls == [True]


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


def _seed_hf_cache(cache_root: Path, repo_ids: list[str]) -> None:
    """Create minimal HuggingFace snapshot directories for the given repository IDs."""
    for repo_id in repo_ids:
        snapshot = cache_root / f"models--{repo_id.replace('/', '--')}" / "snapshots" / "0123456789abcdef"
        snapshot.mkdir(parents=True, exist_ok=True)
        (snapshot / "config.json").write_text("{}", encoding="utf-8")


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
    assert body["khmerVerifierModel"] == "seanghay/whisper-small-khmer-v2"


def test_health_reports_all_models_cached_from_local_cache(tmp_path: Path, monkeypatch) -> None:
    cache_root = tmp_path / "hf"
    _seed_hf_cache(cache_root, list(MODEL_CACHE_REPOS.values()))
    monkeypatch.setattr("model_cache.are_diarization_models_ready", lambda: True)
    monkeypatch.setattr("server.are_diarization_models_ready", lambda: True)
    monkeypatch.setattr("server.inspect_model_readiness", lambda: inspect_model_readiness(cache_root))

    body = _make_client(tmp_path).get("/health").json()

    assert body["models"] == {"whisper": True, "khmerAsr": True, "translator": True, "diarization": True}
    assert body["diarizationReady"] is True


def test_health_reports_partially_cached_models_without_network(tmp_path: Path, monkeypatch) -> None:
    cache_root = tmp_path / "hf"
    _seed_hf_cache(cache_root, [MODEL_CACHE_REPOS["whisper"]])
    monkeypatch.setattr("model_cache.are_diarization_models_ready", lambda: False)
    monkeypatch.setattr("server.are_diarization_models_ready", lambda: False)
    monkeypatch.setattr("server.inspect_model_readiness", lambda: inspect_model_readiness(cache_root))

    body = _make_client(tmp_path).get("/health").json()

    assert body["models"] == {"whisper": True, "khmerAsr": False, "translator": False, "diarization": False}
    assert body["diarizationReady"] is False


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


def test_multilingual_any_to_any_translation_validation_and_async_translate(tmp_path: Path) -> None:
    """Supports Khmer-to-English and any-to-any FLORES-200 targets, skips equivalent self-translation, and returns 400 on invalid codes."""
    import asyncio
    import threading
    import httpx

    sample_mp4 = tmp_path / "multi.mp4"
    _make_sample_mp4(sample_mp4)
    client = _make_client(tmp_path)

    # 1. Khmer source -> English FLORES-200 target during /transcribe
    with open(sample_mp4, "rb") as fh:
        km_to_en = client.post(
            "/transcribe",
            files={"file": ("khmer.mp4", fh, "video/mp4")},
            data={"language": "km", "diarize": "false", "translate_to": "eng_Latn"},
        )
    assert km_to_en.status_code == 200
    km_body = km_to_en.json()
    assert km_body["language"] == "km"
    assert km_body["translatedLanguage"] == "eng_Latn"
    assert km_body["segments"][0]["translatedText"].startswith("[eng_Latn] ")

    # 2. English source -> Japanese target via /transcribe and /translate
    with open(sample_mp4, "rb") as fh:
        en_to_ja = client.post(
            "/transcribe",
            files={"file": ("english.mp4", fh, "video/mp4")},
            data={"language": "en", "diarize": "false", "translate_to": "jpn_Jpan"},
        )
    assert en_to_ja.status_code == 200
    ja_body = en_to_ja.json()
    assert ja_body["translatedLanguage"] == "jpn_Jpan"
    assert ja_body["segments"][0]["translatedText"].startswith("[jpn_Jpan] ")

    tr_ar = client.post(
        "/translate",
        json={"segments": ja_body["segments"], "sourceLanguage": "km", "targetLanguage": "arb_Arab"},
    )
    assert tr_ar.status_code == 200
    assert tr_ar.json()["targetLanguage"] == "arb_Arab"
    assert tr_ar.json()["segments"][0]["translatedText"].startswith("[arb_Arab] ")

    # 3. Equivalent ISO <-> NLLB code skips self-translation cleanly
    with open(sample_mp4, "rb") as fh:
        same_en = client.post(
            "/transcribe",
            files={"file": ("same.mp4", fh, "video/mp4")},
            data={"language": "en", "diarize": "false", "translate_to": "eng_Latn"},
        )
    assert same_en.status_code == 200
    assert same_en.json()["translatedLanguage"] == ""
    assert same_en.json()["segments"][0]["translatedText"] == ""

    # 4. Whisper-only source (`la`) keeps transcript during /transcribe without crashing, while explicit /translate rejects 400
    with open(sample_mp4, "rb") as fh:
        latin_tr = client.post(
            "/transcribe",
            files={"file": ("latin.mp4", fh, "video/mp4")},
            data={"language": "la", "diarize": "false", "translate_to": "eng_Latn"},
        )
    assert latin_tr.status_code == 200
    assert latin_tr.json()["translatedLanguage"] == ""
    assert latin_tr.json()["segments"][0]["translatedText"] == ""

    bad_src_tr = client.post(
        "/translate",
        json={"segments": ja_body["segments"], "sourceLanguage": "la", "targetLanguage": "eng_Latn"},
    )
    assert bad_src_tr.status_code == 400

    # 5. Invalid target codes fail fast with HTTP 400 on both /transcribe and /translate
    with open(sample_mp4, "rb") as fh:
        bad_transcribe = client.post(
            "/transcribe",
            files={"file": ("badlang.mp4", fh, "video/mp4")},
            data={"language": "en", "diarize": "false", "translate_to": "not_a_language"},
        )
    assert bad_transcribe.status_code == 400

    bad_translate = client.post(
        "/translate",
        json={"segments": ja_body["segments"], "sourceLanguage": "en", "targetLanguage": "not_a_language"},
    )
    assert bad_translate.status_code == 400

    # 6. Slow /translate runs off the event loop without blocking /health
    started = threading.Event()
    release = threading.Event()

    class _BlockingTranslator:
        def translate_lines(self, lines: list[str], source_lang: str, target_lang: str = "km") -> list[str]:
            started.set()
            assert release.wait(timeout=5.0)
            return [f"[{target_lang}] {line}" for line in lines]

    async_app = create_app(
        MediaServices(
            job_store=MediaJobStore(tmp_path / "async-jobs"),
            transcriber=_FakeTranscriber(),
            diarizer=_FakeDiarizer(),
            translator=_BlockingTranslator(),
        )
    )

    async def exercise_async_translate() -> None:
        transport = httpx.ASGITransport(app=async_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as async_client:
            tr_task = asyncio.create_task(
                async_client.post(
                    "/translate",
                    json={"segments": ja_body["segments"], "sourceLanguage": "en", "targetLanguage": "fra_Latn"},
                )
            )
            while not started.is_set():
                await asyncio.sleep(0.01)
            health_res = await asyncio.wait_for(async_client.get("/health"), timeout=1.0)
            assert health_res.status_code == 200
            release.set()
            tr_res = await tr_task
            assert tr_res.status_code == 200
            assert tr_res.json()["segments"][0]["translatedText"].startswith("[fra_Latn] ")

    asyncio.run(exercise_async_translate())


def test_transcribe_double_check_and_verify_speech_endpoint(tmp_path: Path) -> None:
    """POST /transcribe forwards double_check & returns altText/verificationSummary; POST /verify-speech scores TTS WAVs cleanly."""
    import wave
    import numpy as np

    wav_path = tmp_path / "tts_khmer.wav"
    samples = (np.ones(16000, dtype=np.float32) * 0.1 * 32767).astype(np.int16)
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(samples.tobytes())

    captured_double_checks: list[bool] = []

    class _VerifyingTranscriber:
        def transcribe(self, wav_p: Path, language: str | None = None, turns=None, double_check: bool = False) -> dict:
            captured_double_checks.append(double_check)
            return {
                "language": "km",
                "segments": [
                    {
                        "start": 0.0,
                        "end": 1.0,
                        "text": "សួស្តី កម្ពុជា",
                        "altText": "សួស្តី ប្រទេស កម្ពុជា" if double_check else "",
                        "verifyReason": "double_check" if double_check else "",
                    }
                ],
                "verificationSummary": {
                    "checked": 1 if double_check else 0,
                    "fallbackApplied": 0,
                    "suggestions": 1 if double_check else 0,
                    "model": "seanghay/whisper-small-khmer-v2" if double_check else "",
                },
            }

        def verify_audio(self, wav_p: Path, language: str = "km") -> tuple[str, str]:
            assert wav_p.is_file() and wav_p.stat().st_size > 100
            return "សួស្តី កម្ពុជា", "seanghay/whisper-small-khmer-v2"

    job_dir = tmp_path / "verify-jobs"
    services = MediaServices(
        job_store=MediaJobStore(job_dir),
        transcriber=_VerifyingTranscriber(),
        diarizer=_FakeDiarizer(),
        translator=_FakeTranslator(),
    )
    client = TestClient(create_app(services))

    with open(wav_path, "rb") as fh:
        tr_res = client.post(
            "/transcribe",
            files={"file": ("voice.wav", fh, "audio/wav")},
            data={"language": "km", "diarize": "false", "double_check": "true"},
        )
    assert tr_res.status_code == 200
    tr_body = tr_res.json()
    assert captured_double_checks == [True]
    assert tr_body["segments"][0]["altText"] == "សួស្តី ប្រទេស កម្ពុជា"
    assert tr_body["segments"][0]["verifyReason"] == "double_check"
    assert tr_body["verificationSummary"]["suggestions"] == 1

    # Round-trip TTS verification: exact Khmer match (spacing-invariant)
    with open(wav_path, "rb") as fh:
        ok_res = client.post(
            "/verify-speech",
            files={"file": ("tts.wav", fh, "audio/wav")},
            data={"expected_text": "សួស្តីកម្ពុជា", "language": "km"},
        )
    assert ok_res.status_code == 200
    ok_body = ok_res.json()
    assert ok_body["verdict"] == "pass"
    assert ok_body["similarity"] == 1.0
    assert ok_body["heardText"] == "សួស្តី កម្ពុជា"
    assert ok_body["model"] == "seanghay/whisper-small-khmer-v2"
    assert ok_body["missingTerms"] == []

    # Round-trip TTS verification: detects dropped words
    with open(wav_path, "rb") as fh:
        mismatch_res = client.post(
            "/verify-speech",
            files={"file": ("tts.wav", fh, "audio/wav")},
            data={"expected_text": "សួស្តី កម្ពុជា ថ្ងៃនេះ មាន ព័ត៌មាន ពិសេស ជាច្រើន", "language": "km"},
        )
    assert mismatch_res.status_code == 200
    mm_body = mismatch_res.json()
    assert mm_body["verdict"] == "fail"
    assert mm_body["similarity"] < 0.65
    assert "ព័ត៌មាន" in mm_body["missingTerms"]

    # Validation guards: empty expected_text & unsupported extension return HTTP 400
    with open(wav_path, "rb") as fh:
        empty_txt = client.post(
            "/verify-speech",
            files={"file": ("tts.wav", fh, "audio/wav")},
            data={"expected_text": "   ", "language": "km"},
        )
    assert empty_txt.status_code == 400

    bad_ext = client.post(
        "/verify-speech",
        files={"file": ("bad.exe", b"123", "application/octet-stream")},
        data={"expected_text": "សួស្តី", "language": "km"},
    )
    assert bad_ext.status_code == 400


def _make_wav_bytes(duration_seconds: float = 0.35, sample_rate: int = 48000) -> bytes:
    """Build an in-memory mono 16-bit PCM WAV byte payload."""
    import io
    import wave

    buf = io.BytesIO()
    num_frames = int(round(sample_rate * duration_seconds))
    raw = b"".join((3000 if (i // 30) % 2 == 0 else -3000).to_bytes(2, "little", signed=True) for i in range(num_frames))
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(raw)
    return buf.getvalue()


def test_dub_endpoint_roundtrip_validation_and_non_blocking_async(tmp_path: Path, monkeypatch) -> None:
    """POST /dub exports valid time-aligned dubbed MP4s, validates inputs strictly, and runs off the event loop."""
    import asyncio
    import json
    import threading
    import httpx
    import server as server_mod

    sample_mp4 = tmp_path / "dub_source.mp4"
    _make_sample_mp4(sample_mp4)
    job_store = MediaJobStore(tmp_path / "dub-jobs")
    services = MediaServices(
        job_store=job_store,
        transcriber=_FakeTranscriber(),
        diarizer=_FakeDiarizer(),
        translator=_FakeTranslator(),
    )
    app = create_app(services)
    client = TestClient(app)

    with open(sample_mp4, "rb") as fh:
        tr = client.post("/transcribe", files={"file": ("news.mp4", fh, "video/mp4")}, data={"language": "en", "diarize": "false"})
    assert tr.status_code == 200
    assert tr.json()["duration"] > 1.5
    job_id = tr.json()["jobId"]

    wav_a = _make_wav_bytes(0.3)
    wav_b = _make_wav_bytes(0.4)
    meta = json.dumps([
        {"segmentId": "seg-1", "start": 0.1, "end": 0.7, "fileIndex": 0},
        {"segmentId": "seg-2", "start": 0.9, "end": 1.6, "fileIndex": 1},
    ])

    # 1. Valid roundtrips across duck, mute, and keep modes preserve 640x360 video + AAC audio and clean temp dirs
    for mode in ("duck", "mute", "keep"):
        res = client.post(
            "/dub",
            data={"jobId": job_id, "metadata": meta, "originalAudioMode": mode},
            files=[
                ("files", ("clip1.wav", wav_a, "audio/wav")),
                ("files", ("clip2.wav", wav_b, "audio/wav")),
            ],
        )
        assert res.status_code == 200, res.text
        assert res.headers["content-type"] == "video/mp4"
        out_mp4 = tmp_path / f"exported-{mode}.mp4"
        out_mp4.write_bytes(res.content)
        assert probe_video_dimensions(out_mp4) == (640, 360)
        assert has_audio_stream(out_mp4) is True
        job_dir = job_store.get_job(job_id).root
        assert list(job_dir.glob("dub-*")) == []

    # 2. Validation guards: bad mode, invalid/missing jobId, bad metadata, bad WAV magic bytes, and audio-only job
    bad_mode = client.post(
        "/dub",
        data={"jobId": job_id, "metadata": meta, "originalAudioMode": "loud"},
        files=[("files", ("clip1.wav", wav_a, "audio/wav")), ("files", ("clip2.wav", wav_b, "audio/wav"))],
    )
    assert bad_mode.status_code == 400
    empty_mode = client.post(
        "/dub",
        data={"jobId": job_id, "metadata": meta, "originalAudioMode": " "},
        files=[("files", ("clip1.wav", wav_a, "audio/wav")), ("files", ("clip2.wav", wav_b, "audio/wav"))],
    )
    assert empty_mode.status_code == 400

    bad_job = client.post(
        "/dub",
        data={"jobId": "../traversal", "metadata": meta, "originalAudioMode": "duck"},
        files=[("files", ("clip1.wav", wav_a, "audio/wav")), ("files", ("clip2.wav", wav_b, "audio/wav"))],
    )
    assert bad_job.status_code == 400

    missing_job = client.post(
        "/dub",
        data={"jobId": "abcdef0123456789", "metadata": meta, "originalAudioMode": "duck"},
        files=[("files", ("clip1.wav", wav_a, "audio/wav")), ("files", ("clip2.wav", wav_b, "audio/wav"))],
    )
    assert missing_job.status_code == 404

    bad_range = client.post(
        "/dub",
        data={"jobId": job_id, "metadata": json.dumps([{"segmentId": "seg-1", "start": 2.0, "end": 1.0, "fileIndex": 0}]), "originalAudioMode": "duck"},
        files=[("files", ("clip1.wav", wav_a, "audio/wav"))],
    )
    assert bad_range.status_code == 400

    beyond_video = client.post(
        "/dub",
        data={"jobId": job_id, "metadata": json.dumps([{"segmentId": "seg-1", "start": 5.0, "end": 5.2, "fileIndex": 0}]), "originalAudioMode": "duck"},
        files=[("files", ("clip1.wav", wav_a, "audio/wav"))],
    )
    assert beyond_video.status_code == 400

    bad_index = client.post(
        "/dub",
        data={"jobId": job_id, "metadata": json.dumps([{"segmentId": "seg-1", "start": 0.0, "end": 1.0, "fileIndex": 9}]), "originalAudioMode": "duck"},
        files=[("files", ("clip1.wav", wav_a, "audio/wav"))],
    )
    assert bad_index.status_code == 400

    bad_allow = client.post(
        "/dub",
        data={"jobId": job_id, "metadata": json.dumps([{"segmentId": "seg-1", "start": 0.0, "end": 1.0, "fileIndex": 0, "allowOverflow": "yes"}]), "originalAudioMode": "duck"},
        files=[("files", ("clip1.wav", wav_a, "audio/wav"))],
    )
    assert bad_allow.status_code == 400

    wav_spill = _make_wav_bytes(0.6)
    valid_allow = client.post(
        "/dub",
        data={"jobId": job_id, "metadata": json.dumps([{"segmentId": "seg-1", "start": 0.0, "end": 0.2, "fileIndex": 0, "allowOverflow": True}]), "originalAudioMode": "duck"},
        files=[("files", ("clip1.wav", wav_spill, "audio/wav"))],
    )
    assert valid_allow.status_code == 200

    overflow_past_video = client.post(
        "/dub",
        data={"jobId": job_id, "metadata": json.dumps([{"segmentId": "seg-1", "start": 1.6, "end": 1.8, "fileIndex": 0, "allowOverflow": True}]), "originalAudioMode": "duck"},
        files=[("files", ("clip1.wav", _make_wav_bytes(0.9), "audio/wav"))],
    )
    assert overflow_past_video.status_code == 400

    overflow_collides_next = client.post(
        "/dub",
        data={
            "jobId": job_id,
            "metadata": json.dumps([
                {"segmentId": "seg-1", "start": 0.0, "end": 0.2, "fileIndex": 0, "allowOverflow": True},
                {"segmentId": "seg-2", "start": 0.3, "end": 0.8, "fileIndex": 1},
            ]),
            "originalAudioMode": "duck",
        },
        files=[("files", ("clip1.wav", wav_spill, "audio/wav")), ("files", ("clip2.wav", wav_a, "audio/wav"))],
    )
    assert overflow_collides_next.status_code == 400

    bad_wav = client.post(
        "/dub",
        data={"jobId": job_id, "metadata": json.dumps([{"segmentId": "seg-1", "start": 0.0, "end": 1.0, "fileIndex": 0}]), "originalAudioMode": "duck"},
        files=[("files", ("fake.wav", b"NOT_A_REAL_WAV_HEADER" * 4, "audio/wav"))],
    )
    assert bad_wav.status_code == 400

    with monkeypatch.context() as mp:
        mp.setattr(server_mod, "MAX_DUB_CLIP_BYTES", 16)
        oversized_wav = client.post(
            "/dub",
            data={"jobId": job_id, "metadata": json.dumps([{"segmentId": "seg-1", "start": 0.0, "end": 1.0, "fileIndex": 0}]), "originalAudioMode": "duck"},
            files=[("files", ("large.wav", wav_a, "audio/wav"))],
        )
        assert oversized_wav.status_code == 413

    # Audio-only job must be rejected with HTTP 400
    audio_tr = client.post("/transcribe", files={"file": ("only.wav", wav_a, "audio/wav")}, data={"language": "en", "diarize": "false"})
    assert audio_tr.status_code == 200
    audio_dub = client.post(
        "/dub",
        data={"jobId": audio_tr.json()["jobId"], "metadata": json.dumps([{"segmentId": "seg-1", "start": 0.0, "end": 0.3, "fileIndex": 0}]), "originalAudioMode": "duck"},
        files=[("files", ("clip1.wav", wav_a, "audio/wav"))],
    )
    assert audio_dub.status_code == 400

    # 3. Non-blocking async execution: slow mux_dubbed_audio does not block concurrent /health
    started = threading.Event()
    release = threading.Event()
    real_mux = server_mod.mux_dubbed_audio

    def _slow_mux(source_video: Path, clips, output_mp4: Path, original_audio_mode: str = "duck") -> Path:
        started.set()
        assert release.wait(timeout=5.0)
        return real_mux(source_video, clips, output_mp4, original_audio_mode=original_audio_mode)

    monkeypatch.setattr(server_mod, "mux_dubbed_audio", _slow_mux)

    async def exercise_async_dub() -> None:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as async_client:
            dub_task = asyncio.create_task(
                async_client.post(
                    "/dub",
                    data={"jobId": job_id, "metadata": meta, "originalAudioMode": "duck"},
                    files=[
                        ("files", ("clip1.wav", wav_a, "audio/wav")),
                        ("files", ("clip2.wav", wav_b, "audio/wav")),
                    ],
                )
            )
            while not started.is_set():
                await asyncio.sleep(0.01)
            health_res = await asyncio.wait_for(async_client.get("/health"), timeout=1.0)
            assert health_res.status_code == 200
            assert health_res.json()["ok"] is True
            release.set()
            dub_res = await dub_task
            assert dub_res.status_code == 200
            assert dub_res.headers["content-type"] == "video/mp4"

    asyncio.run(exercise_async_dub())


def test_transcribe_and_translate_enforce_stage_separated_terminology(tmp_path: Path) -> None:
    import json

    sample_mp4 = tmp_path / "term_sample.mp4"
    _make_sample_mp4(sample_mp4)

    class _TermTranscriber:
        def transcribe(self, audio_wav: Path, language: str = "auto", **kwargs):
            return {
                "language": "en",
                "segments": [
                    {"start": 0.0, "end": 1.2, "text": "Pnom Penh launches vox cpm with AI today."},
                ],
            }

    class _MaskCheckingTranslator:
        def translate_lines(self, lines: list[str], source_lang: str, target_lang: str = "km") -> list[str]:
            return [f"[{target_lang}] {line}" for line in lines]

    app = create_app(
        MediaServices(
            job_store=MediaJobStore(tmp_path / "jobs"),
            transcriber=_TermTranscriber(),
            diarizer=_FakeDiarizer(),
            translator=_MaskCheckingTranslator(),
        )
    )
    client = TestClient(app)

    terminology = [
        {"id": "s1", "category": "spelling", "status": "approved", "term": "Phnom Penh", "variants": ["Pnom Penh"]},
        {"id": "n1", "category": "name", "status": "approved", "term": "VoxCPM", "variants": ["vox cpm"], "preserveInTranslation": True, "pronunciation": "DO_NOT_LEAK_TTS"},
        {"id": "t1", "category": "translation", "status": "approved", "term": "AI", "translation": "បញ្ញាសិប្បនិម្មិត", "sourceLanguage": "en", "targetLanguage": "khm_Khmr"},
        {"id": "d1", "category": "spelling", "status": "draft", "term": "NEVER", "variants": ["today"]},
    ]

    with open(sample_mp4, "rb") as fh:
        res = client.post(
            "/transcribe",
            files={"file": ("term_sample.mp4", fh, "video/mp4")},
            data={"language": "en", "diarize": "false", "translate_to": "khm_Khmr", "terminology": json.dumps(terminology)},
        )
    assert res.status_code == 200
    seg = res.json()["segments"][0]
    assert seg["text"] == "Phnom Penh launches VoxCPM with AI today."
    assert seg["translatedText"] == "[khm_Khmr] Phnom Penh launches VoxCPM with បញ្ញាសិប្បនិម្មិត today."
    assert "DO_NOT_LEAK_TTS" not in seg["text"]
    assert "DO_NOT_LEAK_TTS" not in seg["translatedText"]

    with open(sample_mp4, "rb") as fh:
        bad_json = client.post(
            "/transcribe",
            files={"file": ("bad.mp4", fh, "video/mp4")},
            data={"language": "en", "diarize": "false", "terminology": "{invalid"},
        )
    assert bad_json.status_code == 400

    tr_res = client.post(
        "/translate",
        json={
            "segments": [{"id": "seg-1", "start": 0.0, "end": 1.0, "text": "VoxCPM and AI"}],
            "sourceLanguage": "en",
            "targetLanguage": "khm_Khmr",
            "terminology": terminology,
        },
    )
    assert tr_res.status_code == 200
    assert tr_res.json()["segments"][0]["translatedText"] == "[khm_Khmr] VoxCPM and បញ្ញាសិប្បនិម្មិត"


def test_burn_and_dub_apply_audio_language_metadata_safely(tmp_path: Path) -> None:
    import json
    from video_io import resolve_ffprobe_bin

    sample_mp4 = tmp_path / "lang_sample.mp4"
    _make_sample_mp4(sample_mp4)
    client = _make_client(tmp_path)

    with open(sample_mp4, "rb") as fh:
        tr = client.post("/transcribe", files={"file": ("clip.mp4", fh, "video/mp4")}, data={"language": "en", "diarize": "false"})
    assert tr.status_code == 200
    job_id = tr.json()["jobId"]

    ffprobe = resolve_ffprobe_bin()
    if not Path(ffprobe).exists() and not shutil.which(ffprobe):
        pytest.skip("ffprobe not installed")

    burn_res = client.post(
        "/burn",
        json={
            "jobId": job_id,
            "segments": [{"id": "seg-1", "start": 0.1, "end": 1.2, "text": "សួស្តី", "speakerId": "speaker-1"}],
            "speakerNames": {},
            "videoSize": {"width": 640, "height": 360},
            "audioLanguage": "khm_Khmr",
        },
    )
    assert burn_res.status_code == 200, burn_res.text
    burned_mp4 = tmp_path / "burn-lang.mp4"
    burned_mp4.write_bytes(burn_res.content)
    burn_probe = json.loads(
        subprocess.run([ffprobe, "-v", "error", "-show_streams", "-of", "json", str(burned_mp4)], capture_output=True, text=True, check=True).stdout
    )
    burn_audio = next(s for s in burn_probe["streams"] if s["codec_type"] == "audio")
    assert (burn_audio.get("tags") or {}).get("language") == "khm"

    wav_a = _make_wav_bytes(0.4)
    dub_res = client.post(
        "/dub",
        data={
            "jobId": job_id,
            "metadata": json.dumps([{"segmentId": "seg-1", "start": 0.1, "end": 0.9, "fileIndex": 0}]),
            "originalAudioMode": "mute",
            "audioLanguage": "zsm_Latn",
        },
        files=[("files", ("clip1.wav", wav_a, "audio/wav"))],
    )
    assert dub_res.status_code == 200, dub_res.text
    dubbed_mp4 = tmp_path / "dub-lang.mp4"
    dubbed_mp4.write_bytes(dub_res.content)
    dub_probe = json.loads(
        subprocess.run([ffprobe, "-v", "error", "-show_streams", "-of", "json", str(dubbed_mp4)], capture_output=True, text=True, check=True).stdout
    )
    dub_audio = next(s for s in dub_probe["streams"] if s["codec_type"] == "audio")
    assert (dub_audio.get("tags") or {}).get("language") == "msa"

    # Malformed or injected language input falls back safely without breaking FFmpeg
    bad_lang_burn = client.post(
        "/burn",
        json={
            "jobId": job_id,
            "segments": [{"id": "seg-1", "start": 0.1, "end": 1.2, "text": "Hello", "speakerId": "speaker-1"}],
            "speakerNames": {},
            "videoSize": {"width": 640, "height": 360},
            "audioLanguage": "km\n-invalid-flag",
        },
    )
    assert bad_lang_burn.status_code == 200, bad_lang_burn.text
