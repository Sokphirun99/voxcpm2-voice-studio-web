# VoxCPM Media Subtitle Service (`media/`)

Local Apple Silicon FastAPI service (port `8810`) powering the **Video to subtitle** workspace in Voice Studio:

- **Speech-to-text & Khmer verification**: Hybrid ASR ([`asr.py`](./asr.py), [`khmer_verifier.py`](./khmer_verifier.py)) routing Khmer to `seanghay/Qwen3-ASR-0.6B-Khmer` (+ 3-layer local Khmer lexicon in [`khmer_dictionary.py`](./khmer_dictionary.py) & [`lexicon/`](./lexicon/)), with automatic selective recovery on broken turns, optional full subtitle double-check, and TTS round-trip word QA (`POST /verify-speech`) via `seanghay/whisper-small-khmer-v2`; other languages use `mlx-community/whisper-large-v3-turbo`.
- **Speaker diarization**: Optional offline `sherpa-onnx` pipeline ([`diarizer.py`](./diarizer.py)) with adaptive RMS energy VAD fallback when disabled.
- **Offline translation**: Meta `facebook/nllb-200-distilled-600M` ([`translator.py`](./translator.py)) with cross-cue context batching, source/output repetition guards, beam search, stage-separated terminology preservation ([`terminology.py`](./terminology.py)), and Khmer orthography post-processing ([`khmer_orthography.py`](./khmer_orthography.py)) that removes artificial word-by-word spaces while preserving Latin/brand tokens.
- **Subtitle export, burn-in & video dubbing**: Grapheme/Khmer-cluster-safe ASS/SRT/VTT generation ([`subtitles.py`](./subtitles.py)) and `ffmpeg-full` MP4 export ([`video_io.py`](./video_io.py)):
  - `POST /burn`: hard-coded `libass` ASS subtitles (`yuv420p`, AAC `48 kHz` stereo, `+faststart`).
  - `POST /dub`: time-aligned dubbed MP4 export with explicit audio modes (`original`, `replace`/`mute`, `duck`, `keep`/`mix`), mixing/ducking gain controls (`originalVolume`, `dubVolume`, `duckVolume`), and explicit subtitle modes (`none`, `burned` ASS, `soft` MP4 `mov_text` track with ISO-639-2 language metadata).

## Prerequisites (macOS Apple Silicon)

- Python `3.12` + [`uv`](https://docs.astral.sh/uv/)
- Homebrew `ffmpeg-full` (required for `libass` subtitle burn-in):
  ```sh
  brew install ffmpeg-full
  ```

## Setup

```sh
cd media
uv sync --frozen --python 3.12
# Install qwen-asr without dependency overrides so torch/transformers stay compatible:
uv pip install --python .venv/bin/python --no-deps qwen-asr==0.0.6
```

## Run & Test

```sh
# Run unit and FastAPI/FFmpeg integration tests
media/.venv/bin/pytest -v media/tests

# Start via workspace orchestrator (recommended)
./studio.sh start

# Or run standalone on port 8810
cd media && .venv/bin/uvicorn server:app --host 127.0.0.1 --port 8810
```

## Local Model Caches (Not Committed to Git)

Pretrained weights are cached outside this repository:
- HuggingFace models (`~/.cache/huggingface/hub/`): `mlx-community/whisper-large-v3-turbo`, `seanghay/Qwen3-ASR-0.6B-Khmer`, `seanghay/whisper-small-khmer-v2`, `facebook/nllb-200-distilled-600M`
- Diarization ONNX models (`~/.cache/voxcpm-media/diarization/`): downloaded lazily by [`diarizer.py`](./diarizer.py)

See [`../AGENTS.md`](../AGENTS.md) for the upstream dependency & model update checklist.
