/**
 * @fileoverview Integration and presentation tests for Project Recovery (R1-06).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import {
  saveLastActiveProject,
  getLastActiveProject,
  saveProjectDraft,
  clearLastActiveProject,
} from '../../src/data/projectRecoveryStorage.js';
import {
  collectReferencedAssets,
  assessAssetIntegrity,
  relinkProjectAsset,
  MISSING_ASSET_WARNING_TEXT,
} from '../../src/domain/projectRecovery.js';

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
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.childNodes = v ? [new MiniText(String(v))] : []; }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    }
    removeChild(c) {
      const idx = this.childNodes.indexOf(c);
      if (idx !== -1) { this.childNodes.splice(idx, 1); c.parentNode = null; }
      return c;
    }
    setAttribute(k, v) {
      this.attributes.set(String(k).toLowerCase(), String(v));
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
    }
    getAttribute(k) { return this.attributes.get(String(k).toLowerCase()) || null; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (list) this.listeners.set(type, list.filter(i => i !== fn));
    }
    dispatchEvent(event) {
      event.target = this;
      for (const fn of this.listeners.get(event.type) || []) fn(event);
      return true;
    }
    click() { this.dispatchEvent({ type: 'click' }); }
  }

  class MiniText extends MiniNode {
    constructor(text) { super(3, '#text'); this.data = text; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
  }

  class MiniElement extends MiniNode {
    constructor(tag) { super(1, tag.toUpperCase()); this.tagName = tag.toUpperCase(); }
  }

  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  class HTMLIFrameElement {}
  globalThis.HTMLIFrameElement = HTMLIFrameElement;
  const winListeners = new Map();
  const docListeners = new Map();
  function addListener(map, type, fn) {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  }
  function removeListener(map, type, fn) {
    const list = map.get(type);
    if (list) map.set(type, list.filter(i => i !== fn));
  }
  function dispatchToMap(map, event) {
    for (const fn of map.get(event.type) || []) fn(event);
    return true;
  }
  const body = new MiniElement('body');
  const head = new MiniElement('head');
  const docEl = new MiniElement('html');
  docEl.appendChild(head);
  docEl.appendChild(body);
  const win = {
    HTMLIFrameElement,
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: { userAgent: 'Node' },
    addEventListener(type, fn) { addListener(winListeners, type, fn); },
    removeEventListener(type, fn) { removeListener(winListeners, type, fn); },
    dispatchEvent(event) { return dispatchToMap(winListeners, event); },
  };
  const doc = {
    nodeType: 9,
    nodeName: '#document',
    defaultView: win,
    visibilityState: 'visible',
    activeElement: null,
    head,
    body,
    documentElement: docEl,
    createElement: t => new MiniElement(t),
    createElementNS: (_ns, t) => new MiniElement(t),
    createTextNode: t => new MiniText(t),
    createDocumentFragment: () => new MiniNode(11, '#df'),
    createComment: t => new MiniNode(8, '#c'),
    getElementById: id => docEl.querySelector?.(`#${id}`),
    querySelector: sel => docEl.querySelector?.(sel),
    querySelectorAll: sel => docEl.querySelectorAll?.(sel) || [],
    addEventListener(type, fn) { addListener(docListeners, type, fn); },
    removeEventListener(type, fn) { removeListener(docListeners, type, fn); },
    dispatchEvent(event) { return dispatchToMap(docListeners, event); },
  };
  win.document = doc;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  return {
    container: body.appendChild(new MiniElement('div')),
    restore() {
      globalThis.window = prev.window;
      globalThis.document = prev.document;
      globalThis.HTMLIFrameElement = prev.HTMLIFrameElement;
      globalThis.IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

async function createViteInstance() {
  return createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
}

test('DraftRecoveryBanner renders accessible role="alert" with recovery prompt and actions', async () => {
  const vite = await createViteInstance();
  try {
    const { DraftRecoveryBanner } = await vite.ssrLoadModule('/src/presentation/components/DraftRecoveryBanner.jsx');
    const ts = '2026-11-21T15:30:00.000Z';
    const html = renderToStaticMarkup(
      React.createElement(DraftRecoveryBanner, {
        visible: true,
        timestamp: ts,
        onRestore: () => {},
        onDiscard: () => {},
      })
    );

    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes('id="draft-recovery-banner"'));
    assert.ok(html.includes('Unsaved draft recovered from'));
    assert.ok(html.includes('Restore'));
    assert.ok(html.includes('Discard'));

    // When visible is false, renders nothing
    const hiddenHtml = renderToStaticMarkup(
      React.createElement(DraftRecoveryBanner, { visible: false, timestamp: ts })
    );
    assert.equal(hiddenHtml, '');
  } finally {
    await vite.close();
  }
});

test('MissingAssetBanner renders accessible alert when referenced assets are missing', async () => {
  const vite = await createViteInstance();
  try {
    const { MissingAssetBanner } = await vite.ssrLoadModule('/src/presentation/components/MissingAssetBanner.jsx');
    const missing = [{ assetId: '44444444-4444-4444-4444-444444444444', kind: 'video' }];
    const html = renderToStaticMarkup(
      React.createElement(MissingAssetBanner, {
        visible: true,
        missingAssets: missing,
        onRelinkFile: () => {},
        onDismiss: () => {},
      })
    );

    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes('id="missing-asset-banner"'));
    assert.ok(html.includes(MISSING_ASSET_WARNING_TEXT));
    assert.ok(html.includes('Re-link'));
    assert.ok(html.includes('Dismiss'));

    // When missingAssets is empty, renders nothing
    const emptyHtml = renderToStaticMarkup(
      React.createElement(MissingAssetBanner, { visible: true, missingAssets: [] })
    );
    assert.equal(emptyHtml, '');
  } finally {
    await vite.close();
  }
});

test('Restoring last active project on reload preserves active workspace and project pointer', () => {
  const mockStorage = new Map();
  const storage = {
    getItem: k => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: k => mockStorage.delete(k),
  };

  const projectId = '11111111-1111-1111-1111-111111111111';
  saveLastActiveProject({ projectId, workspace: 'subtitles', storage });

  const restored = getLastActiveProject({ storage });
  assert.equal(restored.projectId, projectId);
  assert.equal(restored.workspace, 'subtitles');

  clearLastActiveProject({ storage });
  assert.equal(getLastActiveProject({ storage }), null);
});

test('useProjectRecovery detects uncommitted draft and handles restore and discard flows', async () => {
  const dom = createDomShim();
  const vite = await createViteInstance();

  let root = null;
  try {
    const { useProjectRecovery } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectRecovery.js');
    const mockStorage = new Map();
    const storage = {
      getItem: k => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: k => mockStorage.delete(k),
    };

    const projectId = '11111111-1111-1111-1111-111111111111';
    // Simulate abrupt crash by storing uncommitted draft newer than confirmed project
    saveProjectDraft({
      draft: {
        projectId,
        workspace: 'tts',
        snapshot: { payload: { script: 'Uncommitted recovered text' } },
        revision: 2,
        timestamp: '2026-11-21T18:00:00.000Z',
      },
      storage,
    });

    const confirmedProject = {
      id: projectId,
      revision: 1,
      updatedAt: '2026-11-21T17:00:00.000Z',
      payload: { script: 'Old saved text' },
    };

    let hookResult = null;
    let restoredSnapshot = null;
    function TestHost() {
      hookResult = useProjectRecovery({
        projectId,
        workspace: 'tts',
        currentProject: confirmedProject,
        storage,
        onRestoreDraft: snap => { restoredSnapshot = snap; },
      });
      return React.createElement('div', null, hookResult.showDraftBanner ? 'banner-visible' : 'no-banner');
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    assert.equal(hookResult.showDraftBanner, true, 'Draft banner must be visible when uncommitted draft is found');
    assert.equal(hookResult.recoveredDraft?.revision, 2);

    // Click restore
    await act(async () => {
      hookResult.restoreDraft();
    });

    assert.ok(restoredSnapshot);
    assert.equal(restoredSnapshot.payload.script, 'Uncommitted recovered text');
    assert.equal(hookResult.showDraftBanner, false, 'Draft banner must hide after restoration');
  } finally {
    await act(async () => root?.unmount());
    await vite?.close();
    dom?.restore();
  }
});

test('useProjectRecovery detects and surfaces missing assets without data corruption', async () => {
  const sourceAssetId = '22222222-2222-2222-2222-222222222222';
  const newAssetId = '33333333-3333-3333-3333-333333333333';
  const initialProject = {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Dubbing project',
    sourceAssetId,
    sourceAsset: { id: sourceAssetId, fileName: 'missing.mp4', kind: 'video' },
    segments: [
      { id: 'seg-1', text: 'Segment 1', takes: [] },
    ],
  };

  // 1. Assets query: asset is missing (returns null)
  const mockAssetRepo = {
    getAssetMeta: async id => {
      if (id === sourceAssetId) return null; // Missing on disk/server!
      return { id, fileName: 'relinked.mp4' };
    },
    uploadAsset: async () => ({
      asset: { id: newAssetId, fileName: 'relinked.mp4', kind: 'video', sizeBytes: 500 },
    }),
  };

  const refs = collectReferencedAssets(initialProject);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].assetId, sourceAssetId);

  // Assess integrity: asset is missing
  const integrity = assessAssetIntegrity(initialProject, { [sourceAssetId]: { exists: false } });
  assert.equal(integrity.isIntact, false);
  assert.equal(integrity.missingAssets.length, 1);
  assert.equal(integrity.missingAssets[0].assetId, sourceAssetId);
  assert.equal(integrity.warningMessage, MISSING_ASSET_WARNING_TEXT);

  // Crucial check: Project was NOT corrupted or wiped out!
  assert.equal(initialProject.sourceAssetId, sourceAssetId);
  assert.equal(initialProject.segments.length, 1);

  // Relink asset
  const updatedProject = relinkProjectAsset(initialProject, sourceAssetId, {
    id: newAssetId,
    fileName: 'relinked.mp4',
    kind: 'video',
    sizeBytes: 500,
  });

  assert.equal(updatedProject.sourceAssetId, newAssetId);
  assert.equal(updatedProject.sourceAsset.id, newAssetId);
  assert.equal(updatedProject.sourceAsset.fileName, 'relinked.mp4');
  assert.equal(updatedProject.segments[0].text, 'Segment 1');

  // Verify new integrity: now intact
  const newIntegrity = assessAssetIntegrity(updatedProject, { [newAssetId]: { exists: true } });
  assert.equal(newIntegrity.isIntact, true);
  assert.equal(newIntegrity.missingAssets.length, 0);
});

test('active typing in project session does not trigger draft recovery banner', async () => {
  const dom = createDomShim();
  const vite = await createViteInstance();

  let root = null;
  try {
    const { useProjectRecovery } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectRecovery.js');
    const mockStorage = new Map();
    const storage = {
      getItem: k => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: k => mockStorage.delete(k),
    };

    let hookResult = null;
    let currentScript = 'A';
    let rerender = null;

    function TestHost() {
      const [, setTick] = React.useState(0);
      rerender = () => setTick(t => t + 1);
      hookResult = useProjectRecovery({
        projectId: 'test-project-123',
        workspace: 'tts',
        currentProject: { id: 'test-project-123', payload: { script: currentScript } },
        storage,
      });
      return React.createElement('div', null, hookResult.showDraftBanner ? 'banner-visible' : 'no-banner');
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    assert.equal(hookResult.showDraftBanner, false, 'Initial fresh project must not show draft banner');

    // User types 'B' -> 'AB'
    await act(async () => {
      currentScript = 'AB';
      rerender();
    });

    assert.equal(hookResult.showDraftBanner, false, 'Typing must not trigger draft recovery banner');
  } finally {
    await act(async () => root?.unmount());
    await vite?.close();
    dom?.restore();
  }
});

test('restoring last active project clears storage when project returns 404', async () => {
  const mockStorage = new Map();
  const storage = {
    getItem: k => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: k => mockStorage.delete(k),
  };

  const missingId = '99999999-9999-9999-9999-999999999999';
  saveLastActiveProject({ projectId: missingId, workspace: 'tts', storage });
  assert.equal(getLastActiveProject({ storage })?.projectId, missingId);

  // If getProject throws 404
  const mockRepo = {
    getProject: async () => {
      const err = new Error('Project not found');
      err.status = 404;
      throw err;
    },
  };

  try {
    await mockRepo.getProject(missingId);
  } catch {
    clearLastActiveProject({ storage });
  }

  assert.equal(getLastActiveProject({ storage }), null, 'Failed restore must clear stale active project');
});
