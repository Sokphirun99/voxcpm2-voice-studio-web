/**
 * @fileoverview Mounted UI, persistence, silent-video guard, and batch-job tests for R3-09 Video dubbing export.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createServer } from 'vite';
import { createVoiceAnchorUseCases, createVoiceLibraryUseCases } from '../../src/domain/useCases.js';
import { JOB_STATUS, createProductionJob } from '../../src/domain/productionJobs.js';

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
      this.oninput = null;
      this.onchange = null;
      this.files = [];
      this.checked = false;
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
    const url = `blob:r309/${++seq}`;
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

test('R3-09 mounted workflow: audio/subtitle modes, mixing/ducking sliders, original-audio export, silent-video guard, and persistence', async () => {
  const dom = createDomShim();
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
    let hasAudioStreamResponse = true;
    let expireNextDub = false;
    let seq = 0;

    const origCreateElement = dom.doc.createElement.bind(dom.doc);
    dom.doc.createElement = tag => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        el.click = () => { downloads.push({ filename: el.download, blob: dom.blobByUrl.get(el.href) || null }); };
      }
      return el;
    };

    const projectRepository = {
      listProjects: async ({ kind } = {}) => {
        const all = Array.from(storedProjects.values());
        const items = kind ? all.filter(p => p.kind === kind) : all;
        return { items, total: items.length, limit: 50, offset: 0 };
      },
      getProject: async id => storedProjects.get(id) ? JSON.parse(JSON.stringify(storedProjects.get(id))) : null,
      saveProject: async (rawId, rawSpec) => {
        const spec = typeof rawId === 'object' && rawId ? rawId : (rawSpec || {});
        const id = (typeof rawId === 'string' && rawId) || spec.id || 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
        const prevRev = Number(storedProjects.get(id)?.revision || 0);
        const saved = { ...spec, id, revision: prevRev + 1, updatedAt: new Date().toISOString() };
        storedProjects.set(id, JSON.parse(JSON.stringify(saved)));
        return { project: saved, isCreated: prevRev === 0 };
      },
    };

    const buildServices = () => ({
      projectRepository,
      speechGateway: {
        checkAvailability: async () => true,
        checkHealth: async () => ({ online: true, ok: true }),
        uploadReferenceAudio: async () => ({}),
        synthesize: async () => ({}),
      },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true, models: {} }),
        transcribeVideo: async () => ({
          jobId: 'r309media1234567',
          duration: 4.0,
          language: 'en',
          translatedLanguage: 'khm_Khmr',
          isAudioOnly: false,
          hasAudioStream: hasAudioStreamResponse,
          speakers: ['speaker-1'],
          videoSize: { width: 1280, height: 720 },
          segments: hasAudioStreamResponse ? [
            { id: 'seg-1', start: 0.2, end: 1.8, speakerId: 'speaker-1', text: 'Welcome everyone.', translatedText: 'សូមស្វាគមន៍ទាំងអស់គ្នា។' },
          ] : [],
        }),
        translateSegments: async ({ segments }) => ({ segments }),
        burnSubtitles: async () => new Blob(['ftypburn'], { type: 'video/mp4' }),
        exportDubbedVideo: async params => {
          if (expireNextDub) {
            expireNextDub = false;
            const err = new Error("Video session 'expired' expired. Please re-upload the video.");
            err.status = 404;
            throw err;
          }
          dubCalls.push(params);
          return new Blob(['ftypdub'], { type: 'video/mp4' });
        },
      },
      synthesizeSpeech: {
        execute: async cmd => {
          const blob = createTestWavBlob(300);
          return {
            recording: {
              id: `take-${++seq}`,
              characterId: cmd.character.id,
              characterName: cmd.character.name,
              transcript: cmd.script,
              blob,
              audioUrl: URL.createObjectURL(blob),
              audioDurationSeconds: 0.3,
              seed: 7,
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

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services: buildServices() }, React.createElement(Studio)));
    });
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });

    const subPanel = dom.container.querySelector('.subtitle-workspace');
    const fileInput = subPanel.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4bytes'], 'panel_talk.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });

    // 1. Generate voiceover clip, then open ExportProjectModal from SubtitleVoiceOutputCard to configure ducking + mixing sliders + embedded soft subtitles
    await act(async () => {
      subPanel.querySelector('.subtitle-cue-voice-btn').click();
      await new Promise(r => setTimeout(r, 20));
    });
    const voiceCard = subPanel.querySelector('#subtitle-voice-output');
    assert.ok(voiceCard);
    await act(async () => { voiceCard.querySelector('#subtitle-voice-export-btn').click(); });

    const dialog = subPanel.querySelector('#export-project-dialog');
    assert.ok(dialog);
    const subModeSelect = dialog.querySelector('#export-dub-subtitle-mode');
    const origSlider = dialog.querySelector('#export-orig-volume');
    const dubSlider = dialog.querySelector('#export-dub-volume');
    const duckSlider = dialog.querySelector('#export-duck-volume');
    const resetMixBtn = dialog.querySelector('#export-reset-mix-btn');
    assert.equal(resetMixBtn.disabled || resetMixBtn.hasAttribute('disabled'), true);

    await act(async () => {
      subModeSelect.value = 'soft';
      subModeSelect.dispatchEvent({ type: 'change', bubbles: true, target: subModeSelect });
      origSlider._value = '0.8';
      origSlider.dispatchEvent({ type: 'input', bubbles: true, target: origSlider });
      dubSlider._value = '1.25';
      dubSlider.dispatchEvent({ type: 'input', bubbles: true, target: dubSlider });
      duckSlider._value = '0.3';
      duckSlider.dispatchEvent({ type: 'input', bubbles: true, target: duckSlider });
    });
    assert.equal(resetMixBtn.disabled || resetMixBtn.hasAttribute('disabled'), false);

    await act(async () => {
      dialog.querySelector('#export-preset-btn-video_dubbed_mp4').click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(dubCalls.length, 1);
    assert.equal(dubCalls[0].originalAudioMode, 'duck');
    assert.equal(dubCalls[0].subtitleMode, 'soft');
    assert.deepEqual(dubCalls[0].mixSettings, { originalVolume: 0.8, dubVolume: 1.25, duckVolume: 0.3 });
    assert.equal(dubCalls[0].subtitles.useTranslation, true);
    assert.equal(dubCalls[0].clips.length, 1);
    assert.equal(downloads.at(-1).filename, 'panel_talk-dubbed-captioned.mp4');
    await act(async () => { dialog.querySelector('#export-project-close-btn').click(); });

    // 2. Reopen ExportProjectModal: verify synced mix/subtitle draft, then switch to Original audio + Burned ASS
    await act(async () => { subPanel.querySelector('#subtitle-export-project-btn').click(); });
    const secondDialog = subPanel.querySelector('#export-project-dialog');
    assert.equal(secondDialog.querySelector('#export-dub-subtitle-mode').value, 'soft');
    assert.equal(secondDialog.querySelector('#export-duck-volume').value, '0.3');

    const modalAudioSelect = secondDialog.querySelector('#export-dub-audio-mode');
    const modalSubSelect = secondDialog.querySelector('#export-dub-subtitle-mode');
    await act(async () => {
      modalAudioSelect.value = 'original';
      modalAudioSelect.dispatchEvent({ type: 'change', bubbles: true, target: modalAudioSelect });
      modalSubSelect.value = 'burned';
      modalSubSelect.dispatchEvent({ type: 'change', bubbles: true, target: modalSubSelect });
    });
    assert.equal(secondDialog.querySelector('#export-dub-volume').disabled || secondDialog.querySelector('#export-dub-volume').hasAttribute('disabled'), true);
    assert.equal(secondDialog.querySelector('#export-duck-volume').disabled || secondDialog.querySelector('#export-duck-volume').hasAttribute('disabled'), true);
    assert.match(secondDialog.textContent, /Original audio \(80%\)/);
    assert.match(secondDialog.textContent, /Burned-in ASS/);

    await act(async () => {
      secondDialog.querySelector('#export-preset-btn-video_dubbed_mp4').click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(dubCalls.length, 2);
    assert.equal(dubCalls[1].originalAudioMode, 'original');
    assert.equal(dubCalls[1].subtitleMode, 'burned');
    assert.equal(dubCalls[1].audioLanguage, 'en');
    assert.deepEqual(dubCalls[1].clips, []);
    assert.equal(downloads.at(-1).filename, 'panel_talk-subtitled.mp4');
    assert.match(secondDialog.querySelector('#export-history-list').textContent, /Audio: original · Subs: burned/);
    await act(async () => { secondDialog.querySelector('#export-project-close-btn').click(); });

    // Wait for autosave and verify reopen preserves dubAudioMode, dubSubtitleMode, dubMixSettings, and exportHistory
    await act(async () => { await new Promise(r => setTimeout(r, 1650)); });
    await act(async () => { root.unmount(); });
    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services: buildServices() }, React.createElement(Studio)));
      await new Promise(r => setTimeout(r, 30));
    });
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });
    const reopenedPanel = dom.container.querySelector('.subtitle-workspace');
    await act(async () => { reopenedPanel.querySelector('#subtitle-export-project-btn').click(); });
    const reopenedDialog = reopenedPanel.querySelector('#export-project-dialog');
    assert.equal(reopenedDialog.querySelector('#export-dub-audio-mode').value, 'original');
    assert.equal(reopenedDialog.querySelector('#export-dub-subtitle-mode').value, 'burned');
    assert.equal(reopenedDialog.querySelector('#export-orig-volume').value, '0.8');
    assert.match(reopenedDialog.querySelector('#export-history-list').textContent, /Audio: duck · Subs: soft/);
    await act(async () => { reopenedDialog.querySelector('#export-project-close-btn').click(); });

    // 3. Silent video (`hasAudioStream: false`): blocks duck mode until user explicitly selects Mute original
    hasAudioStreamResponse = false;
    const silentFileInput = reopenedPanel.querySelector('#subtitle-video-input');
    await act(async () => {
      silentFileInput.files = [new File(['mp4bytes'], 'silent_capture.mp4', { type: 'video/mp4' })];
      silentFileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { reopenedPanel.querySelector('#subtitle-extract-btn').click(); });
    const srtInput = reopenedPanel.querySelector('#subtitle-file-input');
    await act(async () => {
      srtInput.files = [new File(['1\n00:00:00,100 --> 00:00:01,500\nSilent narration cue\n'], 'silent.srt', { type: 'application/x-subrip' })];
      srtInput.dispatchEvent({ type: 'change', bubbles: true });
      await new Promise(r => setTimeout(r, 20));
    });
    await act(async () => {
      reopenedPanel.querySelector('.subtitle-cue-voice-btn').click();
      await new Promise(r => setTimeout(r, 20));
    });
    await act(async () => { reopenedPanel.querySelector('#subtitle-voice-export-btn').click(); });
    const silentDialog = reopenedPanel.querySelector('#export-project-dialog');
    const silentAudioSelect = silentDialog.querySelector('#export-dub-audio-mode');
    await act(async () => {
      silentAudioSelect.value = 'duck';
      silentAudioSelect.dispatchEvent({ type: 'change', bubbles: true, target: silentAudioSelect });
    });
    const silentExportBtn = silentDialog.querySelector('#export-preset-btn-video_dubbed_mp4');
    assert.equal(silentExportBtn.disabled || silentExportBtn.hasAttribute('disabled'), true);
    assert.match(silentDialog.textContent, /no original audio track/i);

    await act(async () => {
      silentAudioSelect.value = 'mute';
      silentAudioSelect.dispatchEvent({ type: 'change', bubbles: true, target: silentAudioSelect });
    });
    assert.equal(silentExportBtn.disabled || silentExportBtn.hasAttribute('disabled'), false);
    await act(async () => {
      silentExportBtn.click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(dubCalls.length, 3);
    assert.equal(dubCalls[2].originalAudioMode, 'mute');
    await act(async () => { silentDialog.querySelector('#export-project-close-btn').click(); });

    // 4. Rejected file upload (.exe) preserves existing cues + voiceover clips; HTTP 404 session expiry clears stale jobId into non-destructive relink recovery
    await act(async () => {
      silentFileInput.files = [new File(['bad'], 'malware.exe', { type: 'application/octet-stream' })];
      silentFileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    assert.ok(reopenedPanel.querySelector('#subtitle-voice-output'), 'rejected upload must not wipe generated voiceover clips');

    await act(async () => { reopenedPanel.querySelector('#subtitle-voice-export-btn').click(); });
    const expiredDialog = reopenedPanel.querySelector('#export-project-dialog');
    expireNextDub = true;
    await act(async () => {
      expiredDialog.querySelector('#export-preset-btn-video_dubbed_mp4').click();
      await new Promise(r => setTimeout(r, 20));
    });
    assert.equal(
      expiredDialog.querySelector('#export-preset-btn-video_dubbed_mp4').disabled || expiredDialog.querySelector('#export-preset-btn-video_dubbed_mp4').hasAttribute('disabled'),
      true
    );
    await act(async () => { expiredDialog.querySelector('#export-project-close-btn').click(); });
    assert.match(reopenedPanel.querySelector('#subtitle-extract-btn').textContent, /Link video for burn-in/);
    hasAudioStreamResponse = true;
    await act(async () => { reopenedPanel.querySelector('#subtitle-extract-btn').click(); });
    assert.equal(reopenedPanel.querySelector('.subtitle-line-input').value, 'Silent narration cue');
    assert.ok(reopenedPanel.querySelector('#subtitle-voice-output'), 'relinking after 404 session expiry must preserve voiceover clips');
    await act(async () => { reopenedPanel.querySelector('#subtitle-voice-export-btn').click(); });
    const relinkedDialog = reopenedPanel.querySelector('#export-project-dialog');
    const relinkedExportBtn = relinkedDialog.querySelector('#export-preset-btn-video_dubbed_mp4');
    assert.equal(relinkedExportBtn.disabled || relinkedExportBtn.hasAttribute('disabled'), false);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});

test('R3-09 useProductionJobs video_dub executor supports original audio + soft subtitles + mix gains and rejects invalid modes', async () => {
  const dom = createDomShim();
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
    const { useProductionJobs } = await vite.ssrLoadModule('/src/presentation/hooks/useProductionJobs.js');

    const jobsMap = new Map();
    const savedProjects = new Map([
      ['99999999-9999-4999-8999-999999999991', { id: '99999999-9999-4999-8999-999999999991', revision: 1, exportHistory: [], payload: { exportHistory: [] } }],
    ]);
    const validOrigJob = createProductionJob({
      id: '88888888-8888-4888-8888-888888888881',
      projectId: '99999999-9999-4999-8999-999999999991',
      type: 'video_dub',
      title: 'Original Soft Captioned MP4',
      items: [{ itemId: 'dub-orig', label: 'Export MP4' }],
      metadata: {
        mediaJobId: 'live-job-id',
        originalAudioMode: 'original',
        subtitleMode: 'soft',
        audioLanguage: 'en',
        mixSettings: { originalVolume: 0.75, dubVolume: 1, duckVolume: 0.15 },
        subtitles: { segments: [{ id: 's1', start: 0, end: 1, text: 'Hello' }], subtitleLanguage: 'en' },
        outputFileName: 'talk-captioned.mp4',
      },
    });
    const audioModeAliasJob = createProductionJob({
      id: '88888888-8888-4888-8888-888888888883',
      type: 'video_dub',
      title: 'Replace Alias Job',
      items: [{ itemId: 'dub-rep', label: 'Replace Export' }],
      metadata: {
        mediaJobId: 'live-job-id',
        audioMode: 'replace',
        clips: [{ segmentId: 's1', start: 0.1, end: 0.9, assetId: '77777777-7777-4777-8777-777777777772' }],
        outputFileName: 'talk-replaced.mp4',
      },
    });
    const missingSubsJob = createProductionJob({
      id: '88888888-8888-4888-8888-888888888884',
      type: 'video_dub',
      title: 'Missing Subtitles Job',
      maxRetries: 0,
      items: [{ itemId: 'dub-nosubs', label: 'Bad Subs Export' }],
      metadata: {
        mediaJobId: 'live-job-id',
        originalAudioMode: 'original',
        subtitleMode: 'soft',
      },
    });
    const invalidModeJob = createProductionJob({
      id: '88888888-8888-4888-8888-888888888882',
      type: 'video_dub',
      title: 'Invalid Dub Mode',
      maxRetries: 0,
      items: [{ itemId: 'dub-bad', label: 'Bad Export' }],
      metadata: {
        mediaJobId: 'live-job-id',
        originalAudioMode: 'unsupported_mode',
      },
    });
    jobsMap.set(validOrigJob.id, validOrigJob);
    jobsMap.set(audioModeAliasJob.id, audioModeAliasJob);
    jobsMap.set(missingSubsJob.id, missingSubsJob);
    jobsMap.set(invalidModeJob.id, invalidModeJob);

    const dubCalls = [];
    const jobRepository = {
      async listJobs() { return { items: [...jobsMap.values()], total: jobsMap.size }; },
      async getJob(id) { return { job: jobsMap.get(id) || null }; },
      async updateJob(id, patch) {
        const cur = jobsMap.get(id);
        let status = cur.status;
        let error = cur.error;
        if (patch.action === 'prepare') status = JOB_STATUS.PREPARING;
        else if (patch.action === 'start') status = JOB_STATUS.RUNNING;
        else if (patch.action === 'complete') status = JOB_STATUS.COMPLETED;
        else if (patch.action === 'fail') {
          status = JOB_STATUS.FAILED;
          error = { code: patch.code, message: patch.message };
        }
        const items = cur.items.map(it => (
          it.itemId === patch.itemId && patch.action === 'item_complete'
            ? { ...it, status: 'completed', outputAssetId: patch.outputAssetId }
            : it
        ));
        const next = { ...cur, status, error, items, revision: cur.revision + 1 };
        jobsMap.set(id, next);
        return { job: next };
      },
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, {
        services: {
          jobRepository,
          projectRepository: {
            getProject: async id => savedProjects.get(id) || null,
            saveProject: async next => {
              const updated = { ...next, revision: (next.revision || 1) + 1 };
              savedProjects.set(next.id, updated);
              return { project: updated };
            },
          },
          assetRepository: {
            getAssetBinary: async () => ({ bytes: await createTestWavBlob(200).arrayBuffer(), mimeType: 'audio/wav' }),
            uploadAsset: async ({ fileName }) => ({ asset: { id: '77777777-7777-4777-8777-777777777771', fileName } }),
          },
          mediaSubtitleGateway: {
            exportDubbedVideo: async params => {
              dubCalls.push(params);
              return new Blob(['mp4'], { type: 'video/mp4' });
            },
          },
          logger: { debug() {}, warn() {}, error() {} },
        },
      }, React.createElement(function JobRunner() {
        useProductionJobs({ workerSessionId: 'r309-worker', autoRecover: false });
        return null;
      })));
    });

    for (let i = 0; i < 100; i += 1) {
      await act(async () => { await new Promise(r => setTimeout(r, 10)); });
      const settled = [...jobsMap.values()].every(j => j.status === JOB_STATUS.COMPLETED || j.status === JOB_STATUS.FAILED);
      if (settled) break;
    }

    assert.equal(jobsMap.get(validOrigJob.id).status, JOB_STATUS.COMPLETED);
    assert.equal(jobsMap.get(audioModeAliasJob.id).status, JOB_STATUS.COMPLETED);
    assert.equal(dubCalls.length, 2);
    assert.equal(dubCalls[0].originalAudioMode, 'original');
    assert.equal(dubCalls[0].subtitleMode, 'soft');
    assert.deepEqual(dubCalls[0].clips, []);
    assert.deepEqual(dubCalls[0].mixSettings, { originalVolume: 0.75, dubVolume: 1, duckVolume: 0.15 });
    assert.equal(dubCalls[1].originalAudioMode, 'mute');
    assert.equal(dubCalls[1].clips.length, 1);

    const updatedProj = savedProjects.get('99999999-9999-4999-8999-999999999991');
    assert.equal(updatedProj.exportHistory.length, 1);
    assert.equal(updatedProj.exportHistory[0].audioMode, 'original');
    assert.equal(updatedProj.exportHistory[0].subtitleMode, 'soft');
    assert.match(updatedProj.exportHistory[0].codec, /mov_text/);

    assert.equal(jobsMap.get(missingSubsJob.id).status, JOB_STATUS.FAILED);
    assert.match(jobsMap.get(missingSubsJob.id).error.message, /Non-empty subtitle segments/);
    assert.equal(jobsMap.get(invalidModeJob.id).status, JOB_STATUS.FAILED);
    assert.match(jobsMap.get(invalidModeJob.id).error.message, /Unsupported video audio mode/);
  } finally {
    await act(async () => { root?.unmount(); });
    await vite.close();
    dom.restore();
  }
});
