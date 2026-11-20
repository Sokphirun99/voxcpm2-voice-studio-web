import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageError, SynthesisError, ValidationError } from '../../src/domain/errors.js';
import {
  createLockReferenceAudioUseCase,
  createSynthesizeSpeechUseCase,
  createVoiceAnchorUseCases,
  createVoiceLibraryUseCases,
} from '../../src/domain/useCases.js';
import { segmentSingleSpeakerScript } from '../../src/domain/scriptSegmentation.js';
import { BUILT_IN_VOICES } from '../../src/domain/voiceLibrary.js';
import { inspectWavBuffer, readWavDurationSeconds, replaceChunkAndRestitch } from '../../src/domain/wavCodec.js';

const CHAR_NISA = BUILT_IN_VOICES[0];

function createMemoryRepository(initialEntries = []) {
  let saved = [...initialEntries];
  return {
    loadSavedEntries: () => ({ entries: [...saved], warning: null }),
    saveEntries: entries => {
      saved = [...entries];
    },
  };
}

function makePcmWavBlob(samples = [100, 200, 300, 400]) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  'RIFF'.split('').forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
  view.setUint32(4, 36 + dataSize, true);
  'WAVE'.split('').forEach((c, i) => view.setUint8(8 + i, c.charCodeAt(0)));
  'fmt '.split('').forEach((c, i) => view.setUint8(12 + i, c.charCodeAt(0)));
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 96000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  'data'.split('').forEach((c, i) => view.setUint8(36 + i, c.charCodeAt(0)));
  view.setUint32(40, dataSize, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, s, true));
  return new Blob([buffer], { type: 'audio/wav' });
}

test('createSynthesizeSpeechUseCase validates injected port contract', () => {
  assert.throws(() => createSynthesizeSpeechUseCase({ speechGateway: {} }), TypeError);
});

test('synthesizeSpeech keeps one single character voice across sequential Khmer scripts via persistent anchor', async () => {
  const uploads = [];
  const calls = [];
  const uploadedRef = { path: '/tmp/nisa-anchor.wav', orig_name: 'character-char-nisa.wav', mime_type: 'audio/wav', meta: { _type: 'gradio.FileData' } };
  const take1Blob = makePcmWavBlob([100, 200]);

  const speechGateway = {
    async uploadReferenceAudio(params) {
      uploads.push(params);
      return uploadedRef;
    },
    async synthesize(params) {
      calls.push(params);
      return { blob: calls.length === 1 ? take1Blob : makePcmWavBlob([300, 400]), seed: params.seed };
    },
  };

  const useCase = createSynthesizeSpeechUseCase({ speechGateway, seedGenerator: () => 555 });

  // Script 1: initial generation without anchor yet uses character description
  const first = await useCase.execute({
    script: 'សួស្តីអ្នកទាំងអស់គ្នា',
    character: CHAR_NISA,
    anchor: null,
    guidance: 2,
    steps: 10,
    seed: CHAR_NISA.defaultSeed,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].referenceFile, null);
  assert.equal(calls[0].instruction, CHAR_NISA.description);
  assert.ok(first.recording.anchorBlob instanceof Blob);

  // Script 2: user replaces script -> anchor from Script 1 is uploaded once and cloned cleanly
  const uploadedCallbacks = [];
  const second = await useCase.execute({
    script: 'ខ្ញុំអាយុ ២៥ ឆ្នាំ ខ្ញុំរៀននៅសាលាភ្នំពេញ',
    character: CHAR_NISA,
    anchor: { characterId: CHAR_NISA.id, blob: first.recording.anchorBlob, source: 'generated', exactClone: false, promptText: '' },
    cachedUpload: null,
    guidance: 2,
    steps: 10,
    seed: '',
    onReferenceUploaded: fileData => uploadedCallbacks.push(fileData),
  });
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploadedCallbacks, [uploadedRef]);
  assert.deepEqual(calls[1].referenceFile, uploadedRef);
  assert.equal(calls[1].instruction, '');
  assert.equal(calls[1].usePromptText, false);
  assert.deepEqual(second.uploadedFileData, uploadedRef);
  assert.equal(second.recording.characterName, CHAR_NISA.name);
  assert.notEqual(second.recording.anchorBlob, first.recording.anchorBlob);
  assert.equal(second.recording.anchorTranscript, 'ខ្ញុំអាយុ ២៥ ឆ្នាំ ខ្ញុំរៀននៅសាលាភ្នំពេញ');

  // Script 3: subsequent run reuses cachedUpload without re-uploading
  await useCase.execute({
    script: 'ជម្រាបសួរមិត្តភក្តិ',
    character: CHAR_NISA,
    anchor: { characterId: CHAR_NISA.id, blob: first.recording.anchorBlob, source: 'generated' },
    cachedUpload: second.uploadedFileData,
    guidance: 2,
    steps: 10,
    seed: '',
  });
  assert.equal(uploads.length, 1);
  assert.deepEqual(calls[2].referenceFile, uploadedRef);
});

test('synthesizeSpeech automatically re-uploads once if a cached server reference expired', async () => {
  let uploadSeq = 0;
  const freshRef = { path: '/tmp/fresh.wav' };
  const callbacks = [];
  const speechGateway = {
    async uploadReferenceAudio() {
      uploadSeq += 1;
      return freshRef;
    },
    async synthesize(params) {
      if (params.referenceFile?.path === '/tmp/stale.wav') {
        throw new SynthesisError('The locked reference audio expired on the server.');
      }
      return { blob: makePcmWavBlob([10, 20]), seed: params.seed };
    },
  };

  const useCase = createSynthesizeSpeechUseCase({ speechGateway, seedGenerator: () => 42 });
  const res = await useCase.execute({
    script: 'សួស្តី',
    character: CHAR_NISA,
    anchor: { characterId: CHAR_NISA.id, blob: makePcmWavBlob([1, 2]), fileName: 'nisa.wav' },
    cachedUpload: { path: '/tmp/stale.wav' },
    guidance: 2,
    steps: 10,
    seed: '',
    onReferenceUploaded: data => callbacks.push(data),
  });

  assert.equal(uploadSeq, 1);
  assert.deepEqual(callbacks, [null, freshRef]);
  assert.deepEqual(res.uploadedFileData, freshRef);
});

test('synthesizeSpeech chunks long single-character scripts and auto-anchors chunk 1 for remaining chunks', async () => {
  const uploads = [];
  const calls = [];
  const speechGateway = {
    async uploadReferenceAudio(params) {
      uploads.push(params);
      return { path: '/tmp/auto-anchor.wav', orig_name: params.fileName };
    },
    async synthesize(params) {
      calls.push(params);
      return { blob: makePcmWavBlob([100, 200]), seed: params.seed };
    },
  };

  const useCase = createSynthesizeSpeechUseCase({ speechGateway, seedGenerator: () => 111 });
  const longText = `${'Sentence one is long enough to exceed the minimum chunk size cleanly. '.repeat(3)}Sentence two keeps the exact same anchored voice.`;
  const result = await useCase.execute({
    script: longText,
    character: CHAR_NISA,
    anchor: null,
    guidance: 2,
    steps: 10,
    seed: '',
  });

  assert.equal(calls.length, 2);
  assert.equal(uploads.length, 1);
  assert.equal(calls[0].referenceFile, null);
  assert.equal(calls[0].instruction, CHAR_NISA.description);
  assert.deepEqual(calls[1].referenceFile, { path: '/tmp/auto-anchor.wav', orig_name: uploads[0].fileName });
  assert.equal(calls[1].instruction, '');
  const info = inspectWavBuffer(await result.recording.blob.arrayBuffer());
  assert.equal(info.sampleRate, 48000);
  assert.ok(result.recording.anchorBlob instanceof Blob);
});

test('synthesizeSpeech exposes ordered chunk metadata with text, seeds, blobs, and durations', async () => {
  let callCount = 0;
  const speechGateway = {
    async uploadReferenceAudio(params) {
      return { path: `/tmp/${params.fileName}`, orig_name: params.fileName };
    },
    async synthesize() {
      callCount += 1;
      const sampleCount = callCount === 1 ? 4800 : 9600;
      return { blob: makePcmWavBlob(new Array(sampleCount).fill(500)), seed: 900 + callCount };
    },
  };
  const useCase = createSynthesizeSpeechUseCase({ speechGateway, seedGenerator: () => 111 });
  const longText = `${'Sentence one is long enough to exceed the minimum chunk size cleanly. '.repeat(3)}Sentence two keeps the exact same anchored voice.`;
  const expectedTexts = segmentSingleSpeakerScript(longText);

  const result = await useCase.execute({
    script: longText,
    character: CHAR_NISA,
    anchor: null,
    guidance: 2,
    steps: 10,
    seed: 5,
    masterAudio: false,
  });

  assert.equal(expectedTexts.length, 2);
  assert.equal(result.recording.chunks.length, expectedTexts.length);
  assert.deepEqual(result.recording.chunks.map(chunk => chunk.index), [0, 1]);
  assert.deepEqual(result.recording.chunks.map(chunk => chunk.text), expectedTexts);
  assert.deepEqual(result.recording.chunks.map(chunk => chunk.seed), [901, 902]);
  assert.ok(result.recording.chunks.every(chunk => chunk.blob instanceof Blob && chunk.blob.size > 0));
  assert.ok(Math.abs(result.recording.chunks[0].durationSeconds - 0.1) < 0.001);
  assert.ok(Math.abs(result.recording.chunks[1].durationSeconds - 0.2) < 0.001);
});

test('replaceChunkAndRestitch swaps one chunk without mutating inputs and produces a valid stitched WAV', async () => {
  const first = makePcmWavBlob([500, 600]);
  const second = makePcmWavBlob([700, 800]);
  const replacement = makePcmWavBlob([900, 1000, 1100, 1200]);
  const chunks = [
    { index: 0, text: 'First segment', blob: first, seed: 1, durationSeconds: 0.001 },
    { index: 1, text: 'Second segment', blob: second, seed: 2, durationSeconds: 0.001 },
  ];

  const result = await replaceChunkAndRestitch({
    chunks,
    index: 1,
    nextChunk: { index: 1, text: 'Second segment fixed', blob: replacement, seed: 3, durationSeconds: 0.002 },
    pauseMs: 0,
  });

  assert.equal(chunks[1].text, 'Second segment');
  assert.equal(chunks[1].blob, second);
  assert.equal(result.chunks[0], chunks[0]);
  assert.equal(result.chunks[1].text, 'Second segment fixed');
  assert.equal(result.chunks[1].index, 1);
  assert.equal(result.chunks[1].seed, 3);
  assert.equal(result.chunks[1].durationSeconds, 0.002);

  const info = inspectWavBuffer(await result.blob.arrayBuffer());
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.dataSize, 4 + 8);

  await assert.rejects(
    () => replaceChunkAndRestitch({ chunks, index: 4, nextChunk: { blob: replacement } }),
    error => error.code === 'INVALID_CHUNK_INDEX'
  );
});

test('regenerateChunk synthesizes one segment with the active anchor and restitches the merged take', async () => {
  let callCount = 0;
  let regenerating = false;
  const calls = [];
  const uploads = [];
  const speechGateway = {
    async uploadReferenceAudio(params) {
      uploads.push(params);
      return { path: `/tmp/${params.fileName}`, orig_name: params.fileName };
    },
    async synthesize(params) {
      calls.push(params);
      callCount += 1;
      const seconds = regenerating ? 0.3 : callCount === 1 ? 0.1 : 0.2;
      return { blob: makePcmWavBlob(new Array(Math.round(48000 * seconds)).fill(500)), seed: 300 + callCount };
    },
  };
  const useCase = createSynthesizeSpeechUseCase({ speechGateway, seedGenerator: () => 5 });
  const longText = `${'Sentence one is long enough to exceed the minimum chunk size cleanly. '.repeat(3)}Sentence two keeps the exact same anchored voice.`;
  const anchor = {
    characterId: CHAR_NISA.id, label: CHAR_NISA.name, blob: makePcmWavBlob(new Array(4800).fill(500)),
    fileName: 'nisa-anchor.wav', source: 'generated', exactClone: false, promptText: '',
  };
  const cachedUpload = { path: '/tmp/nisa-anchor.wav', orig_name: 'nisa-anchor.wav', mime_type: 'audio/wav' };

  const first = await useCase.execute({
    script: longText, character: CHAR_NISA, anchor, cachedUpload,
    guidance: 2, steps: 10, seed: 5, masterAudio: false,
  });
  assert.equal(calls.length, 2);
  assert.equal(uploads.length, 0);
  const initialDuration = first.recording.audioDurationSeconds;
  assert.ok(initialDuration > 0);

  calls.length = 0;
  callCount = 0;
  regenerating = true;
  const updated = await useCase.regenerateChunk({
    recording: first.recording,
    index: 1,
    text: 'A corrected second part.',
    character: CHAR_NISA,
    anchor,
    cachedUpload,
    options: { guidance: 2, steps: 10, seed: 5, masterAudio: false },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'A corrected second part.');
  assert.deepEqual(calls[0].referenceFile, cachedUpload);
  assert.equal(calls[0].instruction, '');
  assert.equal(uploads.length, 0);
  assert.equal(updated.recording.id, first.recording.id);
  assert.equal(updated.recording.chunks.length, 2);
  assert.equal(updated.recording.chunks[0].blob, first.recording.chunks[0].blob);
  assert.equal(updated.recording.chunks[1].text, 'A corrected second part.');
  assert.ok(updated.recording.audioDurationSeconds > initialDuration);
  assert.equal(updated.recording.transcript, `${first.recording.chunks[0].text} A corrected second part.`);
  const info = inspectWavBuffer(await updated.recording.blob.arrayBuffer());
  assert.equal(info.sampleRate, 48000);

  await assert.rejects(
    () => useCase.regenerateChunk({ recording: first.recording, index: 9, text: 'x', character: CHAR_NISA }),
    error => error.code === 'INVALID_CHUNK_INDEX'
  );
});

test('lockReferenceAudio validates audio files and returns upload metadata', async () => {
  const useCase = createLockReferenceAudioUseCase({
    validateFile: async file => {
      if (!file.name.endsWith('.wav')) throw new ValidationError('Invalid file', 'reference');
    },
  });

  await assert.rejects(() => useCase.execute({ name: 'bad.txt', type: 'text/plain' }), ValidationError);

  const locked = await useCase.execute({ name: 'sample.wav', type: 'audio/wav' });
  assert.equal(locked.label, 'sample.wav');
  assert.equal(locked.source, 'upload');
  assert.equal(locked.exactClone, false);
});

test('voiceLibrary use cases create, list, and delete custom characters via VoiceRepositoryPort', () => {
  const repository = createMemoryRepository();
  const useCases = createVoiceLibraryUseCases({ voiceRepository: repository, idGenerator: () => 'char-custom-1' });

  const { entry, entries } = useCases.saveCustom({
    name: 'Pisey',
    category: 'female',
    description: '  (warm) gentle Khmer voice  ',
  });

  assert.equal(entry.id, 'char-custom-1');
  assert.equal(entry.description, 'warm gentle Khmer voice');
  assert.equal(entries.length, 1);
  assert.equal(useCases.loadSaved().entries.length, 1);

  const remaining = useCases.deleteCustom('char-custom-1');
  assert.equal(remaining.length, 0);
});

test('voiceAnchor use cases validate, pin, update, load, and unpin character anchors', async () => {
  const map = new Map();
  const anchorRepository = {
    async loadAllAnchors() { return Object.fromEntries(map.entries()); },
    async saveAnchor(id, rec) { map.set(id, rec); },
    async deleteAnchor(id) { map.delete(id); },
  };
  const anchors = createVoiceAnchorUseCases({ anchorRepository });

  await assert.rejects(() => anchors.pinCharacter({ characterId: '', label: 'Nisa', blob: new Blob(['x']) }), ValidationError);
  const pinned = await anchors.pinCharacter({
    characterId: 'char-nisa', label: 'Nisa', blob: new Blob(['ID3'], { type: 'audio/mpeg' }),
    fileName: 'pisey-sample.mp3', source: 'upload', promptText: 'Hello',
  });
  assert.equal(pinned.exactClone, false);
  assert.equal(pinned.fileName, 'pisey-sample.mp3');
  assert.equal(pinned.mimeType, 'audio/mpeg');
  assert.equal((await anchors.loadAll())['char-nisa'].label, 'Nisa');

  const updated = await anchors.updateAnchor('char-nisa', { exactClone: true, promptText: 'Updated' });
  assert.equal(updated.exactClone, true);
  assert.equal(updated.promptText, 'Updated');

  await anchors.unpinCharacter('char-nisa');
  assert.deepEqual(await anchors.loadAll(), {});
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('voiceAnchor use cases serialize overlapping updateAnchor and unpinCharacter calls per character', async () => {
  const map = new Map();
  const gates = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failNextSave = false;
  const deleted = [];

  const anchorRepository = {
    async loadAllAnchors() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return Object.fromEntries(map.entries());
      } finally {
        inFlight -= 1;
      }
    },
    async saveAnchor(id, rec) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (gates.length) await gates.shift().promise;
        if (failNextSave) {
          failNextSave = false;
          throw new StorageError('Disk full');
        }
        map.set(id, rec);
      } finally {
        inFlight -= 1;
      }
    },
    async deleteAnchor(id) {
      deleted.push(id);
      map.delete(id);
    },
  };

  const anchors = createVoiceAnchorUseCases({ anchorRepository });
  assert.equal(await anchors.updateAnchor('missing-char', { promptText: 'ignored' }), null);

  await anchors.pinCharacter({
    characterId: 'char-nisa', label: 'Nisa', blob: new Blob(['ID3'], { type: 'audio/mpeg' }),
    fileName: 'nisa.mp3', source: 'upload', promptText: '',
  });

  // Hold the 1st update while firing two overlapping updates
  const firstGate = createDeferred();
  gates.push(firstGate);
  const p1 = anchors.updateAnchor('char-nisa', { promptText: 'slow-first' });
  const p2 = anchors.updateAnchor('char-nisa', { exactClone: true });
  const p3 = anchors.updateAnchor('char-nisa', { promptText: 'fast-last' });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(maxInFlight, 1);
  assert.equal(map.get('char-nisa').promptText, '');

  firstGate.resolve();
  await Promise.all([p1, p2, p3]);
  assert.equal(maxInFlight, 1);
  assert.equal(map.get('char-nisa').promptText, 'fast-last');
  assert.equal(map.get('char-nisa').exactClone, true);

  // One failure must not wedge subsequent operations on the same character
  failNextSave = true;
  await assert.rejects(() => anchors.updateAnchor('char-nisa', { promptText: 'failed' }), StorageError);
  const recovered = await anchors.updateAnchor('char-nisa', { promptText: 'recovered' });
  assert.equal(recovered.promptText, 'recovered');

  // Overlapping update followed by unpin must never resurrect the deleted anchor
  const beforeDeleteGate = createDeferred();
  gates.push(beforeDeleteGate);
  const pendingUpdate = anchors.updateAnchor('char-nisa', { promptText: 'stale' });
  const pendingDelete = anchors.unpinCharacter('char-nisa');
  await Promise.resolve();
  assert.deepEqual(deleted, []);
  beforeDeleteGate.resolve();
  await Promise.all([pendingUpdate, pendingDelete]);
  assert.deepEqual(deleted, ['char-nisa']);
  assert.equal(map.has('char-nisa'), false);
});

test('voiceAnchor use cases normalize padded IDs and ignore blank IDs without storage IO', async () => {
  const calls = [];
  const map = new Map();
  const anchors = createVoiceAnchorUseCases({
    anchorRepository: {
      async loadAllAnchors() { calls.push('loadAll'); return Object.fromEntries(map.entries()); },
      async saveAnchor(id, rec) { calls.push(`save:${id}`); map.set(id, rec); },
      async deleteAnchor(id) { calls.push(`delete:${id}`); map.delete(id); },
    },
  });

  assert.equal(await anchors.updateAnchor('   ', { promptText: 'skip' }), null);
  await anchors.unpinCharacter('');
  assert.deepEqual(calls, []);

  await anchors.pinCharacter({ characterId: ' char-nisa ', label: 'Nisa', blob: new Blob(['RIFF']) });
  const updated = await anchors.updateAnchor(' char-nisa ', { promptText: 'trimmed' });
  assert.equal(updated.characterId, 'char-nisa');
  assert.equal(updated.promptText, 'trimmed');
  await anchors.unpinCharacter(' char-nisa ');
  assert.deepEqual(calls, ['save:char-nisa', 'loadAll', 'save:char-nisa', 'delete:char-nisa']);
});

test('synthesizeSpeech integrates audioMaster and synthesisCache cleanly without breaking disabled fallback', async () => {
  let gatewayCalls = 0;
  let masterCalls = 0;
  const cacheStore = new Map();
  const rawBlob = makePcmWavBlob(new Array(2400).fill(500));
  const masteredBlob = makePcmWavBlob(new Array(2400).fill(1500));

  const useCase = createSynthesizeSpeechUseCase({
    speechGateway: {
      async uploadReferenceAudio() { throw new Error('Should not upload'); },
      async synthesize({ seed }) { gatewayCalls += 1; return { blob: rawBlob, seed }; },
    },
    audioMaster: {
      async masterWav() { masterCalls += 1; return { blob: masteredBlob, mastered: true }; },
    },
    synthesisCache: {
      computeKey: async spec => `${spec.characterId}:${spec.text}:${spec.seed}:${spec.masterAudio}`,
      getCachedAudio: async key => cacheStore.get(key) || null,
      putCachedAudio: async (key, blob, meta) => { cacheStore.set(key, { blob, seed: meta.seed }); },
    },
    seedGenerator: () => 42,
  });

  const first = await useCase.execute({ script: 'សួស្តី', character: CHAR_NISA, guidance: 2, steps: 10, seed: '42', masterAudio: true });
  assert.equal(gatewayCalls, 1);
  assert.equal(masterCalls, 1);
  assert.equal(first.recording.fromCache, false);
  assert.equal(first.recording.mastered, true);
  assert.equal(first.recording.blob, masteredBlob);
  assert.equal(first.recording.sizeBytes, masteredBlob.size);
  assert.equal(Number.isFinite(first.recording.elapsedMs) && first.recording.elapsedMs >= 0, true);

  // Exact same inputs must hit cache without hitting gateway or audioMaster again
  const second = await useCase.execute({ script: 'សួស្តី', character: CHAR_NISA, guidance: 2, steps: 10, seed: '42', masterAudio: true });
  assert.equal(gatewayCalls, 1);
  assert.equal(masterCalls, 1);
  assert.equal(second.recording.fromCache, true);
  assert.equal(second.recording.blob, masteredBlob);
  assert.equal(second.recording.sizeBytes, masteredBlob.size);
  assert.equal(Number.isFinite(second.recording.elapsedMs) && second.recording.elapsedMs >= 0, true);

  // Disabling masterAudio creates distinct cache entry and skips audioMaster
  const unmastered = await useCase.execute({ script: 'សួស្តី', character: CHAR_NISA, guidance: 2, steps: 10, seed: '42', masterAudio: false });
  assert.equal(gatewayCalls, 2);
  assert.equal(masterCalls, 1);
  assert.equal(unmastered.recording.mastered, false);
});

test('synthesizeSpeech applies injected glossary rules to the spoken text, lets explicit rules override, and skips them for regenerateChunk', async () => {
  const calls = [];
  const speechGateway = {
    async uploadReferenceAudio(params) { return { path: `/tmp/${params.fileName}`, orig_name: params.fileName }; },
    async synthesize(params) { calls.push(params); return { blob: makePcmWavBlob(new Array(480).fill(500)), seed: 9 }; },
  };
  let loads = 0;
  const glossaryRepository = {
    async loadRules() { loads += 1; return [{ id: 'r1', source: 'NASA', replacement: 'ណាសា', enabled: true }, { id: 'r2', source: 'Visit', replacement: 'Go', enabled: false }]; },
  };
  const useCase = createSynthesizeSpeechUseCase({ speechGateway, glossaryRepository, seedGenerator: () => 5 });
  const base = { script: 'Visit NASA today', character: CHAR_NISA, guidance: 2, steps: 10, seed: 5, masterAudio: false };

  const first = await useCase.execute(base);
  assert.equal(loads, 1);
  assert.equal(calls[0].text, 'Visit ណាសា today');
  assert.equal(first.recording.transcript, 'Visit ណាសា today');

  await useCase.execute({ ...base, pronunciationRules: [{ source: 'today', replacement: 'tonight' }] });
  assert.equal(loads, 1);
  assert.equal(calls[1].text, 'Visit NASA tonight');

  await useCase.execute({ ...base, pronunciationRules: [] });
  assert.equal(calls[2].text, 'Visit NASA today');

  const withoutGlossary = createSynthesizeSpeechUseCase({ speechGateway, seedGenerator: () => 5 });
  await withoutGlossary.execute(base);
  assert.equal(calls[3].text, 'Visit NASA today');
});

test('synthesizeSpeech does not re-apply glossary rules when regenerating a segment', async () => {
  const calls = [];
  const speechGateway = {
    async uploadReferenceAudio(params) { return { path: `/tmp/${params.fileName}`, orig_name: params.fileName }; },
    async synthesize(params) { calls.push(params); return { blob: makePcmWavBlob(new Array(4800).fill(500)), seed: 9 }; },
  };
  const glossaryRepository = { async loadRules() { return [{ id: 'r1', source: 'one', replacement: 'one one', enabled: true }]; } };
  const useCase = createSynthesizeSpeechUseCase({ speechGateway, glossaryRepository, seedGenerator: () => 5 });
  const longText = `${'Sentence ends here and is long enough to exceed the minimum chunk size. '.repeat(3)}Sentence two keeps the voice.`;
  const first = await useCase.execute({ script: longText, character: CHAR_NISA, guidance: 2, steps: 10, seed: 5, masterAudio: false });
  assert.ok(first.recording.chunks.length >= 2);

  calls.length = 0;
  await useCase.regenerateChunk({
    recording: first.recording, index: 1, text: 'one two', character: CHAR_NISA,
    options: { guidance: 2, steps: 10, seed: 5, masterAudio: false },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'one two');
});

test('createSynthesizeSpeechUseCase validates the glossary repository port contract', () => {
  const speechGateway = { uploadReferenceAudio() {}, synthesize() {} };
  assert.throws(() => createSynthesizeSpeechUseCase({ speechGateway, glossaryRepository: {} }), TypeError);
});

test('synthesizeSpeech splits at inline [pause ...] markers without sending literal tags and stitches exact PCM silence', async () => {
  const calls = [];
  const sampleRate = 48000;
  const clipSeconds = 0.1;
  const speechGateway = {
    async uploadReferenceAudio(params) { return { path: `/tmp/${params.fileName}`, orig_name: params.fileName }; },
    async synthesize(params) {
      calls.push(params);
      return { blob: makePcmWavBlob(new Array(Math.round(sampleRate * clipSeconds)).fill(800)), seed: params.seed };
    },
  };
  const useCase = createSynthesizeSpeechUseCase({ speechGateway, seedGenerator: () => 42 });
  const result = await useCase.execute({
    script: 'Part one. [pause 0.5s] Part two. [pause 800ms] Part three.',
    character: CHAR_NISA,
    guidance: 2,
    steps: 10,
    seed: 42,
    masterAudio: false,
  });

  assert.deepEqual(calls.map(call => call.text), ['Part one.', 'Part two.', 'Part three.']);
  assert.ok(calls.every(call => !/\[pause/i.test(call.text)));
  assert.equal(result.recording.transcript, 'Part one. Part two. Part three.');
  assert.deepEqual(result.recording.chunks.map(chunk => chunk.pauseAfterMs), [500, 800, null]);

  const expectedSeconds = (100 + 500 + 100 + 800 + 100) / 1000;
  assert.equal(readWavDurationSeconds(await result.recording.blob.arrayBuffer()), expectedSeconds);
  assert.equal(result.recording.audioDurationSeconds, expectedSeconds);

  // Regenerating one segment preserves surrounding explicit pause durations and strips any typed pause marker.
  calls.length = 0;
  const updated = await useCase.regenerateChunk({
    recording: result.recording,
    index: 1,
    text: 'Part two [pause 2s] revised.',
    character: CHAR_NISA,
    options: { guidance: 2, steps: 10, seed: 42, masterAudio: false },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'Part two revised.');
  assert.deepEqual(updated.recording.chunks.map(chunk => chunk.pauseAfterMs), [500, 800, null]);
  assert.equal(readWavDurationSeconds(await updated.recording.blob.arrayBuffer()), expectedSeconds);
});
