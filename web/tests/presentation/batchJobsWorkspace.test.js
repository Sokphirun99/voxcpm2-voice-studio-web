/**
 * @fileoverview SSR and mounted DOM tests for BatchJobsWorkspace, Sidebar badge, useProductionJobs lifecycle, and Studio/TTS/Subtitle integration (R3-07).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import {
  JOB_STATUS,
  applyJobLifecycleAction,
  createProductionJob,
  isJobWorkerStale,
  summarizeJobs,
  toJobSummary,
} from '../../src/domain/productionJobs.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJ_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID_1 = '22222222-2222-4222-8222-222222222222';
const JOB_ID_2 = '33333333-3333-4333-8333-333333333333';
const ASSET_ID_1 = '44444444-4444-4444-8444-444444444444';

function makeSilentWavBlob() {
  const bytes = new Uint8Array(44 + 4800 * 2);
  const view = new DataView(bytes.buffer);
  const write = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + 9600, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, 9600, true);
  return new Blob([bytes], { type: 'audio/wav' });
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
    focus() { globalThis.document.activeElement = this; }
    blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
    click() {
      if (this.tagName === 'A' || this.disabled) return;
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
      this.checked = false;
      this.disabled = false;
    }
    get options() { return this.querySelectorAll('option'); }
    get value() { return this._value; }
    set value(v) { this._value = v == null ? '' : String(v); this._dirtyValue = true; }
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

function createInMemoryJobRepo(initialJobs = []) {
  const map = new Map(initialJobs.map(j => [j.id, j]));
  return {
    map,
    async listJobs() {
      const items = [...map.values()].map(toJobSummary);
      return { items, total: items.length, limit: 100, offset: 0, hasMore: false, summary: summarizeJobs(items) };
    },
    async getJob(id) {
      return map.get(id) ? toJobSummary(map.get(id)) : null;
    },
    async enqueueJob(spec) {
      const job = createProductionJob({ ...(spec || {}), status: JOB_STATUS.QUEUED });
      map.set(job.id, job);
      return { job: toJobSummary(job), evictedIds: [] };
    },
    async updateJob(id, patch) {
      const existing = map.get(id);
      if (!existing) throw new Error(`Missing job ${id}`);
      const next = applyJobLifecycleAction(existing, patch);
      map.set(id, next);
      return { job: toJobSummary(next) };
    },
    async cancelJob(id, options = {}) {
      return this.updateJob(id, { action: 'cancel', finalize: Boolean(options.finalize) });
    },
    async retryJob(id) {
      return this.updateJob(id, { action: 'retry' });
    },
    async interruptJob(id, options = {}) {
      return this.updateJob(id, { action: 'interrupt', ...(options.reason ? { reason: options.reason } : {}) });
    },
    async recoverInterruptedJobs() {
      return { recoveredCount: 0, jobs: [] };
    },
    async deleteJob(id) {
      map.delete(id);
      return { deleted: true, id };
    },
    async clearHistory() {
      let clearedCount = 0;
      for (const [id, job] of map.entries()) {
        if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
          map.delete(id);
          clearedCount += 1;
        }
      }
      return { clearedCount };
    },
  };
}

test('BatchJobsWorkspace SSR and Sidebar render queued, interrupted, failed, completed jobs, artifacts, and badge count', async () => {
  await withViteSsr(async vite => {
    const { Sidebar } = await vite.ssrLoadModule('/src/presentation/components/Sidebar.jsx');
    const { BatchJobsWorkspace } = await vite.ssrLoadModule('/src/presentation/components/BatchJobsWorkspace.jsx');

    const sidebarHtml = renderToStaticMarkup(
      React.createElement(Sidebar, { activeWorkspace: 'jobs', jobsBadgeCount: 3, onSelectWorkspace() {} })
    );
    assert.ok(sidebarHtml.includes('id="nav-jobs"'));
    assert.ok(sidebarHtml.includes('Batch Jobs'));
    assert.ok(sidebarHtml.includes('class="nav-badge"'));
    assert.ok(sidebarHtml.includes('>3<'));

    const interruptedJob = toJobSummary(createProductionJob({
      id: JOB_ID_1,
      type: 'tts_batch',
      title: 'Khmer Audiobook Ch1',
      projectId: PROJ_ID,
      projectTitle: 'Audiobook',
      status: JOB_STATUS.INTERRUPTED,
      error: { code: 'JOB_INTERRUPTED', message: 'Interrupted by restart' },
      items: [
        { itemId: 's1', segmentId: 's1', label: 'Segment #1', status: 'completed', outputAssetId: ASSET_ID_1 },
        { itemId: 's2', segmentId: 's2', label: 'Segment #2', status: 'interrupted' },
      ],
      artifacts: [{ itemId: 's1', assetId: ASSET_ID_1, fileName: 'segment-01.wav', kind: 'audio' }],
    }));

    const failedJob = toJobSummary(createProductionJob({
      id: JOB_ID_2,
      type: 'video_burn',
      title: 'Burn Episode 2',
      status: JOB_STATUS.FAILED,
      error: { code: 'FFMPEG_ERROR', message: 'FFmpeg failed' },
    }));

    const html = renderToStaticMarkup(
      React.createElement(BatchJobsWorkspace, {
        initialJobs: [interruptedJob, failedJob],
        controller: {
          jobs: [interruptedJob, failedJob],
          filteredJobs: [interruptedJob, failedJob],
          summary: summarizeJobs([interruptedJob, failedJob]),
          badgeCount: 1,
          interruptedCount: 1,
          hasClearableHistory: true,
          loading: false,
          busy: false,
          error: null,
          setError() {},
          filterStatus: 'all',
          setFilterStatus() {},
          refreshJobs: async () => [],
          cancelJob: async () => null,
          retryJob: async () => null,
          retryAllInterrupted: async () => [],
          deleteJob: async () => true,
          clearHistory: async () => 1,
        },
        onOpenProjectById() {},
      })
    );
    assert.ok(html.includes('id="jobs-interrupted-banner"'));
    assert.ok(html.includes('id="retry-all-interrupted-btn"'));
    assert.ok(html.includes('Khmer Audiobook Ch1'));
    assert.ok(html.includes('segment-01.wav'));
    assert.ok(html.includes(`/api/v1/assets/${ASSET_ID_1}/download`));
    assert.ok(html.includes('Resume / Retry'));
    assert.ok(html.includes('FFmpeg failed'));
  });
});

test('Mounted useProductionJobs & BatchJobsWorkspace: retry skips completed items, unmount interrupts cleanly, and Studio reloads synced project', async () => {
  const dom = createMountedDomShim();
  try {
    await withViteSsr(async vite => {
      const { act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
      const { BatchJobsWorkspace } = await vite.ssrLoadModule('/src/presentation/components/BatchJobsWorkspace.jsx');
      const { useProductionJobs } = await vite.ssrLoadModule('/src/presentation/hooks/useProductionJobs.js');

      const wav = makeSilentWavBlob();
      const synthCalls = [];
      let shouldFailSeg2 = true;
      let releaseSlowSeg = null;
      let projectRev = 1;
      const projectRecord = {
        id: PROJ_ID,
        type: 'tts',
        kind: 'tts',
        title: 'Batch Project',
        revision: 1,
        segments: [
          { id: 'seg-1', text: 'One', voiceId: 'char-nisa', takes: [] },
          { id: 'seg-2', text: 'Two', voiceId: 'char-sovath', takes: [] },
        ],
        payload: { segments: [] },
      };

      const jobRepo = createInMemoryJobRepo();
      const assetRepo = {
        async uploadAsset({ fileName }) {
          const id = `00000000-0000-4000-8000-${String(synthCalls.length).padStart(12, '0')}`;
          return { asset: { id, fileName } };
        },
      };
      const projectRepo = {
        async getProject(id) { return id === PROJ_ID ? structuredClone(projectRecord) : null; },
        async saveProject(next) {
          projectRev += 1;
          projectRecord.segments = next.segments;
          projectRecord.payload = next.payload;
          projectRecord.revision = projectRev;
          return { project: structuredClone(projectRecord), isCreated: false };
        },
      };

      const services = {
        jobRepository: jobRepo,
        projectRepository: projectRepo,
        assetRepository: assetRepo,
        voiceLibrary: { loadSaved: () => ({ entries: [] }) },
        voiceAnchors: { loadAll: async () => ({}) },
        synthesizeSpeech: {
          async synthesizeSegment({ segment, character, signal }) {
            synthCalls.push({ segId: segment.id, voiceId: character.id });
            if (segment.id === 'seg-2' && shouldFailSeg2) {
              throw new Error('Temporary engine glitch');
            }
            if (segment.id === 'seg-slow') {
              await new Promise((resolve, reject) => {
                releaseSlowSeg = resolve;
                signal.addEventListener('abort', () => {
                  const err = new Error('Aborted');
                  err.name = 'AbortError';
                  reject(err);
                });
              });
            }
            return { recording: { id: `take-${synthCalls.length}`, blob: wav, seed: 77, audioDurationSeconds: 1.0 } };
          },
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      };

      let jobsCtrl = null;
      const completedJobs = [];
      const updatedProjects = [];
      function Harness() {
        jobsCtrl = useProductionJobs({
          onJobCompleted: j => completedJobs.push(j),
          onProjectUpdated: j => updatedProjects.push(j),
        });
        return React.createElement(BatchJobsWorkspace, { controller: jobsCtrl });
      }

      let root;
      try {
        root = createRoot(dom.container);
        await act(async () => {
          root.render(React.createElement(StudioProvider, { services }, React.createElement(Harness)));
        });

        // 1) Enqueue 2-segment TTS job: seg-1 succeeds, seg-2 fails
        await act(async () => {
          await jobsCtrl.enqueueJob({
            id: JOB_ID_1,
            type: 'tts_batch',
            projectId: PROJ_ID,
            projectTitle: 'Batch Project',
            title: 'Batch Project (2 segments)',
            items: [
              { itemId: 'seg-1', segmentId: 'seg-1', label: 'Seg 1', metadata: { text: 'One', voiceId: 'char-nisa' } },
              { itemId: 'seg-2', segmentId: 'seg-2', label: 'Seg 2', metadata: { text: 'Two', voiceId: 'char-sovath' } },
            ],
          });
        });
        for (let i = 0; i < 150; i += 1) {
          await act(async () => { await new Promise(r => setTimeout(r, 10)); });
          if (jobsCtrl.jobs[0]?.status === JOB_STATUS.FAILED) break;
        }

        assert.equal(jobsCtrl.jobs[0].status, JOB_STATUS.FAILED);
        assert.equal(jobsCtrl.jobs[0].items[0].status, 'completed');
        assert.equal(jobsCtrl.jobs[0].items[1].status, 'failed');
        assert.equal(updatedProjects.length, 1);
        assert.equal(synthCalls.length, 2);
        assert.equal(synthCalls[1].voiceId, 'char-sovath');

        // 2) Retry from UI button: seg-1 MUST NOT be re-synthesized; only seg-2 runs!
        shouldFailSeg2 = false;
        const retryBtn = dom.container.querySelector(`#job-retry-${JOB_ID_1}`);
        assert.ok(retryBtn);
        await act(async () => { retryBtn.click(); });
        for (let i = 0; i < 150; i += 1) {
          await act(async () => { await new Promise(r => setTimeout(r, 10)); });
          if (jobsCtrl.jobs[0]?.status === JOB_STATUS.COMPLETED) break;
        }

        assert.equal(jobsCtrl.jobs[0].status, JOB_STATUS.COMPLETED);
        assert.equal(jobsCtrl.jobs[0].artifacts.length, 2);
        assert.equal(completedJobs.length, 1);
        assert.equal(synthCalls.length, 3);
        assert.deepEqual(synthCalls.map(c => c.segId), ['seg-1', 'seg-2', 'seg-2']);
        assert.equal(projectRecord.segments[0].takes.length, 1);
        assert.equal(projectRecord.segments[1].takes.length, 1);

        // 3) Enqueue slow job and unmount while running -> MUST mark interrupted, NOT cancelled!
        await act(async () => {
          await jobsCtrl.enqueueJob({
            id: JOB_ID_2,
            type: 'tts_batch',
            title: 'Slow Running Job',
            items: [{ itemId: 'seg-slow', segmentId: 'seg-slow', label: 'Slow', metadata: { text: 'Slow' } }],
          });
        });
        for (let i = 0; i < 150; i += 1) {
          if (jobsCtrl.jobs.find(j => j.id === JOB_ID_2)?.status === JOB_STATUS.RUNNING) break;
          await act(async () => { await new Promise(r => setTimeout(r, 15)); });
        }
        assert.equal(jobsCtrl.jobs.find(j => j.id === JOB_ID_2)?.status, JOB_STATUS.RUNNING);

        await act(async () => { root.unmount(); root = null; });
        let afterUnmount = null;
        for (let i = 0; i < 150; i += 1) {
          afterUnmount = await jobRepo.getJob(JOB_ID_2);
          if (afterUnmount?.status === JOB_STATUS.INTERRUPTED) break;
          await new Promise(r => setTimeout(r, 15));
        }
        assert.equal(afterUnmount.status, JOB_STATUS.INTERRUPTED);
      } finally {
        if (releaseSlowSeg) releaseSlowSeg();
        if (root) await act(async () => { root.unmount(); });
      }
    });
  } finally {
    dom.restore();
  }
});

test('Mounted Studio queues TTS batch from unsaved script, executes segments, syncs takes back to TTS, and supports Batch Jobs filters + clear history', async () => {
  const dom = createMountedDomShim();
  try {
    await withViteSsr(async vite => {
      const { act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
      const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

      const wav = makeSilentWavBlob();
      const jobRepo = createInMemoryJobRepo();
      const savedProjects = new Map();
      let synthSeq = 0;

      const services = {
        jobRepository: jobRepo,
        projectRepository: {
          async listProjects() { return { items: [...savedProjects.values()], total: savedProjects.size, limit: 50, offset: 0, hasMore: false }; },
          async getProject(id) { return savedProjects.has(id) ? structuredClone(savedProjects.get(id)) : null; },
          async saveProject(next) {
            const id = next.id || PROJ_ID;
            const prev = savedProjects.get(id);
            const updated = { ...next, id, revision: (prev?.revision || 0) + 1, updatedAt: new Date().toISOString() };
            savedProjects.set(id, structuredClone(updated));
            return { project: structuredClone(updated), isCreated: !prev };
          },
        },
        assetRepository: {
          async uploadAsset({ fileName }) {
            return { asset: { id: `55555555-5555-4555-8555-${String(++synthSeq).padStart(12, '0')}`, fileName } };
          },
        },
        speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
        mediaSubtitleGateway: { checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: false, models: {} }) },
        diagnosticsGateway: { checkAll: async () => ({ checkedAt: new Date().toISOString(), services: {}, models: [], storage: {} }) },
        audioDecoder: { decodePeaks: async () => [] },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        synthesizeSpeech: {
          async synthesizeSegment() {
            return { recording: { id: `take-ui-${synthSeq + 1}`, blob: wav, seed: 123, audioDurationSeconds: 1.0 } };
          },
          async execute() {
            return { recording: { id: `take-ui-${synthSeq + 1}`, blob: wav, seed: 123, audioDurationSeconds: 1.0 } };
          },
        },
        lockReferenceAudio: { execute: async f => ({ blob: f, fileName: f.name, mimeType: 'audio/wav' }) },
        voiceLibrary: { loadSaved: () => ({ entries: [], warning: null }), saveCustom: () => ({ entry: {}, entries: [] }), deleteCustom: () => [] },
        voiceAnchors: { loadAll: async () => ({}), pinCharacter: async p => p, updateAnchor: async () => null, unpinCharacter: async () => {} },
        glossaryRepository: { loadRules: async () => [], saveRules: async r => ({ rules: r }) },
        terminologyRepository: { loadTerms: async () => [], saveTerms: async t => ({ terms: t }) },
      };

      const root = createRoot(dom.container);
      try {
        await act(async () => {
          root.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
        });

        await act(async () => { dom.container.querySelector('#nav-tts').click(); });
        const scriptEl = dom.container.querySelector('#script');
        await act(async () => {
          scriptEl._value = 'Sentence one. Sentence two.';
          scriptEl.dispatchEvent({ type: 'input', bubbles: true, target: scriptEl });
          scriptEl.dispatchEvent({ type: 'change', bubbles: true, target: scriptEl });
        });
        await act(async () => { dom.container.querySelector('#view-mode-segments').click(); });
        const queueBtn = dom.container.querySelector('#queue-tts-batch-btn');
        assert.ok(queueBtn, 'Expected Queue batch button in Segments mode');
        await act(async () => { queueBtn.click(); });

        for (let i = 0; i < 200; i += 1) {
          await act(async () => { await new Promise(r => setTimeout(r, 15)); });
          if (dom.container.querySelector('#restitch-segments')) break;
        }

        assert.ok(dom.container.querySelector('#restitch-segments'), 'Expected #restitch-segments after completed batch sync');
        assert.equal(savedProjects.size, 1);
        assert.ok(dom.container.querySelector('#export-narration'));

        await act(async () => { dom.container.querySelector('#nav-jobs').click(); });
        assert.equal(dom.container.querySelector('#jobs-status-count').textContent, '1 job');

        await act(async () => { dom.container.querySelector('#filter-job-failed').click(); });
        assert.equal(dom.container.querySelector('#jobs-status-count').textContent, '0 jobs');

        await act(async () => { dom.container.querySelector('#filter-job-completed').click(); });
        assert.equal(dom.container.querySelector('#jobs-status-count').textContent, '1 job');

        const toggleBtn = dom.container.querySelector('.job-items-toggle');
        assert.ok(toggleBtn);
        await act(async () => { toggleBtn.click(); });
        assert.ok(dom.container.querySelector('.job-items-list'));

        await act(async () => { dom.container.querySelector('#clear-job-history-btn').click(); });
        assert.equal(dom.container.querySelector('#jobs-status-count').textContent, '0 jobs');
      } finally {
        await act(async () => { root.unmount(); });
      }
    });
  } finally {
    dom.restore();
  }
});

test('BatchJobsWorkspace with external controller skips duplicate listJobs fetches and supports ArrowLeft/ArrowRight chip navigation', async () => {
  const dom = createMountedDomShim();
  try {
    await withViteSsr(async vite => {
      const { act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
      const { BatchJobsWorkspace } = await vite.ssrLoadModule('/src/presentation/components/BatchJobsWorkspace.jsx');
      const { useProductionJobs } = await vite.ssrLoadModule('/src/presentation/hooks/useProductionJobs.js');

      const baseRepo = createInMemoryJobRepo();
      let listCalls = 0;
      const jobRepo = {
        ...baseRepo,
        async listJobs(params) {
          listCalls += 1;
          return baseRepo.listJobs(params);
        },
      };

      let jobsCtrl = null;
      function Harness() {
        jobsCtrl = useProductionJobs();
        return React.createElement(BatchJobsWorkspace, { controller: jobsCtrl });
      }

      const root = createRoot(dom.container);
      try {
        await act(async () => {
          root.render(React.createElement(StudioProvider, { services: { jobRepository: jobRepo, logger: { debug() {}, info() {}, warn() {}, error() {} } } }, React.createElement(Harness)));
        });

        assert.equal(listCalls, 1, 'Expected exactly one listJobs() fetch from host controller without duplicate internal hook fetch');

        const allChip = dom.container.querySelector('#filter-job-all');
        const activeChip = dom.container.querySelector('#filter-job-active');
        assert.equal(allChip.getAttribute('aria-checked'), 'true');
        assert.equal(allChip.getAttribute('tabindex'), '0');
        assert.equal(activeChip.getAttribute('tabindex'), '-1');

        await act(async () => {
          allChip.dispatchEvent({ type: 'keydown', key: 'ArrowRight', bubbles: true });
        });
        assert.equal(activeChip.getAttribute('aria-checked'), 'true');
        assert.equal(activeChip.getAttribute('tabindex'), '0');
        assert.equal(allChip.getAttribute('tabindex'), '-1');
        assert.equal(globalThis.document.activeElement?.id, 'filter-job-active');

        await act(async () => {
          activeChip.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', bubbles: true });
        });
        assert.equal(dom.container.querySelector('#filter-job-all').getAttribute('aria-checked'), 'true');
        assert.equal(globalThis.document.activeElement?.id, 'filter-job-all');
      } finally {
        await act(async () => { root.unmount(); });
      }
    });
  } finally {
    dom.restore();
  }
});

test('Audit regressions: crash-window TTS retry deduplicates existing project take, exhausted interrupted banner disables retry, pumpQueue halts on repo failure, and subtitle sync preserves video/clips', async () => {
  const dom = createMountedDomShim();
  try {
    await withViteSsr(async vite => {
      const { act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
      const { BatchJobsWorkspace } = await vite.ssrLoadModule('/src/presentation/components/BatchJobsWorkspace.jsx');
      const { useProductionJobs } = await vite.ssrLoadModule('/src/presentation/hooks/useProductionJobs.js');
      const { useVideoSubtitles } = await vite.ssrLoadModule('/src/presentation/hooks/useVideoSubtitles.js');

      // 1) Crash-window deduplication: seg-1 was saved to project BEFORE crash prevented item_complete; retry MUST NOT re-synthesize seg-1
      const wav = makeSilentWavBlob();
      const synthCalls = [];
      const projectRecord = {
        id: PROJ_ID,
        type: 'tts',
        kind: 'tts',
        title: 'Crash Window Project',
        revision: 2,
        segments: [
          {
            id: 'seg-1',
            text: 'Already persisted before crash',
            voiceId: 'char-nisa',
            status: 'ready',
            takes: [{ id: 'take-precrash', text: 'Already persisted before crash', voiceId: 'char-nisa', audioAssetId: ASSET_ID_1, duration: 1.2, isSelected: true, settings: { seed: 55 } }],
          },
          { id: 'seg-2', text: 'Still needs synthesis', voiceId: 'char-nisa', status: 'draft', takes: [] },
        ],
        payload: { segments: [] },
      };
      const interruptedJob = createProductionJob({
        id: JOB_ID_1,
        type: 'tts_batch',
        projectId: PROJ_ID,
        projectTitle: 'Crash Window Project',
        title: 'Crash Window Batch',
        status: JOB_STATUS.INTERRUPTED,
        items: [
          { itemId: 'seg-1', segmentId: 'seg-1', label: 'Seg 1', status: 'interrupted', metadata: { text: 'Already persisted before crash', voiceId: 'char-nisa' } },
          { itemId: 'seg-2', segmentId: 'seg-2', label: 'Seg 2', status: 'pending', metadata: { text: 'Still needs synthesis', voiceId: 'char-nisa' } },
        ],
      });
      const exhaustedJob = createProductionJob({
        id: JOB_ID_2,
        type: 'tts_batch',
        title: 'Exhausted Interrupted Job',
        status: JOB_STATUS.INTERRUPTED,
        retryCount: 3,
        maxRetries: 3,
      });

      const jobRepo = createInMemoryJobRepo([interruptedJob, exhaustedJob]);
      let uploadCount = 0;
      const services = {
        jobRepository: jobRepo,
        projectRepository: {
          async getProject(id) { return id === PROJ_ID ? structuredClone(projectRecord) : null; },
          async saveProject(next) {
            projectRecord.segments = next.segments;
            projectRecord.payload = next.payload;
            projectRecord.revision += 1;
            return { project: structuredClone(projectRecord), isCreated: false };
          },
        },
        assetRepository: {
          async uploadAsset({ fileName }) {
            uploadCount += 1;
            return { asset: { id: `66666666-6666-4666-8666-${String(uploadCount).padStart(12, '0')}`, fileName } };
          },
        },
        voiceLibrary: { loadSaved: () => ({ entries: [] }) },
        voiceAnchors: { loadAll: async () => ({}) },
        synthesizeSpeech: {
          async synthesizeSegment({ segment }) {
            synthCalls.push(segment.id);
            return { recording: { id: `take-new-${synthCalls.length}`, blob: wav, seed: 88, audioDurationSeconds: 1.0 } };
          },
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      };

      let jobsCtrl = null;
      let subCtrl = null;
      function Harness() {
        jobsCtrl = useProductionJobs();
        subCtrl = useVideoSubtitles({
          projectRepository: null,
          mediaSubtitleGateway: { checkHealth: async () => ({ online: true, burnInSupported: true, models: {} }) },
        });
        return React.createElement(BatchJobsWorkspace, { controller: jobsCtrl });
      }

      const root = createRoot(dom.container);
      try {
        await act(async () => {
          root.render(React.createElement(StudioProvider, { services }, React.createElement(Harness)));
        });

        // Retry interrupted job 1 -> seg-1 MUST reuse take-precrash without re-synthesizing or uploading duplicate!
        await act(async () => { await jobsCtrl.retryJob(JOB_ID_1); });
        for (let i = 0; i < 150; i += 1) {
          await act(async () => { await new Promise(r => setTimeout(r, 10)); });
          if (jobsCtrl.jobs.find(j => j.id === JOB_ID_1)?.status === JOB_STATUS.COMPLETED) break;
        }

        const doneJob = jobsCtrl.jobs.find(j => j.id === JOB_ID_1);
        assert.equal(doneJob.status, JOB_STATUS.COMPLETED);
        assert.deepEqual(synthCalls, ['seg-2']);
        assert.equal(uploadCount, 1);
        assert.equal(doneJob.items[0].outputAssetId, ASSET_ID_1);
        assert.equal(doneJob.artifacts.length, 2);

        // Now only exhaustedJob remains interrupted -> Retry interrupted banner button MUST be disabled!
        assert.equal(jobsCtrl.interruptedCount, 1);
        assert.equal(jobsCtrl.retryableInterruptedCount, 0);
        const retryAllBtn = dom.container.querySelector('#retry-all-interrupted-btn');
        assert.ok(retryAllBtn);
        assert.equal(retryAllBtn.disabled, true);

        // 2) useVideoSubtitles.applyExternalProjectUpdate updates segments & translation WITHOUT wiping videoFile/transcriptEpoch
        const beforeEpoch = subCtrl.transcriptEpoch;
        await act(async () => {
          subCtrl.selectVideoFile(new File([new Uint8Array([0, 0, 0, 20])], 'lesson.mp4', { type: 'video/mp4' }));
        });
        const epochAfterVideo = subCtrl.transcriptEpoch;
        assert.ok(epochAfterVideo >= beforeEpoch);
        assert.equal(subCtrl.state.videoFile?.name, 'lesson.mp4');

        await act(async () => {
          subCtrl.applyExternalProjectUpdate({
            id: PROJ_ID,
            type: 'subtitles',
            kind: 'subtitle',
            revision: 5,
            segments: [{ id: 'cue-1', start: 0, end: 2, text: 'Hello', translatedText: 'សួស្តី' }],
            payload: {
              segments: [{ id: 'cue-1', start: 0, end: 2, text: 'Hello', translatedText: 'សួស្តី' }],
              hasTranslation: true,
              translatedLanguage: 'km',
            },
          });
        });
        assert.equal(subCtrl.state.videoFile?.name, 'lesson.mp4', 'videoFile must NOT be wiped on external batch sync');
        assert.equal(subCtrl.transcriptEpoch, epochAfterVideo, 'transcriptEpoch must NOT bump and wipe voiceover clips');
        assert.equal(subCtrl.state.segments.length, 1);
        assert.equal(subCtrl.state.segments[0].translatedText, 'សួស្តី');
        assert.equal(subCtrl.state.hasTranslation, true);
      } finally {
        await act(async () => { root.unmount(); });
      }

      // 3) pumpQueue stops cleanly (no infinite loop / unhandled rejection) when jobRepository fails persistently
      let updateAttempts = 0;
      const failingRepo = {
        ...createInMemoryJobRepo([createProductionJob({ id: JOB_ID_1, type: 'tts_batch', title: 'Stuck Job', status: JOB_STATUS.QUEUED })]),
        async updateJob() {
          updateAttempts += 1;
          throw new Error('Storage offline 500');
        },
      };
      let failCtrl = null;
      function FailingHarness() {
        failCtrl = useProductionJobs();
        return null;
      }
      const root2 = createRoot(dom.container);
      try {
        await act(async () => {
          root2.render(React.createElement(StudioProvider, { services: { jobRepository: failingRepo, logger: { debug() {}, info() {}, warn() {}, error() {} } } }, React.createElement(FailingHarness)));
        });
        await act(async () => { await new Promise(r => setTimeout(r, 80)); });
        assert.equal(updateAttempts, 2, 'Expected exactly 1 prepare attempt + 1 fail attempt, then clean halt without infinite loop');
        assert.equal(failCtrl.jobs[0].status, JOB_STATUS.QUEUED);
      } finally {
        await act(async () => { root2.unmount(); });
      }
    });
  } finally {
    dom.restore();
  }
});

test('Cancel-while-queued then retry runs cleanly (no stale cancelSet ghost) and multi-tab pumpQueue contention yields without failing winner', async () => {
  const dom = createMountedDomShim();
  try {
    await withViteSsr(async vite => {
      const { act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
      const { useProductionJobs } = await vite.ssrLoadModule('/src/presentation/hooks/useProductionJobs.js');
      const { ConflictError } = await vite.ssrLoadModule('/src/domain/errors.js');

      // 1) Cancel queued job then retry -> MUST execute & complete (previously self-cancelled due to stale cancelSetRef)
      const queuedJob = createProductionJob({
        id: JOB_ID_1,
        type: 'tts_batch',
        title: 'Cancel Then Retry',
        status: JOB_STATUS.QUEUED,
        items: [{ itemId: 's1', segmentId: 's1', label: 'Seg 1', metadata: { text: 'Hello' } }],
      });
      const repo1 = createInMemoryJobRepo([queuedJob]);
      let execCount = 0;
      let ctrl1 = null;
      function CancelRetryHarness({ autoRun }) {
        ctrl1 = useProductionJobs({ autoRun });
        return null;
      }
      const root1 = createRoot(dom.container);
      try {
        await act(async () => {
          root1.render(React.createElement(StudioProvider, {
            services: {
              jobRepository: repo1,
              logger: { debug() {}, info() {}, warn() {}, error() {} },
            },
          }, React.createElement(CancelRetryHarness, { autoRun: false })));
        });
        await act(async () => {
          ctrl1.registerExecutor(JOB_ID_1, async () => {
            execCount += 1;
            return { outputAssetId: ASSET_ID_1, takeId: 't-1', durationSeconds: 1.0 };
          });
          await ctrl1.cancelJob(JOB_ID_1);
        });
        assert.equal((await repo1.getJob(JOB_ID_1)).status, JOB_STATUS.CANCELLED);

        // Re-enable autoRun and retry -> MUST execute item and complete!
        await act(async () => {
          root1.render(React.createElement(StudioProvider, {
            services: {
              jobRepository: repo1,
              logger: { debug() {}, info() {}, warn() {}, error() {} },
            },
          }, React.createElement(CancelRetryHarness, { autoRun: true })));
        });
        await act(async () => { await ctrl1.retryJob(JOB_ID_1); });
        for (let i = 0; i < 100; i += 1) {
          if ((await repo1.getJob(JOB_ID_1))?.status === JOB_STATUS.COMPLETED) break;
          await act(async () => { await new Promise(r => setTimeout(r, 15)); });
        }
        assert.equal((await repo1.getJob(JOB_ID_1)).status, JOB_STATUS.COMPLETED);
        assert.equal(execCount, 1);
      } finally {
        await act(async () => { root1.unmount(); });
      }

      // 2) Multi-tab contention: two tabs claim the SAME queued job with revision checks; loser yields without failing winner
      const sharedJob = createProductionJob({
        id: JOB_ID_2,
        type: 'tts_batch',
        title: 'Contended Job',
        status: JOB_STATUS.QUEUED,
        items: [{ itemId: 's1', segmentId: 's1', label: 'Seg 1', metadata: { text: 'Race' } }],
      });
      const baseRepo = createInMemoryJobRepo([sharedJob]);
      const revisionRepo = {
        ...baseRepo,
        async updateJob(id, patch, options = {}) {
          const existing = baseRepo.map.get(id);
          if (!existing) throw new Error(`Missing job ${id}`);
          if (options?.expectedRevision && Number(existing.revision) !== Number(options.expectedRevision)) {
            throw new ConflictError('Revision mismatch', { code: 'REVISION_CONFLICT' });
          }
          return baseRepo.updateJob(id, patch);
        },
      };
      let tabExecutions = 0;
      const tabErrors = [];
      let tabA = null;
      let tabB = null;
      function MultiTabHarness({ autoRun }) {
        tabA = useProductionJobs({
          workerSessionId: 'tab-A',
          autoRun,
          onNotify: n => { if (n.kind === 'error') tabErrors.push(n); },
        });
        tabB = useProductionJobs({
          workerSessionId: 'tab-B',
          autoRun,
          onNotify: n => { if (n.kind === 'error') tabErrors.push(n); },
        });
        return null;
      }
      const multiTabServices = {
        jobRepository: revisionRepo,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      };
      const root2 = createRoot(dom.container);
      try {
        await act(async () => {
          root2.render(React.createElement(StudioProvider, { services: multiTabServices }, React.createElement(MultiTabHarness, { autoRun: false })));
        });
        const slowExec = async () => {
          tabExecutions += 1;
          await new Promise(r => setTimeout(r, 30));
          return { outputAssetId: ASSET_ID_1, takeId: 't-race', durationSeconds: 1.0 };
        };
        tabA.registerExecutor(JOB_ID_2, slowExec);
        tabB.registerExecutor(JOB_ID_2, slowExec);

        // Enable both tabs to pump simultaneously against the same queued revision
        await act(async () => {
          root2.render(React.createElement(StudioProvider, { services: multiTabServices }, React.createElement(MultiTabHarness, { autoRun: true })));
        });
        await act(async () => {
          await Promise.all([tabA.pumpQueue(), tabB.pumpQueue()]);
        });
        const finalJob = await revisionRepo.getJob(JOB_ID_2);
        assert.equal(finalJob.status, JOB_STATUS.COMPLETED);
        assert.equal(tabExecutions, 1, 'Exactly one tab should execute the contended job');
        assert.equal(tabErrors.length, 0, 'Losing tab must yield quietly without error toast');
      } finally {
        await act(async () => { root2.unmount(); });
      }
    });
  } finally {
    dom.restore();
  }
});

test('Multi-tab race on prepare, live failing itemId, resilient stale recovery, built-in media executors, and subtitle voiceover hydration work cleanly', async () => {
  const dom = createMountedDomShim();
  try {
    await withViteSsr(async vite => {
      const { act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { ConflictError } = await vite.ssrLoadModule('/src/domain/errors.js');
      const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
      const { useProductionJobs } = await vite.ssrLoadModule('/src/presentation/hooks/useProductionJobs.js');
      const { useSubtitleVoiceover } = await vite.ssrLoadModule('/src/presentation/hooks/useSubtitleVoiceover.js');

      // 1) Multi-tab race: Tab A and Tab B share one repo with J1 & J2. Tab B's 409 on J1 prepare MUST NOT fail J1!
      const job1 = createProductionJob({
        id: JOB_ID_1,
        type: 'tts_batch',
        title: 'Multi-Tab Job 1',
        status: JOB_STATUS.QUEUED,
        items: [{ itemId: 'seg-1', segmentId: 'seg-1', label: 'Seg 1', metadata: { text: 'One' } }],
      });
      const job2 = createProductionJob({
        id: JOB_ID_2,
        type: 'tts_batch',
        title: 'Multi-Tab Job 2',
        status: JOB_STATUS.QUEUED,
        items: [{ itemId: 'seg-2', segmentId: 'seg-2', label: 'Seg 2', metadata: { text: 'Two' } }],
      });
      const baseRepo = createInMemoryJobRepo([job1, job2]);
      const failCalls = [];
      const sharedRepo = {
        ...baseRepo,
        async updateJob(id, patch, options) {
          if (patch.action === 'fail') failCalls.push({ id, patch });
          const cur = baseRepo.map.get(id);
          if (options?.expectedRevision && cur && Number(cur.revision) !== Number(options.expectedRevision)) {
            throw new ConflictError('Revision mismatch', { code: 'REVISION_CONFLICT' });
          }
          return baseRepo.updateJob(id, patch);
        },
      };
      const executedItems = [];
      const wav = makeSilentWavBlob();
      const wavBytes = new Uint8Array(await wav.arrayBuffer());
      let assetSeq = 0;
      const baseServices = {
        jobRepository: sharedRepo,
        assetRepository: {
          async uploadAsset({ fileName }) {
            return { asset: { id: `77777777-7777-4777-8777-${String(++assetSeq).padStart(12, '0')}`, fileName } };
          },
          async getAssetBinary() {
            return { bytes: wavBytes, mimeType: 'audio/wav' };
          },
        },
        voiceLibrary: { loadSaved: () => ({ entries: [] }) },
        voiceAnchors: { loadAll: async () => ({}) },
        synthesizeSpeech: {
          async synthesizeSegment({ segment }) {
            executedItems.push(segment.id);
            await new Promise(r => setTimeout(r, 25));
            return { recording: { id: `take-${segment.id}`, blob: wav, seed: 7, audioDurationSeconds: 0.5 } };
          },
          async execute() {
            return { recording: { id: 'take-exec', blob: wav, seed: 7, audioDurationSeconds: 0.5 } };
          },
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      };

      let tabA = null;
      let tabB = null;
      function DualTabsHarness() {
        tabA = useProductionJobs({ workerSessionId: 'tab-A', autoRecover: false });
        tabB = useProductionJobs({ workerSessionId: 'tab-B', autoRecover: false });
        return null;
      }
      const root1 = createRoot(dom.container);
      try {
        await act(async () => {
          root1.render(React.createElement(StudioProvider, { services: baseServices }, React.createElement(DualTabsHarness)));
        });
        for (let i = 0; i < 150; i += 1) {
          await act(async () => { await new Promise(r => setTimeout(r, 10)); });
          if (baseRepo.map.get(JOB_ID_1)?.status === JOB_STATUS.COMPLETED && baseRepo.map.get(JOB_ID_2)?.status === JOB_STATUS.COMPLETED) break;
        }
        assert.equal(failCalls.length, 0, 'Conflicted tab MUST NEVER fail another tab running job');
        assert.equal(baseRepo.map.get(JOB_ID_1).status, JOB_STATUS.COMPLETED);
        assert.equal(baseRepo.map.get(JOB_ID_2).status, JOB_STATUS.COMPLETED);
        assert.deepEqual([...executedItems].sort(), ['seg-1', 'seg-2'], 'Each segment must be synthesized exactly once across both tabs');
      } finally {
        await act(async () => { root1.unmount(); });
      }

      // 2) Live failing itemId recorded on item 2 failure + resilient recoverStaleSessionJobs on 409
      const failJob = createProductionJob({
        id: JOB_ID_1,
        type: 'tts_batch',
        title: 'Item 2 Failure',
        status: JOB_STATUS.QUEUED,
        items: [
          { itemId: 'seg-1', segmentId: 'seg-1', label: 'Seg 1', metadata: { text: 'OK' } },
          { itemId: 'seg-2', segmentId: 'seg-2', label: 'Seg 2', metadata: { text: 'Boom' } },
        ],
      });
      const stale1 = createProductionJob({
        id: '88888888-8888-4888-8888-888888888881',
        type: 'tts_batch',
        title: 'Stale Already Done',
        status: JOB_STATUS.RUNNING,
        workerSessionId: 'dead-tab',
        lastHeartbeatAt: '2020-01-01T00:00:00.000Z',
      });
      const stale2 = createProductionJob({
        id: '88888888-8888-4888-8888-888888888882',
        type: 'tts_batch',
        title: 'Stale Needs Interrupt',
        status: JOB_STATUS.RUNNING,
        workerSessionId: 'dead-tab',
        lastHeartbeatAt: '2020-01-01T00:00:00.000Z',
      });
      const failRepoBase = createInMemoryJobRepo([failJob, stale1, stale2]);
      const failRepo = {
        ...failRepoBase,
        async interruptJob(id, opts) {
          if (id === stale1.id) throw new ConflictError('Already completed', { code: 'INVALID_JOB_TRANSITION' });
          return failRepoBase.interruptJob(id, opts);
        },
      };
      let failCtrl = null;
      function FailureHarness() {
        failCtrl = useProductionJobs({ workerSessionId: 'tab-live' });
        return null;
      }
      const root2 = createRoot(dom.container);
      try {
        await act(async () => {
          root2.render(React.createElement(StudioProvider, {
            services: {
              ...baseServices,
              jobRepository: failRepo,
              synthesizeSpeech: {
                async synthesizeSegment({ segment }) {
                  if (segment.id === 'seg-2') throw new Error('Engine timeout on seg-2');
                  return { recording: { id: 'take-ok', blob: wav, seed: 1, audioDurationSeconds: 0.5 } };
                },
              },
            },
          }, React.createElement(FailureHarness)));
        });
        for (let i = 0; i < 150; i += 1) {
          await act(async () => { await new Promise(r => setTimeout(r, 10)); });
          if (failRepoBase.map.get(JOB_ID_1)?.status === JOB_STATUS.FAILED) break;
        }
        const failedSnap = failRepoBase.map.get(JOB_ID_1);
        assert.equal(failedSnap.status, JOB_STATUS.FAILED);
        assert.equal(failedSnap.error.itemId, 'seg-2', 'Failing itemId must reflect live item_start state, not stale null');
        assert.equal(failedSnap.items[0].status, 'completed');
        assert.equal(failedSnap.items[1].status, 'failed');
        assert.equal(failRepoBase.map.get(stale2.id).status, JOB_STATUS.INTERRUPTED, 'Second stale job must recover despite 409 on first');
        assert.equal(failCtrl.error, null);
      } finally {
        await act(async () => { root2.unmount(); });
      }

      // 3) Built-in media executors: subtitle_translate, subtitle_extract, video_burn (ok + 404 expired), video_dub (ok + missing clips)
      const projStore = {
        id: PROJ_ID,
        type: 'subtitles',
        kind: 'subtitle',
        revision: 1,
        segments: [{ id: 'cue-1', start: 0, end: 2, text: 'Hello' }],
        payload: { segments: [{ id: 'cue-1', start: 0, end: 2, text: 'Hello' }] },
      };
      const mediaJobsRepo = createInMemoryJobRepo([
        createProductionJob({
          id: '99999999-9999-4999-8999-999999999991',
          type: 'subtitle_translate',
          projectId: PROJ_ID,
          title: 'Translate Batch',
          items: [{ itemId: 'cue-1', segmentId: 'cue-1', label: 'Cue 1', metadata: { text: 'Hello' } }],
          metadata: { sourceLanguage: 'en', targetLanguage: 'km' },
        }),
        createProductionJob({
          id: '99999999-9999-4999-8999-999999999992',
          type: 'subtitle_extract',
          projectId: PROJ_ID,
          title: 'Extract Batch',
          items: [{ itemId: 'extract-1', label: 'Extract' }],
          metadata: { sourceAssetId: ASSET_ID_1 },
        }),
        createProductionJob({
          id: '99999999-9999-4999-8999-999999999993',
          type: 'video_burn',
          projectId: PROJ_ID,
          title: 'Burn Expired',
          items: [{ itemId: 'burn-1', label: 'Burn' }],
          metadata: { mediaJobId: 'expired-media-id', segments: [] },
        }),
        createProductionJob({
          id: '99999999-9999-4999-8999-999999999994',
          type: 'video_dub',
          projectId: PROJ_ID,
          title: 'Dub Valid',
          items: [{ itemId: 'dub-1', label: 'Dub' }],
          metadata: { mediaJobId: 'live-media-id', clips: [{ segmentId: 'cue-1', start: 0, end: 2, assetId: ASSET_ID_1 }] },
        }),
      ]);
      const mp4Blob = new Blob([new Uint8Array([0, 0, 0, 24])], { type: 'video/mp4' });
      const root3 = createRoot(dom.container);
      try {
        await act(async () => {
          root3.render(React.createElement(StudioProvider, {
            services: {
              ...baseServices,
              jobRepository: mediaJobsRepo,
              projectRepository: {
                async getProject(id) { return id === PROJ_ID ? structuredClone(projStore) : null; },
                async saveProject(next) {
                  projStore.segments = next.segments;
                  projStore.payload = next.payload;
                  projStore.revision += 1;
                  return { project: structuredClone(projStore), isCreated: false };
                },
              },
              mediaSubtitleGateway: {
                async translateSegments({ segments }) {
                  return { segments: segments.map(s => ({ ...s, translatedText: 'សួស្តី' })) };
                },
                async transcribeVideo() {
                  return { language: 'en', segments: [{ id: 'cue-1', start: 0, end: 2, text: 'Hello' }] };
                },
                async burnSubtitles({ jobId }) {
                  const err = new Error(`Job ${jobId} not found`);
                  err.status = 404;
                  throw err;
                },
                async exportDubbedVideo() {
                  return mp4Blob;
                },
              },
            },
          }, React.createElement(function MediaHarness() {
            useProductionJobs({ workerSessionId: 'tab-media', autoRecover: false });
            return null;
          })));
        });
        for (let i = 0; i < 200; i += 1) {
          await act(async () => { await new Promise(r => setTimeout(r, 10)); });
          const allDone = [...mediaJobsRepo.map.values()].every(j => j.status === JOB_STATUS.COMPLETED || j.status === JOB_STATUS.FAILED);
          if (allDone) break;
        }
        assert.equal(mediaJobsRepo.map.get('99999999-9999-4999-8999-999999999991').status, JOB_STATUS.COMPLETED);
        assert.equal(mediaJobsRepo.map.get('99999999-9999-4999-8999-999999999992').status, JOB_STATUS.COMPLETED);
        const expiredBurn = mediaJobsRepo.map.get('99999999-9999-4999-8999-999999999993');
        assert.equal(expiredBurn.status, JOB_STATUS.FAILED);
        assert.equal(expiredBurn.error.code, 'MEDIA_JOB_EXPIRED');
        assert.match(expiredBurn.error.message, /expired/i);
        const validDub = mediaJobsRepo.map.get('99999999-9999-4999-8999-999999999994');
        assert.equal(validDub.status, JOB_STATUS.COMPLETED);
        assert.equal(validDub.artifacts.length, 1);
        assert.equal(validDub.artifacts[0].kind, 'video');
      } finally {
        await act(async () => { root3.unmount(); });
      }

      // 4) useSubtitleVoiceover.hydrateClipsFromJob loads retried batch assets into segmentClips + orphan job cleanup on start failure
      const prevCreateUrl = URL.createObjectURL;
      const prevRevokeUrl = URL.revokeObjectURL;
      URL.createObjectURL = () => 'blob:hydrated-test';
      URL.revokeObjectURL = () => {};
      let voiceCtrl = null;
      const orphanRepoBase = createInMemoryJobRepo();
      let cancelOrphanCalls = 0;
      const orphanRepo = {
        ...orphanRepoBase,
        async updateJob(id, patch) {
          if (patch.action === 'prepare') throw new Error('Storage blip during prepare');
          return orphanRepoBase.updateJob(id, patch);
        },
        async cancelJob(id, opts) {
          cancelOrphanCalls += 1;
          return orphanRepoBase.cancelJob(id, opts);
        },
      };
      const segments = [
        { id: 'cue-1', start: 0, end: 2, text: 'Frame one' },
        { id: 'cue-2', start: 2, end: 4, text: 'Frame two' },
      ];
      function VoiceHydrateHarness() {
        voiceCtrl = useSubtitleVoiceover({ segments });
        return null;
      }
      const root4 = createRoot(dom.container);
      try {
        await act(async () => {
          root4.render(React.createElement(StudioProvider, {
            services: { ...baseServices, jobRepository: orphanRepo },
          }, React.createElement(VoiceHydrateHarness)));
        });
        const completedSubJob = createProductionJob({
          id: JOB_ID_1,
          type: 'subtitle_voiceover',
          title: 'Retried Subtitles',
          status: JOB_STATUS.COMPLETED,
          items: [
            { itemId: 'cue-1', segmentId: 'cue-1', label: 'Frame #1', status: 'completed', outputAssetId: ASSET_ID_1, durationSeconds: 1.0, metadata: { text: 'Frame one', voiceId: 'char-nisa' } },
          ],
        });
        let count = 0;
        await act(async () => {
          count = await voiceCtrl.hydrateClipsFromJob(completedSubJob);
        });
        assert.equal(count, 1);
        assert.equal(voiceCtrl.segmentClips['cue-1']?.audioAssetId, ASSET_ID_1);
        // Second call must skip already-hydrated clip (no duplicate fetch)
        let secondCount = 0;
        await act(async () => {
          secondCount = await voiceCtrl.hydrateClipsFromJob(completedSubJob);
        });
        assert.equal(secondCount, 0);

        // Trigger generateSelectedVoices when prepare fails: newly enqueued job MUST be cancelled cleanly (no orphan queued job)
        await act(async () => { voiceCtrl.toggleSelectSegment('cue-2'); });
        await act(async () => { await voiceCtrl.generateSelectedVoices(); });
        assert.equal(cancelOrphanCalls, 1, 'Partially created subtitle job must be cancelled when prepare fails');
        assert.equal([...orphanRepoBase.map.values()].some(j => j.status === JOB_STATUS.QUEUED), false);
      } finally {
        await act(async () => { root4.unmount(); });
        URL.createObjectURL = prevCreateUrl;
        URL.revokeObjectURL = prevRevokeUrl;
      }
    });
  } finally {
    dom.restore();
  }
});

test('isJobWorkerStale detects orphaned same-tab jobs when no active runner owns job id and heartbeat expired', () => {
  const nowMs = Date.parse('2026-11-27T10:05:00.000Z');
  const staleBeat = '2026-11-27T10:03:00.000Z';
  const freshBeat = '2026-11-27T10:04:50.000Z';
  const sameTabJob = createProductionJob({
    id: JOB_ID_1,
    type: 'subtitle_voiceover',
    title: 'Orphaned same-tab job',
    status: JOB_STATUS.RUNNING,
    workerSessionId: 'tab-same',
    lastHeartbeatAt: staleBeat,
  });

  // Backwards-compatible default without activeJobIds treats currentSessionId as live.
  assert.equal(isJobWorkerStale(sameTabJob, { currentSessionId: 'tab-same', nowMs }), false);
  // Actively running job inside activeJobIds is NOT stale.
  assert.equal(isJobWorkerStale(sameTabJob, { currentSessionId: 'tab-same', activeJobIds: new Set([JOB_ID_1]), nowMs }), false);
  // Same-tab job NOT owned by activeJobIds with stale heartbeat IS recoverable.
  assert.equal(isJobWorkerStale(sameTabJob, { currentSessionId: 'tab-same', activeJobIds: new Set(), nowMs }), true);
  // Same-tab job with fresh heartbeat is NOT falsely marked stale.
  assert.equal(
    isJobWorkerStale({ ...sameTabJob, lastHeartbeatAt: freshBeat }, { currentSessionId: 'tab-same', activeJobIds: new Set(), nowMs }),
    false
  );
});
