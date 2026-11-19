# Workspace Rules & Upstream Update Guide

This workspace keeps the upstream open-source VoxCPM2 engine strictly separated from our custom Voice Studio monorepo (`Sokphirun99/voxcpm2-voice-studio-web`):

- `engine/` — Untouched clone of `https://github.com/OpenBMB/VoxCPM.git` (`origin/main`, ignored by root `.gitignore`). **Do not edit files inside `engine/`.** Use `./update-engine.sh` to check, fast-forward update, verify, or roll back `engine/`.
- `media/` — Custom offline Apple Silicon FastAPI subtitle, diarization, Khmer lexicon, translation, and burn-in service (tracked in this monorepo).
- `web/` — Custom React + Vite Voice Studio frontend and Docker storage API (tracked in this monorepo).

---

## Checklist When Updating `engine/` (For AI & Developers)

Use the automated helper script (recommended):
```sh
./update-engine.sh --check          # preview incoming commits & contract file diffs
./update-engine.sh                  # fast-forward pull, uv sync, run web+media tests, restart stack
./update-engine.sh --rollback <SHA> # roll back engine/ and rebuild engine/.venv if needed
```

Or follow the manual steps below whenever updating `engine/` to newer upstream commits from OpenBMB/VoxCPM:

### 1. Record baseline & pull cleanly
```sh
git -C engine status --short           # must be empty before pulling
git -C engine rev-parse --short HEAD    # save current commit SHA for rollback
cd engine && git pull --ff-only
```
If `git pull --ff-only` fails, inspect why before merging or rebasing; never mix `web/` files into `engine/`.

### 2. Inspect upstream changes that affect `web/`
Run a diff against the saved baseline commit:
```sh
git -C engine diff <OLD_SHA>..HEAD -- app.py pyproject.toml uv.lock src/voxcpm/core.py src/voxcpm/model/utils.py
```

Review every item below and update `web/` if anything changed:

1. **Gradio `/generate` API positional contract (`engine/app.py`)**
   - `web/src/voxcpm.js` sends 10 positional inputs to `POST /gradio_api/call/generate`:
     1. `text` (`str`)
     2. `control_instruction` (`str`)
     3. `reference_wav` (`gradio.FileData | null`, `{ path, orig_name, mime_type, meta: { _type: "gradio.FileData" } }`)
     4. `show_prompt_text` (`bool`, must remain `false` for `control_instruction` to apply)
     5. `prompt_text` (`str`)
     6. `cfg_value` (`float`, `1.0–3.0`)
     7. `DoNormalizeText` (`bool`)
     8. `DoDenoisePromptAudio` (`bool`)
     9. `dit_steps` (`int`, `4–20` in `web/`)
     10. `seed_value` (`int | null`)
   - Expects `outputs=[audio_output, seed_value]` (`[FileData, number]`) and `api_name="generate"` on default port `8808` with `show_error=True`.
   - Confirm `engine/app.py` still strips parentheses `[()（）]` cleanly and matches `web/src/voice-presets.js`.

2. **Gradio HTTP/SSE/Upload routes (`engine/pyproject.toml`, `engine/uv.lock`)**
   - Current constraint: `gradio>=6,<7` (verified on `6.9.0`).
   - Verify these endpoints still behave identically and match allowlists in `web/vite.config.js` and `web/nginx.conf`:
     - `GET /gradio_api/info` (`named_endpoints['/generate']`)
     - `POST /gradio_api/upload` (`files` multipart upload returning `[path]`)
     - `POST /gradio_api/call/generate` (returns `{ event_id }` hex string)
     - `GET /gradio_api/call/generate/{event_id}` (SSE `event: complete` / `event: error`)
     - `GET /gradio_api/file=/.+\.wav` (audio download URL)

3. **Runtime & Apple Silicon MPS behavior (`engine/src/voxcpm/core.py`, `engine/src/voxcpm/model/utils.py`)**
   - Check `pick_runtime_dtype` for any changes to MPS `float32` fallback or `VOXCPM_MPS_DTYPE`.
   - Verify `sample_rate` remains `48000` (if changed, update the `48 kHz` label in `web/src/AudioPlayer.jsx`).

### 3. Rebuild environment & verify both halves
```sh
cd engine
uv sync --frozen --python 3.12
.venv/bin/python app.py --help
```
Then restart `app.py` (`./studio.sh restart`, or manually with `PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python app.py --host 127.0.0.1 --device auto`) and verify `web/`:
```sh
cd web
npm test
npm run build
```
If an upstream update breaks compatibility and needs time to adapt `web/`, roll back `engine/` temporarily:
```sh
git -C engine checkout <OLD_SHA>
cd engine && uv sync --frozen --python 3.12
```

---

## Checklist When Updating `media/` Open-Source Dependencies & Models (For AI & Developers)

`media/` is our own custom source code, but it depends on upstream open-source Python packages, Homebrew `ffmpeg-full`, and cached pretrained models. Follow these steps whenever upgrading any of them:

### 1. Record baseline versions & lockfile
```sh
git status --short media/
media/.venv/bin/python -c "import importlib.metadata as m; print({k: m.version(k) for k in ['qwen-asr', 'mlx-whisper', 'sherpa-onnx', 'transformers', 'torch', 'fastapi']})"
```
Current verified baseline: `qwen-asr==0.0.6` (installed with `--no-deps`), `mlx-whisper==0.4.3`, `sherpa-onnx==1.13.8`, `transformers==4.57.6`, `torch==2.15.0`, `fastapi==0.163.1`.

### 2. Inspect upstream compatibility areas
1. **HTTP API contract with `web/` (`media/server.py`, `web/src/data/mediaSubtitleGateway.js`, `web/vite.config.js`, `web/nginx.conf`)**
   - Keep port `8810` and endpoints intact:
     - `GET /health` (`ok`, `burnInSupported`, `pid`, `startedAt`, model IDs)
     - `POST /transcribe` (`file`, `language`, `num_speakers`, `diarize`, `translate_to` -> `{ jobId, language, speakers, segments, isAudioOnly, videoSize, assColorMap }`)
     - `POST /translate` (`{ segments, sourceLanguage, targetLanguage }`)
     - `POST /burn` (`{ jobId, segments, speakerNames, videoSize, includeSpeaker, useTranslation, bilingual, subtitleStyle }`)
2. **Python packages (`media/pyproject.toml`, `media/uv.lock`)**
   - **Never add `qwen-asr` directly into `media/pyproject.toml`** unless verified against `torch` and `transformers` constraints — install it explicitly with `--no-deps` (`uv pip install --python .venv/bin/python --no-deps qwen-asr==0.0.6`).
   - Verify `nagisa` and `soynlp` module stubs in `media/asr.py` still satisfy `qwen_asr.Qwen3ASRModel` imports after upgrading `qwen-asr`.
   - When upgrading `sherpa-onnx`, confirm `OfflineSpeakerDiarization` and `OfflineSpeechDenoiser` API signatures and the 3 release URLs in `media/diarizer.py` still match.
   - When upgrading `transformers` / `torch`, verify `LocalTranslator._translate_batch` decoding kwargs (`num_beams=2`, `early_stopping=True`, `repetition_penalty=1.15`, `no_repeat_ngram_size=5`, `forced_bos_token_id`) and MPS compatibility.
3. **Cached open-source models & `ffmpeg-full`**
   - Active HuggingFace repos (`~/.cache/huggingface/hub/`): `mlx-community/whisper-large-v3-turbo`, `seanghay/Qwen3-ASR-0.6B-Khmer`, `facebook/nllb-200-distilled-600M` (keep `media/cleanup_cache.py` `ACTIVE_PROJECT_REPOS` in sync if a default model ID changes).
   - Active diarization ONNX cache (`~/.cache/voxcpm-media/diarization/`): Pyannote segmentation 3.0, 3D-Speaker CAM++, GTCRN denoiser (`media/diarizer.py`).
   - After upgrading Homebrew `ffmpeg-full`, verify `libass` filter availability via `media/tests/test_video_io.py`.

### 3. Rebuild environment, test & restart
```sh
cd media
uv sync --frozen --python 3.12
uv pip install --python .venv/bin/python --no-deps qwen-asr==0.0.6
.venv/bin/pytest -v tests
```
Then restart and verify the live stack:
```sh
./studio.sh restart
./studio.sh status
```
If an upgrade breaks compatibility, roll back cleanly:
```sh
git checkout -- media/pyproject.toml media/uv.lock
cd media && uv sync --frozen --python 3.12 && uv pip install --python .venv/bin/python --no-deps qwen-asr==0.0.6
```
