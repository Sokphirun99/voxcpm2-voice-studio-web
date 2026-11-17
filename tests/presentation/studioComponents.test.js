import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { StorageError } from '../../src/domain/errors.js';
import { BUILT_IN_VOICES, DEFAULT_CHARACTER_ID } from '../../src/domain/voiceLibrary.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHAR_NISA = BUILT_IN_VOICES[0];
const CHAR_SOVATH = BUILT_IN_VOICES.find(item => item.id === 'char-sovath');

function createStubServices() {
  return {
    speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
    audioDecoder: { decodePeaks: async () => [] },
    logger: { debug() {}, warn() {}, error() {} },
    synthesizeSpeech: { execute: async () => ({}) },
    lockReferenceAudio: { execute: async file => ({ blob: file, fileName: file.name, mimeType: 'audio/wav' }) },
    voiceLibrary: { loadSaved: () => ({ entries: [], warning: null }), saveCustom: () => ({ entry: {}, entries: [] }), deleteCustom: () => [] },
    voiceAnchors: { loadAll: async () => ({}), pinCharacter: async p => p, updateAnchor: async () => null, unpinCharacter: async () => {} },
  };
}

async function withViteSsr(run) {
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    return await run(vite);
  } finally {
    await vite.close();
  }
}

test('Studio SSR renders Narakeet-style Character UI without Voice type, Delivery, or Conversation bloat', async () => {
  await withViteSsr(async vite => {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { ErrorBoundary } = await vite.ssrLoadModule('/src/presentation/components/ErrorBoundary.jsx');
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    const html = renderToStaticMarkup(
      React.createElement(
        StudioProvider,
        { services: createStubServices() },
        React.createElement(ErrorBoundary, { logger: createStubServices().logger }, React.createElement(Studio))
      )
    );

    assert.ok(html.includes('id="character-select"'));
    assert.ok(html.includes('ID: char-nisa'));
    assert.ok(html.includes('Locks on 1st take'));
    assert.ok(html.includes('Khmer example'));
    assert.ok(html.includes('Character library'));
    assert.ok(!/Voice type|Speaking speed|Conversation \(2/i.test(html));
  });
});

test('VoiceControls displays locked dropdown label, uploaded filename, anchor warning, and busy guards', async () => {
  await withViteSsr(async vite => {
    const { VoiceControls } = await vite.ssrLoadModule('/src/presentation/components/VoiceControls.jsx');
    const anchors = {
      [CHAR_NISA.id]: {
        characterId: CHAR_NISA.id,
        source: 'upload',
        fileName: 'nisa-reference.mp3',
        exactClone: true,
        promptText: 'សួស្តី',
        blob: new Blob(['ID3'], { type: 'audio/mpeg' }),
      },
    };
    const html = renderToStaticMarkup(
      React.createElement(VoiceControls, {
        characters: BUILT_IN_VOICES,
        anchors,
        activeCharacter: CHAR_NISA,
        activeAnchor: anchors[CHAR_NISA.id],
        anchorWarning: 'Could not load saved character voices.',
        busy: true,
        options: { guidance: 2, steps: 10, seed: '', denoiseReference: false },
        lastSeed: null,
        transcriptRef: { current: null },
        actions: {
          onSelectCharacter() {},
          onOpenNewCharacter() {},
          onUploadSample() {},
          onResetVoice() {},
          onUpdateAnchor() {},
          onChangeOption() {},
        },
      })
    );

    assert.ok(html.includes('Nisa — Warm &amp; natural (Locked)'));
    assert.ok(html.includes('Voice locked'));
    assert.ok(html.includes('Locked sample: nisa-reference.mp3'));
    assert.ok(html.includes('Could not load saved character voices.'));
    assert.ok(html.includes('id="locked-transcript"'));
    assert.match(html, /id="upload-reference-audio"[^>]*disabled=""/);
    assert.match(html, /id="reset-character-voice"[^>]*disabled=""/);

    const generatedHtml = renderToStaticMarkup(
      React.createElement(VoiceControls, {
        characters: BUILT_IN_VOICES,
        anchors: { [CHAR_NISA.id]: { characterId: CHAR_NISA.id, source: 'generated', exactClone: false, promptText: 'សួស្តី', blob: new Blob(['RIFF']) } },
        activeCharacter: CHAR_NISA,
        activeAnchor: { characterId: CHAR_NISA.id, source: 'generated', exactClone: false, promptText: 'សួស្តី', blob: new Blob(['RIFF']) },
        anchorWarning: null, busy: false,
        options: { guidance: 2, steps: 10, seed: '', denoiseReference: false },
        lastSeed: null, transcriptRef: { current: null },
        actions: { onSelectCharacter() {}, onOpenNewCharacter() {}, onUploadSample() {}, onResetVoice() {}, onUpdateAnchor() {}, onChangeOption() {} },
      })
    );
    assert.ok(generatedHtml.includes('id="exact-voice-match"'));
  });
});

test('AudioPlayer resolvePinControlState prevents cross-character lock and differentiates Take 1 vs Take 2', async () => {
  await withViteSsr(async vite => {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { AudioPlayer, resolvePinControlState } = await vite.ssrLoadModule('/src/presentation/components/AudioPlayer.jsx');

    const take1 = { id: 'take-1', characterId: CHAR_NISA.id, characterName: CHAR_NISA.name, blob: new Blob(['RIFF']), seed: 10 };
    const take2 = { id: 'take-2', characterId: CHAR_NISA.id, characterName: CHAR_NISA.name, blob: new Blob(['RIFF']), seed: 20 };

    const crossChar = resolvePinControlState({ recording: take1, activeCharacter: CHAR_SOVATH, activeAnchor: null });
    assert.equal(crossChar.disabled, true);
    assert.equal(crossChar.isLocked, false);
    assert.equal(crossChar.label, 'Recorded as Nisa');

    const samePinned = resolvePinControlState({
      recording: take1,
      activeCharacter: CHAR_NISA,
      activeAnchor: { takeId: 'take-1' },
    });
    assert.equal(samePinned.disabled, true);
    assert.equal(samePinned.isLocked, true);
    assert.equal(samePinned.label, 'Locked to Nisa');

    const take2State = resolvePinControlState({
      recording: take2,
      activeCharacter: CHAR_NISA,
      activeAnchor: { takeId: 'take-1' },
    });
    assert.equal(take2State.disabled, false);
    assert.equal(take2State.label, "Use as Nisa's voice");

    const html = renderToStaticMarkup(
      React.createElement(
        StudioProvider,
        { services: createStubServices() },
        React.createElement(AudioPlayer, {
          recording: take1,
          activeCharacter: CHAR_SOVATH,
          activeAnchor: null,
          status: { message: 'Audio ready', error: false },
          onPinTake() {},
          onPlaybackError() {},
        })
      )
    );
    assert.ok(html.includes('Recorded as Nisa'));
    assert.ok(!html.includes("Set as Sovath's voice"));
  });
});

test('VoiceLibrary disables mutations when busy and renders Create character modal controls', async () => {
  await withViteSsr(async vite => {
    const { VoiceLibrary } = await vite.ssrLoadModule('/src/presentation/components/VoiceLibrary.jsx');
    const customChar = {
      id: 'char-custom-9',
      name: 'Pisey',
      role: 'Custom character',
      category: 'female',
      traits: '1 person · Saved character',
      description: 'Gentle Khmer voice',
      isBuiltIn: false,
    };
    const html = renderToStaticMarkup(
      React.createElement(VoiceLibrary, {
        open: false,
        openSaveForm: false,
        busy: true,
        library: {
          matches: [customChar],
          warning: null,
          filters: { search: '', source: '', category: '' },
          updateFilter() {},
        },
        anchors: { [customChar.id]: { blob: new Blob(['RIFF']) } },
        onSelectVoice() {},
        onCreateCharacter: async () => {},
        onDeleteCharacter() {},
        onUnpinAnchor() {},
        onClose() {},
      })
    );

    assert.ok(html.includes('ID: char-custom-9'));
    assert.ok(html.includes('Voice locked'));
    assert.match(html, /class="button subtle-button library-unpin"[^>]*disabled=""/);
    assert.match(html, /class="button subtle-button library-delete"[^>]*disabled=""/);
  });
});

test('finalizeCharacterGeneration pins first take and guards against mid-flight upload, reset, or deletion races', async () => {
  await withViteSsr(async vite => {
    const { finalizeCharacterGeneration } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');
    const logger = { error() {} };
    const result = {
      uploadedFileData: { path: '/tmp/u.wav' },
      recording: { id: 'take-1', anchorBlob: new Blob(['RIFF']), anchorTranscript: 'សួស្តី' },
    };

    const pinnedCalls = [];
    const cachedCalls = [];
    const actions = {
      rerolledIdsRef: { current: new Set([CHAR_NISA.id]) },
      setCachedUpload: (id, data) => cachedCalls.push({ id, data }),
    };

    // Normal Take 1 pins once
    const msg = await finalizeCharacterGeneration({
      result,
      submittedCharacter: CHAR_NISA,
      submittedRevision: 0,
      characterExists: () => true,
      actions,
      anchorApi: {
        hasAnchor: () => false,
        getRevision: () => 0,
        pinCharacterAnchor: async rec => pinnedCalls.push(rec),
      },
      logger,
    });
    assert.equal(pinnedCalls.length, 1);
    assert.equal(cachedCalls.length, 1);
    assert.equal(actions.rerolledIdsRef.current.has(CHAR_NISA.id), false);
    assert.match(msg, /Locked 1-person voice for Nisa \(char-nisa\)/);

    // Race 1: anchor modified mid-flight (e.g. upload or reset)
    await finalizeCharacterGeneration({
      result,
      submittedCharacter: CHAR_NISA,
      submittedRevision: 0,
      characterExists: () => true,
      actions,
      anchorApi: {
        hasAnchor: () => false,
        getRevision: () => 1,
        pinCharacterAnchor: async rec => pinnedCalls.push(rec),
      },
      logger,
    });
    assert.equal(pinnedCalls.length, 1);

    // Race 2: custom character deleted mid-flight
    await finalizeCharacterGeneration({
      result,
      submittedCharacter: { id: 'char-deleted', name: 'Ghost' },
      submittedRevision: 0,
      characterExists: () => false,
      actions,
      anchorApi: {
        hasAnchor: () => false,
        getRevision: () => 0,
        pinCharacterAnchor: async rec => pinnedCalls.push(rec),
      },
      logger,
    });
    assert.equal(pinnedCalls.length, 1);
  });
});

test('resolveEffectiveSeed uses character defaultSeed only before locking or resetting', async () => {
  await withViteSsr(async vite => {
    const { resolveEffectiveSeed } = await vite.ssrLoadModule('/src/presentation/hooks/useCharacterActions.js');
    assert.equal(resolveEffectiveSeed({ rawSeed: '', character: CHAR_NISA, hasAnchor: false, rerolledIds: new Set() }), CHAR_NISA.defaultSeed);
    assert.equal(resolveEffectiveSeed({ rawSeed: '', character: CHAR_NISA, hasAnchor: true, rerolledIds: new Set() }), '');
    assert.equal(resolveEffectiveSeed({ rawSeed: '', character: CHAR_NISA, hasAnchor: false, rerolledIds: new Set([CHAR_NISA.id]) }), '');
    assert.equal(resolveEffectiveSeed({ rawSeed: '999', character: CHAR_NISA, hasAnchor: true, rerolledIds: new Set() }), '999');
  });
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('createVoiceAnchorStore coalesces rapid promptText keystrokes, guards against out-of-order overwrites, and rolls back failed writes', async () => {
  await withViteSsr(async vite => {
    const { createVoiceAnchorStore } = await vite.ssrLoadModule('/src/presentation/hooks/useVoiceAnchors.js');
    const initialAnchor = { characterId: CHAR_NISA.id, source: 'upload', exactClone: true, promptText: 'init', blob: new Blob(['RIFF']) };
    let persisted = { ...initialAnchor };
    const gates = [];
    const updateCalls = [];
    const unpinCalls = [];
    let failMode = false;

    const voiceAnchors = {
      loadAll: async () => ({ [CHAR_NISA.id]: { ...persisted } }),
      pinCharacter: async params => {
        persisted = { ...params, updatedAt: Date.now() };
        return persisted;
      },
      async updateAnchor(id, patch) {
        updateCalls.push({ id, patch });
        if (gates.length) await gates.shift().promise;
        if (failMode) throw new StorageError('IndexedDB write failed');
        persisted = { ...persisted, ...patch, updatedAt: Date.now() };
        return persisted;
      },
      async unpinCharacter(id) {
        unpinCalls.push(id);
        persisted = null;
      },
    };

    const snapshots = [];
    const store = createVoiceAnchorStore({
      voiceAnchors,
      logger: { debug() {}, error() {} },
      onStateChange: snap => snapshots.push(snap),
    });
    await store.loadAll();
    assert.equal(store.state.isLoaded, true);
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'init');

    // Rapid keystrokes while 1st update is genuinely mid-flight
    const gate1 = createDeferred();
    gates.push(gate1);
    const p1 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'a' });
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'a');
    await Promise.resolve();
    assert.equal(updateCalls.length, 1);

    const p2 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'ab' });
    const p3 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'abc' });
    const p4 = store.updateCharacterAnchor(CHAR_NISA.id, { exactClone: false });
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'abc');
    assert.equal(store.state.anchors[CHAR_NISA.id].exactClone, false);
    assert.equal(updateCalls.length, 1);

    gate1.resolve();
    await Promise.all([p1, p2, p3, p4]);
    assert.equal(updateCalls.length, 2);
    assert.deepEqual(updateCalls[1].patch, { promptText: 'abc', exactClone: false });
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'abc');
    assert.equal(store.state.anchors[CHAR_NISA.id].exactClone, false);

    // Failed write #1 while batch #2 is pending and #2 also fails -> rolls back to last genuinely persisted snapshot ('abc')
    failMode = true;
    const gateFail1 = createDeferred();
    gates.push(gateFail1);
    const fail1 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'fail-1' });
    await Promise.resolve();
    const fail2 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'fail-2' });
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'fail-2');
    gateFail1.resolve();
    await assert.rejects(() => fail1, StorageError);
    await assert.rejects(() => fail2, StorageError);
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'abc');

    // Unpinning cancels queued updates and runs after active write finishes
    failMode = false;
    const gateBeforeUnpin = createDeferred();
    gates.push(gateBeforeUnpin);
    const activeWrite = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'inflight' });
    await Promise.resolve();
    const queuedWrite = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'should-cancel' });
    const pendingUnpin = store.unpinCharacterAnchor(CHAR_NISA.id);
    assert.deepEqual(unpinCalls, []);
    gateBeforeUnpin.resolve();
    const [, queuedResult] = await Promise.all([activeWrite, queuedWrite, pendingUnpin]);
    assert.equal(queuedResult, null);
    assert.deepEqual(unpinCalls, [CHAR_NISA.id]);
    assert.equal(store.hasAnchor(CHAR_NISA.id), false);

    // loadAll error surfaces anchorWarning cleanly and still marks isLoaded
    const failingStore = createVoiceAnchorStore({
      voiceAnchors: {
        loadAll: async () => { throw new StorageError('IDB blocked'); },
        pinCharacter: async () => {},
        updateAnchor: async () => null,
        unpinCharacter: async () => {},
      },
      logger: { debug() {}, error() {} },
    });
    await failingStore.loadAll();
    assert.equal(failingStore.state.isLoaded, true);
    assert.equal(failingStore.state.anchorWarning, 'Could not load saved character voices.');
  });
});

test('createVoiceLibraryActions rethrows delete errors after updating warning', async () => {
  await withViteSsr(async vite => {
    const { createVoiceLibraryActions } = await vite.ssrLoadModule('/src/presentation/hooks/useVoiceLibrary.js');
    let stored = { entries: [{ id: 'char-custom-1', name: 'Pisey' }], warning: null };
    const setStored = updater => { stored = typeof updater === 'function' ? updater(stored) : updater; };

    const actions = createVoiceLibraryActions({
      saveCustom: () => { throw new StorageError('Cannot save'); },
      deleteCustom: () => { throw new StorageError('Quota exceeded'); },
    }, setStored);

    assert.throws(() => actions.deleteVoice('char-custom-1'), StorageError);
    assert.equal(stored.warning, 'Quota exceeded');
    assert.equal(stored.entries.length, 1);
  });
});

test('character actions handle onUpdateAnchor errors, prevent false delete success on StorageError, and roll back failed creates', async () => {
  await withViteSsr(async vite => {
    const { createCharacterActionHandlers } = await vite.ssrLoadModule('/src/presentation/hooks/useCharacterActions.js');
    const { buildVoiceActions } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    const customChar = { id: 'char-custom-1', name: 'Pisey', isBuiltIn: false };
    const errors = [];
    const statuses = [];
    const selectedIds = [];
    const unpinnedIds = [];
    let cancelled = false;
    let deleteShouldThrow = true;
    let unpinShouldThrow = false;

    const ctx = {
      activeCharacter: customChar,
      library: {
        allVoices: [customChar, ...BUILT_IN_VOICES],
        saveVoice: () => ({ id: 'char-custom-2', name: 'NewChar' }),
        deleteVoice: id => {
          if (deleteShouldThrow) throw new StorageError('Could not save voices to browser storage.');
          return id;
        },
      },
      synthesis: {
        activeCharacterId: customChar.id,
        recording: null,
        cancel: () => { cancelled = true; },
        setStatus: status => statuses.push(status),
        validateAudioClip: async () => null,
      },
      anchorApi: {
        updateCharacterAnchor: async () => { throw new StorageError('IDB write failed'); },
        unpinCharacterAnchor: async id => {
          if (unpinShouldThrow) throw new StorageError('IDB delete failed');
          unpinnedIds.push(id);
        },
        pinCharacterAnchor: async () => { throw new StorageError('IDB pin failed'); },
      },
      lockReferenceAudio: { execute: async file => ({ blob: file, fileName: file.name }) },
      logger: { error: (loc, err, meta) => errors.push({ loc, err, meta }) },
      uploadedRefsRef: { current: { [customChar.id]: { path: '/tmp/ref.wav' } } },
      rerolledIdsRef: { current: new Set() },
      onCharacterSelected: id => selectedIds.push(id),
      onCloseLibrary: () => {},
    };

    const handlers = createCharacterActionHandlers(ctx);
    const voiceActions = buildVoiceActions({
      actions: handlers,
      activeCharacter: customChar,
      setLibraryModal() {},
      setOptions() {},
    });

    // 1. Studio onUpdateAnchor delegates to handleUpdateAnchor and never leaks unhandled rejections
    voiceActions.onUpdateAnchor({ promptText: 'សួស្តី' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(errors[0].loc, 'useCharacterActions.handleUpdateAnchor');
    assert.deepEqual(statuses[0], { message: 'IDB write failed', error: true });

    // 2. Delete failure in localStorage must NOT unpin IndexedDB, switch character, or report success
    await handlers.handleDeleteCharacter(customChar.id);
    assert.deepEqual(unpinnedIds, []);
    assert.deepEqual(selectedIds, []);
    assert.equal(cancelled, false);
    assert.ok(ctx.uploadedRefsRef.current[customChar.id]);
    assert.equal(statuses.at(-1).error, true);
    assert.doesNotMatch(statuses.at(-1).message, /Deleted character/);

    // 3. Delete success cleans cache, resets active character, unpins IndexedDB, and reports success
    deleteShouldThrow = false;
    await handlers.handleDeleteCharacter(customChar.id);
    assert.equal(cancelled, true);
    assert.equal(ctx.uploadedRefsRef.current[customChar.id], undefined);
    assert.deepEqual(selectedIds, [DEFAULT_CHARACTER_ID]);
    assert.deepEqual(unpinnedIds, [customChar.id]);
    assert.deepEqual(statuses.at(-1), { message: 'Deleted character Pisey (char-custom-1).', error: false });

    // 4. Create character rollback when pin fails, even if rollback deleteVoice also throws
    deleteShouldThrow = true;
    await assert.rejects(
      () => handlers.handleCreateCharacter({ name: 'NewChar', audioFile: new Blob(['RIFF']) }),
      err => err instanceof StorageError && err.message === 'IDB pin failed'
    );
    assert.equal(errors.at(-1).loc, 'useCharacterActions.handleCreateCharacter.rollback');

    // 5. Unpin failure after successful localStorage delete logs and warns clearly
    deleteShouldThrow = false;
    unpinShouldThrow = true;
    await handlers.handleDeleteCharacter(customChar.id);
    assert.equal(statuses.at(-1).error, true);
    assert.match(statuses.at(-1).message, /IDB delete failed/);
  });
});

test('createVoiceAnchorStore preserves microtask-interleaved edits and rolls back cancelled patches when pin/unpin fails', async () => {
  await withViteSsr(async vite => {
    const { createVoiceAnchorStore } = await vite.ssrLoadModule('/src/presentation/hooks/useVoiceAnchors.js');
    let persisted = { characterId: CHAR_NISA.id, source: 'upload', exactClone: true, promptText: 'init', blob: new Blob(['RIFF']) };
    const gates = [];
    let failPin = false;
    let failUnpin = false;
    let loadShouldThrow = true;

    const store = createVoiceAnchorStore({
      voiceAnchors: {
        loadAll: async () => {
          if (loadShouldThrow) throw new StorageError('IDB unavailable');
          return { [CHAR_NISA.id]: { ...persisted } };
        },
        async pinCharacter(params) {
          if (failPin) throw new StorageError('Pin quota full');
          persisted = { ...params, updatedAt: Date.now() };
          return persisted;
        },
        async updateAnchor(_id, patch) {
          if (gates.length) await gates.shift().promise;
          persisted = { ...persisted, ...patch, updatedAt: Date.now() };
          return persisted;
        },
        async unpinCharacter() {
          if (failUnpin) throw new StorageError('Unpin blocked');
          persisted = null;
        },
      },
      logger: { debug() {}, error() {} },
    });

    // Failed loadAll sets warning, subsequent successful loadAll clears it
    await store.loadAll();
    assert.equal(store.state.anchorWarning, 'Could not load saved character voices.');
    loadShouldThrow = false;
    await store.loadAll();
    assert.equal(store.state.anchorWarning, null);

    // 1. Microtask edit interleaved between drainCharacterQueue and batch 2 execution must NOT regress to 'ab'
    const gate1 = createDeferred();
    const gate2 = createDeferred();
    gates.push(gate1, gate2);
    const p1 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'a' });
    await Promise.resolve();
    const p2 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'ab' });
    gate1.resolve();
    await p1;
    const p3 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'abc' });
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'abc');
    gate2.resolve();
    await p2;
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'abc');
    await p3;
    assert.equal(persisted.promptText, 'abc');

    // 2. Failed unpin after cancelPendingPatch rolls back cancelled optimistic text to last persisted snapshot
    failUnpin = true;
    const gateBeforeUnpin = createDeferred();
    gates.push(gateBeforeUnpin);
    const step1 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'step1' });
    await Promise.resolve();
    const cancelledEdit = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'cancelled-edit' });
    const failedUnpin = store.unpinCharacterAnchor(CHAR_NISA.id);
    gateBeforeUnpin.resolve();
    await Promise.all([step1, cancelledEdit]);
    await assert.rejects(() => failedUnpin, StorageError);
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'step1');

    // 3. Failed pin after cancelPendingPatch also rolls back cancelled optimistic text
    failPin = true;
    const gateBeforePin = createDeferred();
    gates.push(gateBeforePin);
    const step2 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'step2' });
    await Promise.resolve();
    const cancelledEdit2 = store.updateCharacterAnchor(CHAR_NISA.id, { promptText: 'cancelled-edit-2' });
    const failedPin = store.pinCharacterAnchor({ characterId: CHAR_NISA.id, blob: new Blob(['RIFF']) });
    gateBeforePin.resolve();
    await Promise.all([step2, cancelledEdit2]);
    await assert.rejects(() => failedPin, StorageError);
    assert.equal(store.state.anchors[CHAR_NISA.id].promptText, 'step2');
  });
});
