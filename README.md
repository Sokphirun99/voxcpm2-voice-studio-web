# Project Text-to-Voice

Workspace separating the upstream open-source VoxCPM2 engine from the custom Voice Studio web frontend.

## Folders

- **`engine/`** — Unmodified upstream open-source clone of [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM) (`origin` points upstream; ignored by root `.gitignore`) with its own Python virtual environment (`engine/.venv/`). Update safely with `./update-engine.sh`.
- **`media/`** — Custom local Apple Silicon speech-to-subtitle, diarization, Khmer 3-layer dictionary, translation, and burn-in service (port `8810`; tracked in this monorepo). See [media/README.md](./media/README.md).
- **`web/`** — Custom React + Vite **Voice Studio** frontend, persistent Docker storage (`8090`), and unit tests (tracked in this monorepo). See [web/README.md](./web/README.md).

## Fresh Machine Setup

```sh
git clone https://github.com/Sokphirun99/voxcpm2-voice-studio-web.git project-text-to-voice
cd project-text-to-voice
git clone https://github.com/OpenBMB/VoxCPM.git engine

# 1. Engine environment
(cd engine && uv sync --frozen --python 3.12)

# 2. Media subtitle environment (requires Homebrew ffmpeg-full for libass burn-in)
brew install ffmpeg-full
(cd media && uv sync --frozen --python 3.12 && uv pip install --python .venv/bin/python --no-deps qwen-asr==0.0.6)

# 3. Start full stack
./studio.sh start
```

## Updating Upstream Open-Source `engine/`

```sh
./update-engine.sh --check          # inspect incoming upstream commits and contract diffs
./update-engine.sh                  # fast-forward pull, rebuild engine/.venv, run tests, restart stack
./update-engine.sh --rollback <SHA> # roll back safely if an upstream change breaks compatibility
```

## Quick start (macOS)

Run the persistent background engines (`launchd`, Apple GPU MPS on ports `8808` & `8810` with automatic restart) plus the Voice Studio Docker stack (`8087`) with one command:

~~~sh
./studio.sh start
~~~

Other commands:

~~~sh
./studio.sh status    # check engine/media launchd services, Docker container, and proxy health
./studio.sh logs      # tail engine & media logs (logs/*.log)
./studio.sh restart   # restart engines and rebuild/restart Docker container
./studio.sh stop      # stop background launchd services and Docker container
./cleanup.sh --unused --dry-run   # preview unused benchmark models & temp cache cleanup (~9.7 GB)
~~~

See [CLEANUP.md](./CLEANUP.md) for the full disk footprint inventory, safe cleanup modes (`--unused`, `--app`, `--all`), and manual uninstall steps.

Manual setup (without `launchd`):

1. Start the VoxCPM2 Gradio inference server from `engine/`:

~~~sh
cd engine
uv sync --frozen --python 3.12
PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python app.py --host 127.0.0.1 --device auto
~~~

2. Start the live-reload Voice Studio container from the workspace root:

~~~sh
docker compose -f web/compose.yaml up --build -d
~~~

3. Open [Voice Studio](http://127.0.0.1:8087). See [web/README.md](./web/README.md) for development, testing, and production nginx options, and [AGENTS.md](./AGENTS.md) for the upstream `engine/` update review checklist.
