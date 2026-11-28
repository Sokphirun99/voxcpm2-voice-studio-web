/**
 * @fileoverview SSR and mounted integration tests for R3-08 Export presets modal,
 * VTT/SRT/WAV/MP4 preset execution, and Release 3 project reopen with edits, takes, and export history intact.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createVoiceAnchorUseCases, createVoiceLibraryUseCases } from '../../src/domain/useCases.js';
import {
  createProjectSegment,
  createSegmentTake,
  createSubtitleProjectSnapshot,
  createTtsProjectSnapshot,
} from '../../src/domain/projects.js';
import { EXPORT_PRESET_IDS } from '../../src/domain/exportPresets.js';
import { createStorageStore } from '../../server/storageStore.js';
import { createStorageHttpApp } from '../../server/httpApp.js';
import { createHttpProjectRepository } from '../../src/data/httpProjectRepository.js';
import { createHttpAssetRepository } from '../../src/data/httpAssetRepository.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function createTestWavBlob(durationMs = 200) {
  const sampleRate = 48000;
  const frames = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const dataLen = frames * 2;
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
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataLen, true);
  return new Blob([buf], { type: 'audio/wav' });
}

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
  const blobByUrl = new Map();
  let seq = 0;
  URL.createObjectURL = blob => {
    const url = `blob:export-test/${++seq}`;
    blobByUrl.set(url, blob);
    return url;
  };
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
    setTimeout: () => 1,
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
    getElementById(id) { return docEl.querySelector(`#${id}`); },
    querySelector(sel) { return docEl.querySelector(sel); },
    querySelectorAll(sel) { return docEl.querySelectorAll(sel); },
    addEventListener() {},
    removeEventListener() {},
  };
  win.document = doc;
  const container = new MiniElement('div');
  body.appendChild(container);
  Object.assign(globalThis, { window: win, document: doc, HTMLIFrameElement, ResizeObserver: win.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true });
  return {
    container,
    doc,
    blobByUrl,
    restore() {
      URL.createObjectURL = prev.createObjectURL;
      URL.revokeObjectURL = prev.revokeObjectURL;
      Object.assign(globalThis, {
        window: prev.window, document: prev.document, HTMLIFrameElement: prev.HTMLIFrameElement,
        ResizeObserver: prev.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: prev.IS_REACT_ACT_ENVIRONMENT,
      });
    },
  };
}

test('ExportProjectModal SSR renders audio, subtitle, and MP4 presets with expected outputs, warnings, blockers, and history', async () => {
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const { ExportProjectModal } = await vite.ssrLoadModule('/src/presentation/components/ExportProjectModal.jsx');
    const wavBlob = createTestWavBlob(400);

    const subtitleHtml = renderToStaticMarkup(
      React.createElement(ExportProjectModal, {
        open: true,
        workspace: 'subtitle',
        context: {
          projectTitle: 'Khmer Documentary',
          videoFileName: 'episode_01.mkv',
          segments: [
            { id: 's1', start: 0, end: 1.5, text: 'Hello --> team', translatedText: 'សួស្តី' },
            { id: 's2', start: 2.0, end: 4.0, text: 'Second cue', translatedText: '' },
          ],
          segmentClips: { s1: { blob: wavBlob, durationSeconds: 2.1 } },
          detectedLanguage: 'en',
          translatedLanguage: 'khm_Khmr',
          hasTranslation: true,
          useTranslation: true,
          videoDuration: 5.0,
          hasLinkedVideo: true,
          jobId: 'job-001',
          burnInSupported: true,
        },
        exportHistory: [
          {
            id: 'exp-1',
            presetId: 'subtitle_vtt',
            category: 'subtitle',
            label: 'WebVTT Subtitles (.vtt)',
            filename: 'episode_01.km.vtt',
            format: 'VTT',
            durationSeconds: 4.0,
            languageCode: 'km',
            languageLabel: 'Khmer',
            exportedAt: '2026-11-26T00:00:00.000Z',
          },
        ],
      })
    );

    assert.ok(subtitleHtml.includes('Audio presets (WAV)'));
    assert.ok(subtitleHtml.includes('Subtitle &amp; script presets'));
    assert.ok(subtitleHtml.includes('Supported video presets (MP4)'));
    assert.ok(subtitleHtml.includes('episode_01.vtt'));
    assert.ok(subtitleHtml.includes('episode_01-dubbed.mp4'));
    assert.ok(subtitleHtml.includes('Khmer (km)'));
    assert.ok(subtitleHtml.includes('H.264 (yuv420p)'));
    assert.ok(subtitleHtml.includes('UTF-8 clean text'));
    assert.ok(subtitleHtml.includes('Browser downloads folder'));
    assert.ok(subtitleHtml.includes('export-advanced-details'));
    assert.ok(subtitleHtml.includes('Advanced export options'));
    assert.ok(subtitleHtml.includes('lack translations'));
    assert.ok(subtitleHtml.includes('Non-MP4 source container'));
    assert.ok(subtitleHtml.includes('id="export-history-list"'));
    assert.ok(subtitleHtml.includes('episode_01.km.vtt'));

    const ttsHtml = renderToStaticMarkup(
      React.createElement(ExportProjectModal, {
        open: true,
        workspace: 'tts',
        context: {
          projectTitle: 'Narration Episode',
          ttsRecording: null,
          ttsSegments: [],
        },
        exportHistory: [],
      })
    );
    assert.ok(ttsHtml.includes('Narration Master WAV'));
    assert.ok(ttsHtml.includes('Generate audio or assemble narration before exporting WAV.'));
    assert.ok(ttsHtml.includes('id="export-history-empty"'));
  } finally {
    await vite.close();
  }
});

test('mounted ExportProject workflow exports VTT/MP4 presets and reopens subtitle & TTS projects with edits, takes, and export history intact', async () => {
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
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    const downloads = [];
    const dubCalls = [];
    const storedProjects = new Map();
    const assetStore = new Map();
    let seq = 0;

    const origCreateElement = dom.doc.createElement.bind(dom.doc);
    dom.doc.createElement = tag => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        el.click = () => { downloads.push({ filename: el.download, href: el.href, blob: dom.blobByUrl.get(el.href) || null }); };
      }
      return el;
    };

    const makePersistentRepos = () => {
      let idCount = storedProjects.size;
      const uuids = [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      ];
      return {
        projectRepository: {
          listProjects: async ({ kind } = {}) => {
            const all = Array.from(storedProjects.values()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
            const items = kind ? all.filter(p => p.kind === kind) : all;
            return { items, total: items.length, limit: 50, offset: 0 };
          },
          getProject: async id => storedProjects.get(id) ? JSON.parse(JSON.stringify(storedProjects.get(id))) : null,
          createProject: async spec => {
            const id = spec.id || uuids[idCount++] || `cccccccc-cccc-4ccc-8ccc-${String(idCount).padStart(12, '0')}`;
            const saved = { ...spec, id, revision: 1, updatedAt: new Date().toISOString() };
            storedProjects.set(id, JSON.parse(JSON.stringify(saved)));
            return { project: saved, isCreated: true };
          },
          saveProject: async (rawId, rawSpec) => {
            const spec = typeof rawId === 'object' && rawId ? rawId : (rawSpec || {});
            const existingId = typeof rawId === 'string' && rawId ? rawId : (spec.id || '');
            const id = existingId || uuids[idCount++] || `cccccccc-cccc-4ccc-8ccc-${String(idCount).padStart(12, '0')}`;
            const prevRev = Number(storedProjects.get(id)?.revision || 0);
            const saved = { ...spec, id, revision: prevRev + 1, updatedAt: new Date().toISOString() };
            storedProjects.set(id, JSON.parse(JSON.stringify(saved)));
            return { project: saved, isCreated: prevRev === 0 };
          },
          deleteProject: async id => { storedProjects.delete(id); return { deleted: true, id }; },
        },
        assetRepository: {
          uploadAsset: async ({ bytes, mimeType, fileName }) => {
            const assetId = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
            assetStore.set(assetId, { bytes: new Uint8Array(bytes), mimeType, fileName });
            return { asset: { id: assetId, mimeType, fileName } };
          },
          getAssetBinary: async assetId => assetStore.get(assetId) || null,
        },
      };
    };

    const buildServices = repos => ({
      ...repos,
      speechGateway: {
        checkAvailability: async () => true,
        checkHealth: async () => ({ online: true, ok: true }),
        uploadReferenceAudio: async () => ({}),
        synthesize: async () => ({}),
      },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true, models: {} }),
        transcribeVideo: async () => ({
          jobId: 'r308job123456789',
          language: 'en',
          translatedLanguage: 'khm_Khmr',
          isAudioOnly: false,
          speakers: ['speaker-1'],
          videoSize: { width: 1280, height: 720 },
          segments: [
            { id: 'seg-1', start: 0.0, end: 1.5, speakerId: 'speaker-1', text: 'Original English line', translatedText: 'បន្ទាត់ខ្មែរដើម' },
          ],
        }),
        translateSegments: async ({ segments }) => ({ segments }),
        burnSubtitles: async () => new Blob(['ftypburnedmp4'], { type: 'video/mp4' }),
        exportDubbedVideo: async params => {
          dubCalls.push(params);
          return new Blob(['ftypdubmp4'], { type: 'video/mp4' });
        },
      },
      synthesizeSpeech: {
        execute: async cmd => {
          const blob = createTestWavBlob(250);
          return {
            recording: {
              id: `take-${++seq}`,
              characterId: cmd.character.id,
              characterName: cmd.character.name,
              transcript: cmd.script,
              blob,
              audioUrl: URL.createObjectURL(blob),
              audioDurationSeconds: 0.25,
              seed: 11,
            },
            uploadedFileData: null,
          };
        },
        restitchSegments: async () => {
          const blob = createTestWavBlob(300);
          return {
            recording: {
              id: `narration-${++seq}`,
              blob,
              audioUrl: URL.createObjectURL(blob),
              audioDurationSeconds: 0.3,
              filename: 'tts-story-narration.wav',
              isAssembled: true,
              isNarration: true,
              chunks: [],
            },
          };
        },
      },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      lockReferenceAudio: { execute: async file => ({ blob: file }) },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    });

    // --- Session 1: TTS narration export + Subtitle/Dubbing export ---
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services: buildServices(makePersistentRepos()) }, React.createElement(Studio)));
    });

    // Generate TTS take + open TTS Export Project modal + export narration WAV
    const scriptArea = dom.container.querySelector('#script');
    await act(async () => {
      scriptArea._value = 'Hello Cambodia.';
      scriptArea.dispatchEvent({ type: 'input', bubbles: true, target: scriptArea });
    });
    await act(async () => {
      dom.container.querySelector('#speech-form').dispatchEvent({ type: 'submit', bubbles: true });
      await new Promise(r => setTimeout(r, 20));
    });
    await act(async () => { dom.container.querySelector('#tts-export-project-btn').click(); });
    const ttsDialog = dom.container.querySelector('#export-project-dialog');
    assert.equal(ttsDialog.open, true);
    const ttsPresetBtn = ttsDialog.querySelector('#export-preset-btn-tts_narration_wav');
    assert.equal(ttsPresetBtn.disabled || ttsPresetBtn.hasAttribute('disabled'), false);
    await act(async () => {
      ttsPresetBtn.click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.ok(ttsDialog.querySelector('#export-history-list').textContent.includes('narration.wav'));
    await act(async () => { ttsDialog.querySelector('#export-project-close-btn').click(); });

    // Switch to Video to Subtitle workspace, load .mkv, edit cue, generate voice clip, export VTT & Dubbed MP4
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });
    const subPanel = dom.container.querySelector('.subtitle-workspace');
    const fileInput = subPanel.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mkvbytes'], 'interview.mkv', { type: 'video/x-matroska' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });

    const cueInput = subPanel.querySelector('.subtitle-line-input');
    await act(async () => {
      cueInput._value = 'Edited Khmer subtitle line';
      cueInput.dispatchEvent({ type: 'input', bubbles: true, target: cueInput });
    });
    await act(async () => {
      subPanel.querySelector('.subtitle-cue-voice-btn').click();
      await new Promise(r => setTimeout(r, 20));
    });

    await act(async () => { subPanel.querySelector('#subtitle-export-project-btn').click(); });
    const subDialog = subPanel.querySelector('#export-project-dialog');
    assert.equal(subDialog.open, true);
    assert.match(subDialog.textContent, /Non-MP4 source container/);
    assert.match(subDialog.textContent, /Khmer \(km\)/);

    const langModeSelect = subDialog.querySelector('#export-language-mode');
    const stemInput = subDialog.querySelector('#export-filename-stem');
    const langSuffixCheck = subDialog.querySelector('#export-language-suffix');
    const dubModeSelect = subDialog.querySelector('#export-dub-audio-mode');
    await act(async () => {
      langModeSelect.value = 'original';
      langModeSelect.dispatchEvent({ type: 'change', bubbles: true, target: langModeSelect });
    });
    assert.match(subDialog.textContent, /English \(en\)/);
    await act(async () => {
      langModeSelect.value = 'bilingual';
      langModeSelect.dispatchEvent({ type: 'change', bubbles: true, target: langModeSelect });
    });
    await act(async () => {
      stemInput._value = 'cambodia-brief';
      stemInput.dispatchEvent({ type: 'input', bubbles: true, target: stemInput });
    });
    assert.match(subDialog.textContent, /cambodia-brief/);
    await act(async () => {
      langSuffixCheck.checked = true;
      langSuffixCheck.dispatchEvent({ type: 'click', bubbles: true, target: langSuffixCheck });
      dubModeSelect.value = 'mute';
      dubModeSelect.dispatchEvent({ type: 'change', bubbles: true, target: dubModeSelect });
    });
    assert.match(subDialog.textContent, /Khmer \(km\)/);

    await act(async () => { subDialog.querySelector('#export-preset-btn-subtitle_vtt').click(); });
    const vttDownload = downloads.find(d => d.filename === 'cambodia-brief.km.vtt');
    assert.ok(vttDownload, `Expected cambodia-brief.km.vtt download, got ${JSON.stringify(downloads.map(d => d.filename))}`);
    const vttText = await vttDownload.blob.text();
    assert.ok(vttText.startsWith('WEBVTT\nKind: subtitles\nLanguage: km\n\n'));
    assert.ok(vttText.includes('Original English line\nEdited Khmer subtitle line'));

    await act(async () => {
      subDialog.querySelector('#export-preset-btn-video_dubbed_mp4').click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(dubCalls.length, 1);
    assert.equal(dubCalls[0].originalAudioMode, 'mute');
    assert.equal(dubCalls[0].audioLanguage, 'khm_Khmr');
    assert.ok(downloads.some(d => d.filename === 'cambodia-brief-dubbed.mp4'));
    assert.equal(subDialog.querySelector('#export-filename-stem').value, 'cambodia-brief');
    assert.equal(subDialog.querySelector('#export-language-suffix').checked, true);
    assert.ok(subDialog.querySelector('#export-history-list').textContent.includes('cambodia-brief-dubbed.mp4'));
    await act(async () => { subDialog.querySelector('#export-project-close-btn').click(); });

    // Wait for autosave debounce (1500ms) so both TTS & Subtitle projects flush completely
    await act(async () => { await new Promise(r => setTimeout(r, 1650)); });
    assert.equal(storedProjects.size, 2);

    // --- Session 2: Unmount & reopen Studio cleanly from persistent store ---
    await act(async () => { root.unmount(); });
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services: buildServices(makePersistentRepos()) }, React.createElement(Studio)));
      await new Promise(r => setTimeout(r, 30));
    });

    // TTS project reopened with script edits, segment takes, and export history intact
    assert.equal(dom.container.querySelector('#script').value, 'Hello Cambodia.');
    const savedTts = Array.from(storedProjects.values()).find(p => p.kind === 'tts');
    assert.equal(savedTts.segments[0].takes.length, 1);
    const reopenedTtsHistory = dom.container.querySelector('#tts-export-project-btn');
    assert.match(reopenedTtsHistory.textContent, /Export project \(1\)/);
    await act(async () => { reopenedTtsHistory.click(); });
    const ttsReopenedDialog = dom.container.querySelector('#export-project-dialog');
    const ttsReopenedBtn = ttsReopenedDialog.querySelector('#export-preset-btn-tts_narration_wav');
    assert.equal(ttsReopenedBtn.disabled || ttsReopenedBtn.hasAttribute('disabled'), false);
    assert.ok(ttsReopenedDialog.querySelector('#export-history-list').textContent.includes('narration.wav'));
    const downloadsBeforeTtsReexport = downloads.length;
    await act(async () => {
      ttsReopenedBtn.click();
      await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(downloads.length, downloadsBeforeTtsReexport + 1);
    assert.match(downloads.at(-1).filename, /narration\.wav$/);
    assert.match(reopenedTtsHistory.textContent, /Export project \(2\)/);
    await act(async () => { ttsReopenedDialog.querySelector('#export-project-close-btn').click(); });

    // Subtitle project reopened with edited cue text + export history intact + relink blocker on MP4 + working SRT export
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });
    const reopenedSubPanel = dom.container.querySelector('.subtitle-workspace');
    assert.equal(reopenedSubPanel.querySelector('.subtitle-line-input').value, 'Edited Khmer subtitle line');
    const subExportBtn = reopenedSubPanel.querySelector('#subtitle-export-project-btn');
    assert.match(subExportBtn.textContent, /Export project \(2\)/);

    await act(async () => { subExportBtn.click(); });
    const reopenedDialog = reopenedSubPanel.querySelector('#export-project-dialog');
    const historyText = reopenedDialog.querySelector('#export-history-list').textContent;
    assert.ok(historyText.includes('cambodia-brief-dubbed.mp4'));
    assert.ok(historyText.includes('cambodia-brief.km.vtt'));
    const reopenedSrtBtn = reopenedDialog.querySelector('#export-preset-btn-subtitle_srt');
    assert.equal(Boolean(reopenedSrtBtn.disabled || reopenedSrtBtn.hasAttribute('disabled')), false);
    assert.equal(
      Boolean(reopenedDialog.querySelector('#export-preset-btn-video_dubbed_mp4').disabled || reopenedDialog.querySelector('#export-preset-btn-video_dubbed_mp4').hasAttribute('disabled')),
      true
    );
    assert.match(reopenedDialog.textContent, /Re-link/);
    await act(async () => { reopenedSrtBtn.click(); });
    const srtDownload = downloads.find(d => d.filename === 'interview.srt');
    assert.ok(srtDownload, 'Reopened project should export interview.srt using preserved videoFileName stem');
    const srtText = await srtDownload.blob.text();
    assert.match(srtText, /1\n00:00:00,000 --> 00:00:01,500\nEdited Khmer subtitle line/);
    assert.match(subExportBtn.textContent, /Export project \(3\)/);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('ExportProjectModal preserves draft on context updates, deduplicates close, and surfaces export errors', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    logLevel: 'silent',
  });
  let root;
  try {
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    const { ExportProjectModal } = await vite.ssrLoadModule('/src/presentation/components/ExportProjectModal.jsx');
    let closeCalls = 0;
    const baseContext = {
      workspace: 'subtitle',
      videoFileName: 'intro.mkv',
      segments: [{ id: 's1', start: 0, end: 1.5, text: 'Hello', translatedText: '' }],
      detectedLanguage: 'en',
      hasTranslation: false,
      useTranslation: true,
      dubAudioMode: 'duck',
    };
    const renderModal = async ctx => {
      await act(async () => {
        root.render(React.createElement(ExportProjectModal, {
          open: true,
          workspace: 'subtitle',
          context: ctx,
          exportHistory: [],
          onClose: () => { closeCalls += 1; },
          onExportPreset: async () => { throw new Error('Simulated burn failure'); },
        }));
      });
    };

    root = createRoot(dom.container);
    await renderModal(baseContext);
    const dialog = dom.container.querySelector('#export-project-dialog');
    // Un-translated projects clamp initial languageMode to 'original'
    assert.equal(dialog.querySelector('#export-language-mode').value, 'original');

    const stemInput = dialog.querySelector('#export-filename-stem');
    const langSuffixCheck = dialog.querySelector('#export-language-suffix');
    await act(async () => {
      stemInput._value = 'kept-custom-name';
      stemInput.dispatchEvent({ type: 'input', bubbles: true, target: stemInput });
      langSuffixCheck.checked = true;
      langSuffixCheck.dispatchEvent({ type: 'click', bubbles: true, target: langSuffixCheck });
    });

    // Context update (like dubAudioMode changing) must not wipe user-entered draft values
    await renderModal({ ...baseContext, dubAudioMode: 'mute' });
    assert.equal(dialog.querySelector('#export-filename-stem').value, 'kept-custom-name');
    assert.equal(dialog.querySelector('#export-language-suffix').checked, true);

    // Export failure surfaces human-readable alert inside modal
    await act(async () => {
      dialog.querySelector('#export-preset-btn-subtitle_srt').click();
      await new Promise(r => setTimeout(r, 10));
    });
    const alertEl = dialog.querySelector('.terminology-error');
    assert.ok(alertEl);
    assert.match(alertEl.textContent, /Simulated burn failure/);

    // Close button & Escape key trigger close cleanly once without duplicate calls
    await act(async () => {
      dialog.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    });
    assert.equal(closeCalls, 1);

    // Active export progress banner + Cancel button invoke onCancelExport
    let cancelCount = 0;
    await act(async () => {
      root.render(React.createElement(ExportProjectModal, {
        open: true,
        workspace: 'subtitle',
        context: baseContext,
        exportHistory: [],
        busy: true,
        onCancelExport: () => { cancelCount += 1; },
        onClose: () => {},
        onExportPreset: async () => {},
      }));
    });
    const banner = dom.container.querySelector('#export-progress-banner');
    const cancelBtn = dom.container.querySelector('#export-cancel-btn');
    assert.ok(banner, 'Busy ExportProjectModal must render progress banner');
    assert.ok(cancelBtn, 'Busy ExportProjectModal must render Cancel export button');
    await act(async () => { cancelBtn.click(); });
    assert.equal(cancelCount, 1);
  } finally {
    await actOrNoop(() => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

async function actOrNoop(fn) {
  try {
    const { act } = await import('react');
    await act(async () => { fn?.(); });
  } catch {
    fn?.();
  }
}

function createInProcessAppFetch(app) {
  return async (url, init = {}) => {
    const reqObj = new Request(url, init);
    const parsed = new URL(reqObj.url);
    const bodyBuf = reqObj.body ? Buffer.from(await reqObj.arrayBuffer()) : Buffer.alloc(0);
    const req = Readable.from(bodyBuf.length ? [bodyBuf] : []);
    req.method = reqObj.method;
    req.url = `${parsed.pathname}${parsed.search}`;
    req.headers = Object.fromEntries(reqObj.headers.entries());
    req.socket = { remoteAddress: '127.0.0.1' };
    return new Promise((resolve, reject) => {
      const headers = new Map();
      const chunks = [];
      let statusCode = 200;
      const res = {
        get statusCode() { return statusCode; },
        set statusCode(v) { statusCode = v; },
        headersSent: false,
        setHeader(k, v) { headers.set(String(k).toLowerCase(), String(v)); },
        getHeader(k) { return headers.get(String(k).toLowerCase()); },
        writeHead(status, extraHeaders = {}) {
          statusCode = status;
          for (const [k, v] of Object.entries(extraHeaders)) headers.set(String(k).toLowerCase(), String(v));
          this.headersSent = true;
        },
        write(chunk) {
          if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        },
        end(chunk) {
          if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const outHeaders = new Headers();
          for (const [k, v] of headers.entries()) outHeaders.set(k, v);
          resolve(new Response(Buffer.concat(chunks), { status: statusCode, headers: outHeaders }));
        },
        on() { return this; },
        once() { return this; },
        emit() { return false; },
      };
      Promise.resolve(app(req, res)).catch(reject);
    });
  };
}

test('Real HTTP storage server and repositories persist TTS takes, subtitle mediaDuration, and exportHistory across restart', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxcpm-export-persist-'));
  try {
    const store1 = createStorageStore({ dataDir: tempDir });
    await store1.init();
    const fetch1 = createInProcessAppFetch(createStorageHttpApp({ store: store1 }));
    const baseUrl = 'http://127.0.0.1:4174/api/v1';

    const projectRepo1 = createHttpProjectRepository({ baseUrl, fetchImpl: fetch1 });
    const assetRepo1 = createHttpAssetRepository({ baseUrl, fetchImpl: fetch1 });

    const ttsId = '11111111-1111-4111-8111-111111111111';
    const subId = '22222222-2222-4222-8222-222222222222';
    const initialTts = await projectRepo1.saveProject(createTtsProjectSnapshot({
      id: ttsId,
      title: 'HTTP TTS Project',
      script: 'Persisted narration',
    }));
    const takeBlob = createTestWavBlob(350);
    const { asset } = await assetRepo1.uploadAsset({
      bytes: new Uint8Array(await takeBlob.arrayBuffer()),
      fileName: 'take-1.wav',
      kind: 'audio',
      mimeType: 'audio/wav',
      projectId: ttsId,
    });
    assert.ok(asset?.id);

    const ttsSnap = createTtsProjectSnapshot({
      id: ttsId,
      revision: initialTts.revision,
      title: 'HTTP TTS Project',
      script: 'Persisted narration',
      segments: [
        createProjectSegment({
          id: 'seg-tts-1',
          text: 'Persisted narration',
          takes: [
            createSegmentTake({
              id: 'take-1',
              text: 'Persisted narration',
              audioAssetId: asset.id,
              duration: 0.35,
              blob: {}, // non-Blob object from legacy/corrupt JSON must be stripped cleanly
            }),
          ],
          activeTakeId: 'take-1',
        }),
      ],
      exportHistory: [
        { presetId: EXPORT_PRESET_IDS.TTS_NARRATION_WAV, filename: 'HTTP-TTS-Project-narration.wav', category: 'audio', format: 'wav', durationSeconds: 0.35, languageCode: 'en', languageLabel: 'English' },
      ],
    });
    assert.equal(ttsSnap.segments[0].takes[0].blob, null);
    await projectRepo1.saveProject(ttsSnap);

    const subSnap = createSubtitleProjectSnapshot({
      id: subId,
      title: 'HTTP Subtitle Project',
      videoFileName: 'report.mp4',
      mediaDuration: 42.5,
      detectedLanguage: 'en',
      translatedLanguage: 'khm_Khmr',
      hasTranslation: true,
      segments: [{ id: 's1', start: 0, end: 2.0, text: 'Hello', translatedText: 'សួស្តី', speakerId: 'speaker-1' }],
      exportHistory: [
        { presetId: EXPORT_PRESET_IDS.SUBTITLE_VTT, filename: 'report.km.vtt', category: 'subtitle', format: 'vtt', durationSeconds: 2.0, languageCode: 'km', languageLabel: 'Khmer' },
      ],
    });
    await projectRepo1.saveProject(subSnap);

    // Re-open store & HTTP app on same dataDir to simulate restart
    const store2 = createStorageStore({ dataDir: tempDir });
    await store2.init();
    const fetch2 = createInProcessAppFetch(createStorageHttpApp({ store: store2 }));

    const projectRepo2 = createHttpProjectRepository({ baseUrl, fetchImpl: fetch2 });
    const assetRepo2 = createHttpAssetRepository({ baseUrl, fetchImpl: fetch2 });

    const reloadedTts = await projectRepo2.getProject(ttsId);
    assert.equal(reloadedTts.segments[0].takes[0].audioAssetId, asset.id);
    assert.equal(reloadedTts.segments[0].takes[0].duration, 0.35);
    assert.equal(reloadedTts.segments[0].takes[0].blob, null);
    assert.equal(reloadedTts.exportHistory.length, 1);
    assert.equal(reloadedTts.exportHistory[0].filename, 'HTTP-TTS-Project-narration.wav');

    const binary = await assetRepo2.getAssetBinary(asset.id);
    assert.equal(binary.bytes.byteLength, (await takeBlob.arrayBuffer()).byteLength);

    const reloadedSub = await projectRepo2.getProject(subId);
    assert.equal(reloadedSub.payload.mediaDuration, 42.5);
    assert.equal(reloadedSub.exportHistory.length, 1);
    assert.equal(reloadedSub.exportHistory[0].filename, 'report.km.vtt');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
