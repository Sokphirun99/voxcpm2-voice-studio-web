/**
 * @fileoverview Regression tests for R3-06 terminology modal diff/validation, subtitle translation concurrency/errors, and TTS spelling/staleness wiring.
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
    contains(other) {
      for (let cur = other; cur; cur = cur.parentNode) if (cur === this) return true;
      return false;
    }
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
      for (let i = pathNodes.length - 1; i >= 0; i--) {
        event.currentTarget = pathNodes[i];
        for (const fn of pathNodes[i].listeners.get(`cap:${event.type}`) || []) fn(event);
      }
      for (let i = 0; i < pathNodes.length; i++) {
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
    click() { this.dispatchEvent({ type: 'click', bubbles: true }); }
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
      this.files = [];
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

async function withMountedVite(run) {
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
    root = createRoot(dom.container);
    await run({ dom, React, act, root, vite });
  } finally {
    try {
      if (root) await act(async () => { root.unmount(); });
    } finally {
      await vite.close();
      dom.restore();
    }
  }
}

test('TerminologyManagerModal rejects invalid override inline without losing other project overrides and submits minimal diff', async () => {
  await withMountedVite(async ({ dom, React, act, root, vite }) => {
    const { useState } = await import('react');
    const { useGlobalTerminology, useTerminology } = await vite.ssrLoadModule('/src/presentation/hooks/useTerminology.js');
    const { TerminologyManagerModal } = await vite.ssrLoadModule('/src/presentation/components/TerminologyManagerModal.jsx');

    const initialGlobal = [
      { id: 'g-tr', category: 'translation', term: 'AI', translation: 'បញ្ញា', sourceLanguage: 'en', targetLanguage: 'km', status: 'approved' },
      { id: 'g-sp', category: 'spelling', term: 'VoxCPM2', variants: ['voxcpm'], status: 'approved' },
    ];
    let latestProject = {
      overrides: { 'g-sp': { variants: ['vox-custom'], notes: 'existing' } },
      disabledIds: [],
      terms: [],
    };
    const terminologyRepository = {
      loadTerms: async () => initialGlobal,
      saveTerms: async terms => terms,
    };

    function Harness() {
      const globalCtrl = useGlobalTerminology({ terminologyRepository });
      const [proj, setProj] = useState(latestProject);
      latestProject = proj;
      const termCtrl = useTerminology({
        globalController: globalCtrl,
        terminologyRepository,
        projectTerminology: proj,
        onChangeProjectTerminology: setProj,
      });
      return React.createElement(TerminologyManagerModal, {
        open: true,
        terminologyCtrl: termCtrl,
        canEditProject: true,
        projectTitle: 'Override Test',
        onClose() {},
      });
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 15)); });

    const rows = dom.container.querySelectorAll('.terminology-row');
    const trRow = rows.find(r => r.textContent.includes('AI'));
    assert.ok(trRow);
    const overrideBtn = trRow.querySelectorAll('button').find(b => b.textContent.includes('Override'));
    assert.ok(overrideBtn);
    await act(async () => { overrideBtn.click(); });

    const form = dom.container.querySelector('.terminology-form');
    assert.ok(form, 'Terminology edit/override form should open');
    const trInput = form.querySelector('#term-translation-input');
    assert.ok(trInput, 'Translation input should render for translation category');

    // Clear translation -> submit must reject inline while preserving g-sp override!
    await act(async () => {
      trInput._value = '';
      trInput.dispatchEvent({ type: 'input', bubbles: true, target: trInput });
    });
    await act(async () => {
      form.dispatchEvent({ type: 'submit', bubbles: true, target: form });
    });

    const errorBanner = form.querySelector('.terminology-error');
    assert.ok(errorBanner, 'Inline validation error should be visible');
    assert.deepEqual(latestProject.overrides['g-sp'], { variants: ['vox-custom'], notes: 'existing' });
    assert.equal(latestProject.overrides['g-tr'], undefined);

    // Supply valid override translation -> saves minimal diff only
    await act(async () => {
      trInput._value = 'បញ្ញាសិប្បនិម្មិត';
      trInput.dispatchEvent({ type: 'input', bubbles: true, target: trInput });
    });
    await act(async () => {
      form.dispatchEvent({ type: 'submit', bubbles: true, target: form });
    });

    assert.equal(dom.container.querySelector('.terminology-form'), null);
    assert.equal(dom.container.querySelector('.terminology-error'), null);
    const { updatedAt, ...gTrFields } = latestProject.overrides['g-tr'] || {};
    assert.ok(updatedAt);
    assert.deepEqual(gTrFields, { translation: 'បញ្ញាសិប្បនិម្មិត' });
    assert.deepEqual(latestProject.overrides['g-sp'], { variants: ['vox-custom'], notes: 'existing' });
  });
});

test('useVideoSubtitles.applyTranslationTerminology surfaces MT failures and preserves concurrent segment edits', async () => {
  await withMountedVite(async ({ React, act, root, vite }) => {
    const { useRef } = await import('react');
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { useVideoSubtitles } = await vite.ssrLoadModule('/src/presentation/hooks/useVideoSubtitles.js');

    let latestCtrl = null;
    const notifications = [];
    let translateHandler = async () => ({ segments: [] });

    const services = {
      logger: { debug() {}, warn() {}, error() {} },
      speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
      mediaSubtitleGateway: {
        checkHealth: async () => ({ online: true, burnInSupported: true, diarizationReady: true }),
        translateSegments: payload => translateHandler(payload),
      },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    const terms = [
      { id: 't-ai', category: 'translation', term: 'AI', translation: 'បញ្ញា', sourceLanguage: 'en', targetLanguage: 'km', status: 'approved' },
    ];

    function Harness() {
      const termsRef = useRef(terms);
      latestCtrl = useVideoSubtitles({
        onNotify: n => notifications.push(n),
        hidden: false,
        effectiveTermsRef: termsRef,
      });
      return null;
    }

    await act(async () => {
      root.render(React.createElement(StudioProvider, { services }, React.createElement(Harness)));
    });

    const seedSnapshot = {
      id: 'sub-reg-1',
      kind: 'subtitle',
      title: 'Subtitles Regression',
      payload: {
        detectedLanguage: 'en',
        translatedLanguage: 'km',
        hasTranslation: true,
        subtitleOptions: { sourceLanguage: 'en', targetLanguage: 'khm_Khmr', autoTranslate: true },
        segments: [
          { id: 's1', start: 0, end: 1.5, text: 'AI works', translatedText: 'មិនត្រឹមត្រូវ' },
          { id: 's2', start: 2.0, end: 3.5, text: 'Keep calm', translatedText: 'រក្សាទុក' },
        ],
      },
    };
    await act(async () => { latestCtrl.loadProjectFromSnapshot(seedSnapshot); });

    // Part A: MT failure must report error truthfully instead of lying "already follow approved terminology"
    translateHandler = async () => { throw new Error('NLLB translator offline'); };
    let count = -1;
    await act(async () => { count = await latestCtrl.applyTranslationTerminology(); });
    assert.equal(count, 0);
    assert.equal(latestCtrl.state.status.error, true);
    assert.match(latestCtrl.state.status.message, /NLLB translator offline/);
    assert.equal(notifications.at(-1)?.kind, 'error');

    // Part B: Concurrent edit while translateSegments is in flight must survive completion
    let resolveMt;
    translateHandler = () => new Promise(resolve => { resolveMt = resolve; });

    let pendingApply;
    await act(async () => {
      pendingApply = latestCtrl.applyTranslationTerminology();
    });
    // Edit unrelated segment while MT call is pending
    await act(async () => {
      latestCtrl.updateSegment('s2', { text: 'Edited during MT', translatedText: 'កែប្រែក្នុងពេលរង់ចាំ' });
    });
    await act(async () => {
      resolveMt({ segments: [{ id: 's1', translatedText: 'បញ្ញា ដំណើរការ' }] });
      count = await pendingApply;
    });

    assert.equal(count, 1);
    const s1 = latestCtrl.state.segments.find(s => s.id === 's1');
    const s2 = latestCtrl.state.segments.find(s => s.id === 's2');
    assert.equal(s1.translatedText, 'បញ្ញា ដំណើរការ');
    assert.equal(s2.text, 'Edited during MT');
    assert.equal(s2.translatedText, 'កែប្រែក្នុងពេលរង់ចាំ');
  });
});

test('TextToSpeechWorkspace preserves sourceLanguage, flags Stage 3 take staleness, and notifies spelling synchronously', async () => {
  await withMountedVite(async ({ dom, React, act, root, vite }) => {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { TextToSpeechWorkspace } = await vite.ssrLoadModule('/src/presentation/components/TextToSpeechWorkspace.jsx');

    const notifications = [];
    const savedSnapshots = [];
    const logErrors = [];
    const projectUuid = '11111111-1111-4111-8111-111111111111';
    const assetUuid = '22222222-2222-4222-8222-222222222222';
    const ttsProject = {
      id: projectUuid,
      kind: 'tts',
      type: 'tts',
      title: 'Khmer TTS Reg',
      revision: 2,
      sourceLanguage: 'km',
      terminology: { overrides: {}, disabledIds: [], terms: [] },
      payload: {
        script: 'voxcpm test',
        voiceId: 'char-nisa',
        detectedLanguage: 'km',
        segments: [
          {
            id: 'seg-1',
            text: 'voxcpm test',
            voiceId: 'char-nisa',
            takes: [
              {
                id: 'take-1',
                isSelected: true,
                audioAssetId: assetUuid,
                duration: 1.0,
                settings: { text: 'voxcpm test', voiceId: 'char-nisa', pronunciationSignature: 'stale-sig-0' },
              },
            ],
          },
        ],
      },
      segments: [
        {
          id: 'seg-1',
          text: 'voxcpm test',
          voiceId: 'char-nisa',
          takes: [
            {
              id: 'take-1',
              isSelected: true,
              audioAssetId: assetUuid,
              duration: 1.0,
              settings: { text: 'voxcpm test', voiceId: 'char-nisa', pronunciationSignature: 'stale-sig-0' },
            },
          ],
        },
      ],
    };

    const services = {
      logger: { debug() {}, warn() {}, error: (...args) => logErrors.push(args) },
      speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
      terminologyRepository: {
        loadTerms: async () => [
          { id: 'sp-1', category: 'spelling', term: 'VoxCPM2', variants: ['voxcpm'], sourceLanguage: 'km', status: 'approved' },
          { id: 'pr-1', category: 'pronunciation', term: 'VoxCPM2', pronunciation: 'Vox C P M two', sourceLanguage: 'km', status: 'approved' },
        ],
        saveTerms: async terms => terms,
      },
      projectRepository: {
        listProjects: async () => ({ items: [{ id: ttsProject.id, kind: 'tts', title: ttsProject.title }], total: 1 }),
        getProject: async () => ttsProject,
        saveProject: async snapshot => { savedSnapshots.push(snapshot); return { ...snapshot, revision: (snapshot.revision || 1) + 1 }; },
        updateProject: async (_id, patch) => { savedSnapshots.push(patch); return { ...ttsProject, ...patch }; },
      },
      voiceLibrary: createVoiceLibraryUseCases({
        voiceRepository: { loadSavedEntries: () => ({ entries: [], warning: null }), saveEntries() {} },
      }),
      voiceAnchors: createVoiceAnchorUseCases({
        anchorRepository: { loadAllAnchors: async () => ({}), saveAnchor: async () => {}, deleteAnchor: async () => {} },
      }),
    };

    const shared = {
      library: {
        allVoices: [{ id: 'char-nisa', name: 'Nisa' }],
        matches: [{ id: 'char-nisa', name: 'Nisa' }],
        filters: { search: '', source: '', category: '' },
        updateFilter() {},
        warning: null,
        builtInVoices: [{ id: 'char-nisa', name: 'Nisa' }],
        customVoices: [],
      },
      anchorApi: { anchors: {}, isLoaded: true, getRevision: () => 1, anchorWarning: null },
      activeCharacter: { id: 'char-nisa', name: 'Nisa' },
      activeAnchor: null,
      lockedSeeds: {},
      setLockedSeeds() {},
      characterActions: {
        uploadedRefsRef: { current: {} },
        rerolledIdsRef: { current: new Set() },
        handleSelectCharacter() {},
      },
      onNotify: n => notifications.push(n),
    };

    const actionsRef = { current: null };
    await act(async () => {
      root.render(
        React.createElement(
          StudioProvider,
          { services },
          React.createElement(TextToSpeechWorkspace, { shared, actionsRef, hidden: false })
        )
      );
    });
    // Allow microtasks from terminologyRepository + restoreLatestProject to flush
    await act(async () => { await new Promise(r => setTimeout(r, 40)); });
    assert.deepEqual(logErrors, [], 'restoreLatestProject must not hit validation errors');

    const applyBtn = dom.container.querySelector('#apply-tts-spelling');
    assert.ok(applyBtn && !applyBtn.disabled, 'Apply spelling button should be enabled for matching km spelling rule');
    await act(async () => { applyBtn.click(); });

    assert.equal(notifications.at(-1)?.kind, 'success');
    assert.equal(notifications.at(-1)?.title, 'Spelling terminology applied');
    assert.equal(dom.container.querySelector('#script').value, 'VoxCPM2 test');

    // Verify flushProjectSave preserves sourceLanguage ('km')
    await act(async () => { await actionsRef.current?.autosave?.saveNow?.(); });
    assert.ok(savedSnapshots.length >= 1);
    assert.equal(savedSnapshots.at(-1).sourceLanguage, 'km');

    // Switch to Segment view and confirm outdated badge triggered by pronunciationSignature mismatch
    const segmentsBtn = dom.container.querySelectorAll('button').find(b => b.textContent.includes('Segments'));
    assert.ok(segmentsBtn);
    await act(async () => { segmentsBtn.click(); });
    const hasOutdatedStatus = dom.container.querySelectorAll('span').some(
      el => String(el.className || '').includes('outdated') || /outdated/i.test(el.textContent || '')
    );
    assert.ok(hasOutdatedStatus, 'Take generated under older pronunciationSignature must render outdated status');
  });
});
