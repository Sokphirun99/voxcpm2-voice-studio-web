/**
 * @fileoverview Full-stack integration tests for R3-07 durable batch jobs across service restarts, TTS project take sync, and Subtitle Voiceover cancellation.
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
import { createHttpJobRepository } from '../../src/data/httpJobRepository.js';
import { createHttpProjectRepository } from '../../src/data/httpProjectRepository.js';
import { createHttpAssetRepository } from '../../src/data/httpAssetRepository.js';
import {
  JOB_STATUS,
  buildTtsBatchJobItems,
  buildTtsBatchJobSpec,
  getPendingJobItems,
} from '../../src/domain/productionJobs.js';
import { attachTakeToSegment } from '../../src/domain/projectSegments.js';
import { createProject } from '../../src/domain/projects.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJ_ID = '11111111-1111-4111-8111-111111111111';

function makeWavBytes() {
  const bytes = new Uint8Array(44 + 4800 * 2);
  const view = new DataView(bytes.buffer);
  const write = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + 9600, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, 9600, true);
  return bytes;
}

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
  };
}

function createAppFetch(handlerRef) {
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
    const buf = Buffer.concat(chunks);
    return new Response(buf, { status: statusCode, headers: resHeaders });
  };
}

function createMountedDomShim() {
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
      const path = [];
      for (let cur = this; cur; cur = cur.parentNode) path.push(cur);
      for (let i = path.length - 1; i >= 0; i -= 1) {
        event.currentTarget = path[i];
        for (const fn of path[i].listeners.get(`cap:${event.type}`) || []) fn(event);
      }
      for (let i = 0; i < path.length; i += 1) {
        event.currentTarget = path[i];
        for (const fn of path[i].listeners.get(`bub:${event.type}`) || []) fn(event);
      }
      event.currentTarget = null;
      return true;
    }
    focus() {}
    blur() {}
    click() { if (this.tagName !== 'A' && !this.disabled) this.dispatchEvent({ type: 'click', bubbles: true }); }
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
      this.checked = false;
      this.disabled = false;
    }
    get options() { return this.querySelectorAll('option'); }
    get value() { return this._value; }
    set value(v) { this._value = v == null ? '' : String(v); }
  }
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    ResizeObserver: globalThis.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
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
    setTimeout: () => 1,
    clearTimeout() {},
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
    },
  };
}

test('End-to-end durable batch job survives real server restart, interrupts safely, and retries only remaining segments without duplicate assets', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-batch-e2e-'));
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  try {
    let store = createStorageStore({ dataDir });
    await store.init();
    const handlerRef = {
      current: createStorageHttpApp({ store, rateLimitOptions: { maxRequests: 500 }, logger: silentLogger }),
    };

    const fetchImpl = createAppFetch(handlerRef);
    const storage = makeMemoryStorage();
    const jobRepo = createHttpJobRepository({ fetchImpl, storage, logger: silentLogger });
    const projectRepo = createHttpProjectRepository({ fetchImpl, storage, logger: silentLogger });
    const assetRepo = createHttpAssetRepository({ fetchImpl, logger: silentLogger });

    const project = createProject({
      id: PROJ_ID,
      type: 'tts',
      title: 'Khmer Documentary',
      segments: [
        { id: 'seg-1', text: 'សួស្តីកម្ពុជា', voiceId: 'char-nisa', takes: [] },
        { id: 'seg-2', text: 'អរគុណច្រើន', voiceId: 'char-nisa', takes: [] },
      ],
    });
    const saved = (await projectRepo.saveProject(project)).project;

    const items = buildTtsBatchJobItems({ segments: saved.segments, defaultVoiceId: 'char-nisa' });
    const spec = buildTtsBatchJobSpec({ projectId: PROJ_ID, projectTitle: saved.title, savedProject: saved, activeCharacter: { id: 'char-nisa' }, items });
    let job = (await jobRepo.enqueueJob(spec)).job;
    job = (await jobRepo.updateJob(job.id, { action: 'prepare', workerSessionId: 'tab-1' })).job;
    job = (await jobRepo.updateJob(job.id, { action: 'start', workerSessionId: 'tab-1' })).job;

    job = (await jobRepo.updateJob(job.id, { action: 'item_start', itemId: 'seg-1', workerSessionId: 'tab-1' })).job;
    const asset1 = (await assetRepo.uploadAsset({ bytes: new Blob([makeWavBytes()], { type: 'audio/wav' }), fileName: 'seg-1.wav', kind: 'audio', mimeType: 'audio/wav', projectId: PROJ_ID })).asset;
    const projBeforeRestart = await projectRepo.getProject(PROJ_ID);
    const segsAfter1 = attachTakeToSegment(projBeforeRestart.segments, 'seg-1', { id: 'take-1', seed: 10, duration: 1.0 }, { voiceId: 'char-nisa', audioAssetId: asset1.id });
    await projectRepo.saveProject({ ...projBeforeRestart, segments: segsAfter1, payload: { ...projBeforeRestart.payload, segments: segsAfter1 } }, { expectedRevision: projBeforeRestart.revision });
    job = (await jobRepo.updateJob(job.id, {
      action: 'item_complete', itemId: 'seg-1', outputAssetId: asset1.id, takeId: 'take-1', durationSeconds: 1.0,
    })).job;

    // Start segment 2 then simulate sudden Docker/storage restart
    job = (await jobRepo.updateJob(job.id, { action: 'item_start', itemId: 'seg-2', workerSessionId: 'tab-1' })).job;
    store = createStorageStore({ dataDir });
    await store.init();
    handlerRef.current = createStorageHttpApp({ store, rateLimitOptions: { maxRequests: 500 }, logger: silentLogger });

    const interrupted = await jobRepo.getJob(job.id);
    assert.equal(interrupted.status, JOB_STATUS.INTERRUPTED);
    assert.equal(interrupted.items[0].status, 'completed');
    assert.equal(interrupted.items[0].outputAssetId, asset1.id);
    assert.equal(interrupted.items[1].status, 'interrupted');
    assert.equal(interrupted.artifacts.length, 1);

    // Retry job -> ONLY seg-2 is pending; seg-1 asset is NOT duplicated
    let retried = (await jobRepo.retryJob(job.id)).job;
    assert.equal(retried.status, JOB_STATUS.QUEUED);
    assert.deepEqual(getPendingJobItems(retried).map(i => i.itemId), ['seg-2']);

    retried = (await jobRepo.updateJob(retried.id, { action: 'prepare', workerSessionId: 'tab-2' })).job;
    retried = (await jobRepo.updateJob(retried.id, { action: 'start', workerSessionId: 'tab-2' })).job;
    retried = (await jobRepo.updateJob(retried.id, { action: 'item_start', itemId: 'seg-2', workerSessionId: 'tab-2' })).job;
    const asset2 = (await assetRepo.uploadAsset({ bytes: new Blob([makeWavBytes()], { type: 'audio/wav' }), fileName: 'seg-2.wav', kind: 'audio', mimeType: 'audio/wav', projectId: PROJ_ID })).asset;
    const projFor2 = await projectRepo.getProject(PROJ_ID);
    const segsAfter2 = attachTakeToSegment(projFor2.segments, 'seg-2', { id: 'take-2', seed: 20, duration: 1.0 }, { voiceId: 'char-nisa', audioAssetId: asset2.id });
    await projectRepo.saveProject({ ...projFor2, segments: segsAfter2, payload: { ...projFor2.payload, segments: segsAfter2 } }, { expectedRevision: projFor2.revision });
    retried = (await jobRepo.updateJob(retried.id, {
      action: 'item_complete', itemId: 'seg-2', outputAssetId: asset2.id, takeId: 'take-2', durationSeconds: 1.0,
    })).job;
    const completed = (await jobRepo.updateJob(retried.id, { action: 'complete' })).job;

    assert.equal(completed.status, JOB_STATUS.COMPLETED);
    assert.equal(completed.artifacts.length, 2);
    const finalProject = await projectRepo.getProject(PROJ_ID);
    assert.equal(finalProject.segments[0].takes.length, 1);
    assert.equal(finalProject.segments[0].takes[0].audioAssetId, asset1.id);
    assert.equal(finalProject.segments[1].takes.length, 1);
    assert.equal(finalProject.segments[1].takes[0].audioAssetId, asset2.id);
    assert.equal((await assetRepo.listAssets({ projectId: PROJ_ID })).total, 2);
    assert.equal((await store.verifyIntegrity()).valid, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('SubtitleVoiceover tracked job stops immediately when cancelled from Batch Jobs and preserves completed frame asset', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-sub-job-e2e-'));
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const dom = createMountedDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const store = createStorageStore({ dataDir });
    await store.init();
    const handlerRef = { current: createStorageHttpApp({ store, rateLimitOptions: { maxRequests: 500 }, logger: silentLogger }) };
    const fetchImpl = createAppFetch(handlerRef);
    const storage = makeMemoryStorage();
    const jobRepository = createHttpJobRepository({ fetchImpl, storage, logger: silentLogger });
    const projectRepository = createHttpProjectRepository({ fetchImpl, storage, logger: silentLogger });
    const assetRepository = createHttpAssetRepository({ fetchImpl, logger: silentLogger });

    await projectRepository.saveProject(createProject({
      id: PROJ_ID,
      type: 'subtitles',
      title: 'Sub Dub',
      segments: [
        { id: 'cue-1', start: 0, end: 2, text: 'Frame 1' },
        { id: 'cue-2', start: 2, end: 4, text: 'Frame 2' },
      ],
    }));

    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { useProductionJobs } = await vite.ssrLoadModule('/src/presentation/hooks/useProductionJobs.js');
    const { useSubtitleVoiceover } = await vite.ssrLoadModule('/src/presentation/hooks/useSubtitleVoiceover.js');

    const wavBlob = new Blob([makeWavBytes()], { type: 'audio/wav' });
    const synthCalls = [];
    let jobsCtrl = null;
    let voiceCtrl = null;

    const services = {
      jobRepository,
      assetRepository,
      logger: silentLogger,
      synthesizeSpeech: {
        async execute({ script, signal }) {
          synthCalls.push(script);
          if (synthCalls.length === 1) {
            return { recording: { id: 'take-f1', blob: wavBlob, seed: 1, audioDurationSeconds: 1.0 } };
          }
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('Cancelled');
              err.name = 'SynthesisCancelledError';
              reject(err);
            });
          });
        },
      },
    };

    const segs = [
      { id: 'cue-1', start: 0, end: 2, text: 'Frame 1' },
      { id: 'cue-2', start: 2, end: 4, text: 'Frame 2' },
    ];

    function Harness() {
      jobsCtrl = useProductionJobs({ autoRun: false });
      voiceCtrl = useSubtitleVoiceover({
        segments: segs,
        productionJobs: jobsCtrl,
        projectId: PROJ_ID,
        projectTitle: 'Sub Dub',
      });
      return null;
    }

    let root = null;
    let runPromise = null;
    try {
      root = createRoot(dom.container);
      await act(async () => {
        root.render(React.createElement(StudioProvider, { services }, React.createElement(Harness)));
      });
      await act(async () => {
        voiceCtrl.toggleSelectAll();
      });

      await act(async () => {
        runPromise = voiceCtrl.generateSelectedVoices();
      });
      for (let i = 0; i < 150; i += 1) {
        if (jobsCtrl.jobs[0]?.status === JOB_STATUS.RUNNING && synthCalls.length === 2) break;
        await act(async () => { await new Promise(r => setTimeout(r, 15)); });
      }

      assert.equal(jobsCtrl.jobs.length, 1);
      const activeJobId = jobsCtrl.jobs[0].id;
      assert.equal(jobsCtrl.jobs[0].status, JOB_STATUS.RUNNING);
      assert.equal(synthCalls.length, 2);

      // Cancel from Batch Jobs controller -> aborts active frame 2 immediately and finalizes cancelled with frame 1 preserved!
      await act(async () => {
        await jobsCtrl.cancelJob(activeJobId);
        await runPromise;
      });
      runPromise = null;

      const persisted = await jobRepository.getJob(activeJobId);
      assert.equal(persisted.status, JOB_STATUS.CANCELLED);
      assert.equal(persisted.items[0].status, 'completed');
      assert.ok(persisted.items[0].outputAssetId);
      assert.equal(persisted.items[1].status, 'cancelled');
      assert.equal(persisted.artifacts.length, 1);
    } finally {
      if (root) await act(async () => { root.unmount(); });
      if (runPromise) await runPromise.catch(() => {});
    }
  } finally {
    await vite.close();
    dom.restore();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('SubtitleVoiceover tracked job marks interrupted on unmount, preserves completed frame asset, and retry leaves only incomplete frame pending', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxcpm-sub-unmount-e2e-'));
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const dom = createMountedDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const store = createStorageStore({ dataDir });
    await store.init();
    const handlerRef = { current: createStorageHttpApp({ store, rateLimitOptions: { maxRequests: 500 }, logger: silentLogger }) };
    const fetchImpl = createAppFetch(handlerRef);
    const storage = makeMemoryStorage();
    const jobRepository = createHttpJobRepository({ fetchImpl, storage, logger: silentLogger });
    const projectRepository = createHttpProjectRepository({ fetchImpl, storage, logger: silentLogger });
    const assetRepository = createHttpAssetRepository({ fetchImpl, logger: silentLogger });

    await projectRepository.saveProject(createProject({
      id: PROJ_ID,
      type: 'subtitles',
      title: 'Sub Unmount Dub',
      segments: [
        { id: 'cue-1', start: 0, end: 2, text: 'Frame 1' },
        { id: 'cue-2', start: 2, end: 4, text: 'Frame 2' },
      ],
    }));

    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { useProductionJobs } = await vite.ssrLoadModule('/src/presentation/hooks/useProductionJobs.js');
    const { useSubtitleVoiceover } = await vite.ssrLoadModule('/src/presentation/hooks/useSubtitleVoiceover.js');

    const wavBlob = new Blob([makeWavBytes()], { type: 'audio/wav' });
    const synthCalls = [];
    let jobsCtrl = null;
    let voiceCtrl = null;

    const services = {
      jobRepository,
      assetRepository,
      logger: silentLogger,
      synthesizeSpeech: {
        async execute({ script, signal }) {
          synthCalls.push(script);
          if (synthCalls.length === 1) {
            return { recording: { id: 'take-f1', blob: wavBlob, seed: 1, audioDurationSeconds: 1.0 } };
          }
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('Interrupted');
              err.name = 'SynthesisCancelledError';
              reject(err);
            });
          });
        },
      },
    };

    const segs = [
      { id: 'cue-1', start: 0, end: 2, text: 'Frame 1' },
      { id: 'cue-2', start: 2, end: 4, text: 'Frame 2' },
    ];

    function Harness() {
      jobsCtrl = useProductionJobs({ autoRun: false });
      voiceCtrl = useSubtitleVoiceover({
        segments: segs,
        productionJobs: jobsCtrl,
        projectId: PROJ_ID,
        projectTitle: 'Sub Unmount Dub',
      });
      return null;
    }

    let root = null;
    let runPromise = null;
    try {
      root = createRoot(dom.container);
      await act(async () => {
        root.render(React.createElement(StudioProvider, { services }, React.createElement(Harness)));
      });
      await act(async () => {
        voiceCtrl.toggleSelectAll();
      });

      await act(async () => {
        runPromise = voiceCtrl.generateSelectedVoices();
      });
      for (let i = 0; i < 150; i += 1) {
        if (jobsCtrl.jobs[0]?.status === JOB_STATUS.RUNNING && synthCalls.length === 2) break;
        await act(async () => { await new Promise(r => setTimeout(r, 15)); });
      }

      const activeJobId = jobsCtrl.jobs[0].id;
      assert.equal(synthCalls.length, 2);

      // Unmount while frame 2 is active -> tracked job must finalize interrupted, preserving cue-1 asset
      await act(async () => {
        root.unmount();
        root = null;
        await runPromise;
      });
      runPromise = null;

      const interrupted = await jobRepository.getJob(activeJobId);
      assert.equal(interrupted.status, JOB_STATUS.INTERRUPTED);
      assert.equal(interrupted.items[0].status, 'completed');
      assert.ok(interrupted.items[0].outputAssetId);
      assert.equal(interrupted.items[1].status, 'interrupted');
      assert.equal(interrupted.artifacts.length, 1);

      // Explicit retry leaves cue-1 completed and only cue-2 pending
      const retried = (await jobRepository.retryJob(activeJobId)).job;
      assert.equal(retried.status, JOB_STATUS.QUEUED);
      assert.equal(retried.items[0].status, 'completed');
      assert.equal(retried.items[1].status, 'pending');
      assert.equal(retried.artifacts.length, 1);
    } finally {
      if (root) await act(async () => { root.unmount(); });
      if (runPromise) await runPromise.catch(() => {});
    }
  } finally {
    await vite.close();
    dom.restore();
    await rm(dataDir, { recursive: true, force: true });
  }
});
