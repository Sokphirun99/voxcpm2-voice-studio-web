/**
 * @fileoverview Mounted integration test covering multi-function switching, speaker-colored extraction, editing, burn-in, and TTS handoff.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createVoiceAnchorUseCases, createVoiceLibraryUseCases } from '../../src/domain/useCases.js';

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
      this.attributes.set(k, String(v));
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
      if (k === 'type') this.type = String(v);
      if (k === 'hidden') this.hidden = true;
      if (k.startsWith('on')) this[k] = () => {};
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    removeAttribute(k) {
      this.attributes.delete(k);
      if (k === 'id') this.id = '';
      if (k === 'hidden') this.hidden = false;
    }
    hasAttribute(k) { return this.attributes.has(k); }
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
    click() {
      if (this.tagName === 'A') return;
      this.dispatchEvent({ type: 'click', bubbles: true });
    }
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
      this.onchange = null;
      this.files = [];
      this.checked = false;
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
      this._value = next;
      this._dirtyValue = true;
    }
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

    const fileInput = dom.container.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4bytes'], 'news-clip.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });

    const extractBtn = dom.container.querySelector('#subtitle-extract-btn');
    await act(async () => { extractBtn.click(); });

    const rows = dom.container.querySelectorAll('.subtitle-segment-row');
    assert.equal(rows.length, 2);
    assert.ok(dom.container.querySelector('track'));

    const renameInput = dom.container.querySelector('.subtitle-roster-input');
    await act(async () => {
      renameInput._value = 'ពិធីករ';
      renameInput.dispatchEvent({ type: 'input', bubbles: true, target: renameInput });
    });

    const burnBtn = dom.container.querySelector('#subtitle-burn-btn');
    await act(async () => { burnBtn.click(); });
    assert.ok(burnRequest);
    assert.equal(burnRequest.speakerNames['speaker-1'], 'ពិធីករ');
    assert.equal(burnRequest.useTranslation, true);

    const sendTtsBtn = dom.container.querySelector('#subtitle-send-tts-btn');
    await act(async () => { sendTtsBtn.click(); });

    assert.equal(subPanel.hasAttribute('hidden'), true);
    assert.equal(dom.container.querySelector('#script').value, 'សួស្តីពេលល្ងាច។ សូមស្វាគមន៍ការត្រឡប់មកវិញ។');
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});
