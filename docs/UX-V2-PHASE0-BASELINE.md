# Voice Studio — UX & Quality V2: Phase 0 Inventory & Baseline (`UX0-01` / `UX0-02`)

- **Reviewed Branch:** `stage-phirun`
- **Baseline Commit SHA:** `4f4dea2` (prior to V2 delta edits)
- **Review Date:** `2026-11-28`
- **Source Plan:** `/Users/phirun/Downloads/Voice-Studio-UX-Quality-V2-Plan.md`

---

## 1. Capability Matrix Across Primary User Journeys (`UX0-01`)

| User Journey | Key Routes / Components / Services / Stores | Status | Verified Defects & V2 Delta Needed |
|---|---|---|---|
| **1. Text to Speech & Narration** | `Studio.jsx` (`activeWorkspace === 'tts'`), `TextToSpeechWorkspace.jsx`, `Toolbar.jsx`, `ScriptEditor.jsx`, `SegmentEditor.jsx`, `ChunkSegmentsPanel.jsx`, `VoiceControls.jsx`, `VoiceLibrary.jsx`, `AudioPlayer.jsx`, `useSpeechSynthesis.js`, `useCases.js`, `httpSpeechGateway.js`, `httpSynthesisCache.js`, `engine/app.py` (`:8808`) | `partially complete` | **Fixed in this pass:** `ChunkSegmentsPanel`/`regenerateChunk` previously overwrote takes in-place (`replaceTake`). **Remaining V2 deltas:** surface language & playable voice previews in TTS/VoiceLibrary; reconcile `SegmentEditor` vs `ChunkSegmentsPanel`; add custom voice consent notice; include `modelVersion` in synthesis cache key. |
| **2. Generate Subtitles** | `VideoSubtitleWorkspace.jsx`, `useVideoSubtitles.js`, `SubtitleSegmentRow.jsx`, `SubtitleTimeline.jsx`, `SubtitleExportDock.jsx`, `ExportProjectModal.jsx`, `mediaSubtitleGateway.js`, `media/server.py` (`:8810`) | `partially complete` | **Fixed in this pass:** removed duplicate `ProjectSelector`, removed competing `restoreLatestProject` in `Studio`-hosted workspaces, consolidated 3 overlapping export surfaces around `ExportProjectModal` (with quality, location, estimated size, collapsible advanced options, progress & cancel). **Remaining V2 deltas:** guided wizard wrapper + diagnostics log viewer (`UX1-04`). |
| **3. Translate & Dub Video** | `VideoSubtitleWorkspace.jsx`, `useVideoSubtitles.js`, `useSubtitleVoiceover.js`, `durationMismatch.js`, `subtitleTts.js`, `videoDubExport.js`, `media/translator.py`, `media/video_io.py` | `partially complete` | Timing/mismatch remedies (`UX2-04`) and FFmpeg duck/keep/mute mix modes (`UX3-01`) are complete. **Remaining V2 deltas:** dedicated `'dubbing'` route/wizard (`UX1-01`/`UX1-04`), vocal/background source separation + live mix preview (`UX3-01`), interactive non-destructive audio trim/volume/speed (`UX2-03`), and Khmer-speaking human review of the UX2-02 eval corpus. |
| **4. Reopen & Recover Projects** | `Studio.jsx` (`useRestoreLastActiveProject`), `ProjectsWorkspace.jsx`, `useProjectAutosave.js`, `useProjectRecovery.js`, `BatchJobsWorkspace.jsx`, `web/server/projectStore.js`, `web/server/assetStore.js`, `web/server/storageMigration.js` | `complete` (minor optional delta) | Atomic writes, autosave badge, crash draft & missing-asset relinking, schema migration + pre-migration backup, and `./studio.sh backup/restore` are implemented. Optional V2 delta: portable single-project export/import archive. |

---

## 2. Task-by-Task V2 Delta Summary (15 Tasks)

| Task ID | Priority | Current Status | Action |
|---|---|---|---|
| `UX0-01` | P0 | `partially complete` | Maintain this matrix; add `lint` script in `web/package.json`; verify `seanghay/whisper-small-khmer-v2` weight license; complete live app walkthrough outside sandbox. |
| `UX0-02` | P0 | `not verified` (live stack) | Record 4-workflow step counts, generation latency, export duration, and peak Apple Silicon unified RAM on host outside sandbox. |
| `UX1-01` | P0 | `partially complete` | Removed duplicate `ProjectSelector` & competing workspace auto-restore. Remaining: task-oriented Home view & dedicated `'dubbing'` workflow entry. |
| `UX1-02` | P0 | `mostly complete` | Fixed destructive `ChunkSegmentsPanel` take overwrite. Remaining: active language indicator, voice preview, and unifying `SegmentEditor`/`ChunkSegmentsPanel`. |
| `UX1-03` | P0 | `partially complete` | Add playable voice sample previews, favorites, language tags on built-in voices, and custom voice authorization/consent notice. |
| `UX1-04` | P0 | `partially complete` | Add guided step-by-step wizard wrapper, optional mid-`/transcribe` checkpointing, and optional diagnostics log viewer in `Models & Setup`. |
| `UX2-01` | P0 | `complete` (live smoke verified) | General Undo/Redo, stale-translation flag with per-cue Re-translate/Keep, and subtitle take switcher implemented; verified in browser at `:8087` on `2026-11-28`. |
| `UX2-02` | P0 | `implemented; human review pending` | Khmer TTS normalization now speaks valid `DD/MM/YYYY` and `YYYY-MM-DD` dates in Khmer calendar order, preserves invalid dates, and separates uppercase acronym/version number boundaries while retaining mixed-case brand names. Added a 58-case exact-match regression/eval corpus in `web/evals/UX2-02-khmer-normalization.json` with `npm run eval:khmer-normalization`; corpus is agent-curated and still needs Khmer-speaking human review before it can be called human-reviewed. |
| `UX2-03` | P1 | `missing` (core editor) | Add interactive non-destructive trim handles, per-clip volume slider, playback/export speed, and user-triggered silence removal with preview/reset. |
| `UX2-04` | P0 | `complete` (`retain`) | Keep existing mismatch/spill/extend/trim remedies; minor optional gap warning between cues. |
| `UX3-01` | P1 | `partially complete` | Retain FFmpeg mix modes (`Duck`/`Keep`/`Mute`/`Original`); add optional local vocal/BGM separation adapter & pre-export mix preview. |
| `UX3-02` | P1 | `mostly complete` | Consolidated 3 overlapping export surfaces around `ExportProjectModal`; added quality, location, estimated size, collapsible advanced options, progress, and cancel. |
| `UX4-01` | P0 | `complete` (`retain`) | Keep autosave, recovery, migration, and backup/restore; add portable single-project package only if needed. |
| `UX4-02` | P1 | `mostly complete` | Add `modelVersion` to synthesis cache key, simultaneous heavy-model RAM guard in `media/`, and default `127.0.0.1` bind option for `studio`/`vite` if LAN access should be opt-in. |
| `UX4-03` | P0 | `partially complete` | Added `npm run lint` syntax/static check in `web/package.json`. Remaining: live browser E2E, automated a11y checks, license audit, and nginx CSP headers. |

---

## 3. Repository Test, Build & License Inventory (`UX0-01` / `UX0-02`)

### Build, Lint, and Test Commands
- **Frontend unit/integration tests:** `cd web && npm test` (`node --test`)
- **Frontend production build:** `cd web && npm run build` (`vite build`)
- **Frontend static syntax check:** `cd web && npm run lint` (added in `web/package.json`)
- **Media service tests:** `media/.venv/bin/pytest -v media/tests`

### License & Offline Inventory
- **Repo custom code (`web/`, `media/`, root scripts):** MIT (`LICENSE`)
- **`OpenBMB/VoxCPM` (`engine/`):** Apache-2.0
- **`mlx-whisper` / OpenAI Whisper:** MIT
- **`Qwen3-ASR` & `seanghay/Qwen3-ASR-0.6B-Khmer`:** Apache-2.0
- **`seanghay/whisper-small-khmer-v2`:** **Unverified** — confirm exact HuggingFace model card license before commercial distribution
- **`facebook/nllb-200-distilled-600M`:** CC-BY-NC-4.0 (non-commercial model weights; evaluate commercial alternatives if shipping commercially)
- **`sherpa-onnx`:** Apache-2.0
- **Runtime prerequisites:** `ffmpeg-full` (with `libass`), Python 3.12 (`uv`), Node 20+, Docker Desktop (optional for containerized `storage` + `studio` nginx proxy).

### Live Browser Verification — `UX2-01` (`2026-11-28`)
- Rebuilt the Docker prod stack and opened the existing 55-cue Khmer project at `http://localhost:8087`.
- **Undo/Redo:** edited a cue (normal typing), `Cmd+Z` reverted it and `Cmd+Shift+Z` reapplied it; `#subtitle-undo-btn` / `#subtitle-redo-btn` also worked and toggled their disabled states correctly.
- **Stale translation:** editing source text showed `Source text changed since translation.` with `Re-translate` / `Keep translation`; both actions worked, single-cue MT returned an updated Khmer cue, and Undo restored the stale flag.
- **Take switcher:** generated a second persisted take, confirming `TAKES (2)` with `Take 1` marked `OUTDATED` and `Take 2` `ACTIVE`; selecting Take 1 moved the `Active` badge and duration, and Play/Stop on Take 2 toggled `is-playing`.
- Translation-only edits did **not** raise the stale flag. Cleanup restored the cue text and removed the extra take; the persisted project matched its pre-test content (revision advanced only).

### UX2-02 Normalization & Evaluation
- `web/src/domain/khmerText.js` now expands valid Khmer-context `DD/MM/YYYY` and `YYYY-MM-DD` tokens into day/month/year Khmer speech, accepts Khmer digits, avoids duplicate `ថ្ងៃទី`, and leaves invalid calendar dates unchanged.
- Uppercase acronym/version boundaries (for example `GPT-6.2`, `AI2026`) are separated before number expansion; mixed-case names such as `VoxCPM2` remain unchanged.
- The deterministic 58-case fixture passes exact matching. It is explicitly marked **human review pending**; no Khmer-speaking human review has been performed in this automated pass.

### Runtime Baseline Status (`UX0-02`)
- **Process check (`./studio.sh status` on `2026-11-28`):** Native `engine` (`PID 97609`, `127.0.0.1:8808`) and native `media` (`PID 97611`, `127.0.0.1:8810`) are running; Docker CLI and direct localhost HTTP requests were blocked by the agent sandbox environment (`operation not permitted` / `Direct IP access is not allowed`), so live inference latency, end-to-end export timings, and peak Apple Silicon RAM baselines remain **not verified** in this automated pass and should be captured directly on the host.
