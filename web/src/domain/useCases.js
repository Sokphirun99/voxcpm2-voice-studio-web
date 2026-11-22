/**
 * @fileoverview Pure domain application use cases coordinating ports via dependency injection.
 */

import { validateAudioFile } from './audioValidation.js';
import { ValidationError } from './errors.js';
import { assertFeatureOfflineReady } from './offlineReadiness.js';
import { assertPort } from './ports.js';
import { validateGenerationInput } from './presets.js';
import { hasPauseMarkers, segmentScriptWithPauses, stripPauseMarkers } from './scriptSegmentation.js';
import { createSavedVoiceEntry } from './voiceLibrary.js';
import { concatenateWavBlobsWithPauses, replaceChunkAndRestitch, tryReadWavDurationSeconds, trySmoothWavBlob } from './wavCodec.js';

const SINGLE_VOICE_PAUSE_MS = 160;
const EXPIRED_REF_PATTERN = /expired on the server/i;

/**
 * Generates a unique ID using Web Crypto when available.
 * @returns {string} Unique saved character ID.
 */
function defaultIdGenerator() {
  if (globalThis.crypto?.randomUUID) return `char-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  return `char-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Uploads an audio Blob as a character reference clip and notifies `onReferenceUploaded`.
 * @param {object} params - Upload specification.
 * @returns {Promise<object>} Uploaded Gradio FileData descriptor.
 */
async function uploadAnchorBlob({ speechGateway, anchor, signal, onReferenceUploaded }) {
  const fileData = await speechGateway.uploadReferenceAudio({
    blob: anchor.blob,
    fileName: anchor.fileName || `character-${anchor.characterId || 'voice'}.wav`,
    mimeType: anchor.mimeType || anchor.blob?.type || 'audio/wav',
    signal,
  });
  onReferenceUploaded?.(fileData);
  return fileData;
}

/**
 * Resolves the initial Gradio FileData for a pinned character anchor, uploading once if needed.
 * @param {object} params - Resolution parameters.
 * @returns {Promise<{ fileData: object|null, wasCached: boolean }>} Resolved FileData and cache flag.
 */
async function resolveInitialReference({ speechGateway, anchor, cachedUpload, signal, onReferenceUploaded }) {
  if (!anchor) return { fileData: null, wasCached: false };
  if (cachedUpload) return { fileData: cachedUpload, wasCached: true };
  if (!anchor.blob) return { fileData: null, wasCached: false };
  const fileData = await uploadAnchorBlob({ speechGateway, anchor, signal, onReferenceUploaded });
  return { fileData, wasCached: false };
}

/**
 * Synthesizes one text chunk and automatically re-uploads once if a cached Gradio ref expired.
 * @param {object} params - Execution parameters.
 * @returns {Promise<{ blob: Blob, seed: number|null, referenceFile: object|null }>} Chunk synthesis result.
 */
async function synthesizeChunkWithRetry(params) {
  const { speechGateway, payload, referenceFile, wasCached, anchor, signal, onReferenceUploaded } = params;
  try {
    const res = await speechGateway.synthesize({ ...payload, referenceFile, signal });
    return { ...res, referenceFile };
  } catch (error) {
    if (!wasCached || !anchor?.blob || !EXPIRED_REF_PATTERN.test(error?.message || '')) throw error;
    onReferenceUploaded?.(null);
    const freshRef = await uploadAnchorBlob({ speechGateway, anchor, signal, onReferenceUploaded });
    const retried = await speechGateway.synthesize({ ...payload, referenceFile: freshRef, signal });
    return { ...retried, referenceFile: freshRef };
  }
}

/**
 * Builds the chunk-specific payload preserving anchored 1-person voice timbre across chunks.
 * @param {{ payload: object, text: string, index: number, hasInitialAnchor: boolean, denoiseReference: boolean }} spec - Chunk spec.
 * @returns {object} Gateway synthesize payload.
 */
function buildChunkPayload({ payload, text, index, hasInitialAnchor, denoiseReference }) {
  const isFirst = index === 0;
  return {
    ...payload,
    text,
    instruction: isFirst || hasInitialAnchor ? payload.instruction : '',
    usePromptText: isFirst ? payload.usePromptText : Boolean(hasInitialAnchor && payload.usePromptText),
    denoiseReference: isFirst || hasInitialAnchor ? denoiseReference : false,
  };
}

/**
 * Uploads chunk 0 as a session anchor when an unpinned script splits into multiple chunks.
 * @param {object} params - Session anchor upload parameters.
 * @returns {Promise<object|null>} Uploaded FileData or existing reference.
 */
async function ensureMultiChunkAnchor({ speechGateway, activeRef, index, totalChunks, characterId, blob, signal, onReferenceUploaded }) {
  if (activeRef || index !== 0 || totalChunks <= 1) return activeRef;
  return uploadAnchorBlob({
    speechGateway,
    anchor: { characterId, blob, fileName: `anchor-${characterId}.wav` },
    signal,
    onReferenceUploaded,
  });
}

/**
 * Synthesizes one chunk and updates the active server anchor after chunk 0.
 * @param {object} spec - Iteration context.
 * @returns {Promise<{ blob: Blob, seed: number|null, activeRef: object|null }>} Chunk output and anchor ref.
 */
async function processSynthesisChunk(spec) {
  const { speechGateway, payload, chunks, index, anchor, activeRef, wasCached, denoiseReference, signal, onProgress, onReferenceUploaded } = spec;
  onProgress?.({ completed: index, total: chunks.length });
  const chunkPayload = buildChunkPayload({ payload, text: chunks[index], index, hasInitialAnchor: Boolean(anchor), denoiseReference });
  const res = await synthesizeChunkWithRetry({
    speechGateway, payload: chunkPayload, referenceFile: activeRef,
    wasCached: index === 0 && wasCached, anchor, signal, onReferenceUploaded,
  });
  const nextRef = await ensureMultiChunkAnchor({
    speechGateway, activeRef: res.referenceFile, index, totalChunks: chunks.length,
    characterId: payload.characterId, blob: res.blob, signal, onReferenceUploaded,
  });
  return { blob: res.blob, seed: res.seed ?? payload.seed, activeRef: nextRef };
}

/**
 * Synthesizes all chunks of a script while anchoring chunk 0 to keep 1 consistent speaker.
 * @param {object} params - Batch synthesis params.
 * @returns {Promise<object>} Combined recording and uploadedFileData.
 */
async function runChunkedSynthesis(params) {
  let activeRef = params.initialRef;
  let firstSeed = params.payload.seed;
  const blobs = [];
  const chunks = [];
  for (let i = 0; i < params.chunks.length; i++) {
    const step = await processSynthesisChunk({ ...params, index: i, activeRef });
    if (i === 0) firstSeed = step.seed;
    blobs.push(step.blob);
    chunks.push({
      index: i,
      text: params.chunks[i],
      blob: step.blob,
      seed: step.seed,
      durationSeconds: await readRecordingDurationSeconds(step.blob),
      pauseAfterMs: params.pausesAfterMs?.[i] ?? null,
    });
    activeRef = step.activeRef;
  }
  const merged = await concatenateWavBlobsWithPauses(chunks.map(chunk => ({ blob: chunk.blob, pauseAfterMs: chunk.pauseAfterMs })), SINGLE_VOICE_PAUSE_MS);
  return { blob: merged, seed: firstSeed, anchorBlob: blobs[0], anchorTranscript: params.chunks[0], uploadedFileData: activeRef, chunks };
}

/**
 * Builds the recording response for a deterministic synthesis cache hit.
 * @param {object} spec - Cached hit, payload, character, chunks, and flags.
 * @returns {object} Synthesis use-case result shape.
 */
function buildCachedSynthesisResult({ hit, payload, character, chunks, cachedUpload, masterAudio }) {
  const seed = hit.seed ?? payload.seed;
  const transcript = hasPauseMarkers(payload.text) ? stripPauseMarkers(payload.text) : payload.text;
  return {
    recording: {
      id: `take-${Date.now()}-${seed ?? 'cached'}`,
      characterId: character.id,
      characterName: character.name,
      transcript,
      blob: hit.blob,
      seed,
      anchorBlob: hit.blob,
      anchorTranscript: chunks[0],
      uploadedFileData: cachedUpload || null,
      fromCache: true,
      mastered: Boolean(masterAudio),
      chunks: [],
    },
    uploadedFileData: cachedUpload || null,
  };
}

/**
 * Looks up a deterministic cached synthesis clip if a `SynthesisCachePort` is injected.
 * @param {{ synthesisCache: object|null, cacheSpec: object, signal?: AbortSignal }} params - Lookup inputs.
 * @returns {Promise<{ cacheKey: string|null, hit: object|null }>} Computed cache key and matched clip.
 */
async function tryLookupSynthesisCache({ synthesisCache, cacheSpec, signal }) {
  if (!synthesisCache) return { cacheKey: null, hit: null };
  const cacheKey = await synthesisCache.computeKey(cacheSpec);
  const hit = await synthesisCache.getCachedAudio(cacheKey, { signal });
  return { cacheKey, hit };
}

/**
 * Applies server loudness mastering when enabled, falling back cleanly to local PCM smoothing.
 * @param {{ blob: Blob, anchorBlob?: Blob, masterAudio: boolean, audioMaster: object|null, signal?: AbortSignal }} params - Mastering inputs.
 * @returns {Promise<{ blob: Blob, anchorBlob?: Blob, mastered: boolean }>} Final WAV Blobs and mastered flag.
 */
async function applySynthesisMastering({ blob, anchorBlob, masterAudio, audioMaster, signal }) {
  const cleanAnchor = anchorBlob ? await trySmoothWavBlob(anchorBlob) : anchorBlob;
  if (masterAudio && audioMaster) {
    const mastered = await audioMaster.masterWav(blob, { signal });
    return { blob: mastered.blob, anchorBlob: cleanAnchor, mastered: mastered.mastered };
  }
  return { blob: await trySmoothWavBlob(blob), anchorBlob: cleanAnchor, mastered: false };
}

async function readRecordingDurationSeconds(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') return 0;
  return tryReadWavDurationSeconds(await blob.arrayBuffer());
}

/**
 * Attaches generation timing, payload byte size, and PCM duration metrics to a synthesis result.
 * @param {object} result - Raw synthesis output `{ recording, uploadedFileData }`.
 * @param {number} startedAt - Synthesis start timestamp in ms.
 * @returns {Promise<object>} Enriched synthesis output.
 */
async function attachRecordingMetrics(result, startedAt) {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const blob = result.recording?.blob;
  const duration = await readRecordingDurationSeconds(blob);
  return {
    ...result,
    recording: {
      ...result.recording,
      elapsedMs,
      sizeBytes: Number.isFinite(blob?.size) ? blob.size : 0,
      audioDurationSeconds: duration > 0 ? duration : null,
    },
  };
}

function assertOfflineReadyIfSpecified(featureId, models, isOnline) {
  if (models === undefined) return;
  const online = isOnline ?? (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true);
  assertFeatureOfflineReady({ featureId, models, isOnline: online });
}

/**
 * Executes single-character synthesis validation, cache lookup, chunking, mastering, and voice anchoring.
 * @param {{ speechGateway: import('./ports.js').SpeechGatewayPort, audioMaster?: object|null, synthesisCache?: object|null, seedGenerator?: () => number }} deps - Use-case ports.
 * @param {object} params - Synthesis command parameters.
 * @returns {Promise<object>} Recording metadata and uploaded FileData cache.
 */
async function executeSpeechSynthesis({ speechGateway, audioMaster = null, synthesisCache = null, glossaryRepository = null, seedGenerator }, params) {
  const { script, character, anchor = null, cachedUpload = null, guidance, steps, seed, autoFormatKhmer = false, styleMode, customStyle = '', denoiseReference = false, masterAudio = true, pronunciationRules, signal, onProgress, onReferenceUploaded, models, isOnline } = params || {};
  assertOfflineReadyIfSpecified('tts', models, isOnline);
  const rules = pronunciationRules ?? (glossaryRepository ? await glossaryRepository.loadRules() : []);
  const payload = validateGenerationInput(
    { script, character, hasLockedAudio: Boolean(anchor?.blob || cachedUpload), exactClone: Boolean(anchor?.exactClone), promptText: anchor?.promptText || '', guidance, steps, seed, autoFormatKhmer, styleMode, customStyle, pronunciationRules: rules },
    seedGenerator
  );
  const startedAt = Date.now();
  const segments = segmentScriptWithPauses(payload.text);
  const chunks = segments.map(segment => segment.text);
  const pausesAfterMs = segments.map(segment => segment.pauseAfterMs);
  const cacheSpec = { ...payload, characterId: character.id, anchor, denoiseReference: Boolean(denoiseReference), masterAudio: Boolean(masterAudio) };
  const { cacheKey, hit } = await tryLookupSynthesisCache({ synthesisCache, cacheSpec, signal });
  if (hit) return attachRecordingMetrics(buildCachedSynthesisResult({ hit, payload, character, chunks, cachedUpload, masterAudio }), startedAt);
  const { fileData: initialRef, wasCached } = await resolveInitialReference({ speechGateway, anchor, cachedUpload, signal, onReferenceUploaded });
  const combined = await runChunkedSynthesis({ speechGateway, payload: { ...payload, characterId: character.id }, chunks, pausesAfterMs, anchor, initialRef, wasCached, denoiseReference: Boolean(denoiseReference), signal, onProgress, onReferenceUploaded });
  const polished = await applySynthesisMastering({ blob: combined.blob, anchorBlob: combined.anchorBlob, masterAudio: Boolean(masterAudio), audioMaster, signal });
  if (synthesisCache && cacheKey) await synthesisCache.putCachedAudio(cacheKey, polished.blob, { characterId: character.id, seed: combined.seed });
  const transcript = hasPauseMarkers(payload.text) ? stripPauseMarkers(payload.text) : payload.text;
  return attachRecordingMetrics({
    recording: { id: `take-${Date.now()}-${combined.seed ?? 'rand'}`, characterId: character.id, characterName: character.name, transcript, ...combined, ...polished, fromCache: false },
    uploadedFileData: combined.uploadedFileData,
  }, startedAt);
}

/**
 * Resolves the reference upload used to regenerate one chunk with the active character timbre.
 * @param {object} params - Reference resolution inputs.
 * @returns {Promise<{ fileData: object|null, wasCached: boolean, retryAnchor: object|null }>} Reference state.
 */
async function resolveChunkReference({ speechGateway, recording, anchor, cachedUpload, character, signal, onReferenceUploaded }) {
  const retryAnchor = anchor?.blob
    ? anchor
    : recording?.anchorBlob
      ? { characterId: character.id, blob: recording.anchorBlob, fileName: `anchor-${character.id}.wav` }
      : null;
  if (cachedUpload) return { fileData: cachedUpload, wasCached: true, retryAnchor };
  if (anchor?.blob) {
    const fileData = await uploadAnchorBlob({ speechGateway, anchor, signal, onReferenceUploaded });
    return { fileData, wasCached: false, retryAnchor };
  }
  if (recording?.uploadedFileData) return { fileData: recording.uploadedFileData, wasCached: true, retryAnchor };
  if (retryAnchor) {
    const fileData = await uploadAnchorBlob({ speechGateway, anchor: retryAnchor, signal, onReferenceUploaded });
    return { fileData, wasCached: false, retryAnchor };
  }
  return { fileData: null, wasCached: false, retryAnchor: null };
}

/**
 * Re-synthesizes exactly one segment with the active voice anchor and restitches the merged take.
 * @param {{ speechGateway: import('./ports.js').SpeechGatewayPort, audioMaster?: object|null, seedGenerator?: () => number }} deps - Injected ports.
 * @param {object} params - `{ recording, index, text, character, anchor, cachedUpload, options, signal }`.
 * @returns {Promise<object>} Updated recording and uploaded FileData cache.
 */
async function regenerateSpeechChunk({ speechGateway, audioMaster = null, seedGenerator }, params) {
  const { recording, index, text, character, anchor = null, cachedUpload = null, options = {}, signal, onReferenceUploaded, models, isOnline } = params || {};
  assertOfflineReadyIfSpecified('tts', models, isOnline);
  if (!Array.isArray(recording?.chunks) || recording.chunks.length === 0) {
    throw new ValidationError('Generate a segmented script before regenerating a segment.', 'script', 'MISSING_CHUNKS');
  }
  if (!Number.isInteger(index) || index < 0 || index >= recording.chunks.length) {
    throw new ValidationError('Choose a valid generated segment to replace.', 'script', 'INVALID_CHUNK_INDEX');
  }
  const payload = validateGenerationInput({
    script: text,
    character,
    hasLockedAudio: Boolean(anchor?.blob || cachedUpload),
    exactClone: Boolean(anchor?.exactClone),
    promptText: anchor?.promptText || '',
    guidance: options.guidance,
    steps: options.steps,
    seed: options.seed,
    autoFormatKhmer: options.autoFormatKhmer !== false,
    styleMode: options.styleMode,
    customStyle: options.customStyle || '',
  }, seedGenerator);
  const spokenText = stripPauseMarkers(payload.text);
  if (!spokenText) throw new ValidationError('Enter text to generate speech.', 'script', 'EMPTY_SCRIPT');
  const startedAt = Date.now();
  const reference = await resolveChunkReference({ speechGateway, recording, anchor, cachedUpload, character, signal, onReferenceUploaded });
  const chunkPayload = buildChunkPayload({
    payload: { ...payload, characterId: character.id },
    text: spokenText,
    index,
    hasInitialAnchor: Boolean(anchor),
    denoiseReference: Boolean(options.denoiseReference),
  });
  const regenerated = await synthesizeChunkWithRetry({
    speechGateway,
    payload: chunkPayload,
    referenceFile: reference.fileData,
    wasCached: reference.wasCached,
    anchor: reference.retryAnchor,
    signal,
  });
  const nextChunk = {
    index,
    text: spokenText,
    blob: regenerated.blob,
    seed: regenerated.seed ?? payload.seed,
    durationSeconds: await readRecordingDurationSeconds(regenerated.blob),
  };
  const restitched = await replaceChunkAndRestitch({
    chunks: recording.chunks,
    index,
    nextChunk,
    pauseMs: SINGLE_VOICE_PAUSE_MS,
  });
  const polished = await applySynthesisMastering({
    blob: restitched.blob,
    masterAudio: options.masterAudio !== false,
    audioMaster,
    signal,
  });
  return attachRecordingMetrics({
    recording: {
      ...recording,
      blob: polished.blob,
      mastered: polished.mastered,
      chunks: restitched.chunks,
      transcript: restitched.chunks.map(chunk => chunk.text).join(' '),
      fromCache: false,
    },
    uploadedFileData: regenerated.referenceFile || cachedUpload || recording.uploadedFileData || null,
  }, startedAt);
}

/**
 * Creates the single-character speech synthesis use case.
 * Inputs: `{ speechGateway, audioMaster, synthesisCache, seedGenerator }`.
 * Outputs: `{ execute(command), regenerateChunk(command) }` use-case object.
 * Side effects: delegates synthesis, mastering, and caching exclusively to injected ports.
 * Failure modes: throws ValidationError, SynthesisCancelledError, or SynthesisError.
 * When `glossaryRepository` is injected, its enabled pronunciation rules rewrite the spoken text of `execute`
 * (an explicit `pronunciationRules` param overrides it). `regenerateChunk` never re-applies rules because
 * segment text is already the spoken text and a second pass could rewrite a replacement.
 * @param {{ speechGateway: import('./ports.js').SpeechGatewayPort, audioMaster?: object|null, synthesisCache?: object|null, glossaryRepository?: import('./ports.js').GlossaryRepositoryPort|null, seedGenerator?: () => number }} deps - Injected ports.
 * @returns {{ execute: (params: object) => Promise<object>, regenerateChunk: (params: object) => Promise<object> }} Synthesis use case.
 */
export function createSynthesizeSpeechUseCase({ speechGateway, audioMaster = null, synthesisCache = null, glossaryRepository = null, seedGenerator }) {
  assertPort(speechGateway, 'speechGateway', ['uploadReferenceAudio', 'synthesize']);
  if (glossaryRepository) assertPort(glossaryRepository, 'glossaryRepository', ['loadRules']);
  return {
    execute: params => executeSpeechSynthesis({ speechGateway, audioMaster, synthesisCache, glossaryRepository, seedGenerator }, params),
    regenerateChunk: params => regenerateSpeechChunk({ speechGateway, audioMaster, seedGenerator }, params),
  };
}

/**
 * Creates the use case validating a user-uploaded audio file before attaching it to a character.
 * Inputs: optional `{ validateFile }`.
 * Outputs: `{ execute(file) }` returning validated audio metadata.
 * Side effects: reads leading bytes of `file` for magic-byte verification.
 * Failure modes: throws ValidationError when file size, MIME, or magic bytes are invalid.
 * @param {{ validateFile?: (file: File) => Promise<void> }} [deps] - Optional validator override.
 * @returns {{ execute: (file: File) => Promise<object> }} Reference audio validation use case.
 */
export function createLockReferenceAudioUseCase({ validateFile = validateAudioFile } = {}) {
  return {
    async execute(file) {
      await validateFile(file);
      return {
        label: file.name,
        blob: file,
        fileName: file.name,
        mimeType: file.type || 'audio/wav',
        source: 'upload',
        promptText: '',
        exactClone: false,
      };
    },
  };
}

/**
 * Validates and prepends a custom character entry into persistent library storage.
 * @param {import('./ports.js').VoiceRepositoryPort} voiceRepository - Voice repository.
 * @param {() => string} idGenerator - Unique ID generator.
 * @param {object} input - Raw custom character form data.
 * @returns {{ entry: object, entries: Array<object> }} Created entry and updated list.
 */
function saveCustomCharacter(voiceRepository, idGenerator, input) {
  const entry = createSavedVoiceEntry(input, idGenerator());
  const { entries: existing } = voiceRepository.loadSavedEntries();
  const updated = [entry, ...existing];
  voiceRepository.saveEntries(updated);
  return { entry, entries: updated };
}

/**
 * Deletes a custom character entry from persistent library storage by ID.
 * @param {import('./ports.js').VoiceRepositoryPort} voiceRepository - Voice repository.
 * @param {string} id - Character identifier to delete.
 * @returns {Array<object>} Remaining saved entries.
 */
function deleteCustomCharacter(voiceRepository, id) {
  const { entries: existing } = voiceRepository.loadSavedEntries();
  const remaining = existing.filter(item => item.id !== id);
  voiceRepository.saveEntries(remaining);
  return remaining;
}

/**
 * Hydrates custom characters from an optional remote backend repository and caches them locally.
 * @param {import('./ports.js').VoiceRepositoryPort} voiceRepository - Local voice repository.
 * @param {object|null} remoteRepository - Optional remote character sync adapter.
 * @returns {Promise<{ entries: Array<object>, warning: string|null }|null>} Merged library state or null if unavailable.
 */
async function syncCustomCharactersFromRemote(voiceRepository, remoteRepository) {
  if (!remoteRepository) return null;
  const { entries: localEntries } = voiceRepository.loadSavedEntries();
  const merged = await remoteRepository.syncWithLocal(localEntries);
  if (!merged) return null;
  voiceRepository.saveEntries(merged);
  return { entries: merged, warning: null };
}

/**
 * Creates Character Library CRUD use cases backed by an injected VoiceRepositoryPort and optional remote backend.
 * Inputs: `{ voiceRepository, remoteRepository, idGenerator }`.
 * Outputs: `{ loadSaved(), saveCustom(input), deleteCustom(id), syncSavedFromRemote(), persistCustomRemote(entry), deleteCustomRemote(id) }`.
 * Side effects: reads/writes through injected `voiceRepository` and optional `remoteRepository`.
 * Failure modes: throws ValidationError on invalid character input or StorageError on persistence failure.
 * @param {{ voiceRepository: import('./ports.js').VoiceRepositoryPort, remoteRepository?: object|null, idGenerator?: () => string }} deps - Injected repositories.
 * @returns {object} Library use cases.
 */
export function createVoiceLibraryUseCases({ voiceRepository, remoteRepository = null, idGenerator = defaultIdGenerator }) {
  assertPort(voiceRepository, 'voiceRepository', ['loadSavedEntries', 'saveEntries']);
  return {
    loadSaved: () => voiceRepository.loadSavedEntries(),
    saveCustom: input => saveCustomCharacter(voiceRepository, idGenerator, input),
    deleteCustom: id => deleteCustomCharacter(voiceRepository, id),
    syncSavedFromRemote: () => syncCustomCharactersFromRemote(voiceRepository, remoteRepository),
    persistCustomRemote: entry => (remoteRepository ? remoteRepository.upsertRemoteEntry(entry) : Promise.resolve(entry)),
    deleteCustomRemote: id => (remoteRepository ? remoteRepository.deleteRemoteEntry(id) : Promise.resolve()),
    loadStorageStats: () => (typeof remoteRepository?.fetchStats === 'function' ? remoteRepository.fetchStats() : Promise.resolve(null)),
  };
}

/**
 * Normalizes a character identifier string for anchor storage lookups.
 * @param {unknown} characterId - Candidate character identifier.
 * @returns {string} Trimmed character identifier or empty string.
 */
function normalizeCharacterId(characterId) {
  return typeof characterId === 'string' ? characterId.trim() : '';
}

/**
 * Validates and constructs a normalized persistent character anchor record.
 * @param {object} params - Raw pin params.
 * @returns {object} Validated anchor record.
 */
function buildAnchorRecord({ characterId, label, blob, fileName, source = 'generated', promptText = '', exactClone = false, takeId = null }) {
  const id = normalizeCharacterId(characterId);
  if (!id) throw new ValidationError('Select a character before locking voice audio.', 'characterId', 'MISSING_CHARACTER_ID');
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new ValidationError('Generate or upload a valid audio clip before locking.', 'referenceAudio', 'EMPTY_AUDIO');
  }
  const safeName = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : `character-${id}.wav`;
  return {
    characterId: id, label: String(label || id), blob, source, takeId,
    fileName: safeName, mimeType: blob.type || 'audio/wav',
    promptText: String(promptText || ''), exactClone: Boolean(exactClone), updatedAt: Date.now(),
  };
}

/**
 * Applies partial transcript or exact-clone updates to an existing anchor record.
 * @param {object} existing - Existing stored anchor.
 * @param {object} patch - Patch fields.
 * @returns {object} Updated anchor record.
 */
function applyAnchorPatch(existing, patch) {
  return {
    ...existing,
    ...(patch?.promptText !== undefined ? { promptText: String(patch.promptText) } : {}),
    ...(patch?.exactClone !== undefined ? { exactClone: Boolean(patch.exactClone) } : {}),
    updatedAt: Date.now(),
  };
}

/**
 * Serializes async anchor mutations per character ID so overlapping round-trips never reorder.
 * @param {Map<string, Promise<void>>} pendingByCharacter - Active queue tails keyed by character ID.
 * @param {string} characterId - Target character identifier.
 * @param {() => Promise<unknown>} operation - Async storage operation.
 * @returns {Promise<unknown>} Operation result or rejection.
 */
function enqueueCharacterOp(pendingByCharacter, characterId, operation) {
  const key = normalizeCharacterId(characterId);
  const previous = pendingByCharacter.get(key) || Promise.resolve();
  const next = previous.then(operation, operation);
  const cleanup = () => {
    if (pendingByCharacter.get(key) === settled) pendingByCharacter.delete(key);
  };
  const settled = next.then(cleanup, cleanup);
  pendingByCharacter.set(key, settled);
  return next;
}

/**
 * Loads, patches, and persists a single character anchor inside a serialized queue turn.
 * @param {import('./ports.js').VoiceAnchorRepositoryPort} anchorRepository - Anchor repository.
 * @param {string} characterId - Target character identifier.
 * @param {object} patch - Partial anchor fields.
 * @returns {Promise<object|null>} Updated anchor record or null when missing.
 */
async function persistAnchorUpdate(anchorRepository, characterId, patch) {
  const all = await anchorRepository.loadAllAnchors();
  const existing = all?.[characterId];
  if (!existing) return null;
  const updated = applyAnchorPatch(existing, patch);
  await anchorRepository.saveAnchor(characterId, updated);
  return updated;
}

/**
 * Validates and persists a character audio anchor inside its serialized character queue.
 * @param {import('./ports.js').VoiceAnchorRepositoryPort} anchorRepository - Anchor repository.
 * @param {Map<string, Promise<void>>} pendingByCharacter - Active queue tails keyed by character ID.
 * @param {object} params - Raw pin parameters.
 * @returns {Promise<object>} Persisted anchor record.
 */
async function pinCharacterAnchor(anchorRepository, pendingByCharacter, params) {
  const record = buildAnchorRecord(params || {});
  return enqueueCharacterOp(pendingByCharacter, record.characterId, async () => {
    await anchorRepository.saveAnchor(record.characterId, record);
    return record;
  });
}

/**
 * Creates Character Voice Anchor persistence use cases backed by VoiceAnchorRepositoryPort.
 * Inputs: `{ anchorRepository }`.
 * Outputs: `{ loadAll(), pinCharacter(params), updateAnchor(characterId, patch), unpinCharacter(characterId) }`.
 * Side effects: reads/writes persistent binary audio anchors through injected `anchorRepository`.
 * Failure modes: throws ValidationError on invalid anchor input or StorageError on persistence failure.
 * @param {{ anchorRepository: import('./ports.js').VoiceAnchorRepositoryPort }} deps - Injected anchor repository.
 * @returns {object} Anchor use cases.
 */
export function createVoiceAnchorUseCases({ anchorRepository }) {
  assertPort(anchorRepository, 'anchorRepository', ['loadAllAnchors', 'saveAnchor', 'deleteAnchor']);
  const pendingByCharacter = new Map();

  return {
    loadAll: () => anchorRepository.loadAllAnchors(),
    pinCharacter: params => pinCharacterAnchor(anchorRepository, pendingByCharacter, params),
    updateAnchor(characterId, patch) {
      const id = normalizeCharacterId(characterId);
      return id ? enqueueCharacterOp(pendingByCharacter, id, () => persistAnchorUpdate(anchorRepository, id, patch)) : Promise.resolve(null);
    },
    unpinCharacter(characterId) {
      const id = normalizeCharacterId(characterId);
      return id ? enqueueCharacterOp(pendingByCharacter, id, () => anchorRepository.deleteAnchor(id)) : Promise.resolve();
    },
  };
}
