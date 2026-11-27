# Voice Studio

React web interface for generating speech with VoxCPM2. The studio runs in Docker
Desktop and uses the VoxCPM2 Gradio API on macOS for Apple GPU inference. The
workspace follows the browser's light or dark preference and adapts its sidebar,
voice controls, and playback dock to the window size.

## Run on macOS (live reload)

Start Docker Desktop. From the `engine/` folder (the upstream VoxCPM2 repository),
start the inference server with its Python environment.

~~~sh
cd engine
uv sync --frozen --python 3.12
PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python app.py --host 127.0.0.1 --device auto
~~~

Keep that terminal open. VoxCPM2 downloads its weights on the first generation if
they are not already cached. If the original Gradio demo is already running on
port 8808, reuse it.

In a second terminal, build and start the live-reload studio container. Edits in
`web/src/`, `web/index.html`, and `web/vite.config.js` reload automatically in
the browser (and compile/syntax errors show in the Vite overlay and container
logs). Rebuild only when changing `web/package.json` or `web/package-lock.json`.

~~~sh
docker compose -f web/compose.yaml up --build -d
~~~

Open [Voice Studio](http://127.0.0.1:8087) to navigate across its five workspaces:

- **Projects:** Search, filter (`Text to speech`, `Video to subtitle`, `Dubbing`), duplicate, rename, delete, or create persistent projects stored in `/api/v1/projects`, and manage global **Terminology** (`spelling`, `translation`, `name`, `pronunciation`).
- **Text to speech:** Paste up to 2,000 characters or switch to **Segments** mode for structured multi-segment authoring with per-segment take history, pause gaps, and Khmer number expansion. Pick or create a speaking **Character** (each with an exclusive 1-person locked voice anchor), configure project terminology, pronunciation rules, and advanced controls (`guidance`, `4–20` diffusion steps, seed, reference denoise), preview/seek the `48 kHz` WAV player, and run Whisper Khmer word QA (`Check words`).
- **Video to subtitle:** Extract speech across 101 source languages, translate offline to 202 languages with continuous Khmer orthography post-processing, inspect timing on the synchronized **Subtitle Timeline**, review/remedy overlaps or speech duration mismatches, generate per-cue or batch voiceover takes, and export presets (`WAV`, `.srt`, `.vtt`, `.txt`, burned `MP4`, or dubbed `MP4` with `duck`/`mute`/`keep` original audio and soft `mov_text`/burned subtitles) via **Export project**.
- **Batch Jobs:** Track queued, running, completed, and interrupted background jobs with automatic restart recovery, retry, cancel, and downloadable artifacts.
- **Models & Setup:** Verify live connectivity across VoxCPM2 (`:8808`), Media (`:8810`), and Storage (`:8090`), offline readiness per feature, and catalog disk headroom.

Set the `VOICE_STUDIO_PORT` environment variable on the Compose command to change
the browser port. Docker Desktop provides the container's connection to macOS
through `host.docker.internal`.

~~~sh
docker compose -f web/compose.yaml down
~~~

## Production nginx container

To build and serve the minified static production bundle via nginx instead of
the Vite dev server (with `no-store` HTML/manifest headers and `/version.json`
auto-refresh polling):

~~~sh
docker compose -f web/compose.prod.yaml up --build -d
~~~

## Architecture & Docker Backend Storage

`web/src/` follows Clean Architecture (`Presentation → Domain → Data`):

- `src/domain/` — Pure entities, projects & segments (`projects.js`, `projectSegments.js`), stage-separated terminology (`terminology.js`, `pronunciationRules.js`), subtitle alignment/validation (`subtitles.js`, `subtitleValidation.js`, `durationMismatch.js`, `subtitleTts.js`), export presets & dub validation (`exportPresets.js`, `videoDubExport.js`, `exportHistory.js`), batch jobs (`productionJobs.js`), diagnostics/recovery (`modelDiagnostics.js`, `offlineReadiness.js`, `projectRecovery.js`), Khmer Unicode/numeral normalization (`khmerText.js`), PCM edge trimming/fades (`wavCodec.js`), typed errors, port contracts (`ports.js`), and application use cases (`useCases.js`) with zero React/DOM/network/storage imports.
- `src/data/` — Port implementations (`gradioSpeechGateway.js`, `mediaSubtitleGateway.js`, `diagnosticsGateway.js`, `httpAudioMaster.js`, `httpSynthesisCache.js`, `httpVersionChecker.js`, `httpProjectRepository.js`, `httpAssetRepository.js`, `httpJobRepository.js`, `httpTerminologyRepository.js`, `httpGlossaryRepository.js`, `httpAudioRepository.js`, `httpVoiceRepository.js`, `projectRecoveryStorage.js`, `takeAssetStorage.js`, `indexedDbAudioRepository.js`, `localVoiceRepository.js`, `webAudioDecoder.js`, `consoleLogger.js`).
- `src/presentation/` — React DI context (`StudioContext.jsx`), hooks, components (`Projects`, `Text to speech`, `Video to subtitle`, `Batch jobs`, `Models & Setup`, `Export project`), and styles consuming only `domain/` and injected services.
- `src/main.jsx` — Composition root wiring Data adapters into Domain use cases and mounting the Presentation UI.
- `server/` — Persistent `/api/v1` backend storage for characters, anchors, projects (`/api/v1/projects`), binary media assets (`/api/v1/assets`), durable batch jobs (`/api/v1/jobs`), terminology (`/api/v1/terminology`), glossary, FFmpeg EBU R128 `-16 LUFS` mastering (`POST /api/v1/audio/master`), bounded LRU synthesis cache, and automatic schema migrations (`storageMigration.js`) running in the `storage` Docker container backed by `voxcpm_voice_studio_data:/data`. Existing browser IndexedDB locks and custom characters migrate automatically on load so character voices stay fixed across browser clears and container rebuilds.

## Development and tests

From `web/`:

~~~sh
npm test
npm run storage   # start persistent backend storage API on :8090
npm run dev
npm run build
~~~
