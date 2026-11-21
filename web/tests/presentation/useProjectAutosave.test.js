/**
 * @fileoverview Unit and integration tests for useProjectAutosave and ProjectAutosaveBadge (R1-05).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';
import { ConflictError } from '../../src/domain/errors.js';

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
      const name = String(k).toLowerCase();
      this.attributes.set(name, String(v));
      if (name === 'id') this.id = String(v);
      if (name === 'class') this.className = String(v);
      if (name === 'type') this.type = String(v);
      if (name === 'hidden') this.hidden = true;
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
      this.nodeName = tag.toUpperCase();
    }
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
    getElementById: id => docEl.querySelector(`#${id}`),
    querySelector: sel => docEl.querySelector(sel),
    querySelectorAll: sel => docEl.querySelectorAll(sel),
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('useProjectAutosave initial status is idle and does not call saveProject before edits', async () => {
  let root = null;
  let vite = null;
  let dom = null;
  try {
    dom = createDomShim();
    vite = await createServer({
      root: WEB_ROOT,
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: 'custom',
      optimizeDeps: { noDiscovery: true },
    });
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    const calls = [];
    const mockRepo = {
      saveProject: async (id, snapshot, options) => {
        calls.push({ id, snapshot, options });
        return { project: { id: id || 'proj-1', revision: 2 } };
      },
    };

    let hookResult = null;
    function TestHost() {
      hookResult = useProjectAutosave({
        projectId: 'proj-1',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'proj-1', title: 'Test Project', script: 'Hello' }),
        debounceMs: 50,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null, hookResult.status);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    assert.equal(hookResult.status, AUTOSAVE_STATUS.IDLE);
    assert.equal(hookResult.isIdle !== false, true);
    assert.equal(hookResult.isSaving, false);
    assert.equal(hookResult.isDirty, false);
    assert.equal(calls.length, 0, 'saveProject must not be called upon initial clean mount');
  } finally {
    await act(async () => root?.unmount());
    await vite?.close();
    dom?.restore();
  }
});

test('useProjectAutosave debounces save and transitions dirty -> saving -> saved', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    const calls = [];
    const mockRepo = {
      saveProject: async (id, snapshot, options) => {
        calls.push({ id, snapshot, options });
        return { project: { id: 'proj-1', revision: 2, title: snapshot.title } };
      },
    };

    let hookResult = null;
    let setContent = null;
    function TestHost() {
      const [text, updateText] = useState('First');
      setContent = updateText;
      hookResult = useProjectAutosave({
        projectId: 'proj-1',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'proj-1', title: 'Debounce Test', script: text }),
        deps: [text],
        debounceMs: 60,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null, hookResult.status);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    assert.equal(hookResult.status, AUTOSAVE_STATUS.IDLE);

    // Edit content to trigger dirty state
    await act(async () => {
      setContent('Second');
    });

    assert.equal(hookResult.status, AUTOSAVE_STATUS.DIRTY);
    assert.equal(hookResult.isDirty, true);
    assert.equal(calls.length, 0, 'Must not save before debounce duration expires');

    // Wait for debounce timer to fire
    await act(async () => {
      await wait(90);
    });

    assert.equal(calls.length, 1, 'Debounced save must be invoked exactly once');
    assert.equal(calls[0].id, 'proj-1');
    assert.equal(calls[0].snapshot.script, 'Second');
    assert.equal(calls[0].options.expectedRevision, 1);
    assert.equal(hookResult.status, AUTOSAVE_STATUS.SAVED);
    assert.equal(hookResult.revision, 2);
    assert.ok(hookResult.lastSavedAt);
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave never claims saved when persistence fails and retains edits for retry', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    let shouldFail = true;
    let attempts = 0;
    const mockRepo = {
      saveProject: async (id, snapshot) => {
        attempts += 1;
        if (shouldFail) throw new Error('Network connection offline');
        return { project: { id, revision: 2, title: snapshot.title } };
      },
    };

    let hookResult = null;
    let errorNotified = null;
    function TestHost() {
      hookResult = useProjectAutosave({
        projectId: 'fail-proj',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'fail-proj', title: 'Failing Project' }),
        debounceMs: 40,
        projectRepository: mockRepo,
        onSaveError: err => { errorNotified = err; },
      });
      return React.createElement('div', null, hookResult.status);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    // Mark dirty
    await act(async () => {
      hookResult.markDirty();
    });
    assert.equal(hookResult.status, AUTOSAVE_STATUS.DIRTY);

    // Wait for timer
    await act(async () => {
      await wait(60);
    });

    // CRITICAL: Must be ERROR, NEVER SAVED!
    assert.equal(attempts, 1);
    assert.equal(hookResult.status, AUTOSAVE_STATUS.ERROR);
    assert.equal(hookResult.isSaved, false, 'UI must NEVER claim Saved when persistence fails');
    assert.equal(hookResult.isError, true);
    assert.match(hookResult.error.message, /Network connection offline/);
    assert.equal(errorNotified?.message, 'Network connection offline');

    // Fix connection and retry
    shouldFail = false;
    await act(async () => {
      await hookResult.retry();
    });

    assert.equal(attempts, 2);
    assert.equal(hookResult.status, AUTOSAVE_STATUS.SAVED);
    assert.equal(hookResult.isError, false);
    assert.equal(hookResult.revision, 2);
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave retry and saveNow bypass debounce and execute immediately', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    let saveCount = 0;
    const mockRepo = {
      saveProject: async () => {
        saveCount += 1;
        return { project: { id: 'immediate-proj', revision: 2 } };
      },
    };

    let hookResult = null;
    function TestHost() {
      hookResult = useProjectAutosave({
        projectId: 'immediate-proj',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'immediate-proj', title: 'Immediate Test' }),
        debounceMs: 5000, // Very long debounce
        projectRepository: mockRepo,
      });
      return React.createElement('div', null, hookResult.status);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    // Save now bypasses 5000ms delay
    await act(async () => {
      await hookResult.saveNow();
    });

    assert.equal(saveCount, 1, 'saveNow must persist immediately without waiting for debounce');
    assert.equal(hookResult.status, AUTOSAVE_STATUS.SAVED);
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave passes expectedRevision and increments revision on success', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    const recordedExpectedRevisions = [];
    let currentServerRev = 3;
    const mockRepo = {
      saveProject: async (id, snapshot, options) => {
        recordedExpectedRevisions.push(options?.expectedRevision);
        currentServerRev += 1;
        return { project: { id, revision: currentServerRev } };
      },
    };

    let hookResult = null;
    function TestHost() {
      hookResult = useProjectAutosave({
        projectId: 'rev-aware-proj',
        initialRevision: 3,
        buildSnapshot: () => ({ id: 'rev-aware-proj', title: 'Rev Test' }),
        debounceMs: 40,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    // First save passes 3
    await act(async () => {
      await hookResult.saveNow();
    });
    assert.equal(recordedExpectedRevisions[0], 3);
    assert.equal(hookResult.revision, 4);

    // Second save passes updated revision 4
    await act(async () => {
      await hookResult.saveNow();
    });
    assert.equal(recordedExpectedRevisions[1], 4);
    assert.equal(hookResult.revision, 5);
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave handles 409 conflict and notifies user', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    let conflictNotified = false;
    const mockRepo = {
      saveProject: async () => {
        throw new ConflictError('Project revision mismatch. Expected 1 but found 2.', {
          code: 'REVISION_CONFLICT',
          expectedRevision: 1,
          currentRevision: 2,
        });
      },
    };

    let hookResult = null;
    function TestHost() {
      hookResult = useProjectAutosave({
        projectId: 'conflict-proj',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'conflict-proj', title: 'Conflict Project' }),
        debounceMs: 30,
        projectRepository: mockRepo,
        onConflict: () => { conflictNotified = true; },
      });
      return React.createElement('div', null);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    await act(async () => {
      await hookResult.saveNow();
    });

    assert.equal(hookResult.status, AUTOSAVE_STATUS.ERROR);
    assert.equal(hookResult.isConflict, true);
    assert.equal(conflictNotified, true, 'onConflict callback must be triggered on 409');
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave prevents race condition when edits occur during in-flight save', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    let resolveFirstSave;
    const firstSavePromise = new Promise(res => { resolveFirstSave = res; });
    let saveCount = 0;
    const snapshotsSaved = [];

    const mockRepo = {
      saveProject: async (id, snapshot) => {
        saveCount += 1;
        snapshotsSaved.push(snapshot.script);
        if (saveCount === 1) await firstSavePromise;
        return { project: { id, revision: saveCount + 1 } };
      },
    };

    let hookResult = null;
    let setScript = null;
    function TestHost() {
      const [script, updateScript] = useState('First edit');
      setScript = updateScript;
      hookResult = useProjectAutosave({
        projectId: 'race-proj',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'race-proj', title: 'Race Test', script }),
        deps: [script],
        debounceMs: 30,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    // Trigger save 1
    await act(async () => {
      setScript('Script version 1');
    });
    await act(async () => {
      await wait(40);
    });

    // Save 1 is now in flight
    assert.equal(hookResult.status, AUTOSAVE_STATUS.SAVING);
    assert.equal(saveCount, 1);

    // User types 'Script version 2' while save 1 is in-flight!
    await act(async () => {
      setScript('Script version 2');
    });

    // Finish save 1
    await act(async () => {
      resolveFirstSave();
      await wait(10);
    });

    // Must NOT claim saved, because version 2 was typed during saving!
    assert.equal(hookResult.status, AUTOSAVE_STATUS.DIRTY);
    assert.equal(hookResult.isDirty, true);

    // Wait for version 2 debounced save
    await act(async () => {
      await wait(50);
    });

    assert.equal(saveCount, 2);
    assert.equal(snapshotsSaved[1], 'Script version 2');
    assert.equal(hookResult.status, AUTOSAVE_STATUS.SAVED);
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave flushes pending edits on unmount without losing data', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    let flushedSnapshot = null;
    const mockRepo = {
      saveProject: async (id, snapshot) => {
        flushedSnapshot = snapshot;
        return { project: { id, revision: 2 } };
      },
    };

    let hookResult = null;
    function TestHost() {
      hookResult = useProjectAutosave({
        projectId: 'unmount-proj',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'unmount-proj', title: 'Unmount Flush', content: 'Vital unsaved changes' }),
        debounceMs: 5000,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    // Mark dirty with a pending 5000ms timer
    await act(async () => {
      hookResult.markDirty();
    });
    assert.equal(flushedSnapshot, null);

    // Unmount before timer finishes
    await act(async () => {
      root.unmount();
    });

    // Must flush on unmount!
    assert.ok(flushedSnapshot, 'Unmount must flush pending dirty edits');
    assert.equal(flushedSnapshot.content, 'Vital unsaved changes');
  } finally {
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave flushes pending edits on navigation when hidden becomes true', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    let navFlushed = null;
    const mockRepo = {
      saveProject: async (id, snapshot) => {
        navFlushed = snapshot;
        return { project: { id, revision: 2 } };
      },
    };

    let hookResult = null;
    let setHidden = null;
    function TestHost() {
      const [hidden, updateHidden] = useState(false);
      setHidden = updateHidden;
      hookResult = useProjectAutosave({
        projectId: 'nav-proj',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'nav-proj', title: 'Navigation Flush' }),
        debounceMs: 5000,
        hidden,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    await act(async () => {
      hookResult.markDirty();
    });
    assert.equal(navFlushed, null);

    // Switch tabs / navigate away
    await act(async () => {
      setHidden(true);
    });

    assert.ok(navFlushed, 'Switching workspace/navigating must flush pending edits');
    assert.equal(navFlushed.title, 'Navigation Flush');
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('ProjectAutosaveBadge renders accessible status and handles retry click', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { ProjectAutosaveBadge } = await vite.ssrLoadModule('/src/presentation/components/ProjectAutosaveBadge.jsx');
    const { AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');

    let retried = false;
    const fakeAutosave = {
      status: AUTOSAVE_STATUS.SAVING,
      retry: () => { retried = true; },
    };

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(ProjectAutosaveBadge, { autosave: fakeAutosave }));
    });

    let badge = dom.container.querySelector('#project-autosave-status');
    assert.ok(badge);
    assert.ok(badge.className.includes('status-saving'));
    assert.match(badge.textContent, /Saving…/);

    // Test Saved
    fakeAutosave.status = AUTOSAVE_STATUS.SAVED;
    await act(async () => {
      root.render(React.createElement(ProjectAutosaveBadge, { autosave: fakeAutosave }));
    });
    badge = dom.container.querySelector('#project-autosave-status');
    assert.ok(badge.className.includes('status-saved'));
    assert.match(badge.textContent, /Saved/);

    // Test Error with Retry
    fakeAutosave.status = AUTOSAVE_STATUS.ERROR;
    await act(async () => {
      root.render(React.createElement(ProjectAutosaveBadge, { autosave: fakeAutosave }));
    });
    badge = dom.container.querySelector('#project-autosave-status');
    assert.ok(badge.className.includes('status-error'));
    assert.equal(badge.getAttribute('role'), 'alert');
    assert.match(badge.textContent, /Save failed/);

    const retryBtn = dom.container.querySelector('#autosave-retry-button');
    assert.ok(retryBtn, 'Retry button must render in error state');
    await act(async () => {
      retryBtn.click();
    });
    assert.equal(retried, true, 'Clicking retry button must trigger retry callback');
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave saves brand new project without expectedRevision and adopts assigned id and revision', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    const saveCalls = [];
    const mockRepo = {
      saveProject: async (id, snapshot, options) => {
        saveCalls.push({ id, snapshot, options });
        return { project: { id: id || 'server-assigned-id', revision: 1, title: snapshot.title } };
      },
    };

    let hookResult = null;
    let setScript = null;
    function TestHost() {
      const [script, updateScript] = useState('New draft text');
      setScript = updateScript;
      hookResult = useProjectAutosave({
        projectId: null,
        initialRevision: null,
        buildSnapshot: () => ({ title: 'Brand New Project', script }),
        deps: [script],
        debounceMs: 40,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null, hookResult.status);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    assert.equal(hookResult.status, AUTOSAVE_STATUS.IDLE);
    assert.equal(saveCalls.length, 0);

    // First edit on brand new project
    await act(async () => {
      setScript('New draft text with edit');
    });
    assert.equal(hookResult.status, AUTOSAVE_STATUS.DIRTY);

    await act(async () => {
      await wait(60);
    });

    // Verify first save: MUST NOT pass expectedRevision (brand new project does not exist on server yet)
    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0].options?.expectedRevision, undefined, 'First save of brand new project must omit expectedRevision');
    assert.equal(hookResult.status, AUTOSAVE_STATUS.SAVED);
    assert.equal(hookResult.projectId, 'server-assigned-id');
    assert.equal(hookResult.revision, 1);

    // Second edit on now-persisted project: MUST pass expectedRevision: 1
    mockRepo.saveProject = async (id, snapshot, options) => {
      saveCalls.push({ id, snapshot, options });
      return { project: { id, revision: 2, title: snapshot.title } };
    };

    await act(async () => {
      setScript('Second edit on established project');
    });
    await act(async () => {
      await wait(60);
    });

    assert.equal(saveCalls.length, 2);
    assert.equal(saveCalls[1].options?.expectedRevision, 1, 'Subsequent save must pass expectedRevision: 1');
    assert.equal(hookResult.revision, 2);
    assert.equal(hookResult.status, AUTOSAVE_STATUS.SAVED);
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave resetProject cleanly loads project without triggering dirty state or autosave', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    let saveCount = 0;
    const mockRepo = {
      saveProject: async () => {
        saveCount += 1;
        return { project: { id: 'p1', revision: 2 } };
      },
    };

    let hookResult = null;
    let setContent = null;
    function TestHost() {
      const [content, updateContent] = useState('Existing loaded script');
      setContent = updateContent;
      hookResult = useProjectAutosave({
        projectId: 'p1',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'p1', script: content }),
        deps: [content],
        debounceMs: 50,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    assert.equal(hookResult.status, AUTOSAVE_STATUS.IDLE);
    assert.equal(saveCount, 0);

    // Simulate loading another project via resetProject
    await act(async () => {
      hookResult.resetProject('p2', 3);
      setContent('Switched project text');
    });

    // Must remain IDLE, NOT DIRTY!
    assert.equal(hookResult.status, AUTOSAVE_STATUS.IDLE);
    assert.equal(hookResult.projectId, 'p2');
    assert.equal(hookResult.revision, 3);

    // Wait for timer that shouldn't exist
    await act(async () => {
      await wait(80);
    });

    assert.equal(saveCount, 0, 'Loading a project via resetProject must not trigger autosave');
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave conflict retry recovers latest remote revision and persists uncommitted changes', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    let attempt = 0;
    let passedExpectedRev = null;
    const mockRepo = {
      getProject: async () => ({ id: 'conflict-proj', revision: 5, title: 'Server Project' }),
      saveProject: async (id, snapshot, options) => {
        attempt += 1;
        passedExpectedRev = options?.expectedRevision;
        if (attempt === 1) {
          throw new ConflictError('Revision mismatch', { code: 'REVISION_CONFLICT', status: 409 });
        }
        return { project: { id, revision: 6, title: snapshot.title } };
      },
    };

    let hookResult = null;
    function TestHost() {
      hookResult = useProjectAutosave({
        projectId: 'conflict-proj',
        initialRevision: 2,
        buildSnapshot: () => ({ id: 'conflict-proj', title: 'Local Edits Kept' }),
        debounceMs: 30,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    // Attempt 1 causes 409 conflict
    await act(async () => {
      await hookResult.saveNow();
    });
    assert.equal(hookResult.status, AUTOSAVE_STATUS.ERROR);
    assert.equal(hookResult.isConflict, true);

    // Attempt 2 via retry: recovers remote revision (5) and successfully saves
    await act(async () => {
      await hookResult.retry();
    });

    assert.equal(attempt, 2);
    assert.equal(passedExpectedRev, 5, 'Retry after conflict should query and use latest remote revision');
    assert.equal(hookResult.status, AUTOSAVE_STATUS.SAVED);
    assert.equal(hookResult.revision, 6);
    assert.equal(hookResult.isConflict, false);
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});

test('useProjectAutosave flushes on document visibilityState hidden', async () => {
  const dom = createDomShim();
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  let root = null;
  try {
    const { useProjectAutosave, AUTOSAVE_STATUS } = await vite.ssrLoadModule('/src/presentation/hooks/useProjectAutosave.js');
    let flushed = false;
    const mockRepo = {
      saveProject: async () => {
        flushed = true;
        return { project: { id: 'vis-proj', revision: 2 } };
      },
    };

    let hookResult = null;
    function TestHost() {
      hookResult = useProjectAutosave({
        projectId: 'vis-proj',
        initialRevision: 1,
        buildSnapshot: () => ({ id: 'vis-proj', title: 'Visibility Flush' }),
        debounceMs: 5000,
        projectRepository: mockRepo,
      });
      return React.createElement('div', null);
    }

    root = createRoot(dom.container);
    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    // Mark dirty with a 5000ms debounce
    await act(async () => {
      hookResult.markDirty();
    });
    assert.equal(flushed, false);

    // Simulate switching browser tab
    await act(async () => {
      dom.container.ownerDocument.visibilityState = 'hidden';
      dom.container.ownerDocument.dispatchEvent({ type: 'visibilitychange' });
    });

    assert.equal(flushed, true, 'Visibility change to hidden must immediately flush pending edits');
  } finally {
    await act(async () => root?.unmount());
    await vite.close();
    dom.restore();
  }
});
