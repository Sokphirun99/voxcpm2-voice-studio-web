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

Open [Voice Studio](http://127.0.0.1:8087). Paste up to 2,000 characters or load
the Khmer example, pick a speaking **Character** (each character has its own
unique ID and exclusive 1-person voice), and generate speech. A character's
voice clip automatically locks on its first generation—or via **Upload voice
sample…**—so subsequent scripts always sound like the same single person. Use
**Reset voice** if you want a character to generate a fresh sample, or open
**Character library** to browse characters and create custom ones in browser
storage. Use **Cancel** in the toolbar to abort an active synthesis request.

The player lets you preview, seek, bind a take to the active character, and
download the 48 kHz WAV. The advanced controls expose guidance, diffusion steps
(`4–20`), reproducible seed selection, and reference noise cleanup.

Set the `VOICE_STUDIO_PORT` environment variable on the Compose command to change
the browser port. Docker Desktop provides the container's connection to macOS
through `host.docker.internal`.

~~~sh
docker compose -f web/compose.yaml down
~~~

## Production nginx container

To build and serve the minified static production bundle via nginx instead of
the Vite dev server:

~~~sh
docker compose -f web/compose.prod.yaml up --build -d
~~~

## Architecture & Docker Backend Storage

`web/src/` follows Clean Architecture (`Presentation → Domain → Data`):

- `src/domain/` — Pure entities, Khmer Unicode/numeral normalization (`khmerText.js`), PCM edge trimming/fades (`wavCodec.js`), validation rules, typed errors, port contracts (`ports.js`), and application use cases (`useCases.js`) with zero React/DOM/network/storage imports.
- `src/data/` — Port implementations (`gradioSpeechGateway.js`, `httpAudioMaster.js`, `httpSynthesisCache.js`, `httpAudioRepository.js`, `httpVoiceRepository.js`, `indexedDbAudioRepository.js`, `localVoiceRepository.js`, `webAudioDecoder.js`, `consoleLogger.js`).
- `src/presentation/` — React DI context (`StudioContext.jsx`), hooks, components, and styles consuming only `domain/` and injected services.
- `src/main.jsx` — Composition root wiring Data adapters into Domain use cases and mounting the Presentation UI.
- `server/` — Persistent `/api/v1` backend storage, FFmpeg EBU R128 `-16 LUFS` mastering (`POST /api/v1/audio/master`), and bounded LRU synthesis cache (`GET/PUT /api/v1/cache/:key`) running in the `storage` Docker container backed by `voxcpm_voice_studio_data:/data` (`catalog.json`, `/data/anchors/*.audio`, `/data/cache/*.wav`). Existing browser IndexedDB locks and custom characters migrate automatically on load so character voices stay fixed across browser clears and container rebuilds.

## Development and tests

From `web/`:

~~~sh
npm test
npm run storage   # start persistent backend storage API on :8090
npm run dev
npm run build
~~~
