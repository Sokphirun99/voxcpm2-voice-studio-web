import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageError, SynthesisError, ValidationError } from '../../src/domain/errors.js';
import {
  createLockReferenceAudioUseCase,
  createSynthesizeSpeechUseCase,
  createVoiceAnchorUseCases,
  createVoiceLibraryUseCases,
} from '../../src/domain/useCases.js';
import { BUILT_IN_VOICES } from '../../src/domain/voiceLibrary.js';
import { inspectWavBuffer } from '../../src/domain/wavCodec.js';

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

  // Exact same inputs must hit cache without hitting gateway or audioMaster again
  const second = await useCase.execute({ script: 'សួស្តី', character: CHAR_NISA, guidance: 2, steps: 10, seed: '42', masterAudio: true });
  assert.equal(gatewayCalls, 1);
  assert.equal(masterCalls, 1);
  assert.equal(second.recording.fromCache, true);
  assert.equal(second.recording.blob, masteredBlob);

  // Disabling masterAudio creates distinct cache entry and skips audioMaster
  const unmastered = await useCase.execute({ script: 'សួស្តី', character: CHAR_NISA, guidance: 2, steps: 10, seed: '42', masterAudio: false });
  assert.equal(gatewayCalls, 2);
  assert.equal(masterCalls, 1);
  assert.equal(unmastered.recording.mastered, false);
});
