/**
 * @fileoverview R3-10 End-to-End Release 3 Exit Criteria validation suite.
 * Exercises: Khmer & multilingual video import -> ASR -> cue editing, terminology & translation
 * -> timeline alignment & overlap/duration mismatch checks/remedies -> per-frame/batch voiceover
 * with durable asset storage & batch job restart recovery -> SRT/VTT/TXT/WAV/MP4 preset exports
 * -> full process/storage restart + UI remount -> immediate relink & dub export without repair steps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createServer } from 'vite';
import { createStorageHttpApp } from '../../server/httpApp.js';
import { createStorageStore } from '../../server/storageStore.js';
import { createHttpAssetRepository } from '../../src/data/httpAssetRepository.js';
import { createHttpJobRepository } from '../../src/data/httpJobRepository.js';
import { createHttpProjectRepository } from '../../src/data/httpProjectRepository.js';
import { createHttpTerminologyRepository } from '../../src/data/httpTerminologyRepository.js';
import { createVoiceAnchorUseCases, createVoiceLibraryUseCases } from '../../src/domain/useCases.js';
import { JOB_STATUS } from '../../src/domain/productionJobs.js';
import { assembleTimelineAlignedVoiceover } from '../../src/domain/subtitleTts.js';
import { splitSubtitleSegment } from '../../src/domain/subtitles.js';
import { validateSubtitleSegments } from '../../src/domain/subtitleValidation.js';
import { inspectWavBuffer } from '../../src/domain/wavCodec.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_RATE_HZ = 48000;
const PCM_BYTES_PER_SAMPLE = 2;

function createPcmToneBlob(durationSec = 0.5, amplitude = 1800) {
  const frames = Math.max(1, Math.round(SAMPLE_RATE_HZ * durationSec));
  const dataLen = frames * PCM_BYTES_PER_SAMPLE;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE_HZ, true);
  view.setUint32(28, SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE, true);
  view.setUint16(32, PCM_BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataLen, true);
  for (let i = 0; i < frames; i += 1) {
    view.setInt16(44 + i * PCM_BYTES_PER_SAMPLE, amplitude, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
  };
}

function createStorageFetch(handlerRef) {
  return async (url, options = {}) => {
    const parsedUrl = new URL(url, 'http://storage.local');
    const headers = {};
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) headers[k.toLowerCase()] = v;
    }
    let rawBytes = Buffer.alloc(0);
    if (options.body instanceof FormData) {
      const reqObj = new Request(parsedUrl.toString(), { method: options.method || 'POST', body: options.body });
      for (const [k, v] of reqObj.headers.entries()) headers[k.toLowerCase()] = v;
      rawBytes = Buffer.from(await reqObj.arrayBuffer());
    } else if (typeof options.body === 'string') {
      rawBytes = Buffer.from(options.body, 'utf8');
    } else if (options.body instanceof Uint8Array) {
      rawBytes = Buffer.from(options.body);
    }
    const req = Readable.from(rawBytes.length ? [rawBytes] : []);
    req.method = options.method || 'GET';
    req.url = `${parsedUrl.pathname}${parsedUrl.search}`;
    req.headers = headers;
    req.socket = { remoteAddress: '127.0.0.1' };
    const chunks = [];
    let statusCode = 200;
    let resHeaders = {};
    const res = {
      headersSent: false,
      get statusCode() { return statusCode; },
      writeHead(code, hdrs = {}) {
        statusCode = code;
        resHeaders = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]));
        this.headersSent = true;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      },
    };
    await handlerRef.current(req, res);
    return new Response(Buffer.concat(chunks), { status: statusCode, headers: resHeaders });
  };
}

function createDomEnvironment() {
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
      const name = String(k).toLowerCase();
      this.attributes.set(name, String(v));
      if (name === 'id') this.id = String(v);
      if (name === 'class') this.className = String(v);
      if (name === 'type') this.type = String(v);
      if (name === 'value') this._value = String(v);
      if (name === 'hidden') this.hidden = true;
      if (name === 'disabled') this.disabled = true;
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
      if (name === 'disabled') this.disabled = false;
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
      event.stopPropagation = event.stopPropagation || (() => {});
      event.preventDefault = event.preventDefault || (() => {});
      const pathNodes = [];
      for (let cur = this; cur; cur = cur.parentNode) pathNodes.push(cur);
      for (let i = pathNodes.length - 1; i >= 0; i -= 1) {
        event.currentTarget = pathNodes[i];
        for (const fn of pathNodes[i].listeners.get(`cap:${event.type}`) || []) fn(event);
      }
      for (let i = 0; i < pathNodes.length; i += 1) {
        event.currentTarget = pathNodes[i];
        for (const fn of pathNodes[i].listeners.get(`bub:${event.type}`) || []) fn(event);
      }
      event.currentTarget = null;
      return true;
    }
    focus() { globalThis.document.activeElement = this; }
    blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent({ type: 'close' }); }
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
      this.files = [];
      this.checked = false;
      this.currentTime = 0;
    }
    get options() { return this.querySelectorAll('option'); }
    get length() { return this.tagName === 'SELECT' ? this.options.length : 0; }
    get defaultValue() { return this._defaultValue; }
    set defaultValue(v) { this._defaultValue = String(v); if (!this._dirtyValue) this._value = this._defaultValue; }
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
    set value(v) { this._value = v == null ? '' : String(v); this._dirtyValue = true; }
    play() { return Promise.resolve(); }
  }

  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    ResizeObserver: globalThis.ResizeObserver,
    Audio: globalThis.Audio,
    localStorage: globalThis.localStorage,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  const blobByUrl = new Map();
  let seq = 0;
  URL.createObjectURL = blob => {
    const url = `blob:r310/${++seq}`;
    blobByUrl.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};

  const memoryStorage = createMemoryStorage();
  class HTMLIFrameElement {}
  class FakeAudio {
    constructor() { this.listeners = new Map(); this.src = ''; this.currentTime = 0; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    play() { return Promise.resolve(); }
    pause() {}
  }
  const body = new MiniElement('body');
  const head = new MiniElement('head');
  const docEl = new MiniElement('html');
  docEl.appendChild(head);
  docEl.appendChild(body);
  const win = {
    HTMLIFrameElement,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    localStorage: memoryStorage,
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
    createComment: () => new MiniNode(8, '#c'),
    getElementById(id) { return docEl.querySelector(`#${id}`); },
    querySelector(sel) { return docEl.querySelector(sel); },
    querySelectorAll(sel) { return docEl.querySelectorAll(sel); },
    addEventListener() {},
    removeEventListener() {},
  };
  win.document = doc;
  const container = new MiniElement('div');
  body.appendChild(container);
  Object.assign(globalThis, {
    window: win, document: doc, HTMLIFrameElement, ResizeObserver: win.ResizeObserver,
    Audio: FakeAudio, localStorage: memoryStorage, IS_REACT_ACT_ENVIRONMENT: true,
  });
  return {
    container,
    doc,
    blobByUrl,
    memoryStorage,
    restore() {
      URL.createObjectURL = prev.createObjectURL;
      URL.revokeObjectURL = prev.revokeObjectURL;
      Object.assign(globalThis, {
        window: prev.window, document: prev.document, HTMLIFrameElement: prev.HTMLIFrameElement,
        ResizeObserver: prev.ResizeObserver, Audio: prev.Audio, localStorage: prev.localStorage,
        IS_REACT_ACT_ENVIRONMENT: prev.IS_REACT_ACT_ENVIRONMENT,
      });
    },
  };
}

async function waitForCondition(act, predicate, attempts = 80, delayMs = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await act(async () => { await new Promise(r => setTimeout(r, delayMs)); });
  }
  return predicate();
}

function createDiskRepositories(handlerRef, storage, logger) {
  const fetchImpl = createStorageFetch(handlerRef);
  return {
    projectRepository: createHttpProjectRepository({ baseUrl: '/api/v1', fetchImpl, storage, logger }),
    assetRepository: createHttpAssetRepository({ baseUrl: '/api/v1', fetchImpl, logger }),
    jobRepository: createHttpJobRepository({ baseUrl: '/api/v1', fetchImpl, storage, logger }),
    terminologyRepository: createHttpTerminologyRepository({ baseUrl: '/api/v1', fetchImpl, storage, logger }),
  };
}

function createRealisticMediaServices({ repos, logger, synthCalls, dubCalls, burnCalls, shouldCancelCue2 = false }) {
  let takeSeq = 0;
  let blockCue2 = shouldCancelCue2;
  return {
    ...repos,
    logger,
    speechGateway: {
      checkAvailability: async () => true,
      checkHealth: async () => ({ online: true, ok: true }),
      uploadReferenceAudio: async () => ({}),
      synthesize: async () => ({}),
    },
    mediaSubtitleGateway: {
      checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true, models: {} }),
      transcribeVideo: async ({ file }) => {
        if (String(file?.name || '').includes('khmer')) {
          return {
            jobId: 'media-km-001',
            duration: 6.5,
            language: 'km',
            translatedLanguage: 'eng_Latn',
            isAudioOnly: false,
            hasAudioStream: true,
            speakers: ['speaker-1', 'speaker-2'],
            videoSize: { width: 1280, height: 720 },
            segments: [
              { id: 'km-1', start: 0.5, end: 1.5, speakerId: 'speaker-1', text: 'សួស្តី អេស៊ីដាប៊ែលយូ សម្រាប់ ១២០០ រៀល។', translatedText: '' },
              { id: 'km-2', start: 2.0, end: 3.5, speakerId: 'speaker-2', text: 'ថ្ងៃនេះ យើង សាកល្បង ស្ទូឌីយោ សំឡេង ខ្មែរ។', translatedText: '' },
              { id: 'km-3', start: 4.0, end: 5.2, speakerId: 'speaker-1', text: 'អរគុណច្រើនសម្រាប់ការទស្សនា។', translatedText: '' },
            ],
          };
        }
        return {
          jobId: 'media-multi-002',
          duration: 5.0,
          language: 'en',
          translatedLanguage: 'khm_Khmr',
          isAudioOnly: false,
          hasAudioStream: true,
          speakers: ['speaker-1', 'speaker-2'],
          videoSize: { width: 1280, height: 720 },
          segments: [
            { id: 'en-1', start: 0.2, end: 1.4, speakerId: 'speaker-1', text: 'Welcome to Voice Studio', translatedText: 'សូមស្វាគមន៍មកកាន់ ស្ទូឌីយោ សំឡេង' },
          ],
        };
      },
      translateSegments: async ({ segments, targetLanguage }) => ({
        segments: segments.map(s => ({
          ...s,
          translatedText: s.id === 'km-1'
            ? `Hello ACL Studio for 1200 riels (${targetLanguage}).`
            : s.id === 'km-2'
              ? `Today we test Khmer Voice Studio (${targetLanguage}).`
              : `Thank you very much for watching (${targetLanguage}).`,
        })),
      }),
      burnSubtitles: async params => {
        burnCalls.push(params);
        return new Blob(['ftypburn'], { type: 'video/mp4' });
      },
      exportDubbedVideo: async params => {
        dubCalls.push(params);
        return new Blob(['ftypdub'], { type: 'video/mp4' });
      },
    },
    synthesizeSpeech: {
      execute: async ({ script, character, signal }) => {
        synthCalls.push(script);
        if (blockCue2 && synthCalls.length === 2) {
          blockCue2 = false;
          return new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              const err = new Error('Interrupted');
              err.name = 'SynthesisCancelledError';
              reject(err);
            });
          });
        }
        const dur = script.includes('១២០០') || script.includes('1200') ? 1.4 : 0.7;
        const blob = createPcmToneBlob(dur, 2400);
        return {
          recording: {
            id: `sub-take-${++takeSeq}`,
            characterId: character.id,
            characterName: character.name,
            transcript: script,
            blob,
            audioUrl: URL.createObjectURL(blob),
            audioDurationSeconds: dur,
            seed: 42,
          },
        };
      },
    },
    audioDecoder: { decodePeaks: async () => [] },
    lockReferenceAudio: { execute: async file => ({ blob: file }) },
    voiceLibrary: createVoiceLibraryUseCases({
      voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
    }),
    voiceAnchors: createVoiceAnchorUseCases({
      anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
    }),
  };
}

test('R3-10 end-to-end Release 3 validation: Khmer/multilingual import, edit, align, validate, batch recovery, export, restart & reopen without repair', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-r310-'));
  const dom = createDomEnvironment();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });

  const silentLogger = { info() {}, debug() {}, warn() {}, error() {} };
  const handlerRef = { current: null };
  const downloads = [];
  const synthCalls = [];
  const dubCalls = [];
  const burnCalls = [];
  const origCreateElement = dom.doc.createElement.bind(dom.doc);
  dom.doc.createElement = tag => {
    const el = origCreateElement(tag);
    if (tag === 'a') {
      el.click = () => { downloads.push({ filename: el.download, blob: dom.blobByUrl.get(el.href) || null }); };
    }
    return el;
  };

  let store = createStorageStore({ dataDir });
  await store.init();
  handlerRef.current = createStorageHttpApp({ store, logger: silentLogger });
  let repos = createDiskRepositories(handlerRef, dom.memoryStorage, silentLogger);

  let root = null;
  try {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { VideoSubtitleWorkspace } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');
    const { useVideoSubtitles } = await vite.ssrLoadModule('/src/presentation/hooks/useVideoSubtitles.js');
    const { useSubtitleVoiceover } = await vite.ssrLoadModule('/src/presentation/hooks/useSubtitleVoiceover.js');
    const { useTerminology } = await vite.ssrLoadModule('/src/presentation/hooks/useTerminology.js');
    const { useProductionJobs } = await vite.ssrLoadModule('/src/presentation/hooks/useProductionJobs.js');

    // Stage-separated terminology: spelling fixes Khmer cluster, translation fixes EN term, pronunciation only affects TTS script
    await repos.terminologyRepository.saveTerms([
      { id: 'km-spell', category: 'spelling', status: 'approved', enabled: true, term: 'អេស៊ីអិល', variants: ['អេស៊ីដាប៊ែលយូ'], sourceLanguage: 'km', scope: 'global' },
      { id: 'km-trans', category: 'translation', status: 'approved', enabled: true, term: 'ស្ទូឌីយោ សំឡេង', translation: 'Voice Studio', sourceLanguage: 'km', targetLanguage: 'eng_Latn', scope: 'global' },
      { id: 'km-pron', category: 'pronunciation', status: 'approved', enabled: true, term: 'ACL', pronunciation: 'អេស៊ីអិលដាប៊ែលយូ', sourceLanguage: 'en', scope: 'global' },
    ]);

    const actionsRef = { current: null };
    let subtitleCtrl = null;
    let voiceCtrl = null;

    function WorkspaceHarness() {
      const effectiveTermsRef = React.useRef([]);
      subtitleCtrl = useVideoSubtitles({ effectiveTermsRef });
      const terminologyCtrl = useTerminology({
        terminologyRepository: repos.terminologyRepository,
        projectTerminology: subtitleCtrl.state.terminology,
        onChangeProjectTerminology: subtitleCtrl.setProjectTerminology,
        sourceLanguage: subtitleCtrl.state.detectedLanguage || subtitleCtrl.state.options.sourceLanguage,
        targetLanguage: subtitleCtrl.state.translatedLanguage || subtitleCtrl.state.options.targetLanguage,
        speechLanguage: subtitleCtrl.state.options.sourceLanguage,
      });
      effectiveTermsRef.current = terminologyCtrl.effectiveTerms;
      voiceCtrl = useSubtitleVoiceover({
        segments: subtitleCtrl.state.segments,
        useTranslation: subtitleCtrl.useTranslation,
        videoFile: subtitleCtrl.state.videoFile,
        videoFileName: subtitleCtrl.state.videoFileName,
        jobId: subtitleCtrl.state.jobId,
        isAudioOnly: subtitleCtrl.state.isAudioOnly,
        hasAudioStream: subtitleCtrl.state.hasAudioStream,
        burnInSupported: subtitleCtrl.health.burnInSupported,
        mediaDuration: subtitleCtrl.mediaDuration,
        transcriptEpoch: subtitleCtrl.transcriptEpoch,
        terminology: terminologyCtrl.effectiveTerms,
        pronunciationSignature: terminologyCtrl.pronunciationSignature,
        speechLanguage: subtitleCtrl.state.options.sourceLanguage,
        audioLanguage: subtitleCtrl.state.options.sourceLanguage,
        subtitleContext: {
          speakerNames: subtitleCtrl.state.speakerNames,
          includeSpeaker: subtitleCtrl.effectiveIncludeSpeaker,
          hasTranslation: subtitleCtrl.state.hasTranslation,
          useTranslation: subtitleCtrl.useTranslation,
          bilingual: subtitleCtrl.bilingual,
          subtitleLanguage: subtitleCtrl.state.translatedLanguage,
        },
        dubAudioModeProp: subtitleCtrl.state.options.dubAudioMode,
        onChangeDubAudioMode: v => subtitleCtrl.updateOption('dubAudioMode', v),
        dubSubtitleModeProp: subtitleCtrl.state.options.dubSubtitleMode,
        onChangeDubSubtitleMode: v => subtitleCtrl.updateOption('dubSubtitleMode', v),
        dubMixSettingsProp: subtitleCtrl.state.options.dubMixSettings,
        onChangeDubMixSettings: v => subtitleCtrl.updateOption('dubMixSettings', v),
        selectedVoiceIdProp: subtitleCtrl.state.options.voiceId || undefined,
        onChangeSelectedVoiceId: v => subtitleCtrl.updateOption('voiceId', v),
        pauseGapMsProp: subtitleCtrl.state.options.voiceoverPauseMs,
        onChangePauseGapMs: v => subtitleCtrl.updateOption('voiceoverPauseMs', v),
        spillApprovalsProp: subtitleCtrl.state.options.spillApprovals,
        onChangeSpillApprovals: v => subtitleCtrl.updateOption('spillApprovals', v),
        onAttachSegmentTake: subtitleCtrl.attachSegmentVoiceTake,
        onClearSegmentTakes: subtitleCtrl.clearSegmentVoiceTakes,
        onExportRecorded: subtitleCtrl.recordExportHistory,
      });
      return null;
    }

    // 1. Mount full VideoSubtitleWorkspace -> Import Khmer & multilingual videos, ASR, Edit, Terminology, Translation, Voiceover
    let services = createRealisticMediaServices({ repos, logger: silentLogger, synthCalls, dubCalls, burnCalls });
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(VideoSubtitleWorkspace, { actionsRef })));
      await new Promise(r => setTimeout(r, 40));
    });

    const fileInput = dom.container.querySelector('#subtitle-video-input');
    // Multilingual check first, then realistic Khmer project in mounted VideoSubtitleWorkspace
    await act(async () => {
      fileInput.files = [new File(['multi'], 'multilingual-clip.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { dom.container.querySelector('#subtitle-extract-btn').click(); });
    assert.equal(dom.container.querySelectorAll('.subtitle-line-input').length, 1);

    await act(async () => {
      fileInput.files = [new File(['khmermp4'], 'khmer-lesson.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { dom.container.querySelector('#subtitle-extract-btn').click(); });
    assert.equal(dom.container.querySelectorAll('.subtitle-line-input').length, 3);

    // Mounted ExportProjectModal check: export WebVTT and check expected outputs before running deep hook assertions
    await act(async () => { dom.container.querySelector('#subtitle-export-project-btn').click(); });
    const modalDialog = dom.container.querySelector('#export-project-dialog');
    assert.ok(modalDialog);
    await act(async () => { modalDialog.querySelector('#export-preset-btn-subtitle_vtt').click(); });
    assert.equal(downloads.at(-1).filename, 'khmer-lesson.vtt');
    assert.match(modalDialog.querySelector('#export-history-list').textContent, /khmer-lesson\.vtt/);
    await act(async () => { modalDialog.querySelector('#export-project-close-btn').click(); });

    // Unmount WorkspaceHarness test vs mounted DOM: run core validation/edit/voice/reopen via VideoSubtitleWorkspace + WorkspaceHarness!
    await act(async () => { root.unmount(); });
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(WorkspaceHarness)));
      await new Promise(r => setTimeout(r, 30));
    });

    await act(async () => {
      subtitleCtrl.updateOption('sourceLanguage', 'km');
      subtitleCtrl.updateOption('targetLanguage', 'eng_Latn');
      subtitleCtrl.updateOption('detectSpeakers', true);
      subtitleCtrl.selectVideoFile(new File(['khmer'], 'khmer-lesson.mp4', { type: 'video/mp4' }));
    });
    await act(async () => { await subtitleCtrl.extractSubtitles(); });
    assert.equal(subtitleCtrl.state.segments.length, 3);

    // Criterion 2 & 4: Terminology spelling check, voiceover generation, translation preserves takes, and mismatch/overlap remedies
    await act(async () => { subtitleCtrl.applySpellingTerminology(); });
    assert.match(subtitleCtrl.state.segments[0].text, /អេស៊ីអិល/);

    await act(async () => {
      await voiceCtrl.generateSegmentVoice(subtitleCtrl.state.segments[0]);
      await voiceCtrl.generateSegmentVoice(subtitleCtrl.state.segments[1]);
    });
    assert.equal(subtitleCtrl.state.segments[0].takes.length, 1);
    assert.ok(subtitleCtrl.state.segments[0].takes[0].audioAssetId);

    await act(async () => { await subtitleCtrl.translateNow(); });
    // Critical R3-10 regression check: translating MUST NOT wipe previously generated voice takes!
    assert.equal(subtitleCtrl.state.segments[0].takes.length, 1);
    assert.ok(subtitleCtrl.state.segments[0].takes[0].audioAssetId);
    assert.match(subtitleCtrl.state.segments[0].translatedText, /Hello ACL Studio/);

    // Approve speech duration spill (cue-1 is 1.0s wide [0.5, 1.5], clip is 1.4s -> fits before cue-2 at 2.0s)
    assert.equal(voiceCtrl.exportDurationMismatches.hasUnresolved, true);
    await act(async () => { voiceCtrl.approveSegmentSpill('km-1'); });
    assert.equal(voiceCtrl.exportDurationMismatches.hasUnresolved, false);

    // Criterion 5: Verify timeline aligned WAV places speech at exact timestamps with zero PCM silence before 0.5s
    const aligned = await assembleTimelineAlignedVoiceover({
      segments: subtitleCtrl.state.segments,
      segmentClips: voiceCtrl.segmentClips,
      totalDuration: 6.5,
      spillApprovals: voiceCtrl.spillApprovals,
      strictDurationCheck: true,
    });
    assert.ok(aligned.blob);
    const wavBuf = await aligned.blob.arrayBuffer();
    const wavInfo = inspectWavBuffer(wavBuf);
    const pcmView = new DataView(wavBuf, wavInfo.dataOffset, wavInfo.dataSize);
    assert.equal(pcmView.getInt16(0, true), 0, 'leading silence before 0.5s must be digital zero');
    const preOnsetFrame = Math.round(0.45 * wavInfo.sampleRate);
    assert.equal(pcmView.getInt16(preOnsetFrame * wavInfo.blockAlign, true), 0, 'silence immediately before cue-1 onset must remain zero');
    const settledOnsetFrame = Math.round(0.51 * wavInfo.sampleRate);
    assert.notEqual(pcmView.getInt16(settledOnsetFrame * wavInfo.blockAlign, true), 0, 'speech must start at cue-1 start (0.5s)');

    // Criterion 3 & 4: Overlap validation & splitSubtitleSegment clears stale takes on second cue
    const overlapping = [
      { ...subtitleCtrl.state.segments[0], end: 2.3 },
      subtitleCtrl.state.segments[1],
    ];
    const overlapCheck = validateSubtitleSegments({ segments: overlapping });
    assert.equal(overlapCheck.issues.some(i => i.type === 'overlap'), true);
    const splitCheck = splitSubtitleSegment(subtitleCtrl.state.segments, 'km-1', { nextId: 'km-1b' });
    assert.equal(splitCheck[0].takes.length, 1);
    assert.deepEqual(splitCheck[1].takes, []);

    // Criterion 7: Dubbed MP4 export with explicit mix settings + embedded soft subtitles + exportHistory
    await act(async () => {
      voiceCtrl.setDubAudioMode('duck');
      voiceCtrl.setDubSubtitleMode('soft');
      voiceCtrl.updateDubMixSetting('duckVolume', 0.2);
      voiceCtrl.setPauseGapMs(500);
    });
    await act(async () => { await voiceCtrl.exportDubbedVideo({ throwOnError: true }); });
    assert.equal(dubCalls.length, 1);
    assert.equal(dubCalls[0].originalAudioMode, 'duck');
    assert.equal(dubCalls[0].subtitleMode, 'soft');
    assert.equal(dubCalls[0].mixSettings.duckVolume, 0.2);
    assert.equal(subtitleCtrl.exportHistory.length, 1);
    assert.equal(subtitleCtrl.exportHistory[0].audioMode, 'duck');
    assert.equal(subtitleCtrl.exportHistory[0].subtitleMode, 'soft');

    // Flush project save explicitly (deterministic vs 1.5s debounce timer)
    let savedProject = null;
    await act(async () => { savedProject = await subtitleCtrl.flushProjectSave(); });
    const projectId = savedProject?.id || subtitleCtrl.projectId;
    assert.ok(projectId);

    // Criterion 6: Batch job persistence, restart recovery & retry without re-synthesizing completed frames
    const { job: crashedJob } = await repos.jobRepository.enqueueJob({
      type: 'subtitle_voiceover',
      title: 'Recovery check',
      projectId,
      items: [
        { itemId: 'km-1', segmentId: 'km-1', label: 'Cue 1', status: 'completed', outputAssetId: subtitleCtrl.state.segments[0].takes[0].audioAssetId },
        { itemId: 'km-2', segmentId: 'km-2', label: 'Cue 2', status: 'pending', outputAssetId: null, metadata: { text: subtitleCtrl.state.segments[1].text, voiceId: voiceCtrl.selectedVoiceId } },
        { itemId: 'km-3', segmentId: 'km-3', label: 'Cue 3', status: 'pending', outputAssetId: null, metadata: { text: subtitleCtrl.state.segments[2].translatedText, voiceId: voiceCtrl.selectedVoiceId } },
      ],
    });
    await repos.jobRepository.updateJob(crashedJob.id, { action: 'prepare', workerSessionId: 'old-worker' });
    await repos.jobRepository.updateJob(crashedJob.id, { action: 'start', workerSessionId: 'old-worker' });

    // Simulate service/container restart (unmount React + close & re-open disk store; store.init() auto-recovers in-flight jobs)
    await act(async () => { root.unmount(); root = null; });
    store = createStorageStore({ dataDir });
    await store.init();
    handlerRef.current = createStorageHttpApp({ store, logger: silentLogger });
    repos = createDiskRepositories(handlerRef, dom.memoryStorage, silentLogger);
    const integrity = await store.verifyIntegrity();
    assert.equal(integrity.valid, true);

    const recoveredJob = await repos.jobRepository.getJob(crashedJob.id);
    assert.equal(recoveredJob.status, JOB_STATUS.INTERRUPTED);

    // Retry recovered subtitle_voiceover job via mounted useProductionJobs -> reuses km-1 & km-2 takes, synthesizes only km-3, persists onto project
    const beforeRetrySynthCount = synthCalls.length;
    let jobsCtrl = null;
    function JobsRetryHarness() {
      jobsCtrl = useProductionJobs({ autoRun: true });
      return null;
    }
    const jobsServices = createRealisticMediaServices({ repos, logger: silentLogger, synthCalls, dubCalls, burnCalls });
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services: jobsServices }, React.createElement(JobsRetryHarness)));
    });
    await act(async () => { await jobsCtrl.retryJob(crashedJob.id); });
    const jobCompleted = await waitForCondition(
      act,
      () => jobsCtrl.jobs.find(j => j.id === crashedJob.id)?.status === JOB_STATUS.COMPLETED,
      100,
      20
    );
    assert.equal(jobCompleted, true, 'Recovered subtitle_voiceover job should complete on retry');
    assert.equal(synthCalls.length - beforeRetrySynthCount, 1, 'Completed/saved frames km-1 & km-2 must NOT be re-synthesized on retry');
    await act(async () => { root.unmount(); root = null; });

    // Criterion 8: Reopen in fresh UI session -> automatic take hydration from assetStore + intact spillApprovals + immediate export!
    services = createRealisticMediaServices({ repos, logger: silentLogger, synthCalls, dubCalls, burnCalls });
    const reopenedDoc = await repos.projectRepository.getProject(projectId);
    assert.ok(reopenedDoc.segments[2].takes?.[0]?.audioAssetId, 'Batch job retry must persist generated km-3 take onto subtitle project');
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(WorkspaceHarness)));
    });
    await act(async () => { subtitleCtrl.loadProjectFromSnapshot(reopenedDoc); });

    const clipsHydrated = await waitForCondition(
      act,
      () => Boolean(voiceCtrl.segmentClips['km-1']?.blob && voiceCtrl.segmentClips['km-2']?.blob && voiceCtrl.segmentClips['km-3']?.blob && voiceCtrl.alignedClip?.blob)
    );
    assert.equal(clipsHydrated, true, 'Persisted subtitle voiceover takes and aligned track must auto-hydrate from assetStore');
    assert.equal(subtitleCtrl.autosave.isDirty, false, 'Hydrating saved takes on reopen must not mark project dirty');
    assert.equal(voiceCtrl.exportDurationMismatches.hasUnresolved, false, 'Saved spill approval must stay intact across restart');
    assert.equal(voiceCtrl.dubAudioMode, 'duck');
    assert.equal(voiceCtrl.dubSubtitleMode, 'soft');
    assert.equal(voiceCtrl.dubMixSettings.duckVolume, 0.2);
    assert.equal(voiceCtrl.pauseGapMs, 500);
    assert.equal(subtitleCtrl.exportHistory.length, 1);

    // Relink video and immediately export dubbed MP4 with zero regeneration or manual repair
    await act(async () => {
      subtitleCtrl.selectVideoFile(new File(['khmer-relinked'], 'khmer-lesson.mp4', { type: 'video/mp4' }));
    });
    await act(async () => { await subtitleCtrl.extractSubtitles(); });
    await act(async () => { await voiceCtrl.exportDubbedVideo({ throwOnError: true }); });
    assert.equal(dubCalls.length, 2);
    assert.equal(dubCalls[1].clips.length, 3);
    assert.equal(dubCalls[1].originalAudioMode, 'duck');
    assert.equal(dubCalls[1].subtitleMode, 'soft');
    assert.equal(subtitleCtrl.exportHistory.length, 2);
  } finally {
    if (root) await act(async () => { root.unmount(); });
    await vite.close();
    dom.restore();
    await rm(dataDir, { recursive: true, force: true });
  }
});
