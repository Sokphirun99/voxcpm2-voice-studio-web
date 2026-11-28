/**
 * @fileoverview Pure domain application use cases coordinating ports via dependency injection.
 */

import { assembleAudioNarration } from './audioAssembly.js';
import { validateAudioFile } from './audioValidation.js';
import { SynthesisError, ValidationError } from './errors.js';
import { assertFeatureOfflineReady } from './offlineReadiness.js';
import { assertPort } from './ports.js';
import { validateGenerationInput } from './presets.js';
import { getSegmentActiveTake } from './projectSegments.js';
import { hasPauseMarkers, segmentScriptWithPauses, stripPauseMarkers } from './scriptSegmentation.js';
import { resolveEffectiveTerminology } from './terminology.js';
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
  params.onWorkflowStage?.('finish');
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
 * Resolves active Stage 3 pronunciation inputs from explicit overrides, project terminology, and legacy glossary.
 * @param {object} deps - Injected repositories (`glossaryRepository`, `terminologyRepository`).
 * @param {object} params - Command params (`pronunciationRules`, `terminology`, `projectTerminology`).
 * @returns {Promise<{ rules: Array<object>, effectiveTerms: Array<object>|undefined }>} Resolved Stage 3 inputs.
 */
async function resolveSpeechStageRules({ glossaryRepository, terminologyRepository }, params) {
  const { pronunciationRules, terminology, projectTerminology } = params || {};
  if (pronunciationRules !== undefined && terminology === undefined && projectTerminology === undefined) {
    return { rules: pronunciationRules, effectiveTerms: undefined };
  }
  const hasTerminologySource = terminology !== undefined || projectTerminology !== undefined || Boolean(terminologyRepository);
  if (!hasTerminologySource) {
    const rules = pronunciationRules ?? (glossaryRepository ? await glossaryRepository.loadRules() : []);
    return { rules, effectiveTerms: undefined };
  }
  const [globalTerms, legacyRules] = await Promise.all([
    terminology === undefined && terminologyRepository ? terminologyRepository.loadTerms() : Promise.resolve([]),
    pronunciationRules === undefined && glossaryRepository ? glossaryRepository.loadRules() : Promise.resolve(pronunciationRules ?? []),
  ]);
  const effectiveTerms = terminology !== undefined ? terminology : resolveEffectiveTerminology(globalTerms, projectTerminology);
  return { rules: legacyRules, effectiveTerms };
}

/**
 * Executes single-character synthesis validation, cache lookup, chunking, mastering, and voice anchoring.
 * @param {{ speechGateway: import('./ports.js').SpeechGatewayPort, audioMaster?: object|null, synthesisCache?: object|null, glossaryRepository?: object|null, terminologyRepository?: object|null, seedGenerator?: () => number }} deps - Use-case ports.
 * @param {object} params - Synthesis command parameters.
 * @returns {Promise<object>} Recording metadata and uploaded FileData cache.
 */
async function executeSpeechSynthesis({ speechGateway, audioMaster = null, synthesisCache = null, glossaryRepository = null, terminologyRepository = null, seedGenerator }, params) {
  const { script, character, anchor = null, cachedUpload = null, guidance, steps, seed, autoFormatKhmer = false, styleMode, customStyle = '', denoiseReference = false, masterAudio = true, sourceLanguage = '', signal, onProgress, onWorkflowStage, onReferenceUploaded, models, isOnline } = params || {};
  assertOfflineReadyIfSpecified('tts', models, isOnline);
  const { rules, effectiveTerms } = await resolveSpeechStageRules({ glossaryRepository, terminologyRepository }, params);
  const payload = validateGenerationInput(
    { script, character, hasLockedAudio: Boolean(anchor?.blob || cachedUpload), exactClone: Boolean(anchor?.exactClone), promptText: anchor?.promptText || '', guidance, steps, seed, autoFormatKhmer, styleMode, customStyle, pronunciationRules: rules, terminology: effectiveTerms, sourceLanguage },
    seedGenerator
  );
  const startedAt = Date.now();
  const segments = segmentScriptWithPauses(payload.text);
  const chunks = segments.map(segment => segment.text);
  const pausesAfterMs = segments.map(segment => segment.pauseAfterMs);
  const cacheSpec = { ...payload, characterId: character.id, anchor, denoiseReference: Boolean(denoiseReference), masterAudio: Boolean(masterAudio) };
  onWorkflowStage?.('cache');
  const { cacheKey, hit } = await tryLookupSynthesisCache({ synthesisCache, cacheSpec, signal });
  if (hit) return attachRecordingMetrics(buildCachedSynthesisResult({ hit, payload, character, chunks, cachedUpload, masterAudio }), startedAt);
  if (anchor && (anchor.blob || cachedUpload)) onWorkflowStage?.('reference');
  const { fileData: initialRef, wasCached } = await resolveInitialReference({ speechGateway, anchor, cachedUpload, signal, onReferenceUploaded });
  onWorkflowStage?.('generate');
  const combined = await runChunkedSynthesis({ speechGateway, payload: { ...payload, characterId: character.id }, chunks, pausesAfterMs, anchor, initialRef, wasCached, denoiseReference: Boolean(denoiseReference), signal, onProgress, onWorkflowStage, onReferenceUploaded });
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
 * Synthesizes speech for an individual script segment, validating input and reusing cache semantics.
 * @param {object} deps - Injected ports.
 * @param {object} params - `{ segment, character, options, ...rest }`.
 * @returns {Promise<object>} Synthesis output `{ recording, uploadedFileData }`.
 */
async function executeSegmentSpeechSynthesis(deps, params) {
  const { segment, character, options = {}, ...rest } = params || {};
  const text = typeof segment === 'string' ? segment.trim() : (segment?.text || '').trim();
  if (!text) {
    throw new ValidationError('Enter segment text before generating speech.', 'script', 'EMPTY_SEGMENT');
  }
  const resolvedOptions = { guidance: 2.0, steps: 10, ...options };
  return executeSpeechSynthesis(deps, {
    ...rest,
    ...resolvedOptions,
    script: text,
    character,
  });
}

/**
 * Concatenates active segment takes into a seamless full-script audio track with calibrated pauses.
 * Inputs: `{ audioMaster }`, `{ segments, character, options, assetFetcher, signal, projectTitle }`.
 * Outputs: `{ recording, blob, filename }` entity with combined audio and chunk metadata.
 * Side effects: reads take Blobs or fetches asset binaries, optional audio mastering.
 * Failure modes: throws ValidationError if segments are missing takes, SynthesisError on stitch failure.
 * @param {object} deps - Injected dependencies ({ audioMaster }).
 * @param {object} params - Restitching parameters.
 * @returns {Promise<{ recording: object, blob: Blob, filename: string }>} Stitched recording.
 */
export async function executeRestitchSegments({ audioMaster = null }, params) {
  return assembleAudioNarration({ ...params, audioMaster });
}

export const executeAssembleNarration = executeRestitchSegments;

function validateMultiSpeakerSegments(segments) {
  const active = (segments || []).filter(s => (s.text || '').trim().length > 0);
  if (active.length === 0) {
    throw new ValidationError('Enter text before generating speech.', 'script', 'EMPTY_SCRIPT');
  }
  return active;
}

function resolveSegmentSpeakerContext({ segment, characters, defaultCharacter, anchors, cachedUploads }) {
  const voiceId = segment.voiceId || defaultCharacter?.id;
  const character = characters.find(c => c.id === voiceId) || defaultCharacter;
  if (!character?.id) {
    throw new ValidationError('Select a speaking character before generating speech.', 'character', 'MISSING_CHARACTER');
  }
  const anchor = anchors?.[character.id] || null;
  const cachedUpload = cachedUploads?.[character.id] || null;
  return { character, anchor, cachedUpload };
}

function buildMultiSpeakerChunk({ segment, index, result, duration, pauseAfterMs, character }) {
  return {
    index,
    segmentId: segment.id,
    text: segment.text,
    blob: result.recording.blob,
    duration,
    durationSeconds: duration,
    pauseAfterMs,
    seed: result.recording.seed ?? null,
    voiceId: character.id,
    speakerId: segment.speakerId || character.id,
    speakerName: segment.speakerName || character.name,
    anchorBlob: result.recording.anchorBlob,
    anchorTranscript: result.recording.anchorTranscript,
    uploadedFileData: result.uploadedFileData || null,
  };
}

async function synthesizeMultiSpeakerStep(deps, ctx) {
  const { segment, character, anchor, cachedUpload, options, signal, onReferenceUploaded, models, isOnline } = ctx;
  return executeSegmentSpeechSynthesis(deps, {
    segment,
    character,
    anchor,
    cachedUpload,
    options,
    signal,
    onReferenceUploaded: fileData => onReferenceUploaded?.(character.id, fileData),
    models,
    isOnline,
  });
}

function buildMultiSpeakerRecording({ combinedBlob, duration, chunks, mastered }) {
  const distinctVoices = Array.from(new Set(chunks.map(c => c.voiceId).filter(Boolean)));
  const isMulti = distinctVoices.length > 1;
  return {
    id: `take-${Date.now()}-${isMulti ? 'multi' : (distinctVoices[0] || 'mix')}`,
    characterId: isMulti ? 'multi-speaker' : (distinctVoices[0] || null),
    characterName: isMulti ? 'Multiple speakers' : (chunks[0]?.speakerName || 'Voice'),
    transcript: chunks.map(c => c.text).join('\n'),
    blob: combinedBlob,
    audioUrl: typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(combinedBlob) : null,
    duration,
    audioDurationSeconds: duration,
    chunks,
    fromCache: chunks.every(c => c.fromCache),
    mastered,
    isMultiSpeaker: isMulti,
  };
}

async function synthesizeMultiSpeakerSegments(deps, params) {
  const { segments, characters, defaultCharacter, anchors, cachedUploads, options, signal, onProgress, onReferenceUploaded, models, isOnline, defaultPauseMs } = params;
  const chunks = [];
  const segmentResults = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const speaker = resolveSegmentSpeakerContext({ segment: seg, characters, defaultCharacter, anchors, cachedUploads });
    onProgress?.({ stage: 'synthesizing_segment', completed: i, total: segments.length, characterName: speaker.character.name });
    const result = await synthesizeMultiSpeakerStep(deps, { segment: seg, ...speaker, options, signal, onReferenceUploaded, models, isOnline });
    const duration = result.recording.audioDurationSeconds || await readRecordingDurationSeconds(result.recording.blob);
    const pauseAfterMs = typeof seg.pauseDuration === 'number' && seg.pauseDuration >= 0 ? Math.round(seg.pauseDuration * 1000) : defaultPauseMs;
    const chunk = buildMultiSpeakerChunk({ segment: seg, index: i, result, duration, pauseAfterMs, character: speaker.character });
    chunks.push(chunk);
    segmentResults.push({ segmentId: seg.id, segment: seg, recording: result.recording, chunk });
  }
  return { chunks, segmentResults };
}

async function masterMultiSpeakerTrack(blob, audioMaster, options, signal) {
  if (options.masterAudio === false || !audioMaster) {
    return { blob, mastered: false };
  }
  const res = await audioMaster.masterWav(blob, { signal });
  return { blob: res.blob, mastered: res.mastered };
}

/**
 * Synthesizes a multi-speaker script by generating each segment with its assigned voice and anchor.
 * Inputs: injected deps, params ({ segments, characters, defaultCharacter, anchors, cachedUploads, options, signal, onProgress, onReferenceUploaded }).
 * Outputs: Promise<{ recording: object, segmentResults: object[], uploadedFileData: null }>.
 * Side effects: executes inference calls via speechGateway, masters stitched audio track.
 * Failure modes: throws ValidationError on empty segments or missing characters.
 * @param {object} deps - Injected ports.
 * @param {object} params - Multi-speaker generation parameters.
 * @returns {Promise<object>} Combined recording and per-segment results.
 */
export async function executeMultiSpeakerSynthesis(deps, params) {
  const { segments, characters = [], defaultCharacter, anchors = {}, cachedUploads = {}, options = {}, pronunciationRules, terminology, projectTerminology, sourceLanguage, signal, onProgress, onWorkflowStage, onReferenceUploaded, models, isOnline } = params || {};
  const activeSegments = validateMultiSpeakerSegments(segments);
  const resolvedOptions = {
    ...options,
    ...(pronunciationRules !== undefined ? { pronunciationRules } : {}),
    ...(terminology !== undefined ? { terminology } : {}),
    ...(projectTerminology !== undefined ? { projectTerminology } : {}),
    ...(sourceLanguage !== undefined ? { sourceLanguage } : {}),
  };
  const defaultPauseMs = typeof resolvedOptions.defaultPauseSeconds === 'number' ? Math.round(resolvedOptions.defaultPauseSeconds * 1000) : SINGLE_VOICE_PAUSE_MS;
  onWorkflowStage?.('generate');
  const { chunks, segmentResults } = await synthesizeMultiSpeakerSegments(deps, {
    segments: activeSegments, characters, defaultCharacter, anchors, cachedUploads, options: resolvedOptions, signal, onProgress, onReferenceUploaded, models, isOnline, defaultPauseMs,
  });
  onWorkflowStage?.('finish');
  const stitchedBlob = await concatenateWavBlobsWithPauses(chunks, defaultPauseMs);
  const { blob: combinedBlob, mastered } = await masterMultiSpeakerTrack(stitchedBlob, deps.audioMaster, options, signal);
  const totalDuration = await readRecordingDurationSeconds(combinedBlob);
  const recording = buildMultiSpeakerRecording({ combinedBlob, duration: totalDuration, chunks, mastered });
  return { recording, segmentResults, uploadedFileData: null };
}

/**
 * Creates the single-character speech synthesis use case.
 * Inputs: `{ speechGateway, audioMaster, synthesisCache, seedGenerator }`.
 * Outputs: `{ execute(command), regenerateChunk(command), synthesizeSegment(command), restitchSegments(command) }` use-case object.
 * Side effects: delegates synthesis, mastering, and caching exclusively to injected ports.
 * Failure modes: throws ValidationError, SynthesisCancelledError, or SynthesisError.
 * When `glossaryRepository` or `terminologyRepository` is injected, approved Stage 3 pronunciation rules
 * rewrite the spoken text of `execute`, `synthesizeSegment`, and `synthesizeMultiSpeaker` without altering saved script text.
 * `regenerateChunk` never re-applies rules because segment text is already the spoken text.
 * @param {{ speechGateway: import('./ports.js').SpeechGatewayPort, audioMaster?: object|null, synthesisCache?: object|null, glossaryRepository?: import('./ports.js').GlossaryRepositoryPort|null, terminologyRepository?: import('./ports.js').TerminologyRepositoryPort|null, seedGenerator?: () => number }} deps - Injected ports.
 * @returns {{ execute: (params: object) => Promise<object>, regenerateChunk: (params: object) => Promise<object>, synthesizeSegment: (params: object) => Promise<object>, synthesizeMultiSpeaker: (params: object) => Promise<object>, restitchSegments: (params: object) => Promise<object> }} Synthesis use case.
 */
export function createSynthesizeSpeechUseCase({ speechGateway, audioMaster = null, synthesisCache = null, glossaryRepository = null, terminologyRepository = null, seedGenerator }) {
  assertPort(speechGateway, 'speechGateway', ['uploadReferenceAudio', 'synthesize']);
  if (glossaryRepository) assertPort(glossaryRepository, 'glossaryRepository', ['loadRules']);
  if (terminologyRepository) assertPort(terminologyRepository, 'terminologyRepository', ['loadTerms']);
  return {
    execute: params => executeSpeechSynthesis({ speechGateway, audioMaster, synthesisCache, glossaryRepository, terminologyRepository, seedGenerator }, params),
    regenerateChunk: params => regenerateSpeechChunk({ speechGateway, audioMaster, seedGenerator }, params),
    synthesizeSegment: params => executeSegmentSpeechSynthesis({ speechGateway, audioMaster, synthesisCache, glossaryRepository, terminologyRepository, seedGenerator }, params),
    synthesizeMultiSpeaker: params => executeMultiSpeakerSynthesis({ speechGateway, audioMaster, synthesisCache, glossaryRepository, terminologyRepository, seedGenerator }, params),
    restitchSegments: params => executeRestitchSegments({ audioMaster }, params),
    assembleAudioNarration: params => executeRestitchSegments({ audioMaster }, params),
    assembleNarration: params => executeRestitchSegments({ audioMaster }, params),
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
