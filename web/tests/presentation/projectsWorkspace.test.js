/**
 * @fileoverview Unit and component SSR tests for Projects Workspace (R1-04).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function createMockProjectRepository(initialProjects = []) {
  const projects = [...initialProjects];
  return {
    projects,
    listProjects: async (query = {}) => {
      let filtered = [...projects].filter(p => !p.deletedAt);
      if (query.type && query.type !== 'all') {
        filtered = filtered.filter(p => {
          const resolved = p.type || (p.kind === 'subtitle' ? 'subtitles' : 'tts');
          return resolved === query.type;
        });
      }
      if (query.search) {
        const term = query.search.toLowerCase();
        filtered = filtered.filter(p => (p.title || p.name || '').toLowerCase().includes(term));
      }
      return {
        items: filtered,
        total: filtered.length,
        limit: query.limit || 50,
        offset: query.offset || 0,
        hasMore: false,
      };
    },
    getProject: async id => projects.find(p => p.id === id) || null,
    saveProject: async project => {
      const idx = projects.findIndex(p => p.id === project.id);
      if (idx !== -1) {
        projects[idx] = { ...project, revision: (projects[idx].revision || 1) + 1, updatedAt: new Date().toISOString() };
        return { project: projects[idx], isCreated: false };
      }
      const created = {
        ...project,
        id: project.id || 'f1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c',
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      projects.unshift(created);
      return { project: created, isCreated: true };
    },
    duplicateProject: async (id, options = {}) => {
      const existing = projects.find(p => p.id === id);
      if (!existing) throw new Error('Not found');
      const copy = {
        ...existing,
        id: `c1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5d`,
        title: options.title || `${existing.title} (Copy)`,
        name: options.title || `${existing.title} (Copy)`,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      projects.unshift(copy);
      return { project: copy };
    },
    deleteProject: async id => {
      const idx = projects.findIndex(p => p.id === id);
      if (idx !== -1) {
        projects.splice(idx, 1);
        return { deleted: true, id };
      }
      return { deleted: false, id };
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

test('resolveProjectType, resolveProjectStatus, and resolveProjectTitle handle edge cases correctly', async () => {
  await withViteSsr(async vite => {
    const {
      resolveProjectId,
      resolveProjectType,
      resolveProjectStatus,
      resolveProjectTitle,
      formatProjectTimestamp,
    } = await vite.ssrLoadModule('/src/presentation/hooks/useProjects.js');

    assert.equal(resolveProjectId('11111111-1111-4111-8111-111111111111'), '11111111-1111-4111-8111-111111111111');
    assert.equal(resolveProjectId({ id: ' 22222222-2222-4222-8222-222222222222 ' }), '22222222-2222-4222-8222-222222222222');
    assert.equal(resolveProjectId(null), '');
    assert.equal(resolveProjectId({ type: 'click', preventDefault() {}, currentTarget: {} }), '');
    assert.equal(resolveProjectId({ id: 'event-element-id', nativeEvent: {} }), '');

    assert.equal(resolveProjectType(null), 'tts');
    assert.equal(resolveProjectType({}), 'tts');
    assert.equal(resolveProjectType({ kind: 'subtitle' }), 'subtitles');
    assert.equal(resolveProjectType({ type: 'subtitles' }), 'subtitles');
    assert.equal(resolveProjectType({ type: 'dubbing' }), 'dubbing');
    assert.equal(resolveProjectType({ kind: 'dub' }), 'dubbing');
    assert.equal(resolveProjectType({ kind: 'tts' }), 'tts');

    assert.equal(resolveProjectStatus(null), 'draft');
    assert.equal(resolveProjectStatus({}), 'draft');
    assert.equal(resolveProjectStatus({ status: 'READY' }), 'ready');
    assert.equal(resolveProjectStatus({ status: 'archived' }), 'archived');
    assert.equal(resolveProjectStatus({ status: 'unknown-status' }), 'draft');

    assert.equal(resolveProjectTitle(null), 'Untitled project');
    assert.equal(resolveProjectTitle({}), 'Untitled project');
    assert.equal(resolveProjectTitle({ title: '   ' }), 'Untitled project');
    assert.equal(resolveProjectTitle({ title: 'My Khmer Voice' }), 'My Khmer Voice');
    assert.equal(resolveProjectTitle({ name: 'Fallback Name' }), 'Fallback Name');

    assert.equal(formatProjectTimestamp(null), '—');
    assert.equal(formatProjectTimestamp('invalid-date'), '—');
    assert.match(formatProjectTimestamp('2026-11-21T12:00:00.000Z'), /\w+/);
  });
});

test('buildProjectFilterParams normalizes type chips and trims search queries', async () => {
  await withViteSsr(async vite => {
    const { buildProjectFilterParams } = await vite.ssrLoadModule('/src/presentation/hooks/useProjects.js');

    assert.deepEqual(buildProjectFilterParams('all', ''), { type: undefined, search: undefined, limit: 50, offset: 0 });
    assert.deepEqual(buildProjectFilterParams('all', '   '), { type: undefined, search: undefined, limit: 50, offset: 0 });
    assert.deepEqual(buildProjectFilterParams('tts', 'Khmer Lesson'), { type: 'tts', search: 'Khmer Lesson', limit: 50, offset: 0 });
    assert.deepEqual(buildProjectFilterParams('subtitles', '  trimmed query  '), { type: 'subtitles', search: 'trimmed query', limit: 50, offset: 0 });
    assert.deepEqual(buildProjectFilterParams('dubbing', ''), { type: 'dubbing', search: undefined, limit: 50, offset: 0 });
  });
});

test('useProjects hook executes CRUD and modal flows with repository', async () => {
  await withViteSsr(async vite => {
    const { useProjects } = await vite.ssrLoadModule('/src/presentation/hooks/useProjects.js');
    const initialItems = [
      { id: '11111111-1111-4111-8111-111111111111', title: 'TTS Khmer Intro', type: 'tts', status: 'draft', updatedAt: '2026-11-21T10:00:00.000Z' },
      { id: '22222222-2222-4222-8222-222222222222', title: 'Subtitles Documentary', type: 'subtitles', status: 'ready', updatedAt: '2026-11-21T11:00:00.000Z' },
      { id: '33333333-3333-4333-8333-333333333333', title: 'Dubbing Commercial', type: 'dubbing', status: 'archived', updatedAt: '2026-11-21T12:00:00.000Z' },
    ];
    const repo = createMockProjectRepository(initialItems);

    const notifications = [];
    let openedProject = null;

    let hookState;
    function TestComponent() {
      hookState = useProjects({
        projectRepository: repo,
        initialProjects: initialItems,
        onOpenProject: p => { openedProject = p; },
        onNotify: n => { notifications.push(n); },
      });
      return null;
    }

    renderToStaticMarkup(React.createElement(TestComponent));
    assert.ok(hookState);
    assert.equal(hookState.projects.length, 3);

    // Validation guard on empty title
    const emptyResult = await hookState.createProject({ title: '   ', type: 'tts' });
    assert.equal(emptyResult, null);
    assert.equal(repo.projects.length, 3);

    // Valid creation
    const created = await hookState.createProject({ title: 'New Khmer Episode', type: 'tts' });
    assert.ok(created);
    assert.equal(created.title, 'New Khmer Episode');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].kind, 'success');
    assert.equal(repo.projects.length, 4);

    // Renaming execution
    const renamed = await hookState.renameProject(created, 'Renamed Episode Title');
    assert.equal(renamed, true);
    assert.equal(notifications.length, 2);
    const updated = repo.projects.find(p => p.id === created.id);
    assert.equal(updated.title, 'Renamed Episode Title');

    // Duplicate
    const duplicated = await hookState.duplicateProject(updated);
    assert.ok(duplicated);
    assert.equal(duplicated.title, 'Renamed Episode Title (Copy)');
    assert.equal(notifications.length, 3);
    assert.equal(repo.projects.length, 5);

    // Opening project
    await hookState.openProject(updated);
    assert.ok(openedProject);
    assert.equal(openedProject.id, updated.id);

    // Explicit delete confirmation flow: unconfirmed call without target deletes nothing
    const unconfirmed = await hookState.confirmDelete(null);
    assert.equal(unconfirmed, false);
    assert.equal(repo.projects.some(p => p.id === duplicated.id), true);

    // Confirmed deletion removes target project
    const deleted = await hookState.confirmDelete(duplicated.id);
    assert.equal(deleted, true);
    assert.equal(notifications.length, 4);
    assert.equal(repo.projects.some(p => p.id === duplicated.id), false);
  });
});

test('fetchProjectList discards stale slow responses when a newer request has started', async () => {
  await withViteSsr(async vite => {
    const { fetchProjectList } = await vite.ssrLoadModule('/src/presentation/hooks/useProjects.js');

    let resolveSlow;
    const slowPromise = new Promise(resolve => { resolveSlow = resolve; });
    const slowRepo = {
      listProjects: async () => {
        await slowPromise;
        return { items: [{ id: 'slow-id', title: 'Slow Project' }] };
      },
    };
    const fastRepo = {
      listProjects: async () => ({ items: [{ id: 'fast-id', title: 'Fast Project' }] }),
    };

    const requestIdRef = { current: 1 };
    let currentProjects = [];
    const setProjects = items => { currentProjects = items; };
    const setError = () => {};

    // Request 1 starts with currentId = 1
    const slowFetch = fetchProjectList({
      repo: slowRepo,
      filterType: 'all',
      searchQuery: 'a',
      currentId: 1,
      requestIdRef,
      setProjects,
      setError,
      logger: null,
    });

    // User types more: Request 2 increments requestIdRef to 2 and finishes fast
    requestIdRef.current = 2;
    await fetchProjectList({
      repo: fastRepo,
      filterType: 'all',
      searchQuery: 'ab',
      currentId: 2,
      requestIdRef,
      setProjects,
      setError,
      logger: null,
    });

    assert.equal(currentProjects.length, 1);
    assert.equal(currentProjects[0].id, 'fast-id');

    // Now slow request 1 resolves late
    resolveSlow();
    await slowFetch;

    // Verify request 1 was discarded and did not overwrite request 2!
    assert.equal(currentProjects.length, 1);
    assert.equal(currentProjects[0].id, 'fast-id');
  });
});

test('ProjectsWorkspace SSR renders toolbar, search, filter chips, cards, and modals accessible markup', async () => {
  await withViteSsr(async vite => {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { ProjectsWorkspace } = await vite.ssrLoadModule('/src/presentation/components/ProjectsWorkspace.jsx');

    const sampleProjects = [
      { id: '11111111-1111-4111-8111-111111111111', title: 'Khmer News Story', type: 'tts', status: 'ready', updatedAt: '2026-11-21T10:00:00.000Z' },
      { id: '22222222-2222-4222-8222-222222222222', title: 'Village Tour Subtitles', type: 'subtitles', status: 'draft', updatedAt: '2026-11-21T11:00:00.000Z' },
    ];
    const repo = createMockProjectRepository(sampleProjects);

    const stubServices = {
      projectRepository: repo,
      logger: { debug() {}, warn() {}, error() {} },
    };

    const html = renderToStaticMarkup(
      React.createElement(
        StudioProvider,
        { services: stubServices },
        React.createElement(ProjectsWorkspace, { projectRepository: repo, initialProjects: sampleProjects })
      )
    );

    // Check Toolbar
    assert.ok(html.includes('id="new-project-btn"'));
    assert.ok(html.includes('New project'));

    // Check Filter Bar & Search
    assert.ok(html.includes('id="projects-search-input"'));
    assert.ok(html.includes('id="filter-type-all"'));
    assert.ok(html.includes('id="filter-type-tts"'));
    assert.ok(html.includes('id="filter-type-subtitles"'));
    assert.ok(html.includes('id="filter-type-dubbing"'));
    assert.ok(html.includes('id="projects-status-count"'));

    // Check Project Cards & Accessible Markup
    assert.ok(html.includes('Khmer News Story'));
    assert.ok(html.includes('Village Tour Subtitles'));
    assert.ok(html.includes('tabindex="0"'));
    assert.ok(html.includes('id="project-open-11111111-1111-4111-8111-111111111111"'));
    assert.ok(html.includes('id="project-rename-11111111-1111-4111-8111-111111111111"'));
    assert.ok(html.includes('id="project-duplicate-11111111-1111-4111-8111-111111111111"'));
    assert.ok(html.includes('id="project-delete-11111111-1111-4111-8111-111111111111"'));

    // Check Modals
    assert.ok(html.includes('id="new-project-modal"'));
    assert.ok(html.includes('id="new-project-title-input"'));
    assert.ok(html.includes('id="new-project-type-select"'));
    assert.ok(html.includes('id="rename-project-modal"'));
    assert.ok(html.includes('id="delete-project-modal"'));
    assert.ok(html.includes('id="delete-project-cancel-btn"'));
    assert.ok(html.includes('id="delete-project-confirm-btn"'));
  });
});

test('Sidebar SSR renders nav-projects alongside nav-tts and nav-subtitles', async () => {
  await withViteSsr(async vite => {
    const { Sidebar } = await vite.ssrLoadModule('/src/presentation/components/Sidebar.jsx');
    const html = renderToStaticMarkup(
      React.createElement(Sidebar, { activeWorkspace: 'projects', onSelectWorkspace() {} })
    );

    assert.ok(html.includes('id="nav-projects"'));
    assert.ok(html.includes('id="nav-tts"'));
    assert.ok(html.includes('id="nav-subtitles"'));
    assert.ok(html.includes('Projects'));
    assert.ok(html.includes('Text to speech'));
    assert.ok(html.includes('Video to subtitle'));
  });
});

test('Studio SSR renders Projects workspace and wires navigation between views', async () => {
  await withViteSsr(async vite => {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { Studio } = await vite.ssrLoadModule('/src/presentation/components/Studio.jsx');

    const repo = createMockProjectRepository([]);
    const stubServices = {
      projectRepository: repo,
      speechGateway: { checkAvailability: async () => true, uploadReferenceAudio: async () => ({}), synthesize: async () => ({}) },
      audioDecoder: { decodePeaks: async () => [] },
      logger: { debug() {}, warn() {}, error() {} },
      synthesizeSpeech: { execute: async () => ({}) },
      lockReferenceAudio: { execute: async file => ({ blob: file, fileName: file.name, mimeType: 'audio/wav' }) },
      voiceLibrary: { loadSaved: () => ({ entries: [], warning: null }), saveCustom: () => ({ entry: {}, entries: [] }), deleteCustom: () => [] },
      voiceAnchors: { loadAll: async () => ({}), pinCharacter: async p => p, updateAnchor: async () => null, unpinCharacter: async () => {} },
    };

    const html = renderToStaticMarkup(
      React.createElement(
        StudioProvider,
        { services: stubServices },
        React.createElement(Studio)
      )
    );

    assert.ok(html.includes('id="nav-projects"'));
    assert.ok(html.includes('id="nav-tts"'));
    assert.ok(html.includes('id="nav-subtitles"'));
    assert.ok(html.includes('class="workspace-panel projects-workspace"'));
    assert.ok(html.includes('No projects found'));
  });
});

test('useProjects handles repository errors gracefully across CRUD actions', async () => {
  await withViteSsr(async vite => {
    const { useProjects } = await vite.ssrLoadModule('/src/presentation/hooks/useProjects.js');
    const failingRepo = {
      listProjects: async () => { throw new Error('Database connection failed'); },
      getProject: async () => { throw new Error('Failed to fetch project'); },
      saveProject: async () => { throw new Error('Disk full'); },
      duplicateProject: async () => { throw new Error('Duplicate error'); },
      deleteProject: async () => { throw new Error('Delete permission denied'); },
    };

    let hookState;
    function TestComponent() {
      hookState = useProjects({ projectRepository: failingRepo });
      return null;
    }
    renderToStaticMarkup(React.createElement(TestComponent));
    assert.ok(hookState);

    // List failure executes without throwing unhandled exception
    await assert.doesNotReject(async () => {
      await hookState.loadProjects();
    });

    // Create failure returns null safely
    const created = await hookState.createProject({ title: 'Test Project', type: 'tts' });
    assert.equal(created, null);

    // Rename failure returns false safely
    const renamed = await hookState.renameProject({ id: '11111111-1111-4111-8111-111111111111' }, 'New Title');
    assert.equal(renamed, false);

    // Duplicate failure returns null safely
    const duplicated = await hookState.duplicateProject({ id: '11111111-1111-4111-8111-111111111111' });
    assert.equal(duplicated, null);

    // Delete failure returns false safely
    const deleted = await hookState.deleteProject('11111111-1111-4111-8111-111111111111');
    assert.equal(deleted, false);
  });
});

test('ProjectsWorkspace renders error banner when error state is active', async () => {
  await withViteSsr(async vite => {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { ProjectsWorkspace } = await vite.ssrLoadModule('/src/presentation/components/ProjectsWorkspace.jsx');

    const failingRepo = {
      listProjects: async () => { throw new Error('Simulated network error'); },
      getProject: async () => null,
      saveProject: async () => ({}),
      duplicateProject: async () => ({}),
      deleteProject: async () => ({}),
    };

    const stubServices = {
      projectRepository: failingRepo,
      logger: { debug() {}, warn() {}, error() {} },
    };

    const html = renderToStaticMarkup(
      React.createElement(
        StudioProvider,
        { services: stubServices },
        React.createElement(ProjectsWorkspace, { projectRepository: failingRepo })
      )
    );

    assert.ok(html.includes('id="projects-search-input"'));
    assert.ok(html.includes('No projects found'));
  });
});

function matchesMiniSelector(node, sel) {
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  if (sel.startsWith('.')) return String(node.className || '').split(/\s+/).includes(sel.slice(1));
  return node.tagName === sel.toUpperCase();
}

function walkQuerySelectorAll(root, sel, out = []) {
  for (const child of root.childNodes) {
    if (child.nodeType !== 1) continue;
    if (matchesMiniSelector(child, sel)) out.push(child);
    walkQuerySelectorAll(child, sel, out);
  }
  return out;
}

function createMountedTestDom() {
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
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
      if (k.startsWith('on')) this[k] = () => {};
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    removeAttribute(k) {
      this.attributes.delete(k);
      if (k === 'id') this.id = '';
    }
    hasAttribute(k) { return this.attributes.has(k); }
    addEventListener(type, fn, capture) {
      const key = `${capture ? 'cap' : 'bub'}:${type}`;
      if (!this.listeners.has(key)) this.listeners.set(key, []);
      this.listeners.get(key).push(fn);
    }
    removeEventListener(type, fn, capture) {
      const key = `${capture ? 'cap' : 'bub'}:${type}`;
      const list = this.listeners.get(key);
      if (list) this.listeners.set(key, list.filter(item => item !== fn));
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
    closest(sel) {
      for (let cur = this; cur; cur = cur.parentNode) {
        if (cur.nodeType === 1 && matchesMiniSelector(cur, sel)) return cur;
      }
      return null;
    }
    focus() { globalThis.document.activeElement = this; }
    showModal() { this.open = true; this.setAttribute('open', ''); }
    close() { this.open = false; this.removeAttribute('open'); }
    querySelectorAll(sel) { return walkQuerySelectorAll(this, sel); }
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
      this._value = v == null ? '' : String(v);
      this._dirtyValue = true;
    }
  }
  class HTMLIFrameElement {}
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const win = { HTMLIFrameElement, navigator: { userAgent: 'Node' }, matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }) };
  const body = new MiniElement('body');
  const docEl = new MiniElement('html');
  docEl.appendChild(new MiniElement('head'));
  docEl.appendChild(body);
  const doc = {
    nodeType: 9,
    defaultView: win,
    activeElement: null,
    head: docEl.firstChild,
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.HTMLIFrameElement = HTMLIFrameElement;
  return { doc, restore() { Object.assign(globalThis, prev); } };
}

test('mounted ProjectsWorkspace deletes project by UUID on real button click and hides background error banner while modal is open', async () => {
  const dom = createMountedTestDom();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');

  await withViteSsr(async vite => {
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');
    const { ProjectsWorkspace } = await vite.ssrLoadModule('/src/presentation/components/ProjectsWorkspace.jsx');

    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const baseRepo = createMockProjectRepository([
      { id: firstId, title: 'Khmer Draft One', type: 'tts', status: 'draft', updatedAt: '2026-11-27T14:04:00.000Z' },
      { id: secondId, title: 'Khmer Draft Two', type: 'tts', status: 'draft', updatedAt: '2026-11-27T14:04:00.000Z' },
    ]);
    const deletedArgs = [];
    const callbackIds = [];
    let shouldFailDelete = true;
    const repo = {
      ...baseRepo,
      deleteProject: async id => {
        deletedArgs.push(id);
        if (shouldFailDelete) throw new Error('Simulated delete failure');
        return baseRepo.deleteProject(id);
      },
    };
    const stubServices = { projectRepository: repo, logger: { debug() {}, warn() {}, error() {} } };
    const container = dom.doc.createElement('div');
    dom.doc.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(
            StudioProvider,
            { services: stubServices },
            React.createElement(ProjectsWorkspace, {
              projectRepository: repo,
              onDeleteProject: id => callbackIds.push(id),
            })
          )
        );
      });

      assert.equal(container.querySelectorAll('.project-card').length, 2);
      const deleteTrigger = container.querySelector(`#project-delete-${firstId}`);
      assert.ok(deleteTrigger);

      await act(async () => {
        deleteTrigger.dispatchEvent({ type: 'click', bubbles: true });
      });

      const confirmBtn = container.querySelector('#delete-project-confirm-btn');
      assert.ok(confirmBtn);

      await act(async () => {
        confirmBtn.dispatchEvent({ type: 'click', bubbles: true });
      });

      assert.equal(deletedArgs[0], firstId);
      assert.equal(typeof deletedArgs[0], 'string');
      const modalError = container.querySelector('#delete-project-modal')?.querySelector('.project-modal-error');
      assert.ok(modalError);
      assert.match(modalError.textContent, /Simulated delete failure/);
      assert.equal(container.querySelector('.projects-error-banner'), null);

      shouldFailDelete = false;
      await act(async () => {
        confirmBtn.dispatchEvent({ type: 'click', bubbles: true });
      });

      assert.equal(deletedArgs[1], firstId);
      assert.deepEqual(callbackIds, [firstId]);
      assert.equal(container.querySelectorAll('.project-card').length, 1);
      assert.equal(container.querySelector(`#project-title-${firstId}`), null);
      assert.ok(container.querySelector(`#project-title-${secondId}`));
    } finally {
      await act(async () => { root.unmount(); });
      dom.restore();
    }
  });
});
