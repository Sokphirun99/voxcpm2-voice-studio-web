import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { StorageError } from '../../src/domain/errors.js';
import { createVoiceAnchorUseCases, createVoiceLibraryUseCases } from '../../src/domain/useCases.js';
import { BUILT_IN_VOICES } from '../../src/domain/voiceLibrary.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHAR_NISA = BUILT_IN_VOICES[0];

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function installTestDom() {
  class MiniNode {
    constructor(nodeType, nodeName) {
      this.nodeType = nodeType;
      this.nodeName = nodeName;
      this.childNodes = [];
      this.parentNode = null;
      this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
      this.attributes = new Map();
      this.listeners = new Map();
    }
    get ownerDocument() { return globalThis.document; }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return this.parentNode.childNodes[idx + 1] || null;
    }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.childNodes = v ? [new MiniText(String(v))] : []; }
    appendChild(c) {
      if (c.nodeType === 11) { [...c.childNodes].forEach(x => this.appendChild(x)); return c; }
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    }
    insertBefore(c, r) {
      if (!r) return this.appendChild(c);
      if (c.nodeType === 11) { [...c.childNodes].forEach(x => this.insertBefore(x, r)); return c; }
      if (c.parentNode) c.parentNode.removeChild(c);
      const idx = this.childNodes.indexOf(r);
      if (idx === -1) return this.appendChild(c);
      c.parentNode = this;
      this.childNodes.splice(idx, 0, c);
      return c;
    }
    removeChild(c) {
      const idx = this.childNodes.indexOf(c);
      if (idx !== -1) { this.childNodes.splice(idx, 1); c.parentNode = null; }
      return c;
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
      if (k.startsWith('on')) this[k] = () => {};
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    removeAttribute(k) {
      this.attributes.delete(k);
      if (k === 'id') this.id = '';
    }
    hasAttribute(k) { return this.attributes.has(k); }
    addEventListener(type, fn, capture) {
      const key = `${capture ? 'cap' : 'bub'}:${type}`;
      if (!this.listeners.has(key)) this.listeners.set(key, []);
      this.listeners.get(key).push(fn);
    }
    removeEventListener(type, fn, capture) {
      const key = `${capture ? 'cap' : 'bub'}:${type}`;
      const list = this.listeners.get(key);
      if (list) this.listeners.set(key, list.filter(item => item !== fn));
    }
    dispatchEvent(event) {
      event.target = event.target || this;
      event.stopPropagation = event.stopPropagation || (() => {});
      event.preventDefault = event.preventDefault || (() => {});
      const path = [];
      for (let cur = this; cur; cur = cur.parentNode) path.push(cur);
      for (let i = path.length - 1; i >= 0; i--) {
        event.currentTarget = path[i];
        for (const fn of path[i].listeners.get(`cap:${event.type}`) || []) fn(event);
      }
      for (let i = 0; i < path.length; i++) {
        event.currentTarget = path[i];
        for (const fn of path[i].listeners.get(`bub:${event.type}`) || []) fn(event);
      }
      event.currentTarget = null;
      return true;
    }
    focus() { globalThis.document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent({ type: 'close' }); }
    requestSubmit() { this.dispatchEvent({ type: 'submit', bubbles: true }); }
    getContext() { return null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = node => {
        for (const c of node.childNodes) {
          if (c.nodeType !== 1) continue;
          const match = sel.startsWith('#')
            ? c.id === sel.slice(1)
            : sel.startsWith('.')
              ? String(c.className || '').split(/\s+/).includes(sel.slice(1))
              : c.tagName === sel.toUpperCase();
          if (match) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  class MiniText extends MiniNode {
    constructor(text) { super(3, '#text'); this.data = text; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
    get nodeValue() { return this.data; }
    set nodeValue(v) { this.data = String(v); }
  }
  class MiniElement extends MiniNode {
    constructor(tag) {
      super(1, tag.toUpperCase());
      this.tagName = tag.toUpperCase();
      this._value = '';
      this._defaultValue = '';
      this._dirtyValue = false;
      this.oninput = null;
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
    get options() { return this.querySelectorAll('option'); }
    get length() { return this.tagName === 'SELECT' ? this.options.length : 0; }
    get defaultValue() { return this._defaultValue; }
    set defaultValue(v) {
      this._defaultValue = String(v);
      if (!this._dirtyValue) this._value = this._defaultValue;
    }
    get value() { return this._value; }
    set value(v) {
      const next = v == null ? '' : String(v);
      if (this._value !== next) {
        this._value = next;
        this.selectionStart = next.length;
        this.selectionEnd = next.length;
      }
      this._dirtyValue = true;
    }
  }
  class HTMLIFrameElement {}
  const prev = { window: globalThis.window, document: globalThis.document, HTMLIFrameElement: globalThis.HTMLIFrameElement, ResizeObserver: globalThis.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const win = {
    HTMLIFrameElement,
    setInterval: () => 1,
    clearInterval() {},
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    navigator: { userAgent: 'Node' },
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  const body = new MiniElement('body');
  const head = new MiniElement('head');
  const docEl = new MiniElement('html');
  docEl.appendChild(head);
  docEl.appendChild(body);
  const doc = {
    nodeType: 9,
    defaultView: win,
    activeElement: null,
    head,
    body,
    documentElement: docEl,
    createElement: t => new MiniElement(t),
    createElementNS: (_ns, t) => new MiniElement(t),
    createTextNode: t => new MiniText(t),
    createDocumentFragment: () => new MiniNode(11, '#df'),
    createComment: t => new MiniNode(8, '#c'),
    getElementById: id => docEl.querySelector(`#${id}`),
    querySelector: sel => docEl.querySelector(sel),
    querySelectorAll: sel => docEl.querySelectorAll(sel),
    addEventListener() {},
    removeEventListener() {},
  };
  win.document = doc;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.HTMLIFrameElement = HTMLIFrameElement;
  globalThis.ResizeObserver = win.ResizeObserver;
  return {
    doc,
    restore() { Object.assign(globalThis, prev); },
  };
}

function setControlledText(element, nextValue, cursorPosition) {
  element._value = nextValue;
  element.selectionStart = cursorPosition;
  element.selectionEnd = cursorPosition;
  element.dispatchEvent({ type: 'input', bubbles: true, target: element });
}

test('mounted Studio preserves controlled locked-transcript cursor/value across rapid typing, catches anchor write errors, and blocks false delete success', async () => {
  const dom = installTestDom();
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  const unhandledRejections = [];
  const onUnhandled = err => unhandledRejections.push(err);
  process.on('unhandledRejection', onUnhandled);

  let root;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    const customChar = {
      id: 'char-custom-live',
      name: 'Pisey',
      role: 'Custom character',
      category: 'female',
      voiceScope: 'single',
      traits: '1 person · Saved character',
      description: 'Gentle Khmer speaker',
      isBuiltIn: false,
    };
    const anchorMap = new Map([
      [CHAR_NISA.id, {
        characterId: CHAR_NISA.id, label: 'Nisa', source: 'upload', fileName: 'nisa.wav',
        exactClone: true, promptText: 'សួស្តី', blob: new Blob(['RIFF']), updatedAt: 1,
      }],
    ]);
    const saveGates = [];
    let failAnchorSave = false;
    let failLibrarySave = true;
    const errors = [];
    const deletedAnchors = [];

    const voiceAnchors = createVoiceAnchorUseCases({
      anchorRepository: {
        loadAllAnchors: async () => Object.fromEntries(anchorMap.entries()),
        async saveAnchor(id, rec) {
          if (saveGates.length) await saveGates.shift().promise;
          if (failAnchorSave) throw new StorageError('IndexedDB write rejected');
          anchorMap.set(id, rec);
        },
        async deleteAnchor(id) {
          deletedAnchors.push(id);
          anchorMap.delete(id);
        },
      },
    });
    const voiceLibrary = createVoiceLibraryUseCases({
      voiceRepository: {
        loadSavedEntries: () => ({ entries: [customChar], warning: null }),
        saveEntries() {
          if (failLibrarySave) throw new StorageError('localStorage quota exceeded');
        },
      },
    });
    const services = {
      speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error: (loc, err, ctx) => errors.push({ loc, err, ctx }) },
      synthesizeSpeech: { execute: async () => ({}) },
      lockReferenceAudio: { execute: async f => ({ blob: f, fileName: f.name }) },
      voiceLibrary,
      voiceAnchors,
    };

    const container = dom.doc.createElement('div');
    dom.doc.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
    });

    // 1. Controlled textarea cursor stability + coalescing under real React 19 renders
    const transcript = container.querySelector('#locked-transcript');
    assert.equal(transcript.value, 'សួស្តី');
    const gate = createDeferred();
    saveGates.push(gate);
    await act(async () => {
      setControlledText(transcript, 'សួស្តី ក', 8);
    });
    await act(async () => {
      setControlledText(transcript, 'សួស្តី ខ', 8);
    });
    assert.equal(transcript.value, 'សួស្តី ខ');
    assert.equal(transcript.selectionStart, 8);
    await act(async () => {
      gate.resolve();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(anchorMap.get(CHAR_NISA.id).promptText, 'សួស្តី ខ');
    assert.equal(transcript.value, 'សួស្តី ខ');

    // 2. IndexedDB write failure from onUpdateAnchor is caught cleanly (no unhandled rejection) and surfaces error status
    failAnchorSave = true;
    await act(async () => {
      setControlledText(transcript, 'fail-edit', 9);
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(unhandledRejections.length, 0);
    assert.equal(errors.some(e => e.loc === 'useCharacterActions.handleUpdateAnchor'), true);
    assert.match(container.querySelector('#generation-status').textContent, /IndexedDB write rejected/);
    assert.equal(transcript.value, 'សួស្តី ខ');

    // 3. Failing localStorage delete keeps custom character in library, shows warning, and skips unpinning
    await act(async () => {
      container.querySelector('#open-voice-library').dispatchEvent({ type: 'click', bubbles: true });
    });
    const deleteButtons = container.querySelectorAll('.library-delete');
    assert.equal(deleteButtons.length, 1);
    await act(async () => {
      deleteButtons[0].dispatchEvent({ type: 'click', bubbles: true });
    });
    assert.deepEqual(deletedAnchors, []);
    assert.equal(container.querySelectorAll('.library-delete').length, 1);
    assert.match(container.querySelector('#library-status').textContent, /localStorage quota exceeded/);
    assert.doesNotMatch(container.querySelector('#generation-status').textContent, /Deleted character/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (root) {
      await act(async () => { root.unmount(); });
    }
    dom.restore();
    await vite.close();
  }
});

test('mounted Studio auto-locks Take 1 voice for Take 2, ignores duplicate submits, and resets anchor cleanly', async () => {
  const dom = installTestDom();
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createSynthesizeSpeechUseCase } = await import('../../src/domain/useCases.js');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });

  let root;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    const anchorMap = new Map();
    const synthCalls = [];
    const uploadCalls = [];
    const takeGate = createDeferred();
    let callIdx = 0;

    const speechGateway = {
      checkAvailability: async () => true,
      async uploadReferenceAudio(params) {
        uploadCalls.push(params);
        return { path: '/tmp/nisa-take1.wav', orig_name: params.fileName, mime_type: 'audio/wav' };
      },
      async synthesize(params) {
        callIdx += 1;
        synthCalls.push(params);
        if (callIdx === 1) await takeGate.promise;
        return { blob: new Blob(['RIFFtake'], { type: 'audio/wav' }), seed: params.seed };
      },
    };
    const services = {
      speechGateway,
      audioDecoder: { decodePeaks: async () => [0.2, 0.8] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: createSynthesizeSpeechUseCase({ speechGateway, seedGenerator: () => 555 }),
      lockReferenceAudio: { execute: async f => ({ blob: f, fileName: f.name }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: {
          loadAllAnchors: async () => Object.fromEntries(anchorMap.entries()),
          saveAnchor: async (id, rec) => anchorMap.set(id, rec),
          deleteAnchor: async id => anchorMap.delete(id),
        },
      }),
    };

    const container = dom.doc.createElement('div');
    dom.doc.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
    });

    const scriptInput = container.querySelector('#script');
    const speechForm = container.querySelector('#speech-form');
    await act(async () => {
      setControlledText(scriptInput, 'សួស្តីអ្នកទាំងអស់គ្នា', 20);
    });

    // Submit twice back-to-back -> duplicate call must be ignored by synchronous abortController guard
    await act(async () => {
      speechForm.dispatchEvent({ type: 'submit', bubbles: true });
      speechForm.dispatchEvent({ type: 'submit', bubbles: true });
    });
    assert.equal(synthCalls.length, 1);
    assert.equal(synthCalls[0].instruction, CHAR_NISA.description);

    await act(async () => {
      takeGate.resolve();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(anchorMap.has(CHAR_NISA.id), true);
    assert.match(container.querySelector('#active-character-card').textContent, /Voice locked/);
    assert.match(container.querySelector('#generation-status').textContent, /\d+(?:ms|s) · \d+ B/);

    // Take 2 automatically uploads Take 1 anchor and clears control instruction
    await act(async () => {
      setControlledText(scriptInput, 'ប្រយោគទីពីរ', 12);
    });
    await act(async () => {
      speechForm.dispatchEvent({ type: 'submit', bubbles: true });
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(uploadCalls.length, 1);
    assert.equal(synthCalls.length, 2);
    assert.equal(synthCalls[1].instruction, '');
    assert.equal(synthCalls[1].seed, CHAR_NISA.defaultSeed);
    assert.equal(synthCalls[1].referenceFile.path, '/tmp/nisa-take1.wav');
    assert.match(container.querySelector('#generation-status').textContent, /Audio ready · \d+(?:ms|s) · \d+ B/);

    // Take 3 automatically expands Khmer currency/time and infers writing-format style cue even when locked
    await act(async () => {
      setControlledText(scriptInput, 'តម្លៃ $25 ម៉ោង 10:30 អស្ចារ្យ!', 30);
    });
    await act(async () => {
      speechForm.dispatchEvent({ type: 'submit', bubbles: true });
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(synthCalls.length, 3);
    assert.equal(synthCalls[2].text, 'តម្លៃ ម្ភៃប្រាំដុល្លារ ម៉ោង ដប់ម៉ោងសាមសិបនាទី អស្ចារ្យ!');
    assert.match(synthCalls[2].instruction, /energetic upbeat/i);

    // Reset voice unpins anchor and reverts card to Locks on 1st take
    await act(async () => {
      container.querySelector('#reset-character-voice').dispatchEvent({ type: 'click', bubbles: true });
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(anchorMap.has(CHAR_NISA.id), false);
    assert.match(container.querySelector('#active-character-card').textContent, /Locks on 1st take/);

    // Character secondary details start closed and toggle cleanly on click
    const detailsToggle = container.querySelector('#character-details-toggle');
    const detailsPanel = container.querySelector('#character-details-panel');
    assert.equal(detailsToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(detailsPanel.hasAttribute('hidden'), true);
    await act(async () => {
      detailsToggle.dispatchEvent({ type: 'click', bubbles: true });
    });
    assert.equal(detailsToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(detailsPanel.hasAttribute('hidden'), false);
    await act(async () => {
      detailsToggle.dispatchEvent({ type: 'click', bubbles: true });
    });
    assert.equal(detailsToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(detailsPanel.hasAttribute('hidden'), true);
  } finally {
    if (root) {
      await act(async () => { root.unmount(); });
    }
    dom.restore();
    await vite.close();
  }
});

function buildPcmWavBlob({ sampleRate = 48000, seconds = 2, type = 'application/octet-stream' } = {}) {
  const sampleCount = sampleRate * seconds;
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, dataSize, true);
  return new Blob([buffer], { type });
}

test('mounted AudioPlayer unlocks Play from WAV/WebAudio duration across Take 1 -> Take 2 without waiting for loadedmetadata', async () => {
  const dom = installTestDom();
  const prevCreate = URL.createObjectURL;
  const prevRevoke = URL.revokeObjectURL;
  const createdUrls = [];
  const revokedUrls = [];
  const audioEvents = [];
  let urlCounter = 0;
  URL.createObjectURL = blob => {
    const url = `blob:http://127.0.0.1:8087/take-${++urlCounter}`;
    createdUrls.push({ url, type: blob.type });
    return url;
  };
  URL.revokeObjectURL = url => revokedUrls.push(url);

  const origCreateElement = dom.doc.createElement;
  dom.doc.createElement = tag => {
    const el = origCreateElement(tag);
    if (tag.toLowerCase() === 'audio') {
      el.paused = true;
      el.readyState = 0;
      Object.defineProperty(el, 'src', { get: () => el.attributes.get('src') || '' });
      el.load = () => audioEvents.push({ type: 'load', src: el.src });
      el.play = async () => {
        audioEvents.push({ type: 'play', src: el.src });
        el.paused = false;
        el.dispatchEvent({ type: 'play' });
      };
      el.pause = () => {
        el.paused = true;
        el.dispatchEvent({ type: 'pause' });
      };
    }
    return el;
  };

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });

  let root;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { AudioPlayer } = await vite.ssrLoadModule('/src/presentation/components/AudioPlayer.jsx');
    const { createWebAudioDecoder } = await vite.ssrLoadModule('/src/data/webAudioDecoder.js');

    const decoder = createWebAudioDecoder({
      AudioContextClass: class {
        async decodeAudioData() { return { duration: 3.5, getChannelData: () => new Float32Array([0.1, -0.5, 0.2]) }; }
        async close() {}
      },
    });
    const summary = await decoder.decodeAudioSummary(new Blob(['x']));
    assert.equal(summary.duration, 3.5);
    assert.ok(summary.peaks.length > 0);

    const playbackErrors = [];
    const loggedErrors = [];
    const services = {
      speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
      audioDecoder: decoder,
      logger: { debug() {}, warn() {}, error: (loc, err) => loggedErrors.push({ loc, err }) },
      synthesizeSpeech: { execute: async () => ({}) },
      lockReferenceAudio: { execute: async f => ({ blob: f, fileName: f.name }) },
      voiceLibrary: { loadSaved: () => ({ entries: [], warning: null }), saveCustom: () => ({}), deleteCustom: () => [] },
      voiceAnchors: { loadAll: async () => ({}), pinCharacter: async p => p, updateAnchor: async () => null, unpinCharacter: async () => {} },
    };

    const container = dom.doc.createElement('div');
    dom.doc.body.appendChild(container);
    const take1 = { id: 'take-1', seed: 101, characterId: CHAR_NISA.id, characterName: CHAR_NISA.name, blob: buildPcmWavBlob({ seconds: 2 }) };
    const take2 = { id: 'take-2', seed: 202, characterId: CHAR_NISA.id, characterName: CHAR_NISA.name, blob: buildPcmWavBlob({ seconds: 6 }) };

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(StudioProvider, { services }, React.createElement(AudioPlayer, {
        recording: take1, activeCharacter: CHAR_NISA, activeAnchor: null,
        status: { message: 'Audio ready', error: false }, onPinTake() {}, onPlaybackError: () => playbackErrors.push('err'),
      })));
      await new Promise(r => setTimeout(r, 20));
    });

    assert.equal(createdUrls[0].type, 'audio/wav');
    assert.equal(container.querySelector('#play').hasAttribute('disabled'), false);
    assert.equal(container.querySelector('#duration').textContent, '0:02');
    const audioEl1 = container.querySelector('#audio');

    // Re-render with Take 2 without firing DOM loadedmetadata: fresh <audio> node mounts and #play unlocks
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(AudioPlayer, {
        recording: take2, activeCharacter: CHAR_NISA, activeAnchor: null,
        status: { message: 'Audio ready', error: false }, onPinTake() {}, onPlaybackError: () => playbackErrors.push('err'),
      })));
      await new Promise(r => setTimeout(r, 20));
    });

    const audioEl2 = container.querySelector('#audio');
    assert.notEqual(audioEl2, audioEl1);
    assert.deepEqual(revokedUrls, ['blob:http://127.0.0.1:8087/take-1']);
    assert.equal(container.querySelector('#play').hasAttribute('disabled'), false);
    assert.equal(container.querySelector('#duration').textContent, '0:06');

    await act(async () => {
      container.querySelector('#play').dispatchEvent({ type: 'click', bubbles: true });
      await new Promise(r => setTimeout(r, 10));
    });
    assert.equal(audioEvents.some(e => e.type === 'load' && e.src === 'blob:http://127.0.0.1:8087/take-2'), true);
    assert.equal(audioEvents.some(e => e.type === 'play' && e.src === 'blob:http://127.0.0.1:8087/take-2'), true);
    assert.equal(container.querySelector('#play').getAttribute('aria-label'), 'Pause audio');

    // Timeupdate + pause must preserve position even when browser clears event.currentTarget after dispatch
    await act(async () => {
      audioEl2.currentTime = 3.25;
      audioEl2.dispatchEvent({ type: 'timeupdate' });
    });
    assert.equal(container.querySelector('#elapsed').textContent, '0:03');
    assert.equal(container.querySelector('#seek').value, '3.25');

    await act(async () => {
      container.querySelector('#play').dispatchEvent({ type: 'click', bubbles: true });
      audioEl2.dispatchEvent({ type: 'timeupdate' });
    });
    assert.equal(container.querySelector('#play').getAttribute('aria-label'), 'Play audio');
    assert.equal(container.querySelector('#elapsed').textContent, '0:03');
    assert.equal(container.querySelector('#seek').value, '3.25');

    // Media error logs cleanly and triggers onPlaybackError
    await act(async () => {
      audioEl2.error = { code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
      audioEl2.dispatchEvent({ type: 'error', currentTarget: audioEl2 });
    });
    assert.equal(playbackErrors.length, 1);
    assert.equal(loggedErrors.length, 1);
  } finally {
    URL.createObjectURL = prevCreate;
    URL.revokeObjectURL = prevRevoke;
    if (root) await act(async () => { root.unmount(); });
    dom.restore();
    await vite.close();
  }
});

test('mounted Studio pops up top offline banner with root cause and hides automatically when online', async () => {
  const dom = installTestDom();
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createSynthesizeSpeechUseCase } = await import('../../src/domain/useCases.js');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });

  let root;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    let health = { available: false, reason: 'VoxCPM2 server on port 8808 is unreachable (HTTP 502).' };
    const speechGateway = {
      checkHealth: async () => health,
      checkAvailability: async () => health.available,
      uploadReferenceAudio: async () => ({}),
      synthesize: async () => ({ blob: new Blob(['RIFF']), seed: 1 }),
    };
    const services = {
      speechGateway,
      audioDecoder: { decodePeaks: async () => [0.2] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: createSynthesizeSpeechUseCase({ speechGateway, seedGenerator: () => 1 }),
      lockReferenceAudio: { execute: async f => ({ blob: f, fileName: f.name }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    const container = dom.doc.createElement('div');
    dom.doc.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
      await new Promise(r => setTimeout(r, 20));
    });

    assert.equal(container.querySelector('#engine'), null);
    assert.ok(container.querySelector('#engine-offline-banner'));
    assert.match(container.querySelector('#engine-offline-reason').textContent, /HTTP 502/);

    // Dismiss hides banner cleanly
    await act(async () => {
      container.querySelector('#dismiss-engine-alert').dispatchEvent({ type: 'click', bubbles: true });
    });
    assert.equal(container.querySelector('#engine-offline-banner'), null);

    // Fresh mount recovering online via Retry removes offline banner completely
    const recoveryRootContainer = dom.doc.createElement('div');
    dom.doc.body.appendChild(recoveryRootContainer);
    const recoveryRoot = createRoot(recoveryRootContainer);
    try {
      await act(async () => {
        recoveryRoot.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
        await new Promise(r => setTimeout(r, 20));
      });
      assert.ok(recoveryRootContainer.querySelector('#engine-offline-banner'));
      health = { available: true, reason: null };
      await act(async () => {
        recoveryRootContainer.querySelector('#retry-engine-check').dispatchEvent({ type: 'click', bubbles: true });
        await new Promise(r => setTimeout(r, 20));
      });
      assert.equal(recoveryRootContainer.querySelector('#engine'), null);
      assert.equal(recoveryRootContainer.querySelector('#engine-offline-banner'), null);
    } finally {
      await act(async () => { recoveryRoot.unmount(); });
    }
  } finally {
    if (root) await act(async () => { root.unmount(); });
    dom.restore();
    await vite.close();
  }
});
