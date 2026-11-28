/**
 * @fileoverview Mounted integration test covering multi-function switching, speaker-colored extraction, editing, burn-in, and TTS handoff.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createVoiceAnchorUseCases, createVoiceLibraryUseCases } from '../../src/domain/useCases.js';
import { BUILT_IN_VOICES } from '../../src/domain/voiceLibrary.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function createDomShim() {
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
    [Symbol.for('nodejs.util.inspect.custom')]() {
      const id = this.id ? `#${this.id}` : '';
      return `<${this.nodeName}${id}>`;
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
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) {
      const name = String(k).toLowerCase();
      this.attributes.set(name, String(v));
      if (name === 'id') this.id = String(v);
      if (name === 'class') this.className = String(v);
      if (name === 'type') this.type = String(v);
      if (name === 'value') this._value = String(v);
      if (name === 'hidden') this.hidden = true;
      if (name.startsWith('on')) this[name] = () => {};
    }
    getAttribute(k) {
      const name = String(k).toLowerCase();
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    removeAttribute(k) {
      const name = String(k).toLowerCase();
      this.attributes.delete(name);
      if (name === 'id') this.id = '';
      if (name === 'hidden') this.hidden = false;
    }
    hasAttribute(k) { return this.attributes.has(String(k).toLowerCase()); }
    addEventListener(type, fn, cap) {
      const key = `${cap ? 'cap' : 'bub'}:${type}`;
      if (!this.listeners.has(key)) this.listeners.set(key, []);
      this.listeners.get(key).push(fn);
    }
    removeEventListener(type, fn, cap) {
      const key = `${cap ? 'cap' : 'bub'}:${type}`;
      const list = this.listeners.get(key);
      if (list) this.listeners.set(key, list.filter(i => i !== fn));
    }
    dispatchEvent(event) {
      event.target = event.target || this;
      event.stopPropagation = event.stopPropagation || (() => { event._stopped = true; });
      event.preventDefault = event.preventDefault || (() => { event.defaultPrevented = true; });
      const path = [];
      for (let cur = this; cur; cur = cur.parentNode) path.push(cur);
      if (event.bubbles !== false && this.ownerDocument && path[path.length - 1] === docEl) path.push(this.ownerDocument);
      for (let i = path.length - 1; i >= 0; i--) {
        if (event._stopped) break;
        event.currentTarget = path[i];
        for (const fn of path[i].listeners?.get(`cap:${event.type}`) || []) fn(event);
      }
      for (let i = 0; i < path.length; i++) {
        if (event._stopped) break;
        event.currentTarget = path[i];
        for (const fn of path[i].listeners?.get(`bub:${event.type}`) || []) fn(event);
      }
      event.currentTarget = null;
      return !event.defaultPrevented;
    }
    focus() {
      globalThis.document.activeElement = this;
      this.dispatchEvent({ type: 'focus', bubbles: false });
      this.dispatchEvent({ type: 'focusin', bubbles: true });
    }
    blur() {
      if (globalThis.document.activeElement === this) globalThis.document.activeElement = null;
      this.dispatchEvent({ type: 'blur', bubbles: false });
      this.dispatchEvent({ type: 'focusout', bubbles: true });
    }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent({ type: 'close' }); }
    click() {
      if (this.tagName === 'A') return;
      this.dispatchEvent({ type: 'click', bubbles: true });
    }
    matchesSingle(sel) {
      if (this.nodeType !== 1) return false;
      const trimmed = String(sel || '').trim();
      if (!trimmed) return false;
      if (trimmed === '[role="dialog"]') return this.getAttribute('role') === 'dialog';
      if (trimmed.startsWith('#')) return this.id === trimmed.slice(1);
      if (trimmed.startsWith('.')) return String(this.className || '').split(/\s+/).includes(trimmed.slice(1));
      return this.tagName === trimmed.toUpperCase();
    }
    closest(sel) {
      const parts = String(sel || '').split(',').map(s => s.trim()).filter(Boolean);
      for (let cur = this; cur; cur = cur.parentNode) {
        if (cur.nodeType === 1 && parts.some(part => cur.matchesSingle(part))) return cur;
      }
      return null;
    }
    contains(other) {
      for (let cur = other; cur; cur = cur.parentNode) {
        if (cur === this) return true;
      }
      return false;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = node => {
        for (const c of node.childNodes) {
          if (c.nodeType !== 1) continue;
          const match = c.matchesSingle(sel);
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
      this.onchange = null;
      this.files = [];
      this.checked = false;
      this.selectionStart = 0;
      this.selectionEnd = 0;
      if (this.tagName === 'TRACK') this.track = { mode: 'disabled' };
    }
    get options() { return this.querySelectorAll('option'); }
    get length() { return this.tagName === 'SELECT' ? this.options.length : 0; }
    get defaultValue() { return this._defaultValue; }
    set defaultValue(v) {
      this._defaultValue = String(v);
      if (!this._dirtyValue) this._value = this._defaultValue;
    }
    get selected() { return Boolean(this._selected); }
    set selected(v) {
      this._selected = Boolean(v);
      if (this._selected && this.tagName === 'OPTION') {
        let p = this.parentNode;
        while (p && p.tagName !== 'SELECT') p = p.parentNode;
        if (p) {
          p._value = this._value;
          for (const o of p.options) if (o !== this) o._selected = false;
        }
      }
    }
    get value() { return this._value; }
    set value(v) {
      const next = v == null ? '' : String(v);
      this._value = next;
      this._dirtyValue = true;
    }
    get srclang() { return this.getAttribute('srclang') || ''; }
    set srclang(v) { this.setAttribute('srclang', v == null ? '' : String(v)); }
  }
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    ResizeObserver: globalThis.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  let blobSeq = 0;
  URL.createObjectURL = () => `blob:test/${++blobSeq}`;
  URL.revokeObjectURL = () => {};
  class HTMLIFrameElement {}
  const body = new MiniElement('body');
  const head = new MiniElement('head');
  const docEl = new MiniElement('html');
  docEl.appendChild(head);
  docEl.appendChild(body);
  const win = {
    HTMLIFrameElement,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn) => { return 1; },
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    navigator: { userAgent: 'Node' },
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  const docListeners = new Map();
  const doc = {
    nodeType: 9,
    defaultView: win,
    activeElement: null,
    head,
    body,
    documentElement: docEl,
    listeners: docListeners,
    createElement: t => new MiniElement(t),
    createElementNS: (_ns, t) => new MiniElement(t),
    createTextNode: t => new MiniText(t),
    createDocumentFragment: () => new MiniNode(11, '#df'),
    createComment: t => new MiniNode(8, '#c'),
    getElementById: id => docEl.querySelector(`#${id}`),
    querySelector: sel => docEl.querySelector(sel),
    querySelectorAll: sel => docEl.querySelectorAll(sel),
    addEventListener(type, fn, cap) {
      const key = `${cap ? 'cap' : 'bub'}:${type}`;
      if (!docListeners.has(key)) docListeners.set(key, []);
      docListeners.get(key).push(fn);
    },
    removeEventListener(type, fn, cap) {
      const key = `${cap ? 'cap' : 'bub'}:${type}`;
      const list = docListeners.get(key);
      if (list) docListeners.set(key, list.filter(i => i !== fn));
    },
    dispatchEvent(event) {
      event.target = event.target || body;
      event.stopPropagation = event.stopPropagation || (() => { event._stopped = true; });
      event.preventDefault = event.preventDefault || (() => { event.defaultPrevented = true; });
      event.currentTarget = doc;
      for (const fn of docListeners.get(`cap:${event.type}`) || []) fn(event);
      for (const fn of docListeners.get(`bub:${event.type}`) || []) fn(event);
      event.currentTarget = null;
      return !event.defaultPrevented;
    },
  };
  win.document = doc;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.HTMLIFrameElement = HTMLIFrameElement;
  globalThis.ResizeObserver = win.ResizeObserver;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    container: body.appendChild(new MiniElement('div')),
    restore() {
      globalThis.window = prev.window;
      globalThis.document = prev.document;
      globalThis.HTMLIFrameElement = prev.HTMLIFrameElement;
      globalThis.ResizeObserver = prev.ResizeObserver;
      globalThis.IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT;
      URL.createObjectURL = prev.createObjectURL;
      URL.revokeObjectURL = prev.revokeObjectURL;
    },
  };
}

test('mounted Studio switches to Video to subtitle, extracts speakers, burns MP4, and sends script to TTS', async () => {
  const dom = createDomShim();
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
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    let burnRequest = null;
    const services = {
      speechGateway: {
        checkAvailability: async () => true,
        checkHealth: async () => ({ online: true, detail: null }),
        uploadReferenceAudio: async () => ({}),
        synthesize: async () => ({}),
      },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true }),
        transcribeVideo: async ({ file }) => {
          assert.equal(file.name, 'news-clip.mp4');
          return {
            jobId: '0123456789abcdef',
            language: 'en',
            speakers: ['speaker-1', 'speaker-2'],
            videoSize: { width: 1280, height: 720 },
            segments: [
              { id: 'seg-1', start: 0.0, end: 1.5, speakerId: 'speaker-1', text: 'Good evening.', translatedText: 'សួស្តីពេលល្ងាច។' },
              { id: 'seg-2', start: 1.6, end: 3.1, speakerId: 'speaker-2', text: 'Welcome back.', translatedText: 'សូមស្វាគមន៍ការត្រឡប់មកវិញ។' },
            ],
          };
        },
        translateSegments: async ({ segments }) => ({ segments }),
        burnSubtitles: async payload => {
          burnRequest = payload;
          return new Blob(['ftypmp4'], { type: 'video/mp4' });
        },
      },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: { execute: async () => ({}) },
      lockReferenceAudio: { execute: async file => ({ blob: file }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
    });

    const subNav = dom.container.querySelector('#nav-subtitles');
    await act(async () => { subNav.click(); });

    const subPanel = dom.container.querySelector('.subtitle-workspace');
    assert.equal(subPanel.hasAttribute('hidden'), false);
    const langSelect = subPanel.querySelector('#subtitle-source-lang');
    assert.equal(langSelect.value, 'km');
    assert.equal(langSelect.options.length, 101);
    const initialAutoTranslate = subPanel.querySelector('#subtitle-auto-translate');
    assert.ok(initialAutoTranslate);
    assert.equal(initialAutoTranslate.checked, false);
    assert.equal(subPanel.querySelector('#subtitle-target-lang'), null);

    await act(async () => {
      langSelect.value = 'en';
      langSelect.dispatchEvent({ type: 'change', bubbles: true, target: langSelect });
    });
    assert.equal(subPanel.querySelector('#subtitle-auto-translate').checked, true);
    const targetLangSelect = subPanel.querySelector('#subtitle-target-lang');
    assert.ok(targetLangSelect);
    assert.equal(targetLangSelect.value, 'khm_Khmr');
    assert.equal(targetLangSelect.options.length, 202);

    const fileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4bytes'], 'news-clip.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });

    const extractBtn = dom.container.querySelector('#subtitle-extract-btn');
    await act(async () => { extractBtn.click(); });

    const rows = dom.container.querySelectorAll('.subtitle-segment-row');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelectorAll('textarea').length, 1);
    assert.ok(dom.container.querySelector('track'));

    const renameInput = dom.container.querySelector('.subtitle-roster-input');
    await act(async () => {
      renameInput._value = 'ពិធីករ';
      renameInput.dispatchEvent({ type: 'input', bubbles: true, target: renameInput });
    });

    await act(async () => { subPanel.querySelector('#subtitle-export-project-btn').click(); });
    const burnDialog = subPanel.querySelector('#export-project-dialog');
    await act(async () => { burnDialog.querySelector('#export-preset-btn-video_burned_mp4').click(); });
    assert.ok(burnRequest);
    assert.equal(burnRequest.speakerNames['speaker-1'], 'ពិធីករ');
    assert.equal(burnRequest.useTranslation, true);
    await act(async () => { burnDialog.querySelector('#export-project-close-btn').click(); });

    const sendTtsBtn = dom.container.querySelector('#subtitle-send-tts-btn');
    await act(async () => { sendTtsBtn.click(); });

    assert.equal(subPanel.hasAttribute('hidden'), true);
    assert.equal(dom.container.querySelector('#script').value, 'សួស្តីពេលល្ងាច។ សូមស្វាគមន៍ការត្រឡប់មកវិញ។');

    // Verify Sidebar contains only Text to speech and Video to subtitle, while Character library lives inside TTS Voice pane
    const sidebar = dom.container.querySelector('.studio-sidebar');
    assert.equal(sidebar.querySelector('#open-voice-library'), null);
    assert.equal(subPanel.querySelector('#open-voice-library'), null);
    const charBtn = dom.container.querySelector('.voice-inspector').querySelector('#open-voice-library');
    assert.ok(charBtn);

    await act(async () => { charBtn.click(); });
    const dialog = dom.container.querySelector('#voice-library');
    assert.equal(dialog.open, true);

    const useButtons = dialog.querySelectorAll('.library-use');
    assert.ok(useButtons.length >= 2);
    await act(async () => { useButtons[1].click(); });
    assert.equal(dialog.open, false);
    assert.notEqual(dom.container.querySelector('#character-select').value, 'char-nisa');

    await act(async () => { dom.container.querySelector('#new-character-button').click(); });
    assert.equal(dialog.open, true);
    assert.ok(dialog.querySelector('#save-voice-name'));
    await act(async () => { dialog.querySelector('#close-voice-library').click(); });
    assert.equal(dialog.open, false);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted Studio handles speaker ON/OFF, audio-only burn guard, playback sync, cue edits, find-replace, and toast+sound cues across TTS & subtitles', async () => {
  const dom = createDomShim();
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
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    const soundEvents = [];
    let muted = false;
    let transcribeCalls = [];
    let shouldFailTranscribe = false;
    let shouldFailTts = false;

    const services = {
      speechGateway: {
        checkAvailability: async () => true,
        checkHealth: async () => ({ online: true, detail: null }),
        uploadReferenceAudio: async () => ({}),
        synthesize: async () => ({}),
      },
      notificationSound: {
        isMuted: () => muted,
        setMuted: next => { muted = Boolean(next); return muted; },
        unlock: () => soundEvents.push('unlock'),
        play: async kind => {
          if (muted) return false;
          soundEvents.push(`play:${kind}`);
          return true;
        },
      },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true }),
        transcribeVideo: async params => {
          transcribeCalls.push({
            name: params.file.name,
            diarize: params.diarize,
            numSpeakers: params.numSpeakers,
          });
          if (shouldFailTranscribe) throw new Error('Whisper crashed');
          if (!params.diarize) {
            return {
              jobId: '1111222233334444',
              language: 'km',
              isAudioOnly: params.file.name.endsWith('.mp3'),
              speakers: ['speaker-1'],
              videoSize: params.file.name.endsWith('.mp3') ? null : { width: 1080, height: 1920 },
              segments: [
                { id: 'seg-1', start: 0.0, end: 2.0, speakerId: 'speaker-1', text: 'សួស្តី មិត្តភក្តិ', translatedText: '' },
                { id: 'seg-2', start: 2.2, end: 4.5, speakerId: 'speaker-1', text: 'សូមស្វាគមន៍ មិត្តភក្តិ', translatedText: '' },
              ],
            };
          }
          return {
            jobId: '5555666677778888',
            language: 'en',
            isAudioOnly: false,
            speakers: ['speaker-1', 'speaker-2'],
            videoSize: { width: 1920, height: 1080 },
            segments: [
              { id: 'seg-1', start: 0.0, end: 1.5, speakerId: 'speaker-1', text: 'Hello host.', translatedText: 'សួស្តី ពិធីករ។' },
              { id: 'seg-2', start: 1.6, end: 3.5, speakerId: 'speaker-2', text: 'Hello guest.', translatedText: 'សួស្តី ភ្ញៀវ។' },
            ],
          };
        },
        translateSegments: async ({ segments }) => ({ segments }),
        burnSubtitles: async () => new Blob(['ftypmp4'], { type: 'video/mp4' }),
      },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: {
        execute: async ({ script }) => {
          if (shouldFailTts) throw new Error('TTS timeout');
          return {
            recording: { id: 'take-1', seed: 42, characterId: 'char-nisa', characterName: 'Nisa', transcript: script, blob: new Blob(['RIFF']), audioDurationSeconds: 1.0, elapsedMs: 120, sizeBytes: 100 },
            uploadedFileData: null,
          };
        },
      },
      lockReferenceAudio: { execute: async file => ({ blob: file }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
    });

    const findToast = kindClass =>
      dom.container.querySelectorAll('.studio-toast').find(el => String(el.className || '').includes(kindClass));

    // 1. TTS generation success triggers popup toast + success sound cue
    const scriptInput = dom.container.querySelector('#script');
    await act(async () => {
      scriptInput._value = 'សួស្តីអ្នកទាំងអស់គ្នា';
      scriptInput.dispatchEvent({ type: 'input', bubbles: true, target: scriptInput });
    });
    await act(async () => {
      dom.container.querySelector('#speech-form').dispatchEvent({ type: 'submit', bubbles: true });
      await new Promise(r => setTimeout(r, 15));
    });
    assert.ok(dom.container.querySelector('#studio-toast-region'));
    assert.ok(findToast('is-success'));
    assert.ok(soundEvents.includes('unlock'));
    assert.ok(soundEvents.includes('play:success'));

    // Dismiss toast cleanly
    await act(async () => {
      dom.container.querySelector('.studio-toast-dismiss').click();
    });
    assert.equal(dom.container.querySelector('#studio-toast-region'), null);

    // 2. TTS failure triggers error toast + error sound cue
    shouldFailTts = true;
    await act(async () => {
      dom.container.querySelector('#speech-form').dispatchEvent({ type: 'submit', bubbles: true });
      await new Promise(r => setTimeout(r, 15));
    });
    assert.ok(findToast('is-error'));
    assert.ok(soundEvents.includes('play:error'));

    // 3. Switch to Video to subtitle: speaker detection starts OFF, Video language uses 1-col full width, and clicking label text never toggles switches
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });
    const subPanel = dom.container.querySelector('.subtitle-workspace');
    const optionGrid = subPanel.querySelector('.subtitle-option-grid');
    const detectToggle = subPanel.querySelector('#subtitle-detect-speakers');
    const detectLabel = subPanel.querySelector('#subtitle-detect-speakers-label');
    const detectRow = detectToggle.parentNode;
    assert.equal(optionGrid.getAttribute('data-columns'), '1');
    assert.equal(detectToggle.checked, false);
    assert.equal(detectToggle.getAttribute('role'), 'switch');
    assert.equal(detectToggle.getAttribute('aria-labelledby'), 'subtitle-detect-speakers-label');
    assert.notEqual(detectRow.tagName, 'LABEL');
    assert.equal(detectLabel.tagName, 'SPAN');
    assert.equal(subPanel.querySelectorAll('label').some(el => el.getAttribute('for') === 'subtitle-detect-speakers'), false);
    assert.equal(subPanel.querySelector('#subtitle-speaker-count').parentNode.parentNode.hasAttribute('hidden'), true);
    assert.equal(subPanel.querySelector('#subtitle-include-speaker').parentNode.hasAttribute('hidden'), true);

    await act(async () => {
      detectLabel.click();
      detectRow.click();
    });
    assert.equal(detectToggle.checked, false);
    assert.equal(optionGrid.getAttribute('data-columns'), '1');

    // Upload audio-only .mp3 -> diarize=false, single speaker hidden, burn button disabled
    const fileInput = subPanel.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp3'], 'podcast.mp3', { type: 'audio/mpeg' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });
    assert.equal(transcribeCalls.at(-1).diarize, false);
    assert.equal(subPanel.querySelector('.subtitle-roster'), null);
    assert.equal(subPanel.querySelector('.subtitle-speaker-badge'), null);
    await act(async () => { subPanel.querySelector('#subtitle-export-project-btn').click(); });
    const audioOnlyDialog = subPanel.querySelector('#export-project-dialog');
    const audioOnlyBurnBtn = audioOnlyDialog.querySelector('#export-preset-btn-video_burned_mp4');
    assert.equal(audioOnlyBurnBtn.disabled || audioOnlyBurnBtn.hasAttribute('disabled'), true);
    await act(async () => { audioOnlyDialog.querySelector('#export-project-close-btn').click(); });

    // Playback sync highlights matching active cue row
    const videoEl = subPanel.querySelector('video');
    await act(async () => {
      videoEl.currentTime = 2.8;
      videoEl.dispatchEvent({ type: 'timeupdate', currentTarget: videoEl });
    });
    const activeRows = subPanel.querySelectorAll('.subtitle-segment-row');
    assert.equal(activeRows[0].className.includes('is-active'), false);
    assert.equal(activeRows[1].className.includes('is-active'), true);

    // Inline timing editor opens and adjusts cue timestamps
    const firstTimeBtn = subPanel.querySelectorAll('button').find(b => b.textContent.includes('Time'));
    await act(async () => { firstTimeBtn.click(); });
    assert.ok(subPanel.querySelector('.subtitle-timing-bar'));
    await act(async () => {
      subPanel.querySelectorAll('.subtitle-nudge-btn')[1].click();
    });
    assert.match(subPanel.querySelector('.subtitle-time-jump').textContent, /00:00 - 00:02/);

    // Find & replace updates all matching segments cleanly
    await act(async () => { subPanel.querySelector('#subtitle-find-toggle').click(); });
    const findInput = subPanel.querySelector('#subtitle-find-input');
    const replaceInput = subPanel.querySelector('#subtitle-replace-input');
    await act(async () => {
      findInput._value = 'មិត្តភក្តិ';
      findInput.dispatchEvent({ type: 'input', bubbles: true, target: findInput });
      replaceInput._value = 'បងប្អូន';
      replaceInput.dispatchEvent({ type: 'input', bubbles: true, target: replaceInput });
    });
    await act(async () => {
      subPanel.querySelector('.subtitle-find-bar').dispatchEvent({ type: 'submit', bubbles: true });
    });
    assert.match(subPanel.querySelectorAll('textarea')[0].value, /បងប្អូន/);
    assert.match(subPanel.querySelectorAll('textarea')[1].value, /បងប្អូន/);

    // Split + Merge + Delete edit operations work on segments
    const firstSplit = subPanel.querySelectorAll('button').find(b => b.textContent.includes('Split'));
    await act(async () => { firstSplit.click(); });
    assert.equal(subPanel.querySelectorAll('.subtitle-segment-row').length, 3);

    const firstMerge = subPanel.querySelectorAll('button').find(b => b.textContent.includes('Merge'));
    await act(async () => { firstMerge.click(); });
    assert.equal(subPanel.querySelectorAll('.subtitle-segment-row').length, 2);

    const firstDelete = subPanel.querySelector('.subtitle-cue-delete');
    await act(async () => { firstDelete.click(); });
    assert.equal(subPanel.querySelectorAll('.subtitle-segment-row').length, 1);

    // 4. Turn speaker detection ON, switch to portrait/landscape video -> expands option grid to 2 columns, resets videoSize cleanly, sends diarize=true, filters TTS speaker
    await act(async () => {
      detectToggle.checked = true;
      detectToggle.dispatchEvent({ type: 'click', bubbles: true, target: detectToggle });
    });
    assert.equal(detectToggle.checked, true);
    assert.equal(optionGrid.getAttribute('data-columns'), '2');
    assert.equal(subPanel.querySelector('#subtitle-speaker-count').parentNode.parentNode.hasAttribute('hidden'), false);
    const includeSpeakerToggle = subPanel.querySelector('#subtitle-include-speaker');
    const includeSpeakerLabel = subPanel.querySelector('#subtitle-include-speaker-label');
    const includeSpeakerRow = includeSpeakerToggle.parentNode;
    assert.equal(includeSpeakerRow.hasAttribute('hidden'), false);
    assert.notEqual(includeSpeakerRow.tagName, 'LABEL');
    assert.equal(includeSpeakerLabel.tagName, 'SPAN');
    assert.equal(includeSpeakerToggle.getAttribute('role'), 'switch');
    assert.equal(includeSpeakerToggle.getAttribute('aria-labelledby'), 'subtitle-include-speaker-label');
    assert.equal(subPanel.querySelectorAll('label').some(el => el.getAttribute('for') === 'subtitle-include-speaker'), false);
    await act(async () => {
      includeSpeakerLabel.click();
      includeSpeakerRow.click();
    });
    assert.equal(includeSpeakerToggle.checked, false);

    await act(async () => {
      fileInput.files = [new File(['mp4'], 'interview.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    assert.ok(subPanel.querySelector('#subtitle-style-position'));
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });
    assert.equal(transcribeCalls.at(-1).diarize, true);
    assert.equal(subPanel.querySelectorAll('.subtitle-speaker-badge').length, 2);

    const ttsSpeakerSel = subPanel.querySelector('#subtitle-tts-speaker');
    assert.ok(ttsSpeakerSel);
    await act(async () => {
      ttsSpeakerSel.value = 'speaker-2';
      ttsSpeakerSel.dispatchEvent({ type: 'change', bubbles: true, target: ttsSpeakerSel });
    });
    await act(async () => { subPanel.querySelector('#subtitle-send-tts-btn').click(); });
    assert.equal(dom.container.querySelector('#script').value, 'Hello guest.');

    // 5. Mute toggle suppresses audio cues while still displaying error popup on failed extraction
    const muteBtn = dom.container.querySelector('#notification-sound-toggle');
    await act(async () => { muteBtn.click(); });
    assert.equal(muted, true);
    const prevPlayCount = soundEvents.filter(e => e.startsWith('play:')).length;

    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });
    shouldFailTranscribe = true;
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });
    assert.equal(soundEvents.filter(e => e.startsWith('play:')).length, prevPlayCount);
    assert.match(findToast('is-error').textContent, /Whisper crashed/);

    // 6. Selecting a new file after portrait extraction resets videoSize (data-orientation reverts to landscape)
    shouldFailTranscribe = false;
    await act(async () => {
      detectToggle.checked = false;
      detectToggle.dispatchEvent({ type: 'click', bubbles: true, target: detectToggle });
      fileInput.files = [new File(['mp4'], 'portrait.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });
    assert.equal(subPanel.querySelector('.subtitle-video-frame').getAttribute('data-orientation'), 'portrait');

    await act(async () => {
      fileInput.files = [new File(['mp4'], 'next.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    assert.equal(subPanel.querySelector('.subtitle-video-frame').getAttribute('data-orientation'), 'landscape');

    // 7. Cancelling an in-flight extraction emits neither an error toast nor an error sound
    while (dom.container.querySelector('.studio-toast-dismiss')) {
      await act(async () => { dom.container.querySelector('.studio-toast-dismiss').click(); });
    }
    const prevErrPlays = soundEvents.filter(e => e === 'play:error').length;
    services.mediaSubtitleGateway.transcribeVideo = async ({ signal }) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('Subtitle extraction cancelled.');
          err.name = 'SynthesisCancelledError';
          reject(err);
        });
      });
    };
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });
    assert.ok(subPanel.querySelector('#subtitle-cancel-btn'));
    assert.equal(detectRow.getAttribute('data-disabled'), 'true');
    assert.equal(detectToggle.hasAttribute('disabled') || detectToggle.disabled, true);
    await act(async () => { subPanel.querySelector('#subtitle-cancel-btn').click(); });
    assert.equal(detectRow.getAttribute('data-disabled'), null);
    assert.equal(detectToggle.hasAttribute('disabled') || Boolean(detectToggle.disabled), false);
    assert.equal(Boolean(findToast('is-error')), false);
    assert.equal(soundEvents.filter(e => e === 'play:error').length, prevErrPlays);
    assert.match(subPanel.querySelector('.status').textContent, /Subtitle extraction cancelled/);

    // 8. Turning Detect speakers ON -> Show speaker names ON -> Detect speakers OFF resets hidden includeSpeaker so Speaker 1 never leaks
    await act(async () => { muteBtn.click(); });
    services.mediaSubtitleGateway.transcribeVideo = async params => {
      transcribeCalls.push({ name: params.file.name, diarize: params.diarize, numSpeakers: params.numSpeakers });
      return {
        jobId: '9999000011112222',
        language: 'km',
        isAudioOnly: false,
        speakers: ['speaker-1'],
        videoSize: { width: 1280, height: 720 },
        segments: [
          { id: 'seg-1', start: 0.1, end: 2.0, speakerId: 'speaker-1', text: 'សួស្តី កំពុងសាកល្បង', translatedText: '' },
        ],
      };
    };
    let capturedBurnIncludeSpeaker = null;
    services.mediaSubtitleGateway.burnSubtitles = async payload => {
      capturedBurnIncludeSpeaker = payload.includeSpeaker;
      return new Blob(['ftypmp4'], { type: 'video/mp4' });
    };

    await act(async () => {
      detectToggle.checked = true;
      detectToggle.dispatchEvent({ type: 'click', bubbles: true, target: detectToggle });
    });
    const showSpeakerToggle = subPanel.querySelector('#subtitle-include-speaker');
    await act(async () => {
      showSpeakerToggle.checked = true;
      showSpeakerToggle.dispatchEvent({ type: 'click', bubbles: true, target: showSpeakerToggle });
    });
    assert.equal(showSpeakerToggle.checked, true);

    await act(async () => {
      detectToggle.checked = false;
      detectToggle.dispatchEvent({ type: 'click', bubbles: true, target: detectToggle });
    });
    assert.equal(showSpeakerToggle.checked, false);
    assert.equal(optionGrid.getAttribute('data-columns'), '1');

    await act(async () => {
      fileInput.files = [new File(['mp4'], 'solo.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });
    await act(async () => { subPanel.querySelector('#subtitle-export-project-btn').click(); });
    const soloDialog = subPanel.querySelector('#export-project-dialog');
    await act(async () => { soloDialog.querySelector('#export-preset-btn-video_burned_mp4').click(); });
    assert.equal(capturedBurnIncludeSpeaker, false);
    await act(async () => { soloDialog.querySelector('#export-project-close-btn').click(); });

    // 9. Find & replace live match count + safe $ replacement + left-nudge duration preservation
    if (!subPanel.querySelector('#subtitle-find-input')) {
      await act(async () => { subPanel.querySelector('#subtitle-find-toggle').click(); });
    }
    const fInput = subPanel.querySelector('#subtitle-find-input');
    const rInput = subPanel.querySelector('#subtitle-replace-input');
    await act(async () => {
      fInput._value = 'សួស្តី';
      fInput.dispatchEvent({ type: 'input', bubbles: true, target: fInput });
    });
    assert.match(subPanel.querySelector('.subtitle-find-count').textContent, /1 match/);
    await act(async () => {
      rInput._value = '$& ១';
      rInput.dispatchEvent({ type: 'input', bubbles: true, target: rInput });
    });
    await act(async () => {
      subPanel.querySelector('.subtitle-find-bar').dispatchEvent({ type: 'submit', bubbles: true });
    });
    assert.equal(subPanel.querySelector('.subtitle-line-input').value, '$& ១ កំពុងសាកល្បង');
    assert.match(subPanel.querySelector('.subtitle-find-count').textContent, /Replaced 1/);

    const timeToggleBtn = subPanel.querySelectorAll('button').find(b => b.textContent.includes('Time'));
    await act(async () => { timeToggleBtn.click(); });
    await act(async () => { subPanel.querySelectorAll('.subtitle-nudge-btn')[0].click(); });
    const timingInputs = subPanel.querySelectorAll('.subtitle-timing-input');
    assert.equal(timingInputs[0].value, '00:00.0');
    assert.equal(timingInputs[1].value, '00:01.9');

    // 10. Single giant segment (>2,000 chars) shows accurate single-segment trim toast and bounds TTS script
    services.mediaSubtitleGateway.transcribeVideo = async () => ({
      jobId: 'aaabbbcccdddeeee',
      language: 'km',
      isAudioOnly: false,
      speakers: ['speaker-1'],
      videoSize: { width: 1280, height: 720 },
      segments: [{ id: 'seg-big', start: 0, end: 5, speakerId: 'speaker-1', text: 'ក'.repeat(2500), translatedText: '' }],
    });
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'long.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });
    await act(async () => { subPanel.querySelector('#subtitle-send-tts-btn').click(); });
    assert.equal(dom.container.querySelector('#script').value.length, 2000);
    assert.match(dom.container.querySelectorAll('.studio-toast').at(-1).textContent, /2,000-character TTS limit/);

    // 11. Detect speakers ON + Show speaker names ON + 1 speaker extracted shows SpeakerRosterCard for renaming
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });
    services.mediaSubtitleGateway.transcribeVideo = async () => ({
      jobId: '1234567890abcdef',
      language: 'km',
      isAudioOnly: false,
      speakers: ['speaker-1'],
      videoSize: { width: 1280, height: 720 },
      segments: [{ id: 'seg-solo', start: 1.0, end: 2.0, speakerId: 'speaker-1', text: 'សួស្តី ពិភពលោក', translatedText: '' }],
    });
    let soloBurnPayload = null;
    services.mediaSubtitleGateway.burnSubtitles = async payload => {
      soloBurnPayload = payload;
      return new Blob(['ftypmp4'], { type: 'video/mp4' });
    };
    await act(async () => {
      detectToggle.checked = true;
      detectToggle.dispatchEvent({ type: 'click', bubbles: true, target: detectToggle });
    });
    await act(async () => {
      showSpeakerToggle.checked = true;
      showSpeakerToggle.dispatchEvent({ type: 'click', bubbles: true, target: showSpeakerToggle });
    });
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'monologue.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });
    const soloRosterInput = subPanel.querySelector('.subtitle-roster-input');
    assert.ok(soloRosterInput);
    await act(async () => {
      soloRosterInput._value = 'អ្នកអត្ថាធិប្បាយ';
      soloRosterInput.dispatchEvent({ type: 'input', bubbles: true, target: soloRosterInput });
    });
    await act(async () => { subPanel.querySelector('#subtitle-export-project-btn').click(); });
    const rosterBurnDialog = subPanel.querySelector('#export-project-dialog');
    const includeSpeakerBox = rosterBurnDialog.querySelector('#export-include-speaker');
    assert.equal(includeSpeakerBox.checked, true);
    await act(async () => { rosterBurnDialog.querySelector('#export-preset-btn-video_burned_mp4').click(); });
    assert.equal(soloBurnPayload.includeSpeaker, true);
    assert.equal(soloBurnPayload.speakerNames['speaker-1'], 'អ្នកអត្ថាធិប្បាយ');
    await act(async () => { rosterBurnDialog.querySelector('#export-project-close-btn').click(); });

    await act(async () => {
      showSpeakerToggle.checked = false;
      showSpeakerToggle.dispatchEvent({ type: 'click', bubbles: true, target: showSpeakerToggle });
    });
    assert.equal(subPanel.querySelector('.subtitle-roster'), null);

    // 12. TimingInlineEditor normalizes equivalent numeric input ('00:01.00' -> '00:01.0'), clamps invalid short end, and cancels on Escape
    const soloTimeBtn = subPanel.querySelectorAll('button').find(b => b.textContent.includes('Time'));
    await act(async () => { soloTimeBtn.click(); });
    const [startInput, endInput] = subPanel.querySelectorAll('.subtitle-timing-input');
    assert.equal(startInput.value, '00:01.0');
    assert.equal(endInput.value, '00:02.0');

    await act(async () => {
      startInput.focus();
      startInput._value = '00:01.00';
      startInput.dispatchEvent({ type: 'input', bubbles: true, target: startInput });
    });
    await act(async () => {
      startInput.blur();
    });
    assert.equal(startInput.value, '00:01.0');

    await act(async () => {
      endInput.focus();
      endInput._value = '00:02.000';
      endInput.dispatchEvent({ type: 'input', bubbles: true, target: endInput });
    });
    await act(async () => {
      endInput.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, target: endInput });
    });
    assert.equal(endInput.value, '00:02.0');

    await act(async () => {
      endInput.focus();
      endInput._value = '00:00.2';
      endInput.dispatchEvent({ type: 'input', bubbles: true, target: endInput });
    });
    await act(async () => {
      endInput.blur();
    });
    assert.equal(endInput.value, '00:01.1');

    await act(async () => {
      startInput.focus();
      startInput._value = '00:09.0';
      startInput.dispatchEvent({ type: 'input', bubbles: true, target: startInput });
    });
    await act(async () => {
      startInput.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true, target: startInput });
    });
    assert.equal(startInput.value, '00:01.0');
    assert.equal(endInput.value, '00:01.1');
    assert.match(subPanel.querySelector('.subtitle-time-jump').textContent, /00:01 - 00:01/);

    // 13. Export guard blocks empty/whitespace-only SRT, VTT, TXT downloads and surfaces error status
    const cueTextarea = subPanel.querySelector('.subtitle-line-input');
    await act(async () => {
      cueTextarea._value = '   \n  ';
      cueTextarea.dispatchEvent({ type: 'input', bubbles: true, target: cueTextarea });
    });
    const origCreateObjectURL = URL.createObjectURL;
    let exportBlobCalls = 0;
    URL.createObjectURL = blob => {
      exportBlobCalls += 1;
      return origCreateObjectURL(blob);
    };
    try {
      await act(async () => { subPanel.querySelector('#subtitle-export-project-btn').click(); });
      const emptyExportDlg = subPanel.querySelector('#export-project-dialog');
      for (const presetId of ['subtitle_srt', 'subtitle_vtt', 'subtitle_txt']) {
        const btn = emptyExportDlg.querySelector(`#export-preset-btn-${presetId}`);
        assert.equal(Boolean(btn.disabled || btn.hasAttribute('disabled')), true);
        assert.equal(exportBlobCalls, 0);
      }
      assert.match(emptyExportDlg.textContent, /Add or transcribe at least one subtitle cue before exporting/);
      await act(async () => { emptyExportDlg.querySelector('#export-project-close-btn').click(); });
      const copyBtn = subPanel.querySelectorAll('button').find(b => b.getAttribute('aria-label') === 'Copy dialogue');
      await act(async () => { copyBtn.click(); });
      const copyStatusEl = subPanel.querySelector('.status');
      assert.ok(copyStatusEl.className.includes('is-error'));
      assert.match(copyStatusEl.textContent, /No subtitle text to copy/);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
    }
    // 14. Translated-mode textarea stays empty when cleared (never snaps original text back) and preserves sub-tenth ASR timing on untouched blur
    services.mediaSubtitleGateway.transcribeVideo = async () => ({
      jobId: 'fedcba9876543210',
      language: 'en',
      isAudioOnly: false,
      speakers: ['speaker-1'],
      videoSize: { width: 1280, height: 720 },
      segments: [
        { id: 'seg-a', start: 0.123, end: 2.456, speakerId: 'speaker-1', text: 'Good evening.', translatedText: 'សួស្តីពេលល្ងាច។' },
        { id: 'seg-b', start: 3.0, end: 5.0, speakerId: 'speaker-1', text: 'Stay tuned.', translatedText: 'សូមរង់ចាំទស្សនា។' },
      ],
    });
    let precisionBurnPayload = null;
    services.mediaSubtitleGateway.burnSubtitles = async payload => {
      precisionBurnPayload = payload;
      return new Blob(['ftypmp4'], { type: 'video/mp4' });
    };
    const langSel = subPanel.querySelector('#subtitle-source-lang');
    await act(async () => {
      langSel.value = 'en';
      langSel.dispatchEvent({ type: 'change', bubbles: true, target: langSel });
    });
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'precision.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });

    const trTextarea = subPanel.querySelectorAll('.subtitle-line-input')[0];
    await act(async () => {
      trTextarea._value = '';
      trTextarea.dispatchEvent({ type: 'input', bubbles: true, target: trTextarea });
    });
    assert.equal(subPanel.querySelectorAll('.subtitle-line-input')[0].value, '');
    assert.match(subPanel.querySelectorAll('.subtitle-source-ref')[0].textContent, /Good evening/);

    const firstRowTimeBtn = subPanel.querySelectorAll('button').find(b => b.textContent.includes('Time'));
    await act(async () => { firstRowTimeBtn.click(); });
    const [pStartInput, pEndInput] = subPanel.querySelectorAll('.subtitle-timing-input');
    // Untouched focus + blur preserves 0.123s precision
    await act(async () => { pStartInput.focus(); });
    await act(async () => { pStartInput.blur(); });
    // Escape on Start does not suppress subsequent End commit
    await act(async () => {
      pStartInput.focus();
      pStartInput._value = '00:08.0';
      pStartInput.dispatchEvent({ type: 'input', bubbles: true, target: pStartInput });
    });
    await act(async () => {
      pStartInput.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true, target: pStartInput });
    });
    await act(async () => {
      pEndInput.focus();
      pEndInput._value = '00:02.7';
      pEndInput.dispatchEvent({ type: 'input', bubbles: true, target: pEndInput });
    });
    await act(async () => { pEndInput.blur(); });
    await act(async () => { subPanel.querySelector('#subtitle-export-project-btn').click(); });
    const precisionDialog = subPanel.querySelector('#export-project-dialog');
    await act(async () => { precisionDialog.querySelector('#export-preset-btn-video_burned_mp4').click(); });
    assert.equal(precisionBurnPayload.segments[0].start, 0.123);
    assert.equal(precisionBurnPayload.segments[0].end, 2.7);
    await act(async () => { precisionDialog.querySelector('#export-project-close-btn').click(); });
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('VideoSubtitleWorkspace polls while offline, clears offline state on action success, debounces <track> VTT preview, sets track.mode=showing, and disables burn on blank cues', async () => {
  const dom = createDomShim();
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });

  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;
  const intervalCallbacks = new Map();
  let intervalSeq = 0;
  globalThis.setInterval = fn => {
    const id = ++intervalSeq;
    intervalCallbacks.set(id, fn);
    return id;
  };
  globalThis.clearInterval = id => {
    intervalCallbacks.delete(id);
  };

  let createdVtts = [];
  let revokedUrls = [];
  let blobId = 0;
  URL.createObjectURL = blob => {
    const url = `blob:vtt/${++blobId}`;
    if (String(blob?.type || '').includes('text/vtt')) createdVtts.push({ url, blob });
    return url;
  };
  URL.revokeObjectURL = url => {
    revokedUrls.push(url);
  };

  let root;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');

    let healthState = { online: false, reason: 'Cannot reach local video subtitle service on port 8810.' };
    let healthChecks = 0;
    const services = {
      speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
      mediaSubtitleGateway: {
        checkHealth: async () => {
          healthChecks += 1;
          return { ...healthState };
        },
        transcribeVideo: async () => ({
          jobId: '0123456789abcdef',
          language: 'en',
          isAudioOnly: false,
          speakers: ['speaker-1'],
          videoSize: { width: 1280, height: 720 },
          segments: [{ id: 'seg-1', start: 0, end: 2, speakerId: 'speaker-1', text: 'First line', translatedText: '' }],
        }),
        translateSegments: async ({ segments }) => ({
          segments: segments.map(s => ({ ...s, translatedText: 'បន្ទាត់ដំបូង' })),
        }),
        burnSubtitles: async () => new Blob(['ftypmp4'], { type: 'video/mp4' }),
      },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: { execute: async () => ({}) },
      lockReferenceAudio: { execute: async f => ({ blob: f }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { notices: null })));
      await new Promise(r => setTimeout(r, 15));
    });

    // 1. Offline banner shown on mount & polling interval registered while offline
    assert.ok(dom.container.querySelector('.engine-alert-popup'));
    assert.equal(intervalCallbacks.size, 1);
    const pollFn = Array.from(intervalCallbacks.values())[0];

    // Polling recovers online automatically and stops the offline interval
    healthState = { online: true, burnInSupported: true, diarizationReady: true };
    const checksBeforePoll = healthChecks;
    await act(async () => {
      pollFn();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(healthChecks, checksBeforePoll + 1);
    assert.equal(dom.container.querySelector('.engine-alert-popup'), null);
    assert.equal(intervalCallbacks.size, 0);

    // Force offline again via Refresh -> successful extractSubtitles clears offline banner immediately
    healthState = { online: false, reason: 'Temporarily offline' };
    // Trigger failed extraction to invoke refreshHealth() -> surfaces offline banner
    const origTranscribe = services.mediaSubtitleGateway.transcribeVideo;
    services.mediaSubtitleGateway.transcribeVideo = async () => { throw new Error('Network error'); };
    const fileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => {
      dom.container.querySelector('#subtitle-extract-btn').click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.ok(dom.container.querySelector('.engine-alert-popup'));
    assert.equal(intervalCallbacks.size, 1);

    // Even if checkHealth still returned offline, successful extractSubtitles clears offline state
    services.mediaSubtitleGateway.transcribeVideo = origTranscribe;
    await act(async () => {
      dom.container.querySelector('#subtitle-extract-btn').click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(dom.container.querySelector('.engine-alert-popup'), null);
    assert.equal(intervalCallbacks.size, 0);

    // 2. Programmatic track.mode === 'showing', debounced VTT updates without replacing <track>, and immediate clear on empty
    const trackEl = dom.container.querySelector('track');
    assert.ok(trackEl);
    assert.equal(trackEl.track.mode, 'showing');
    assert.equal(createdVtts.length, 1);

    const textarea = dom.container.querySelector('.subtitle-line-input');
    const isBurnDisabledInModal = async () => {
      await act(async () => { dom.container.querySelector('#subtitle-export-project-btn').click(); });
      const dlg = dom.container.querySelector('#export-project-dialog');
      const btn = dlg.querySelector('#export-preset-btn-video_burned_mp4');
      const disabled = Boolean(btn.disabled || btn.hasAttribute('disabled'));
      await act(async () => { dlg.querySelector('#export-project-close-btn').click(); });
      return disabled;
    };
    assert.equal(await isBurnDisabledInModal(), false);

    // Rapid edits within 200ms do NOT regenerate VTT synchronously on every keystroke
    await act(async () => {
      textarea._value = 'Edited one';
      textarea.dispatchEvent({ type: 'input', bubbles: true, target: textarea });
    });
    await act(async () => {
      textarea._value = 'Edited two';
      textarea.dispatchEvent({ type: 'input', bubbles: true, target: textarea });
    });
    assert.equal(createdVtts.length, 1);
    assert.equal(dom.container.querySelector('track'), trackEl);

    // After ~240ms debounce settles, VTT regenerates once and preserves track.mode === 'showing'
    await act(async () => {
      await new Promise(r => setTimeout(r, 240));
    });
    assert.equal(createdVtts.length, 2);
    assert.equal(dom.container.querySelector('track'), trackEl);
    assert.equal(trackEl.track.mode, 'showing');
    const latestVttText = await createdVtts[1].blob.text();
    assert.match(latestVttText, /Edited two/);

    // Clearing text to whitespace immediately removes <track> and disables burned MP4 preset
    await act(async () => {
      textarea._value = '   \n  ';
      textarea.dispatchEvent({ type: 'input', bubbles: true, target: textarea });
    });
    assert.equal(dom.container.querySelector('track'), null);
    assert.equal(await isBurnDisabledInModal(), true);

    // Restoring text re-enables burned MP4 preset and restores <track> with mode === 'showing'
    await act(async () => {
      textarea._value = 'Restored caption';
      textarea.dispatchEvent({ type: 'input', bubbles: true, target: textarea });
    });
    assert.equal(await isBurnDisabledInModal(), false);
    const restoredTrack = dom.container.querySelector('track');
    assert.ok(restoredTrack);
    assert.equal(restoredTrack.track.mode, 'showing');

    // 3. Successful translateNow and burnVideo also clear offline state
    const origTranslate = services.mediaSubtitleGateway.translateSegments;
    services.mediaSubtitleGateway.translateSegments = async () => { throw new Error('502'); };
    const langSel = dom.container.querySelector('#subtitle-source-lang');
    await act(async () => {
      langSel.value = 'en';
      langSel.dispatchEvent({ type: 'change', bubbles: true, target: langSel });
    });
    await act(async () => {
      dom.container.querySelector('#subtitle-translate-btn').click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.ok(dom.container.querySelector('.engine-alert-popup'));

    services.mediaSubtitleGateway.translateSegments = origTranslate;
    await act(async () => {
      dom.container.querySelector('#subtitle-translate-btn').click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(dom.container.querySelector('.engine-alert-popup'), null);

    const origBurn = services.mediaSubtitleGateway.burnSubtitles;
    services.mediaSubtitleGateway.burnSubtitles = async () => { throw new Error('502'); };
    await act(async () => { dom.container.querySelector('#subtitle-export-project-btn').click(); });
    const burnCheckDialog = dom.container.querySelector('#export-project-dialog');
    await act(async () => {
      burnCheckDialog.querySelector('#export-preset-btn-video_burned_mp4').click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.ok(dom.container.querySelector('.engine-alert-popup'));

    services.mediaSubtitleGateway.burnSubtitles = origBurn;
    await act(async () => {
      burnCheckDialog.querySelector('#export-preset-btn-video_burned_mp4').click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(dom.container.querySelector('.engine-alert-popup'), null);
    await act(async () => { burnCheckDialog.querySelector('#export-project-close-btn').click(); });

    // 4. Active <track> src URL is NOT revoked prematurely while still displayed; previous VTT URLs ARE revoked
    const activeTrackSrc = dom.container.querySelector('track').getAttribute('src');
    assert.ok(activeTrackSrc);
    assert.equal(activeTrackSrc, createdVtts.at(-1).url);
    assert.equal(revokedUrls.includes(activeTrackSrc), false);
    assert.ok(createdVtts.length >= 2);
    for (const oldVtt of createdVtts.slice(0, -1)) {
      assert.ok(revokedUrls.includes(oldVtt.url));
    }

    // 5. React.StrictMode double-invocation never leaves <track> pointing to a revoked blob URL
    const strictContainer = globalThis.document.createElement('div');
    globalThis.document.body.appendChild(strictContainer);
    const strictRoot = createRoot(strictContainer);
    try {
      await act(async () => {
        strictRoot.render(
          React.createElement(
            React.StrictMode,
            null,
            React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { notices: null }))
          )
        );
        await new Promise(r => setTimeout(r, 15));
      });
      const strictFileInput = strictContainer.querySelector('#subtitle-video-input');
      await act(async () => {
        strictFileInput.files = [new File(['mp4'], 'strict.mp4', { type: 'video/mp4' })];
        strictFileInput.dispatchEvent({ type: 'change', bubbles: true });
      });
      await act(async () => {
        strictContainer.querySelector('#subtitle-extract-btn').click();
        await new Promise(r => setTimeout(r, 15));
      });
      const strictTrack = strictContainer.querySelector('track');
      assert.ok(strictTrack);
      const strictSrc = strictTrack.getAttribute('src');
      assert.ok(strictSrc);
      assert.equal(revokedUrls.includes(strictSrc), false);
      assert.equal(strictTrack.track.mode, 'showing');
    } finally {
      await act(async () => { strictRoot.unmount(); });
      strictContainer.remove();
    }
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('clearing the only Khmer translation textarea keeps translation mode sticky, preserves English original, and formats singular extract summary', async () => {
  const dom = createDomShim();
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
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    let returnTranslation = true;
    let capturedBurn = null;
    const services = {
      speechGateway: {
        checkAvailability: async () => true,
        checkHealth: async () => ({ online: true, detail: null }),
        uploadReferenceAudio: async () => ({}),
        synthesize: async () => ({}),
      },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true }),
        transcribeVideo: async () => ({
          jobId: 'singlecue12345678',
          language: 'en',
          isAudioOnly: false,
          speakers: ['speaker-1'],
          videoSize: { width: 1280, height: 720 },
          segments: [
            {
              id: 'seg-only',
              start: 0.0,
              end: 2.5,
              speakerId: 'speaker-1',
              text: 'Good evening.',
              translatedText: returnTranslation ? 'សួស្តីពេលល្ងាច។' : '',
            },
          ],
        }),
        translateSegments: async ({ segments }) => ({
          segments: segments.map(s => ({ ...s, translatedText: 'សួស្តីពេលល្ងាចថ្មី។' })),
        }),
        burnSubtitles: async payload => {
          capturedBurn = payload;
          return new Blob(['ftypmp4'], { type: 'video/mp4' });
        },
      },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: { execute: async () => ({}) },
      lockReferenceAudio: { execute: async f => ({ blob: f }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
    });
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });

    const subPanel = dom.container.querySelector('.subtitle-workspace');
    const findPreviewSelect = () =>
      subPanel.querySelectorAll('select').find(el => el.getAttribute('aria-label') === 'Preview language') || null;

    const langSelect = subPanel.querySelector('#subtitle-source-lang');
    await act(async () => {
      langSelect.value = 'en';
      langSelect.dispatchEvent({ type: 'change', bubbles: true, target: langSelect });
    });

    const fileInput = subPanel.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'single-line.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });

    // Singular pluralization in status + toast when exactly 1 segment is extracted
    assert.match(subPanel.querySelector('.status').textContent, /^Extracted 1 subtitle segment in /);
    assert.match(dom.container.querySelector('.studio-toast').textContent, /Extracted 1 subtitle segment in /);

    assert.ok(findPreviewSelect());
    assert.equal(findPreviewSelect().value, 'translated');
    assert.equal(subPanel.querySelector('#subtitle-translate-btn').textContent, 'Re-translate Khmer');
    assert.equal(subPanel.querySelector('track').getAttribute('label'), 'Khmer');

    // Clearing the only cue's Khmer translation to '' must NOT flip out of translation mode
    const textarea = subPanel.querySelector('.subtitle-line-input');
    await act(async () => {
      textarea._value = '';
      textarea.dispatchEvent({ type: 'input', bubbles: true, target: textarea });
    });
    assert.ok(findPreviewSelect());
    assert.equal(findPreviewSelect().value, 'translated');
    assert.equal(subPanel.querySelector('#subtitle-translate-btn').textContent, 'Re-translate Khmer');
    assert.equal(subPanel.querySelector('track').getAttribute('label'), 'Khmer');
    assert.equal(subPanel.querySelector('.subtitle-line-input').value, '');
    assert.equal(subPanel.querySelector('.subtitle-line-input').getAttribute('aria-label'), 'Khmer subtitle translation');
    assert.match(subPanel.querySelector('.subtitle-source-ref').textContent, /Good evening\./);

    // Typing new Khmer text writes into translatedText while preserving English segment.text
    await act(async () => {
      textarea._value = 'សួស្តីកម្ពុជា';
      textarea.dispatchEvent({ type: 'input', bubbles: true, target: textarea });
    });
    assert.equal(subPanel.querySelector('.subtitle-line-input').value, 'សួស្តីកម្ពុជា');
    assert.match(subPanel.querySelector('.subtitle-source-ref').textContent, /Good evening\./);

    await act(async () => {
      findPreviewSelect().value = 'original';
      findPreviewSelect().dispatchEvent({ type: 'change', bubbles: true, target: findPreviewSelect() });
    });
    assert.equal(subPanel.querySelector('.subtitle-line-input').value, 'Good evening.');

    await act(async () => {
      findPreviewSelect().value = 'translated';
      findPreviewSelect().dispatchEvent({ type: 'change', bubbles: true, target: findPreviewSelect() });
    });
    assert.equal(subPanel.querySelector('.subtitle-line-input').value, 'សួស្តីកម្ពុជា');

    // Clear translation to '' and verify burnSubtitles sends translatedText='' while keeping text='Good evening.'
    await act(async () => {
      textarea._value = '';
      textarea.dispatchEvent({ type: 'input', bubbles: true, target: textarea });
    });
    await act(async () => { subPanel.querySelector('#subtitle-export-project-btn').click(); });
    const clearedBurnDialog = subPanel.querySelector('#export-project-dialog');
    await act(async () => { clearedBurnDialog.querySelector('#export-preset-btn-video_burned_mp4').click(); });
    assert.equal(capturedBurn.useTranslation, true);
    assert.equal(capturedBurn.segments[0].text, 'Good evening.');
    assert.equal(capturedBurn.segments[0].translatedText, '');
    await act(async () => { clearedBurnDialog.querySelector('#export-project-close-btn').click(); });

    // Re-extracting without translation resets sticky hasTranslation to false
    returnTranslation = false;
    const autoTranslateToggle = subPanel.querySelector('#subtitle-auto-translate');
    const autoTranslateLabel = subPanel.querySelector('#subtitle-auto-translate-label');
    assert.notEqual(autoTranslateToggle.parentNode.tagName, 'LABEL');
    assert.equal(autoTranslateLabel.tagName, 'SPAN');
    assert.equal(subPanel.querySelectorAll('label').some(el => el.getAttribute('for') === 'subtitle-auto-translate'), false);
    assert.equal(autoTranslateToggle.getAttribute('role'), 'switch');
    assert.equal(autoTranslateToggle.getAttribute('aria-labelledby'), 'subtitle-auto-translate-label');
    await act(async () => { autoTranslateLabel.click(); autoTranslateToggle.parentNode.click(); });
    assert.equal(autoTranslateToggle.checked, true);
    await act(async () => {
      autoTranslateToggle.checked = false;
      autoTranslateToggle.dispatchEvent({ type: 'click', bubbles: true, target: autoTranslateToggle });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });
    assert.equal(findPreviewSelect(), null);
    assert.equal(subPanel.querySelector('#subtitle-translate-btn').textContent, 'Translate to Khmer');

    // Manual translation restores sticky translation mode; clearing textarea again preserves English
    await act(async () => { subPanel.querySelector('#subtitle-translate-btn').click(); });
    assert.ok(findPreviewSelect());
    const translatedArea = subPanel.querySelector('.subtitle-line-input');
    assert.equal(translatedArea.value, 'សួស្តីពេលល្ងាចថ្មី។');
    await act(async () => {
      translatedArea._value = '';
      translatedArea.dispatchEvent({ type: 'input', bubbles: true, target: translatedArea });
    });
    assert.ok(findPreviewSelect());
    await act(async () => {
      translatedArea._value = 'ជំរាបសួរ';
      translatedArea.dispatchEvent({ type: 'input', bubbles: true, target: translatedArea });
    });
    await act(async () => {
      findPreviewSelect().value = 'original';
      findPreviewSelect().dispatchEvent({ type: 'change', bubbles: true, target: findPreviewSelect() });
    });
    assert.equal(subPanel.querySelector('.subtitle-line-input').value, 'Good evening.');

    // Clear workspace and new file load reset sticky translation cleanly
    await act(async () => { subPanel.querySelector('#subtitle-clear-btn').click(); });
    assert.equal(findPreviewSelect(), null);
    assert.equal(subPanel.querySelectorAll('.subtitle-segment-row').length, 0);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('multi-cue Khmer clearing, failed/cancelled re-extract restore, post-clear stale resolve guard, and segment deletion preserve sticky translation semantics', async () => {
  const dom = createDomShim();
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
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');

    let resolveLateTranscribe = null;
    const services = {
      speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true }),
        transcribeVideo: async () => ({
          jobId: 'multicue123456789',
          language: 'en',
          isAudioOnly: false,
          speakers: ['speaker-1'],
          videoSize: { width: 1280, height: 720 },
          segments: [
            { id: 'cue-1', start: 0.0, end: 2.0, speakerId: 'speaker-1', text: 'First line.', translatedText: 'បន្ទាត់ទី១។' },
            { id: 'cue-2', start: 2.1, end: 4.0, speakerId: 'speaker-1', text: 'Second line.', translatedText: 'បន្ទាត់ទី២។' },
          ],
        }),
        translateSegments: async ({ segments }) => ({ segments }),
        burnSubtitles: async () => new Blob(['ftypmp4'], { type: 'video/mp4' }),
      },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: { execute: async () => ({}) },
      lockReferenceAudio: { execute: async f => ({ blob: f }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { notices: null })));
      await new Promise(r => setTimeout(r, 15));
    });

    const findPreviewSelect = () =>
      dom.container.querySelectorAll('select').find(el => el.getAttribute('aria-label') === 'Preview language') || null;
    const langSel = dom.container.querySelector('#subtitle-source-lang');
    await act(async () => {
      langSel.value = 'en';
      langSel.dispatchEvent({ type: 'change', bubbles: true, target: langSel });
    });
    const fileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'multi.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { dom.container.querySelector('#subtitle-extract-btn').click(); });

    // 1. Clearing ALL Khmer translation textareas across 2 cues preserves English originals & translation mode
    let inputs = dom.container.querySelectorAll('.subtitle-line-input');
    assert.equal(inputs.length, 2);
    for (const area of inputs) {
      await act(async () => {
        area._value = '';
        area.dispatchEvent({ type: 'input', bubbles: true, target: area });
      });
    }
    assert.ok(findPreviewSelect());
    assert.equal(findPreviewSelect().value, 'translated');
    assert.equal(dom.container.querySelector('track').getAttribute('label'), 'Khmer');
    assert.equal(dom.container.querySelectorAll('.subtitle-source-ref')[0].textContent, 'First line.');
    assert.equal(dom.container.querySelectorAll('.subtitle-source-ref')[1].textContent, 'Second line.');

    // 2. Deleting 1 of 2 cues while remaining cue has empty translatedText keeps hasTranslation sticky
    await act(async () => { dom.container.querySelector('.subtitle-cue-delete').click(); });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 1);
    assert.ok(findPreviewSelect());
    assert.equal(dom.container.querySelector('.subtitle-line-input').getAttribute('aria-label'), 'Khmer subtitle translation');

    // Typing new Khmer writes into translatedText while keeping English original intact
    const remainingArea = dom.container.querySelector('.subtitle-line-input');
    await act(async () => {
      remainingArea._value = 'ជួរទី២ថ្មី';
      remainingArea.dispatchEvent({ type: 'input', bubbles: true, target: remainingArea });
    });
    assert.equal(dom.container.querySelector('.subtitle-source-ref').textContent, 'Second line.');

    // 3. Failed re-extraction restores sticky hasTranslation when prior segments remain
    services.mediaSubtitleGateway.transcribeVideo = () => Promise.reject(new Error('503 offline'));
    await act(async () => { dom.container.querySelector('#subtitle-extract-btn').click(); });
    assert.ok(findPreviewSelect());
    assert.equal(findPreviewSelect().value, 'translated');
    assert.equal(dom.container.querySelector('.subtitle-line-input').value, 'ជួរទី២ថ្មី');

    // 4. Deleting the last remaining cue resets sticky hasTranslation to false
    await act(async () => { dom.container.querySelector('.subtitle-cue-delete').click(); });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 0);
    assert.equal(findPreviewSelect(), null);

    // 5. Cancelling in-flight extraction when gateway resolves late resets busy state cleanly without applying stale segments or hasTranslation
    services.mediaSubtitleGateway.transcribeVideo = () => new Promise(resolve => { resolveLateTranscribe = resolve; });
    await act(async () => { dom.container.querySelector('#subtitle-extract-btn').click(); });
    await act(async () => { dom.container.querySelector('#subtitle-cancel-btn').click(); });
    await act(async () => {
      resolveLateTranscribe({
        jobId: 'stale12345678901',
        language: 'en',
        segments: [{ id: 'stale-1', start: 0, end: 1, speakerId: 'speaker-1', text: 'Stale', translatedText: 'ចាស់' }],
      });
      await new Promise(r => setTimeout(r, 10));
    });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 0);
    assert.equal(findPreviewSelect(), null);
    assert.match(dom.container.querySelector('.status').textContent, /Subtitle extraction cancelled/);
    assert.ok(dom.container.querySelector('#subtitle-clear-btn'));
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted VideoSubtitleWorkspace supports Khmer-to-any and any-to-any multilingual translation across all 202 target languages', async () => {
  const dom = createDomShim();
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
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');

    let capturedTranscribe = null;
    let capturedTranslate = null;
    const services = {
      speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true }),
        transcribeVideo: async params => {
          capturedTranscribe = params;
          return {
            jobId: 'multilang12345678',
            language: 'km',
            translatedLanguage: params.translateTo,
            isAudioOnly: false,
            speakers: ['speaker-1'],
            videoSize: { width: 1280, height: 720 },
            segments: [
              { id: 'seg-1', start: 0.0, end: 2.0, speakerId: 'speaker-1', text: 'សួស្តីកម្ពុជា', translatedText: 'こんにちはカンボジア' },
            ],
          };
        },
        translateSegments: async params => {
          capturedTranslate = params;
          return {
            segments: params.segments.map(s => ({ ...s, translatedText: 'مرحبا كمبوديا' })),
            targetLanguage: params.targetLanguage,
          };
        },
        burnSubtitles: async () => new Blob(['ftypmp4'], { type: 'video/mp4' }),
      },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: { execute: async () => ({}) },
      lockReferenceAudio: { execute: async f => ({ blob: f }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { notices: null })));
      await new Promise(r => setTimeout(r, 15));
    });

    const findPreviewSelect = () =>
      dom.container.querySelectorAll('select').find(el => el.getAttribute('aria-label') === 'Preview language') || null;

    // 1. Default Khmer source can enable translation and pick any of 202 target languages (starting at English)
    const autoToggle = dom.container.querySelector('#subtitle-auto-translate');
    assert.equal(autoToggle.checked, false);
    await act(async () => {
      autoToggle.checked = true;
      autoToggle.dispatchEvent({ type: 'click', bubbles: true, target: autoToggle });
    });
    const targetSel = dom.container.querySelector('#subtitle-target-lang');
    assert.ok(targetSel);
    assert.equal(targetSel.value, 'eng_Latn');
    assert.equal(targetSel.options.length, 202);

    // 2. Switch target to Japanese (jpn_Jpan) and extract Khmer video
    await act(async () => {
      targetSel.value = 'jpn_Jpan';
      targetSel.dispatchEvent({ type: 'change', bubbles: true, target: targetSel });
    });
    const fileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'khmer-news.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { dom.container.querySelector('#subtitle-extract-btn').click(); });

    assert.equal(capturedTranscribe.language, 'km');
    assert.equal(capturedTranscribe.translateTo, 'jpn_Jpan');
    assert.equal(dom.container.querySelector('#subtitle-translate-btn').textContent, 'Re-translate Japanese');
    assert.equal(findPreviewSelect().options[0].textContent, 'Japanese subtitles');
    assert.equal(findPreviewSelect().options[2].textContent, 'Bilingual (Original + Japanese)');
    const jaTrack = dom.container.querySelector('track');
    assert.equal(jaTrack.getAttribute('srclang'), 'ja');
    assert.equal(jaTrack.getAttribute('label'), 'Japanese');
    const jaArea = dom.container.querySelector('.subtitle-line-input');
    assert.equal(jaArea.getAttribute('dir'), 'auto');
    assert.equal(jaArea.getAttribute('lang'), 'ja');
    assert.equal(jaArea.getAttribute('aria-label'), 'Japanese subtitle translation');
    assert.equal(String(jaArea.className).includes('subtitle-line-khmer'), false);

    // 3. Changing target dropdown to Arabic updates button copy immediately without mislabeling existing Japanese preview
    await act(async () => {
      targetSel.value = 'arb_Arab';
      targetSel.dispatchEvent({ type: 'change', bubbles: true, target: targetSel });
    });
    assert.equal(dom.container.querySelector('#subtitle-translate-btn').textContent, 'Translate to Arabic');
    assert.equal(findPreviewSelect().options[0].textContent, 'Japanese subtitles');

    // 4. Translating into Arabic updates preview, track, and RTL-ready textarea attributes
    await act(async () => { dom.container.querySelector('#subtitle-translate-btn').click(); });
    assert.equal(capturedTranslate.sourceLanguage, 'km');
    assert.equal(capturedTranslate.targetLanguage, 'arb_Arab');
    assert.equal(dom.container.querySelector('#subtitle-translate-btn').textContent, 'Re-translate Arabic');
    assert.equal(findPreviewSelect().options[0].textContent, 'Arabic subtitles');
    assert.equal(dom.container.querySelector('track').getAttribute('srclang'), 'ar');
    assert.equal(dom.container.querySelector('track').getAttribute('label'), 'Arabic');
    const arArea = dom.container.querySelector('.subtitle-line-input');
    assert.equal(arArea.getAttribute('dir'), 'auto');
    assert.equal(arArea.getAttribute('lang'), 'ar');
    assert.equal(arArea.value, 'مرحبا كمبوديا');

    // 5. Selecting the same target language as the detected source disables the translate button
    await act(async () => {
      targetSel.value = 'khm_Khmr';
      targetSel.dispatchEvent({ type: 'change', bubbles: true, target: targetSel });
    });
    const translateBtn = dom.container.querySelector('#subtitle-translate-btn');
    assert.equal(translateBtn.disabled || translateBtn.hasAttribute('disabled'), true);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

function createValidTestWavBlob(durationMs = 120, sampleRate = 16000) {
  const numSamples = Math.round((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeTag = (off, tag) => { for (let i = 0; i < 4; i++) view.setUint8(off + i, tag.charCodeAt(i)); };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin(i / 8) * 10000), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

test('mounted Studio supports per-frame and multi-selected subtitle Text-to-Speech, combined WAV output below subtitles, staleness badges, and selection-scoped TTS handoff', async () => {
  const dom = createDomShim();
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
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    const synthCalls = [];
    const dubCalls = [];
    let shouldFailDub = false;
    const downloadedNames = [];
    const blobByUrl = new Map();
    const revokedUrls = [];
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = blob => {
      const url = origCreateObjectURL(blob);
      blobByUrl.set(url, blob);
      return url;
    };
    URL.revokeObjectURL = url => {
      revokedUrls.push(url);
      origRevokeObjectURL?.(url);
    };
    const origCreateElement = dom.container.ownerDocument.createElement;
    dom.container.ownerDocument.createElement = tag => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        const origClick = el.click.bind(el);
        el.click = () => {
          if (el.download) downloadedNames.push(el.download);
          return origClick();
        };
      }
      return el;
    };
    const services = {
      speechGateway: {
        checkAvailability: async () => true,
        checkHealth: async () => ({ online: true, detail: null }),
        uploadReferenceAudio: async () => ({}),
        synthesize: async () => ({}),
      },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true }),
        transcribeVideo: async () => ({
          jobId: 'voiceover1234567',
          language: 'en',
          translatedLanguage: '',
          isAudioOnly: false,
          speakers: ['speaker-1'],
          videoSize: { width: 1280, height: 720 },
          segments: [
            { id: 'seg-1', start: 0.0, end: 2.0, speakerId: 'speaker-1', text: 'First frame line.', translatedText: '' },
            { id: 'seg-2', start: 2.1, end: 4.0, speakerId: 'speaker-1', text: 'Second frame line.', translatedText: '' },
            { id: 'seg-3', start: 4.1, end: 6.0, speakerId: 'speaker-1', text: 'Third frame line.', translatedText: '' },
          ],
        }),
        translateSegments: async ({ segments }) => ({ segments }),
        burnSubtitles: async () => new Blob(['ftypmp4'], { type: 'video/mp4' }),
        exportDubbedVideo: async params => {
          dubCalls.push(params);
          if (shouldFailDub) throw new Error('FFmpeg dubbing failed on server.');
          return new Blob(['ftypdubbedmp4'], { type: 'video/mp4' });
        },
      },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: {
        execute: async cmd => {
          synthCalls.push({ script: cmd.script, characterId: cmd.character.id, autoFormatKhmer: cmd.autoFormatKhmer });
          const blob = createValidTestWavBlob(140);
          return {
            recording: {
              id: `take-${synthCalls.length}`,
              characterId: cmd.character.id,
              characterName: cmd.character.name,
              transcript: cmd.script,
              blob,
              anchorBlob: blob,
              seed: 100 + synthCalls.length,
              audioDurationSeconds: 1.4,
            },
            uploadedFileData: null,
          };
        },
      },
      lockReferenceAudio: { execute: async f => ({ blob: f }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
    });
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });

    const subPanel = dom.container.querySelector('.subtitle-workspace');
    const fileInput = subPanel.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'song.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });

    // 1. Voiceover toolbar + per-frame checkboxes & Generate voice buttons render cleanly; batch button disabled until selection
    const rows = subPanel.querySelectorAll('.subtitle-segment-row');
    assert.equal(rows.length, 3);
    assert.ok(subPanel.querySelector('#subtitle-tts-voice'));
    const batchBtn = subPanel.querySelector('#subtitle-generate-voice-btn');
    assert.equal(batchBtn.disabled || batchBtn.hasAttribute('disabled'), true);
    assert.equal(subPanel.querySelector('#subtitle-voice-output'), null);

    // 2. Generate voice on a single frame (#2) -> renders inline play/download + bottom #subtitle-voice-output card
    const row2VoiceBtn = rows[1].querySelector('.subtitle-cue-voice-btn');
    assert.match(row2VoiceBtn.textContent, /Generate voice/);
    await act(async () => {
      row2VoiceBtn.click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(synthCalls.length, 1);
    assert.equal(synthCalls[0].script, 'Second frame line.');
    assert.equal(synthCalls[0].characterId, 'char-nisa');
    assert.equal(synthCalls[0].autoFormatKhmer, false);
    assert.match(rows[1].querySelector('.subtitle-cue-voice-btn').textContent, /Regenerate/);
    assert.ok(rows[1].querySelector('.subtitle-cue-play-btn'));
    assert.ok(subPanel.querySelector('#subtitle-voice-output'));
    assert.ok(subPanel.querySelector('#subtitle-voice-output').querySelector('audio'));

    // 3. Editing frame #2 marks its generated voice clip with the Edited badge
    const row2Area = rows[1].querySelector('.subtitle-line-input');
    await act(async () => {
      row2Area._value = 'Second frame edited.';
      row2Area.dispatchEvent({ type: 'input', bubbles: true, target: row2Area });
    });
    assert.ok(rows[1].querySelector('.subtitle-cue-stale-badge'));

    // 4. Select frames #1 and #3, switch voice to Sovath, and generate batch voiceover
    const row1Check = rows[0].querySelector('.subtitle-select-checkbox');
    const row3Check = rows[2].querySelector('.subtitle-select-checkbox');
    await act(async () => {
      row1Check.checked = true;
      row1Check.dispatchEvent({ type: 'click', bubbles: true, target: row1Check });
    });
    await act(async () => {
      row3Check.checked = true;
      row3Check.dispatchEvent({ type: 'click', bubbles: true, target: row3Check });
    });
    assert.equal(rows[0].getAttribute('data-selected'), 'true');
    assert.equal(rows[2].getAttribute('data-selected'), 'true');
    assert.match(subPanel.querySelector('#subtitle-generate-voice-btn').textContent, /Generate voice \(2\)/);
    assert.match(subPanel.querySelector('#subtitle-send-tts-btn').textContent, /Send selected to TTS \(2\)/);

    const voiceSelect = subPanel.querySelector('#subtitle-tts-voice');
    await act(async () => {
      voiceSelect.value = 'char-sovath';
      voiceSelect.dispatchEvent({ type: 'change', bubbles: true, target: voiceSelect });
    });
    await act(async () => {
      subPanel.querySelector('#subtitle-generate-voice-btn').click();
      await new Promise(r => setTimeout(r, 30));
    });

    assert.equal(synthCalls.length, 3);
    assert.equal(synthCalls[1].script, 'First frame line.');
    assert.equal(synthCalls[1].characterId, 'char-sovath');
    assert.equal(synthCalls[2].script, 'Third frame line.');
    assert.equal(synthCalls[2].characterId, 'char-sovath');

    const outputCard = subPanel.querySelector('#subtitle-voice-output');
    assert.ok(outputCard);
    assert.match(outputCard.textContent, /Selected voiceover · 2 frames/);
    assert.match(outputCard.textContent, /Sovath/);
    assert.match(outputCard.textContent, /0\.2s gap/);
    assert.ok(outputCard.querySelector('#subtitle-voice-export-btn'));

    // 4b. Gap selector defaults to 0.2s (200ms) and dynamically re-stitches the combined WAV without re-synthesizing
    const gapSelect = subPanel.querySelector('#subtitle-tts-gap');
    assert.ok(gapSelect);
    assert.equal(gapSelect.value, '200');
    assert.deepEqual(
      gapSelect.querySelectorAll('option').map(opt => opt.textContent),
      ['0.1s', '0.2s', '0.5s', '1.0s']
    );
    const { readWavDurationSeconds } = await import('../../src/domain/wavCodec.js');
    const urlAt200ms = outputCard.querySelector('audio').getAttribute('src');
    const durationAt200ms = readWavDurationSeconds(await blobByUrl.get(urlAt200ms).arrayBuffer());
    assert.ok(Math.abs(durationAt200ms - (0.14 + 0.2 + 0.14)) < 0.001, `Expected 0.48s at 200ms gap, got ${durationAt200ms}`);

    await act(async () => {
      gapSelect.value = '1000';
      gapSelect.dispatchEvent({ type: 'change', bubbles: true, target: gapSelect });
      await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(synthCalls.length, 3);
    const updatedOutput = subPanel.querySelector('#subtitle-voice-output');
    const urlAt1000ms = updatedOutput.querySelector('audio').getAttribute('src');
    assert.notEqual(urlAt1000ms, urlAt200ms);
    assert.equal(revokedUrls.includes(urlAt200ms), true);
    assert.match(updatedOutput.textContent, /1\.0s gap/);
    const durationAt1000ms = readWavDurationSeconds(await blobByUrl.get(urlAt1000ms).arrayBuffer());
    assert.ok(Math.abs(durationAt1000ms - (0.14 + 1.0 + 0.14)) < 0.001, `Expected 1.28s at 1000ms gap, got ${durationAt1000ms}`);

    // 4c. Dubbed MP4 export controls inside consolidated ExportProjectModal: select Mute original mode, export <stem>-dubbed.mp4, and surface error inside modal on failure
    await act(async () => { updatedOutput.querySelector('#subtitle-voice-export-btn').click(); });
    const dubDialog = subPanel.querySelector('#export-project-dialog');
    const dubModeSelect = dubDialog.querySelector('#export-dub-audio-mode');
    const dubBtn = dubDialog.querySelector('#export-preset-btn-video_dubbed_mp4');
    assert.ok(dubModeSelect);
    assert.ok(dubBtn);
    assert.equal(dubModeSelect.value, 'duck');
    assert.equal(dubBtn.disabled || dubBtn.hasAttribute('disabled'), false);

    await act(async () => {
      dubModeSelect.value = 'mute';
      dubModeSelect.dispatchEvent({ type: 'change', bubbles: true, target: dubModeSelect });
    });
    await act(async () => {
      dubBtn.click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(dubCalls.length, 1);
    assert.equal(dubCalls[0].jobId, 'voiceover1234567');
    assert.equal(dubCalls[0].originalAudioMode, 'mute');
    assert.deepEqual(
      dubCalls[0].clips.map(clip => [clip.segmentId, clip.start, clip.end]),
      [['seg-1', 0.0, 2.0], ['seg-3', 4.1, 6.0]]
    );
    assert.equal(downloadedNames.includes('song-dubbed.mp4'), true);

    shouldFailDub = true;
    await act(async () => {
      dubDialog.querySelector('#export-preset-btn-video_dubbed_mp4').click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.match(dom.container.querySelector('#studio-toast-region').textContent, /FFmpeg dubbing failed on server/);
    await act(async () => { dubDialog.querySelector('#export-project-close-btn').click(); });
    shouldFailDub = false;

    // 5. Send selected to TTS sends ONLY selected frames (#1 and #3), skipping unselected #2
    await act(async () => { subPanel.querySelector('#subtitle-send-tts-btn').click(); });
    assert.equal(dom.container.querySelector('#script').value, 'First frame line. Third frame line.');

    // 6. Returning and clicking Clear removes generated clips and hides #subtitle-voice-output cleanly
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });
    await act(async () => { subPanel.querySelector('#subtitle-clear-btn').click(); });
    assert.equal(subPanel.querySelector('#subtitle-voice-output'), null);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted VideoSubtitleWorkspace supports optional Khmer Whisper double-check toggle and one-click suggestion apply/dismiss', async () => {
  const dom = createDomShim();
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');
    const transcribeCalls = [];
    const services = {
      logger: { debug() {}, warn() {}, error() {} },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true }),
        async transcribeVideo(params) {
          transcribeCalls.push(params);
          return {
            jobId: 'facefeed12345678',
            language: 'km',
            isAudioOnly: true,
            speakers: ['speaker-1'],
            videoSize: null,
            segments: [
              {
                id: 'seg-1',
                start: 0,
                end: 2.0,
                speakerId: 'speaker-1',
                text: 'សួស្តី កំពុង សាក',
                translatedText: '',
                altText: 'សួស្តី កំពុង សាកល្បង',
                verifyReason: 'double_check',
              },
              {
                id: 'seg-2',
                start: 2.2,
                end: 4.0,
                speakerId: 'speaker-1',
                text: 'សង្គ្រោះ ដោយ Whisper',
                translatedText: '',
                altText: '',
                verifyReason: 'whisper_fallback',
              },
              {
                id: 'seg-3',
                start: 4.2,
                end: 6.0,
                speakerId: 'speaker-1',
                text: 'រក្សា អក្សរ ដើម',
                translatedText: '',
                altText: 'ជម្រើស ផ្សេង ទៀត',
                verifyReason: 'high_oov',
              },
            ],
            verificationSummary: { checked: 3, fallbackApplied: 1, suggestions: 2, model: 'seanghay/whisper-small-khmer-v2' },
          };
        },
        translateSegments: async () => ({ segments: [] }),
        burnSubtitles: async () => new Blob(),
      },
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { hidden: false })));
    });

    const toggle = dom.container.querySelector('#subtitle-double-check-khmer');
    assert.ok(toggle);
    assert.equal(toggle.checked, false);

    // Enable optional Double-check Khmer (Whisper)
    await act(async () => {
      toggle.checked = true;
      toggle.dispatchEvent({ type: 'click', bubbles: true, target: toggle });
    });

    const fileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['wav'], 'khmer.wav', { type: 'audio/wav' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => {
      dom.container.querySelector('#subtitle-extract-btn').click();
      await new Promise(r => setTimeout(r, 20));
    });

    assert.equal(transcribeCalls.length, 1);
    assert.equal(transcribeCalls[0].doubleCheck, true);
    assert.match(dom.container.querySelector('.subtitle-dock').querySelector('.status').textContent, /1 recovered by Whisper · 2 Whisper suggestions/);

    const rows = dom.container.querySelectorAll('.subtitle-segment-row');
    assert.equal(rows.length, 3);
    assert.match(rows[1].textContent, /Whisper recovery/);

    // Row 1 renders Whisper suggestion banner and clicking "Use suggestion" replaces text cleanly
    const banner1 = rows[0].querySelector('.subtitle-verify-banner');
    assert.ok(banner1);
    assert.match(banner1.textContent, /សួស្តី កំពុង សាកល្បង/);
    const useBtn = banner1.querySelectorAll('button').find(b => b.textContent.includes('Use suggestion'));
    await act(async () => { useBtn.click(); });
    assert.equal(rows[0].querySelector('.subtitle-line-input').value, 'សួស្តី កំពុង សាកល្បង');
    assert.equal(rows[0].querySelector('.subtitle-verify-banner'), null);

    // Row 3 renders Whisper check banner and clicking "Dismiss" preserves original text cleanly
    const banner3 = rows[2].querySelector('.subtitle-verify-banner');
    assert.ok(banner3);
    const dismissBtn = banner3.querySelectorAll('button').find(b => b.textContent.includes('Dismiss'));
    await act(async () => { dismissBtn.click(); });
    assert.equal(rows[2].querySelector('.subtitle-line-input').value, 'រក្សា អក្សរ ដើម');
    assert.equal(rows[2].querySelector('.subtitle-verify-banner'), null);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted VideoSubtitleWorkspace shows offline model hints only for enabled features with uncached models', async () => {
  const dom = createDomShim();
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');
    let models = { whisper: true, khmerAsr: true, translator: false, diarization: false };
    const services = {
      logger: { debug() {}, warn() {}, error() {} },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true, models }),
        transcribeVideo: async () => ({ jobId: 'abc123', language: 'en', videoSize: { width: 16, height: 9 }, segments: [] }),
        translateSegments: async () => ({ segments: [] }),
        burnSubtitles: async () => new Blob(),
      },
    };
    const toggleSwitch = async (id, checked) => {
      const el = dom.container.querySelector(id);
      await act(async () => {
        el.checked = checked;
        el.dispatchEvent({ type: 'click', bubbles: true, target: el });
      });
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { hidden: false })));
    });
    assert.equal(dom.container.querySelector('.subtitle-model-hints'), null);

    await toggleSwitch('#subtitle-auto-translate', true);
    let hints = dom.container.querySelector('.subtitle-model-hints');
    assert.ok(hints);
    assert.match(hints.textContent, /First-time translation will download NLLB-200 \(~2\.4 GB\)\./);
    assert.doesNotMatch(hints.textContent, /speaker detection/);

    await toggleSwitch('#subtitle-detect-speakers', true);
    hints = dom.container.querySelector('.subtitle-model-hints');
    assert.match(hints.textContent, /First-time speaker detection will download diarization models/);
    assert.equal(hints.querySelectorAll('p').length, 2);

    await act(async () => { root.unmount(); });
    models = { whisper: true, khmerAsr: true, translator: true, diarization: true };
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { hidden: false })));
    });
    await toggleSwitch('#subtitle-auto-translate', true);
    assert.equal(dom.container.querySelector('.subtitle-model-hints'), null);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted VideoSubtitleWorkspace autosaves subtitle changes and restores on reload', async () => {
  const dom = createDomShim();
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');

    const savedProjects = new Map();
    const projectRepository = {
      listProjects: async () => {
        const items = Array.from(savedProjects.values())
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
          .map(({ id, kind, title, createdAt, updatedAt }) => ({ id, kind, title, createdAt, updatedAt }));
        return { items, total: items.length, limit: 50, offset: 0, hasMore: false };
      },
      getProject: async id => savedProjects.get(id) ?? null,
      saveProject: async snapshot => {
        const id = snapshot.id || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const isCreated = !savedProjects.has(id);
        const stored = { ...snapshot, id, updatedAt: new Date().toISOString() };
        savedProjects.set(id, stored);
        return { project: stored, isCreated };
      },
      deleteProject: async id => { savedProjects.delete(id); return { deleted: true, id }; },
    };
    const services = {
      logger: { debug() {}, warn() {}, error() {} },
      projectRepository,
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true, models: {} }),
        transcribeVideo: async () => ({
          jobId: 'job-1',
          language: 'en',
          videoSize: { width: 16, height: 9 },
          segments: [
            { id: 'seg-1', start: 0.0, end: 2.0, text: 'Original text', translatedText: 'អត្ថបទដើម', speakerId: 'speaker-1' },
            { id: 'seg-2', start: 2.1, end: 4.0, text: 'Second line', translatedText: 'បន្ទាត់ទីពីរ', speakerId: 'speaker-2' },
          ],
        }),
        translateSegments: async () => ({ segments: [] }),
        burnSubtitles: async () => new Blob(),
      },
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { hidden: false })));
    });

    const subPanel = dom.container.querySelector('.subtitle-workspace');
    assert.ok(subPanel);

    const fileInput = subPanel.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['video'], 'saved-video.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });

    // Update segment text via the inline input to trigger autosave
    const row = subPanel.querySelector('.subtitle-segment-row');
    assert.ok(row, 'subtitle segment row should render');
    const input = row.querySelector('.subtitle-line-input');
    assert.ok(input, 'segment input should render');
    await act(async () => {
      input._value = 'Updated subtitle text';
      input.dispatchEvent({ type: 'input', bubbles: true, target: input });
    });
    const speakerInput = subPanel.querySelector('.subtitle-roster-input');
    await act(async () => {
      speakerInput._value = 'Saved host';
      speakerInput.dispatchEvent({ type: 'input', bubbles: true, target: speakerInput });
    });

    // Wait for autosave debounce (1500ms)
    await act(async () => { await new Promise(r => setTimeout(r, 1600)); });

    // Verify autosave was called
    assert.ok(savedProjects.size > 0, 'autosave should persist at least one project');
    const saved = Array.from(savedProjects.values())[0];
    assert.ok(saved.payload.segments.length > 0);
    assert.equal(saved.payload.segments[0].text, 'Updated subtitle text');
    assert.equal(saved.payload.segments[0].translatedText, 'អត្ថបទដើម');
    assert.equal(saved.payload.speakerNames['speaker-1'], 'Saved host');
    assert.equal(saved.payload.videoFileName, 'saved-video.mp4');

    // Capture project id for reload
    const projectId = saved.id;

    // Simulate reload: unmount and remount with same repository
    await act(async () => { root.unmount(); });
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { hidden: false })));
    });

    // Verify project state is restored after the workspace remounts.
    const reloaded = await projectRepository.getProject(projectId);
    assert.ok(reloaded, 'saved project should be retrievable after reload');
    assert.equal(reloaded.kind, 'subtitle');
    const restoredRow = dom.container.querySelector('.subtitle-segment-row');
    assert.ok(restoredRow, 'saved cue should be restored into the editor');
    assert.equal(restoredRow.querySelector('textarea').value, 'Updated subtitle text');
    assert.equal(dom.container.querySelector('.subtitle-roster-input').value, 'Saved host');
    assert.match(dom.container.querySelector('.subtitle-upload-copy').textContent, /Re-link saved-video\.mp4/);

    const restoredFileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      restoredFileInput.files = [new File(['video'], 'saved-video.mp4', { type: 'video/mp4' })];
      restoredFileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    assert.match(dom.container.querySelector('#subtitle-extract-btn').textContent, /Link video for burn-in/);
    await act(async () => { dom.container.querySelector('#subtitle-extract-btn').click(); });
    assert.equal(dom.container.querySelector('.subtitle-line-input').value, 'Updated subtitle text');
    await act(async () => { dom.container.querySelector('#subtitle-export-project-btn').click(); });
    const relinkBurnDlg = dom.container.querySelector('#export-project-dialog');
    const burnButton = relinkBurnDlg.querySelector('#export-preset-btn-video_burned_mp4');
    assert.equal(burnButton.disabled || burnButton.hasAttribute('disabled'), false);
    await act(async () => { relinkBurnDlg.querySelector('#export-project-close-btn').click(); });

  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted TextToSpeechWorkspace autosaves and restores the current script project', async () => {
  const dom = createDomShim();
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { TextToSpeechWorkspace } = await vite.ssrLoadModule('/src/presentation/components/TextToSpeechWorkspace.jsx');
    const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const projects = new Map([[projectId, {
      id: projectId,
      kind: 'tts',
      title: 'Saved script',
      payload: { script: 'Script restored from storage', voiceId: 'char-nisa', ttsOptions: { guidance: 2 } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }]]);
    const projectRepository = {
      listProjects: async () => ({
        items: Array.from(projects.values()).map(({ id, kind, title, createdAt, updatedAt }) => ({ id, kind, title, createdAt, updatedAt })),
        total: projects.size, limit: 50, offset: 0, hasMore: false,
      }),
      getProject: async id => projects.get(id) ?? null,
      saveProject: async project => {
        const id = project.id || projectId;
        const saved = { ...project, id };
        projects.set(id, saved);
        return { project: saved, isCreated: false };
      },
      deleteProject: async id => { projects.delete(id); return { deleted: true, id }; },
    };
    const voice = BUILT_IN_VOICES.find(item => item.id === 'char-nisa');
    const shared = {
      library: {
        allVoices: BUILT_IN_VOICES, matches: [], warning: null, storageStats: null,
        refreshStats() {}, filters: { search: '', source: '', category: '' }, updateFilter() {},
      },
      anchorApi: { isLoaded: true, anchors: {}, anchorWarning: null },
      activeCharacter: voice,
      activeAnchor: null,
      lockedSeeds: {},
      setLockedSeeds() {},
      characterActions: {
        handleSelectCharacter() {}, handleUploadSample() {}, handleResetVoice() {}, handleUpdateAnchor() {},
        handleCreateCharacter() {}, handleDeleteCharacter() {}, handlePinCurrentTake() {},
      },
      refreshEngine() {},
      onTtsStateChange() {},
      onNotify() {},
    };
    const services = {
      projectRepository,
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: { execute: async () => ({}) },
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services },
        React.createElement(TextToSpeechWorkspace, { shared, hidden: false })));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const script = dom.container.querySelector('#script');
    assert.equal(script.value, 'Script restored from storage');
    await act(async () => {
      script._value = 'Edited script survives refresh';
      script.dispatchEvent({ type: 'input', bubbles: true, target: script });
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); });
    assert.equal(projects.get(projectId).payload.script, 'Edited script survives refresh');

    await act(async () => { root.unmount(); });
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services },
        React.createElement(TextToSpeechWorkspace, { shared, hidden: false })));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(dom.container.querySelector('#script').value, 'Edited script survives refresh');
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted subtitle import translates cues and generates per-frame voice without a video', async () => {
  const dom = createDomShim();
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
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');
    const translationRequests = [];
    const voiceRequests = [];
    const notices = [];
    const services = {
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true }),
        translateSegments: async request => {
          translationRequests.push(request);
          return { segments: request.segments.map(segment => ({ ...segment, translatedText: `Translated: ${segment.text}` })) };
        },
      },
      synthesizeSpeech: {
        execute: async request => {
          voiceRequests.push(request);
          return {
            recording: {
              id: 'imported-frame-take',
              seed: 42,
              characterId: 'char-nisa',
              characterName: 'Nisa',
              transcript: request.script,
              blob: new Blob(['RIFF']),
              audioDurationSeconds: 1,
              elapsedMs: 1,
              sizeBytes: 4,
            },
            uploadedFileData: null,
          };
        },
      },
      logger: { debug() {}, warn() {}, error() {} },
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services },
        React.createElement(VideoSubtitleWorkspace, { notices: null, onNotify: notice => notices.push(notice) })));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const importInput = dom.container.querySelector('#subtitle-file-input');
    await act(async () => {
      importInput.files = [new File(['WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHost: Hello there.\n\n00:00:01.200 --> 00:00:02.000\nGuest: Welcome.'], 'captions.vtt', { type: 'text/vtt' })];
      importInput.dispatchEvent({ type: 'change', bubbles: true, target: importInput });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 2);
    await act(async () => { dom.container.querySelector('#subtitle-export-project-btn').click(); });
    const importExportDlg = dom.container.querySelector('#export-project-dialog');
    const burnButton = importExportDlg.querySelector('#export-preset-btn-video_burned_mp4');
    assert.equal(burnButton.disabled || burnButton.hasAttribute('disabled'), true);
    await act(async () => { importExportDlg.querySelector('#export-project-close-btn').click(); });
    assert.ok(notices.some(notice => notice.title === 'Subtitles imported'));

    const sourceLanguage = dom.container.querySelector('#subtitle-source-lang');
    await act(async () => {
      sourceLanguage.value = 'en';
      sourceLanguage.dispatchEvent({ type: 'change', bubbles: true, target: sourceLanguage });
    });
    await act(async () => {
      dom.container.querySelector('#subtitle-translate-btn').click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(translationRequests.length, 1);
    assert.equal(translationRequests[0].sourceLanguage, 'en');
    assert.equal(translationRequests[0].segments.length, 2);

    await act(async () => {
      dom.container.querySelector('.subtitle-cue-voice-btn').click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(voiceRequests.length, 1);
    assert.equal(voiceRequests[0].script, 'Translated: Hello there.');
    assert.ok(dom.container.querySelector('.subtitle-cue-audio-controls'));
    await act(async () => { dom.container.querySelector('#subtitle-voice-export-btn').click(); });
    const noJobDlg = dom.container.querySelector('#export-project-dialog');
    const noJobDubBtn = noJobDlg.querySelector('#export-preset-btn-video_dubbed_mp4');
    assert.ok(noJobDubBtn);
    assert.equal(noJobDubBtn.disabled || noJobDubBtn.hasAttribute('disabled'), true);
    await act(async () => { noJobDlg.querySelector('#export-project-close-btn').click(); });
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted VideoSubtitleWorkspace detects R3-05 speech duration mismatches, blocks dub exports, and resolves every mismatch via explicit remedies', async () => {
  const dom = createDomShim();
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
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');
    const dubCalls = [];
    const downloadedNames = [];
    const origCreateElement = dom.container.ownerDocument.createElement;
    dom.container.ownerDocument.createElement = tag => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        const origClick = el.click.bind(el);
        el.click = () => {
          if (el.download) downloadedNames.push(el.download);
          return origClick();
        };
      }
      return el;
    };

    const durationsByScript = {
      'Cue one.': 1600,   // 1.6s > 1.0s cue, fits before Cue #2 at 2.0s
      'Cue two.': 1500,   // 1.5s > 1.0s cue (2.0-3.0s), collides with Cue #3 at 3.2s
      'Cue three.': 1400, // 1.4s > 1.0s cue (3.2-4.2s), trailing tail free
    };

    const services = {
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true }),
        transcribeVideo: async () => ({
          jobId: 'r305job123456789',
          language: 'en',
          translatedLanguage: '',
          isAudioOnly: false,
          speakers: ['speaker-1'],
          videoSize: { width: 1280, height: 720 },
          segments: [
            { id: 'seg-1', start: 0.0, end: 1.0, speakerId: 'speaker-1', text: 'Cue one.', translatedText: '' },
            { id: 'seg-2', start: 2.0, end: 3.0, speakerId: 'speaker-1', text: 'Cue two.', translatedText: '' },
            { id: 'seg-3', start: 3.2, end: 4.2, speakerId: 'speaker-1', text: 'Cue three.', translatedText: '' },
          ],
        }),
        exportDubbedVideo: async params => {
          dubCalls.push(params);
          return new Blob(['ftypdubmp4'], { type: 'video/mp4' });
        },
      },
      synthesizeSpeech: {
        execute: async cmd => {
          const ms = durationsByScript[cmd.script] || 1000;
          const blob = createValidTestWavBlob(ms);
          return {
            recording: {
              id: `take-${cmd.script}`,
              characterId: cmd.character.id,
              characterName: cmd.character.name,
              transcript: cmd.script,
              blob,
              audioDurationSeconds: ms / 1000,
              seed: 7,
            },
            uploadedFileData: null,
          };
        },
      },
      logger: { debug() {}, warn() {}, error() {} },
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services },
        React.createElement(VideoSubtitleWorkspace, { notices: null })));
      await new Promise(r => setTimeout(r, 0));
    });

    const fileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => {
      dom.container.querySelector('#subtitle-extract-btn').click();
      await new Promise(r => setTimeout(r, 10));
    });

    // Select all 3 cues and generate voices -> all 3 exceed their 1.0s intervals
    await act(async () => {
      const selectAll = dom.container.querySelector('#subtitle-select-all');
      selectAll.checked = true;
      selectAll.dispatchEvent({ type: 'click', bubbles: true, target: selectAll });
    });
    await act(async () => {
      dom.container.querySelector('#subtitle-generate-voice-btn').click();
      await new Promise(r => setTimeout(r, 40));
    });

    // 1. All 3 mismatches are surfaced in validation summary, export banner, and row alerts; dub exports are blocked
    const banner = dom.container.querySelector('.subtitle-mismatch-export-banner');
    assert.ok(banner, 'Must display duration mismatch export banner');
    assert.match(banner.textContent, /Resolve 3 speech duration mismatches before final dub export/);

    await act(async () => { dom.container.querySelector('#subtitle-export-project-btn').click(); });
    const blockedDialog = dom.container.querySelector('#export-project-dialog');
    const dubBtn = blockedDialog.querySelector('#export-preset-btn-video_dubbed_mp4');
    const alignedBtn = blockedDialog.querySelector('#export-preset-btn-subtitle_aligned_wav');
    assert.equal(Boolean(dubBtn.disabled || dubBtn.hasAttribute('disabled')), true);
    assert.equal(Boolean(alignedBtn.disabled || alignedBtn.hasAttribute('disabled')), true);
    await act(async () => { blockedDialog.querySelector('#export-project-close-btn').click(); });

    const rows = dom.container.querySelectorAll('.subtitle-segment-row');
    assert.equal(rows.length, 3);
    const findRemedyBtn = (row, action) => row.querySelectorAll('.subtitle-validation-fix-btn')
      .find(btn => btn.getAttribute('data-remedy-action') === action);

    // 2. Cue #1: Allow spill into empty pause [1.0, 2.0], test Undo spill, then re-approve spill
    const row1SpillBtn = findRemedyBtn(rows[0], 'allow_spill');
    assert.ok(row1SpillBtn, 'Cue #1 must offer Allow spill remedy');
    await act(async () => { row1SpillBtn.click(); });
    assert.ok(rows[0].querySelector('.subtitle-cue-spill-badge'));
    const undoSpillBtn = rows[0].querySelector('.subtitle-cue-undo-spill-btn');
    assert.ok(undoSpillBtn);
    await act(async () => { undoSpillBtn.click(); });
    assert.equal(rows[0].querySelector('.subtitle-cue-spill-badge'), null);
    await act(async () => { findRemedyBtn(rows[0], 'allow_spill').click(); });
    assert.match(dom.container.querySelector('.subtitle-mismatch-export-banner').textContent, /Resolve 2 speech duration mismatches/);

    // 3. Cue #2: Collides with Cue #3 -> resolve via Extend & shift
    const row2ShiftBtn = findRemedyBtn(rows[1], 'extend_and_shift');
    assert.ok(row2ShiftBtn, 'Colliding Cue #2 must offer Extend & shift remedy');
    await act(async () => { row2ShiftBtn.click(); });
    assert.match(dom.container.querySelector('.subtitle-mismatch-export-banner').textContent, /Resolve 1 speech duration mismatch/);

    // 4. Cue #3: Test explicit Trim audio + reversible Undo trim, then resolve via Extend cue
    const row3TrimBtn = findRemedyBtn(rows[2], 'trim_clip');
    assert.ok(row3TrimBtn, 'Cue #3 must offer explicit Trim audio remedy');
    await act(async () => {
      row3TrimBtn.click();
      await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(dom.container.querySelector('.subtitle-mismatch-export-banner'), null, 'Trimming resolves last mismatch');
    const undoTrimBtn = rows[2].querySelector('.subtitle-cue-undo-trim-btn');
    assert.ok(undoTrimBtn, 'Trimmed clip must offer Undo trim');
    await act(async () => {
      undoTrimBtn.click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.ok(dom.container.querySelector('.subtitle-mismatch-export-banner'), 'Undoing trim restores mismatch');

    const row3ExtendBtn = findRemedyBtn(rows[2], 'extend_cue');
    assert.ok(row3ExtendBtn, 'Cue #3 must offer Extend cue remedy');
    await act(async () => {
      row3ExtendBtn.click();
      await new Promise(r => setTimeout(r, 30));
    });

    // 5. All mismatches resolved -> validation badge is clean Valid, banner gone, both exports enabled and succeed!
    assert.equal(dom.container.querySelector('.subtitle-mismatch-export-banner'), null);
    assert.ok(dom.container.querySelector('.is-clean'));

    await act(async () => { dom.container.querySelector('#subtitle-voice-export-btn').click(); });
    const readyDialog = dom.container.querySelector('#export-project-dialog');
    const readyDubBtn = readyDialog.querySelector('#export-preset-btn-video_dubbed_mp4');
    const readyAlignedBtn = readyDialog.querySelector('#export-preset-btn-subtitle_aligned_wav');
    assert.equal(Boolean(readyDubBtn.disabled || readyDubBtn.hasAttribute('disabled')), false);
    assert.equal(Boolean(readyAlignedBtn.disabled || readyAlignedBtn.hasAttribute('disabled')), false);

    await act(async () => {
      readyAlignedBtn.click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(downloadedNames.includes('clip-time-aligned-dub.wav'), true);

    await act(async () => {
      readyDubBtn.click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(dubCalls.length, 1);
    assert.equal(dubCalls[0].clips[0].segmentId, 'seg-1');
    assert.equal(dubCalls[0].clips[0].allowOverflow, true, 'Spill-approved Cue #1 must pass allowOverflow: true to /dub');
    assert.equal(dubCalls[0].clips[1].allowOverflow, undefined);
    assert.equal(dubCalls[0].clips[2].allowOverflow, undefined);
    await act(async () => { readyDialog.querySelector('#export-project-close-btn').click(); });
    assert.equal(downloadedNames.includes('clip-dubbed.mp4'), true);
  } finally {
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted VideoSubtitleWorkspace enforces transcribe duration bounds, revokes spill on neighbor timing edit, supports Remove voice on wedged tail cues, and clears clips on re-extract', async () => {
  const dom = createDomShim();
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
  let extractCount = 0;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');

    const services = {
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true }),
        transcribeVideo: async () => {
          extractCount += 1;
          return {
            jobId: `job-${extractCount}`,
            duration: 3.5, // Probed backend media duration without <video onLoadedMetadata>
            language: 'en',
            translatedLanguage: '',
            isAudioOnly: false,
            speakers: ['speaker-1'],
            videoSize: { width: 1280, height: 720 },
            segments: [
              { id: 'seg-1', start: 0.0, end: 1.0, speakerId: 'speaker-1', text: 'Spill line.', translatedText: '' },
              { id: 'seg-2', start: 2.0, end: 3.35, speakerId: 'speaker-1', text: 'Middle line.', translatedText: '' },
              { id: 'seg-3', start: 3.35, end: 3.5, speakerId: 'speaker-1', text: 'Tail.', translatedText: '' },
            ],
          };
        },
        exportDubbedVideo: async () => new Blob(['mp4'], { type: 'video/mp4' }),
      },
      synthesizeSpeech: {
        execute: async cmd => {
          const ms = cmd.script === 'Spill line.' ? 1600 : cmd.script === 'Middle line.' ? 1350 : 600;
          return {
            recording: {
              id: `take-${cmd.script}`,
              characterId: cmd.character.id,
              characterName: cmd.character.name,
              transcript: cmd.script,
              blob: createValidTestWavBlob(ms),
              audioDurationSeconds: ms / 1000,
              seed: 11,
            },
            uploadedFileData: null,
          };
        },
      },
      logger: { debug() {}, warn() {}, error() {} },
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services },
        React.createElement(VideoSubtitleWorkspace, { notices: null })));
      await new Promise(r => setTimeout(r, 0));
    });

    const fileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mkv'], 'clip.mkv', { type: 'video/x-matroska' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => {
      dom.container.querySelector('#subtitle-extract-btn').click();
      await new Promise(r => setTimeout(r, 15));
    });

    await act(async () => {
      const selectAll = dom.container.querySelector('#subtitle-select-all');
      selectAll.checked = true;
      selectAll.dispatchEvent({ type: 'click', bubbles: true, target: selectAll });
    });
    await act(async () => {
      dom.container.querySelector('#subtitle-generate-voice-btn').click();
      await new Promise(r => setTimeout(r, 40));
    });

    const rows = dom.container.querySelectorAll('.subtitle-segment-row');
    const findRemedyBtn = (row, action) => row.querySelectorAll('.subtitle-validation-fix-btn')
      .find(btn => btn.getAttribute('data-remedy-action') === action);

    // 1. Tail Cue #3 [3.35, 3.50] exceeds 3.50s transcribe mediaDuration -> cannot Extend or Allow spill, offers Remove voice
    assert.equal(findRemedyBtn(rows[2], 'extend_cue'), undefined, 'Must block Extend cue past transcribe duration');
    assert.equal(findRemedyBtn(rows[2], 'allow_spill'), undefined, 'Must block Allow spill past transcribe duration');
    const removeBtn = findRemedyBtn(rows[2], 'remove_clip');
    assert.ok(removeBtn, 'Wedged tail cue must offer explicit Remove voice remedy');
    await act(async () => { removeBtn.click(); });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 3, 'Remove voice must keep subtitle cue intact');

    // 2. Approve spill on Cue #1 [0.0, 1.0] (1.6s clip before Cue #2 at 2.0s) -> clean!
    await act(async () => {
      findRemedyBtn(rows[0], 'allow_spill').click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(dom.container.querySelector('.subtitle-mismatch-export-banner'), null);

    // 3. Edit Cue #2's start timestamp into 1.4s via TimingInlineEditor -> revokes Cue #1's spill approval and re-blocks export!
    const row2TimeToggle = rows[1].querySelectorAll('.subtitle-cue-btn')
      .find(btn => btn.textContent.includes('Time'));
    await act(async () => { row2TimeToggle.click(); });
    const [startInput] = rows[1].querySelectorAll('.subtitle-timing-input');
    await act(async () => {
      startInput.focus();
      startInput._value = '00:01.4';
      startInput.dispatchEvent({ type: 'input', bubbles: true, target: startInput });
    });
    await act(async () => {
      startInput.blur();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(rows[0].querySelector('.subtitle-cue-spill-badge'), null, 'Colliding neighbor edit must immediately revoke spill badge');
    assert.ok(dom.container.querySelector('.subtitle-mismatch-export-banner'), 'Revoked spill must re-block export');

    // 4. Re-extracting subtitles clears old segmentClips and spillApprovals cleanly
    await act(async () => {
      dom.container.querySelector('#subtitle-extract-btn').click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(dom.container.querySelector('#subtitle-voice-output'), null, 'Fresh re-extract must reset prior voiceover clips');
    assert.equal(dom.container.querySelector('.subtitle-mismatch-export-banner'), null);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted VideoSubtitleWorkspace supports Undo/Redo across edits/split/merge/delete/timing, stale-translation remedies, and subtitle take switching', async () => {
  const dom = createDomShim();
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
  const origAudio = globalThis.Audio;
  const playedUrls = [];
  class FakeAudio {
    constructor() { this.listeners = new Map(); this.currentTime = 0; this.src = ''; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    pause() {}
    play() { playedUrls.push(this.src); return Promise.resolve(); }
  }
  globalThis.Audio = FakeAudio;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');

    const assetsById = new Map();
    let assetSeq = 0;
    let takeSeq = 0;
    const translateCalls = [];
    const services = {
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true }),
        transcribeVideo: async () => ({
          jobId: 'job-ux201',
          duration: 6.0,
          language: 'en',
          translatedLanguage: 'khm_Khmr',
          isAudioOnly: false,
          speakers: ['speaker-1'],
          segments: [
            { id: 'seg-1', start: 0.0, end: 2.0, speakerId: 'speaker-1', text: 'First line.', translatedText: 'បន្ទាត់ទី១។' },
            { id: 'seg-2', start: 2.2, end: 4.5, speakerId: 'speaker-1', text: 'Second line.', translatedText: 'បន្ទាត់ទី២។' },
          ],
        }),
        translateSegments: async req => {
          translateCalls.push(req);
          return {
            segments: req.segments.map(s => ({ ...s, translatedText: `បកប្រែ:${s.text}` })),
          };
        },
      },
      synthesizeSpeech: {
        execute: async cmd => {
          takeSeq += 1;
          return {
            recording: {
              id: `take-${takeSeq}`,
              characterId: cmd.character.id,
              characterName: cmd.character.name,
              transcript: cmd.script,
              blob: createValidTestWavBlob(600),
              audioDurationSeconds: 0.6,
              seed: 10 + takeSeq,
            },
            uploadedFileData: null,
          };
        },
      },
      assetRepository: {
        uploadAsset: async ({ bytes, fileName, mimeType }) => {
          assetSeq += 1;
          const id = `00000000-0000-4000-8000-${String(assetSeq).padStart(12, '0')}`;
          const buf = new Uint8Array(await bytes.arrayBuffer());
          assetsById.set(id, { id, bytes: buf, fileName, mimeType });
          return { asset: { id } };
        },
        getAssetBinary: async id => assetsById.get(id) || null,
      },
      logger: { debug() {}, warn() {}, error() {} },
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services },
        React.createElement(VideoSubtitleWorkspace, { notices: null })));
      await new Promise(r => setTimeout(r, 0));
    });

    const fileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'ux201.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => {
      dom.container.querySelector('#subtitle-extract-btn').click();
      await new Promise(r => setTimeout(r, 15));
    });

    const undoBtn = () => dom.container.querySelector('#subtitle-undo-btn');
    const redoBtn = () => dom.container.querySelector('#subtitle-redo-btn');
    const isDisabled = el => Boolean(el?.disabled || el?.hasAttribute?.('disabled'));
    assert.equal(isDisabled(undoBtn()), true);
    assert.equal(isDisabled(redoBtn()), true);

    // Switch preview to Original so source edits are visible, then edit Cue #1 source text
    const previewSelect = dom.container.querySelectorAll('select')
      .find(el => el.getAttribute('aria-label') === 'Preview language');
    await act(async () => {
      previewSelect._value = 'original';
      previewSelect.dispatchEvent({ type: 'change', bubbles: true, target: previewSelect });
    });

    const getRow = idx => dom.container.querySelectorAll('.subtitle-segment-row')[idx];
    const editTextarea = (row, nextVal) => {
      const ta = row.querySelector('.subtitle-line-input');
      ta._value = nextVal;
      ta.dispatchEvent({ type: 'input', bubbles: true, target: ta });
      ta.blur();
    };

    await act(async () => { editTextarea(getRow(0), 'First line edited.'); });
    assert.equal(isDisabled(undoBtn()), false);

    // 1. Stale translation warning appears with Re-translate and Keep translation buttons
    assert.ok(getRow(0).textContent.includes('Source text changed since translation.'));
    const keepBtn = getRow(0).querySelectorAll('.subtitle-validation-fix-btn')
      .find(b => b.getAttribute('data-remedy-action') === 'dismiss_stale_translation');
    assert.ok(keepBtn);
    await act(async () => { keepBtn.click(); });
    assert.equal(getRow(0).textContent.includes('Source text changed since translation.'), false);

    // Edit again -> switch to Bilingual so stale pill stays visible -> empty retranslate must not wipe translation -> valid retranslate + immediate Undo restores stale flag
    await act(async () => { editTextarea(getRow(0), 'First line final.'); });
    await act(async () => {
      previewSelect._value = 'bilingual';
      previewSelect.dispatchEvent({ type: 'change', bubbles: true, target: previewSelect });
    });
    assert.ok(getRow(0).textContent.includes('Source text changed since translation.'));
    const origTranslateSegs = services.mediaSubtitleGateway.translateSegments;
    services.mediaSubtitleGateway.translateSegments = async () => ({ segments: [{ id: 'seg-1', translatedText: '' }] });
    await act(async () => {
      getRow(0).querySelectorAll('.subtitle-validation-fix-btn')
        .find(b => b.getAttribute('data-remedy-action') === 'retranslate_segment').click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(getRow(0).querySelector('.subtitle-line-input').value, 'បន្ទាត់ទី១។', 'Empty retranslate must preserve prior translation');
    assert.ok(getRow(0).textContent.includes('Source text changed since translation.'));

    services.mediaSubtitleGateway.translateSegments = origTranslateSegs;
    const retranslateBtn = getRow(0).querySelectorAll('.subtitle-validation-fix-btn')
      .find(b => b.getAttribute('data-remedy-action') === 'retranslate_segment');
    assert.ok(retranslateBtn);
    await act(async () => {
      retranslateBtn.click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(translateCalls.length, 1);
    assert.equal(translateCalls[0].segments.length, 1);
    assert.equal(translateCalls[0].segments[0].id, 'seg-1');
    assert.equal(getRow(0).textContent.includes('Source text changed since translation.'), false);
    assert.equal(getRow(0).querySelector('.subtitle-line-input').value, 'បកប្រែ:First line final.');

    await act(async () => {
      globalThis.document.dispatchEvent({ type: 'keydown', key: 'z', metaKey: true, bubbles: true, target: globalThis.document.body });
    });
    assert.ok(getRow(0).textContent.includes('Source text changed since translation.'), 'Undo after retranslate must restore stale warning');
    assert.equal(getRow(0).querySelector('.subtitle-line-input').value, 'បន្ទាត់ទី១។');
    await act(async () => { redoBtn().click(); });
    assert.equal(getRow(0).textContent.includes('Source text changed since translation.'), false);
    assert.equal(getRow(0).querySelector('.subtitle-line-input').value, 'បកប្រែ:First line final.');
    await act(async () => {
      previewSelect._value = 'original';
      previewSelect.dispatchEvent({ type: 'change', bubbles: true, target: previewSelect });
    });

    // 2. Subtitle take-switcher UI: generate Take 1 and Take 2 on Cue #1, switch back to Take 1, play Take 2, delete Take 2
    const getGenerateVoiceBtn = row => row.querySelector('.subtitle-cue-voice-btn');
    await act(async () => {
      getGenerateVoiceBtn(getRow(0)).click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(getRow(0).querySelector('.subtitle-takes-tray'), null, '1 take should not render multi-take tray');

    const voiceSelect = dom.container.querySelector('#subtitle-tts-voice');
    const secondVoice = BUILT_IN_VOICES[1]?.id || BUILT_IN_VOICES[0].id;
    await act(async () => {
      voiceSelect._value = secondVoice;
      voiceSelect.dispatchEvent({ type: 'change', bubbles: true, target: voiceSelect });
    });
    await act(async () => {
      getGenerateVoiceBtn(getRow(0)).click();
      await new Promise(r => setTimeout(r, 20));
    });
    const tray = getRow(0).querySelector('.subtitle-takes-tray');
    assert.ok(tray, '2 takes must render subtitle take switcher tray');
    assert.ok(tray.textContent.includes('Takes (2):'));
    const chips = tray.querySelectorAll('.segment-take-chip');
    assert.equal(chips.length, 2);
    assert.ok(chips[1].textContent.includes('Active'));

    // Click Take 1 chip to switch active take back to Take 1
    await act(async () => {
      chips[0].click();
      await new Promise(r => setTimeout(r, 10));
    });
    const chipsAfterSwitch = getRow(0).querySelectorAll('.segment-take-chip');
    assert.ok(chipsAfterSwitch[0].textContent.includes('Active'));
    assert.equal(chipsAfterSwitch[1].textContent.includes('Active'), false);

    // Play Take 2 directly from chip play button
    const playTake2Btn = chipsAfterSwitch[1].querySelector('.segment-take-play-btn');
    await act(async () => {
      playTake2Btn.click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(playedUrls.length, 1);

    // 3. Split, Merge, Timing Nudge, Delete -> Undo & Redo (preserving Cue #1 takes!)
    await act(async () => {
      const splitBtn = getRow(0).querySelectorAll('.subtitle-cue-btn').find(b => b.textContent.includes('Split'));
      splitBtn.click();
    });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 3);

    await act(async () => { undoBtn().click(); });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 2);
    assert.ok(getRow(0).querySelector('.subtitle-takes-tray'), 'Undo split must keep live takes on Cue #1');

    await act(async () => {
      const mergeBtn = getRow(0).querySelectorAll('.subtitle-cue-btn').find(b => b.textContent.includes('Merge'));
      mergeBtn.click();
    });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 1);
    await act(async () => { undoBtn().click(); });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 2);

    // Timing nudge +0.2s then Ctrl+Z undo & Ctrl+Shift+Z redo
    const timeBtn = getRow(0).querySelectorAll('.subtitle-cue-btn').find(b => b.textContent.includes('Time'));
    await act(async () => { timeBtn.click(); });
    const nudgePlus = getRow(0).querySelectorAll('.subtitle-nudge-btn').find(b => b.textContent === '+0.2s');
    await act(async () => { nudgePlus.click(); });
    assert.equal(getRow(0).querySelectorAll('.subtitle-timing-input')[0].value, '00:00.2');

    const cueList = dom.container.querySelector('.subtitle-cue-list');
    await act(async () => {
      cueList.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true, shiftKey: false, bubbles: true });
    });
    assert.equal(getRow(0).querySelectorAll('.subtitle-timing-input')[0].value, '00:00.0');
    await act(async () => {
      cueList.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true, shiftKey: true, bubbles: true });
    });
    assert.equal(getRow(0).querySelectorAll('.subtitle-timing-input')[0].value, '00:00.2');

    // Delete Cue #1 (which has 2 persisted takes) and Undo -> resurrects Cue #1 with its persisted takes!
    const deleteCue1Btn = getRow(0).querySelector('.subtitle-cue-delete');
    await act(async () => { deleteCue1Btn.click(); });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 1);

    await act(async () => {
      undoBtn().click();
      await new Promise(r => setTimeout(r, 15));
    });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 2);
    assert.ok(getRow(0).querySelector('.subtitle-takes-tray'), 'Undoing cue delete must restore persisted takes');
    assert.equal(getRow(0).querySelectorAll('.segment-take-chip').length, 2);

    // Delete Take 2 from tray -> returns to 1 take (tray hidden)
    const delTake2Btn = getRow(0).querySelectorAll('.segment-take-delete-btn')[1];
    await act(async () => { delTake2Btn.click(); });
    assert.equal(getRow(0).querySelector('.subtitle-takes-tray'), null);
    assert.ok(getRow(0).querySelector('.subtitle-cue-audio-controls'), 'Take 1 remains active after deleting Take 2');
  } finally {
    globalThis.Audio = origAudio;
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('mounted VideoSubtitleWorkspace allows Undoing deletion of the last cue, skips Undo inside find/timing inputs, and hydrates uncached takes across mid-flight edits', async () => {
  const dom = createDomShim();
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
  const origAudio = globalThis.Audio;
  const playedSources = [];
  class FakeAudio {
    constructor() { this.listeners = new Map(); this.currentTime = 0; this.src = ''; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    pause() {}
    play() { playedSources.push(this.src); return Promise.resolve(); }
  }
  globalThis.Audio = FakeAudio;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');

    const asset1 = '11111111-1111-4111-8111-111111111111';
    const asset2 = '22222222-2222-4222-8222-222222222222';
    const wavBytes1 = new Uint8Array(await createValidTestWavBlob(500).arrayBuffer());
    const wavBytes2 = new Uint8Array(await createValidTestWavBlob(700).arrayBuffer());
    let resolveAsset1 = null;
    const savedProject = {
      id: 'proj-takes-reload',
      kind: 'subtitle',
      type: 'subtitles',
      title: 'Saved Reload',
      revision: 1,
      payload: {
        videoFileName: 'reload.mp4',
        detectedLanguage: 'en',
        hasTranslation: false,
        segments: [
          {
            id: 'seg-only',
            start: 0,
            end: 2,
            speakerId: 'speaker-1',
            text: 'Saved cue.',
            takes: [
              { id: 't1', audioAssetId: asset1, duration: 0.5, isSelected: false, settings: { text: 'Saved cue.', voiceId: BUILT_IN_VOICES[0].id, characterName: BUILT_IN_VOICES[0].name } },
              { id: 't2', audioAssetId: asset2, duration: 0.7, isSelected: true, settings: { text: 'Saved cue.', voiceId: BUILT_IN_VOICES[0].id, characterName: BUILT_IN_VOICES[0].name } },
            ],
          },
        ],
        subtitleOptions: { sourceLanguage: 'en', previewMode: 'original' },
      },
    };
    const services = {
      mediaSubtitleGateway: { checkHealth: async () => ({ online: true, burnInSupported: true }) },
      projectRepository: {
        listProjects: async () => ({ items: [savedProject] }),
        getProject: async () => savedProject,
        saveProject: async (_id, data) => ({ ...savedProject, ...data, revision: 2 }),
      },
      assetRepository: {
        getAssetBinary: id => {
          if (id === asset2) return Promise.resolve({ id, bytes: wavBytes2, mimeType: 'audio/wav' });
          if (id === asset1) return new Promise(resolve => { resolveAsset1 = () => resolve({ id, bytes: wavBytes1, mimeType: 'audio/wav' }); });
          return Promise.resolve(null);
        },
      },
      logger: { debug() {}, warn() {}, error() {} },
    };

    const actionsRef = { current: null };
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services },
        React.createElement(VideoSubtitleWorkspace, { notices: null, actionsRef, autoRestoreLatest: false })));
      await new Promise(r => setTimeout(r, 10));
    });
    await act(async () => {
      actionsRef.current.loadProject(savedProject);
      await new Promise(r => setTimeout(r, 20));
    });

    // Active Take 2 hydrated immediately on project load
    assert.ok(dom.container.querySelector('.subtitle-cue-audio-controls'), 'Active Take 2 must hydrate on load');

    // Inner button Enter keydown on Take 1 play button must NOT switch active take
    const playTake1Btn = dom.container.querySelectorAll('.segment-take-play-btn')[0];
    await act(async () => {
      playTake1Btn.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, target: playTake1Btn });
    });
    assert.ok(dom.container.querySelectorAll('.segment-take-chip')[1].textContent.includes('Active'));

    // Switching to uncached Take 1 immediately clears stale Take 2 audio bar while Take 1 downloads,
    // and deleting a take while its preview fetch is pending cancels delayed audio playback!
    const playTake1ForRace = dom.container.querySelectorAll('.segment-take-play-btn')[0];
    await act(async () => { playTake1ForRace.click(); });
    const chip1 = dom.container.querySelectorAll('.segment-take-chip')[0];
    await act(async () => { chip1.click(); });
    assert.equal(dom.container.querySelector('.subtitle-cue-audio-controls'), null, 'Uncached take switch must clear stale active clip until hydrated');

    // Editing cue text while Take 1 is still downloading must NOT cancel or drop Take 1 hydration!
    const ta = dom.container.querySelector('.subtitle-line-input');
    await act(async () => {
      ta._value = 'Saved cue edited.';
      ta.dispatchEvent({ type: 'input', bubbles: true, target: ta });
      ta.blur();
    });
    await act(async () => {
      resolveAsset1?.();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(playedSources.length, 0, 'Cancelled pending take preview must not auto-play after take switch');
    assert.ok(dom.container.querySelector('.subtitle-cue-audio-controls'), 'In-flight take hydration must complete even after concurrent cue edit');

    // Ctrl+Z inside Find input or Timing input must NOT trigger subtitle cue Undo (via real .closest())
    await act(async () => { dom.container.querySelector('#subtitle-find-toggle').click(); });
    const findInput = dom.container.querySelector('#subtitle-find-input');
    await act(async () => {
      findInput.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true, bubbles: true, target: findInput });
    });
    assert.equal(dom.container.querySelector('.subtitle-line-input').value, 'Saved cue edited.');

    const timeBtn = dom.container.querySelectorAll('.subtitle-cue-btn').find(b => b.textContent.includes('Time'));
    await act(async () => { timeBtn.click(); });
    const timingInput = dom.container.querySelector('.subtitle-timing-input');
    await act(async () => {
      timingInput.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true, bubbles: true, target: timingInput });
    });
    assert.equal(dom.container.querySelector('.subtitle-line-input').value, 'Saved cue edited.');

    // Deleting the ONLY cue keeps Undo button and document Ctrl+Z working!
    await act(async () => { dom.container.querySelector('.subtitle-cue-delete').click(); });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 0);
    assert.ok(dom.container.querySelector('#subtitle-undo-btn'), 'Undo button must remain visible after deleting the last cue');

    await act(async () => {
      globalThis.document.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true, bubbles: true, target: globalThis.document.body });
    });
    assert.equal(dom.container.querySelectorAll('.subtitle-segment-row').length, 1, 'Document Ctrl+Z must resurrect the last deleted cue');
  } finally {
    globalThis.Audio = origAudio;
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});
