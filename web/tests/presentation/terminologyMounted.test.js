/**
 * @fileoverview Mounted E2E UI verification for R3-06 Project Terminology Management:
 *   - Reusable global library creation, Draft -> Approved activation gating
 *   - Stage isolation across Subtitles (Spelling vs Translation), TTS Spelling fix button, and TTS Pronunciation synthesis
 *   - Per-project overrides, disabling a global term inside one project, and preserving global terms in other workspaces
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
  createSynthesizeSpeechUseCase,
  createVoiceAnchorUseCases,
  createVoiceLibraryUseCases,
} from '../../src/domain/useCases.js';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function makeSilentWavBlob() {
  const bytes = new Uint8Array(44 + 4800 * 2);
  const view = new DataView(bytes.buffer);
  const write = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
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
      if (name === 'open') this.open = true;
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
      if (name === 'open') this.open = false;
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
    blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
    showModal() { this.open = true; this.setAttribute('open', ''); }
    close() { this.open = false; this.removeAttribute('open'); this.dispatchEvent({ type: 'close' }); }
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
      this.open = false;
    }
    get options() { return this.querySelectorAll('option'); }
    get form() {
      let cur = this.parentNode;
      while (cur && cur.tagName !== 'FORM') cur = cur.parentNode;
      return cur || null;
    }
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
        if (p) p._value = this._value;
      }
    }
    get value() { return this._value; }
    set value(v) {
      this._value = v == null ? '' : String(v);
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
      URL.createObjectURL = prev.createObjectURL;
      URL.revokeObjectURL = prev.revokeObjectURL;
    },
  };
}

function setFieldValue(el, value) {
  el._value = value;
  if (el.tagName === 'SELECT') el.value = value;
  el.dispatchEvent({ type: 'input', bubbles: true, target: el });
  el.dispatchEvent({ type: 'change', bubbles: true, target: el });
}

test('mounted Studio manages draft/approved reusable terminology, enforces stage isolation, and isolates per-project overrides', async () => {
  const dom = createMountedDomShim();
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

    let persistedGlobalTerms = [
      {
        id: 'name-pp',
        category: 'name',
        status: 'approved',
        enabled: true,
        term: 'Phnom Penh',
        variants: ['Pnom Penh'],
        translation: 'ភ្នំពេញ',
        preserveInTranslation: false,
        pronunciation: 'ភ្នំពេញ-global',
        sourceLanguage: '',
        targetLanguage: 'khm_Khmr',
      },
      {
        id: 'spell-draft',
        category: 'spelling',
        status: 'draft',
        enabled: true,
        term: 'VoxCPM',
        variants: ['vox cpm'],
      },
    ];
    let savedSubtitleProject = null;
    const spokenTtsPayloads = [];
    const transcribeTerminologyPayloads = [];

    const terminologyRepository = {
      async loadTerms() { return persistedGlobalTerms; },
      async saveTerms(next) {
        persistedGlobalTerms = next;
        return { terms: persistedGlobalTerms, localOnly: false };
      },
    };
    const glossaryRepository = {
      async loadRules() { return []; },
      async saveRules(rules) { return { rules, localOnly: false }; },
    };
    const speechGateway = {
      checkAvailability: async () => true,
      checkHealth: async () => ({ online: true, detail: null }),
      uploadReferenceAudio: async () => ({ path: '/tmp/ref.wav', meta: { _type: 'gradio.FileData' } }),
      synthesize: async params => {
        spokenTtsPayloads.push(params.text);
        return { blob: makeSilentWavBlob(), seed: 42 };
      },
    };
    const projectRepository = {
      async listProjects() { return { items: savedSubtitleProject ? [savedSubtitleProject] : [], total: savedSubtitleProject ? 1 : 0 }; },
      async getProject(id) { return savedSubtitleProject?.id === id ? savedSubtitleProject : null; },
      async createProject(proj) {
        savedSubtitleProject = { ...proj, id: proj.id || 'sub-1', revision: 1 };
        return { project: savedSubtitleProject, isCreated: true };
      },
      async saveProject(id, proj) {
        savedSubtitleProject = { ...proj, id, revision: (savedSubtitleProject?.revision || 1) + 1 };
        return { project: savedSubtitleProject, isCreated: false };
      },
    };
    const mediaSubtitleGateway = {
      checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: false }),
      transcribeVideo: async params => {
        transcribeTerminologyPayloads.push(params.terminology || null);
        return {
          jobId: 'job-term-1',
          language: 'en',
          speakers: ['speaker-1'],
          videoSize: { width: 1280, height: 720 },
          segments: [
            { id: 'seg-1', start: 0.0, end: 2.5, speakerId: 'speaker-1', text: 'Visit Pnom Penh with vox cpm.', translatedText: 'ទៅទស្សនាទីក្រុង' },
          ],
        };
      },
      translateSegments: async ({ segments }) => ({ segments }),
      burnSubtitles: async () => new Blob(['mp4'], { type: 'video/mp4' }),
    };

    const services = {
      speechGateway,
      mediaSubtitleGateway,
      terminologyRepository,
      glossaryRepository,
      projectRepository,
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: createSynthesizeSpeechUseCase({ speechGateway, glossaryRepository, terminologyRepository, seedGenerator: () => 42 }),
      lockReferenceAudio: { execute: async file => ({ blob: file }) },
      voiceLibrary: createVoiceLibraryUseCases({ voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} } }),
      voiceAnchors: createVoiceAnchorUseCases({ anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} } }),
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(Studio)));
    });

    // 1. In Projects workspace, Draft spelling term is NOT active until approved
    const projectsPanel = dom.container.querySelector('.projects-workspace');
    await act(async () => { projectsPanel.querySelector('#open-global-terminology').click(); });
    const dialog = projectsPanel.querySelector('#terminology-manager-dialog');
    assert.equal(Boolean(dialog.open || dialog.hasAttribute('open')), true);
    const draftRow = dialog.querySelectorAll('.terminology-row').find(r => r.getAttribute('data-term-id') === 'spell-draft');
    assert.ok(draftRow);
    const approveBtn = draftRow.querySelectorAll('button').find(b => b.textContent === 'Approve');
    await act(async () => { approveBtn.click(); });
    await act(async () => { dialog.querySelector('#terminology-close-btn').click(); });

    // 2. Switch to TTS: Stage 1 spelling fixes script without injecting translation/pronunciation; Stage 3 speaks pronunciation cleanly
    await act(async () => { dom.container.querySelector('#nav-tts').click(); });
    const ttsPanel = dom.container.querySelectorAll('.workspace-panel').find(el => !el.hasAttribute('hidden'));
    const scriptInput = ttsPanel.querySelector('#script');
    await act(async () => { setFieldValue(scriptInput, 'Visit Pnom Penh using vox cpm.'); });

    const applySpellingBtn = ttsPanel.querySelector('#apply-tts-spelling');
    assert.ok(applySpellingBtn);
    await act(async () => { applySpellingBtn.click(); });
    assert.equal(scriptInput.value, 'Visit Phnom Penh using VoxCPM.');
    assert.equal(scriptInput.value.includes('global'), false);

    // Override Phnom Penh TTS pronunciation inside TTS project ONLY
    await act(async () => { ttsPanel.querySelector('#open-tts-terminology').click(); });
    const ttsDialog = ttsPanel.querySelector('#terminology-manager-dialog');
    const ppRow = ttsDialog.querySelectorAll('.terminology-row').find(r => r.getAttribute('data-term-id') === 'name-pp');
    const overrideBtn = ppRow.querySelectorAll('button').find(b => b.textContent === 'Override');
    await act(async () => { overrideBtn.click(); });
    await act(async () => { setFieldValue(ttsDialog.querySelector('#term-pronunciation-input'), 'ភ្នំពេញ-tts-override'); });
    await act(async () => { ttsDialog.querySelector('#terminology-editor-form').dispatchEvent({ type: 'submit', bubbles: true }); });
    await act(async () => { ttsDialog.querySelector('#terminology-close-btn').click(); });

    // Synthesize in TTS: spoken engine receives TTS project override; #script stays readable canonical text
    await act(async () => {
      ttsPanel.querySelector('#speech-form').dispatchEvent({ type: 'submit', bubbles: true });
    });
    assert.equal(spokenTtsPayloads[0], 'Visit ភ្នំពេញ-tts-override using VoxCPM.');
    assert.equal(ttsPanel.querySelector('#script').value, 'Visit Phnom Penh using VoxCPM.');

    // 3. Switch to Video to subtitle: TTS override stays isolated from subtitle workspace; Subtitles uses global library + project overrides
    await act(async () => { dom.container.querySelector('#nav-subtitles').click(); });
    const subPanel = dom.container.querySelector('.subtitle-workspace');
    const langSelect = subPanel.querySelector('#subtitle-source-lang');
    await act(async () => {
      langSelect.value = 'en';
      langSelect.dispatchEvent({ type: 'change', bubbles: true, target: langSelect });
    });

    const fileInput = subPanel.querySelector('#subtitle-video-input');
    await act(async () => {
      fileInput.files = [new File(['mp4'], 'clip.mp4', { type: 'video/mp4' })];
      fileInput.dispatchEvent({ type: 'change', bubbles: true });
    });
    await act(async () => { subPanel.querySelector('#subtitle-extract-btn').click(); });

    // Verified media gateway received approved spelling & translation terms WITHOUT any TTS pronunciation fields
    assert.ok(transcribeTerminologyPayloads[0].some(item => item.term === 'VoxCPM' && !('pronunciation' in item)));

    // Validation flags Stage 1 spelling (`Pnom Penh` -> `Phnom Penh`) first
    const initialPills = subPanel.querySelectorAll('.subtitle-validation-pill');
    assert.ok(initialPills.some(p => p.textContent.includes('Phnom Penh')));

    // 1-click "Apply spelling" fixes source cue `text` cleanly, revealing Stage 2 translation gap (`ភ្នំពេញ` for `Phnom Penh`)
    await act(async () => { subPanel.querySelector('#subtitle-fix-spelling-all').click(); });
    const cueTextArea = subPanel.querySelector('.subtitle-line-input');
    assert.ok(cueTextArea);
    const postSpellingPills = subPanel.querySelectorAll('.subtitle-validation-pill');
    assert.equal(postSpellingPills.some(p => p.textContent.includes('Use approved spelling')), false);
    assert.ok(postSpellingPills.some(p => p.textContent.includes('ភ្នំពេញ')));

    // Disable `name-pp` inside this subtitle project ONLY via Terminology modal -> warnings clear for this project while global remains intact
    await act(async () => { subPanel.querySelector('#subtitle-terminology-btn').click(); });
    const subDialog = subPanel.querySelector('#terminology-manager-dialog');
    const subPpRow = subDialog.querySelectorAll('.terminology-row').find(r => r.getAttribute('data-term-id') === 'name-pp');
    const disableHereBtn = subPpRow.querySelectorAll('button').find(b => b.textContent === 'Disable here');
    await act(async () => { disableHereBtn.click(); });
    await act(async () => { subDialog.querySelector('#terminology-close-btn').click(); });

    assert.equal(subPanel.querySelectorAll('.subtitle-validation-pill').some(p => p.textContent.includes('ភ្នំពេញ')), false);
    assert.equal(persistedGlobalTerms.find(t => t.id === 'name-pp').pronunciation, 'ភ្នំពេញ-global');
  } finally {
    if (root) await act(async () => { root.unmount(); });
    await vite.close();
    dom.restore();
  }
});
