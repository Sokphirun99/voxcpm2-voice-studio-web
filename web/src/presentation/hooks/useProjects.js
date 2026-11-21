/**
 * @fileoverview Custom hook and utilities for listing, searching, filtering, and mutating Voice Studio projects.
 */

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createProject, generateProjectId } from '../../domain/projects.js';
import { StudioContext } from '../StudioContext.jsx';

export const PROJECT_FILTER_ALL = 'all';
export const PROJECT_PAGE_SIZE = 50;
export const DEFAULT_PROJECT_TYPE = 'tts';
export const DEFAULT_PROJECT_STATUS = 'draft';
export const DEFAULT_PROJECT_TITLE = 'Untitled project';
export const PROJECT_COPY_SUFFIX = ' (Copy)';
export const PROJECT_EMPTY_TIMESTAMP = '—';

export const PROJECT_TYPE_OPTIONS = Object.freeze([
  { id: 'all', label: 'All types' },
  { id: 'tts', label: 'Text to speech' },
  { id: 'subtitles', label: 'Video to subtitle' },
  { id: 'dubbing', label: 'Dubbing' },
]);

export const PROJECT_TYPE_LABELS = Object.freeze({
  tts: 'Text to speech',
  subtitles: 'Video to subtitle',
  dubbing: 'Dubbing',
});

export const PROJECT_STATUS_LABELS = Object.freeze({
  draft: 'Draft',
  ready: 'Ready',
  archived: 'Archived',
});

/**
 * Normalizes project type from record.
 * @param {object|null|undefined} project - Candidate project object.
 * @returns {string} Normalized type string ('tts' | 'subtitles' | 'dubbing').
 */
export function resolveProjectType(project) {
  if (!project) return DEFAULT_PROJECT_TYPE;
  const candidate = project.type || (project.kind === 'subtitle' ? 'subtitles' : project.kind);
  if (candidate === 'subtitles' || candidate === 'subtitle') return 'subtitles';
  if (candidate === 'dubbing' || candidate === 'dub') return 'dubbing';
  return DEFAULT_PROJECT_TYPE;
}

/**
 * Normalizes project status.
 * @param {object|null|undefined} project - Candidate project object.
 * @returns {string} Status string ('draft' | 'ready' | 'archived').
 */
export function resolveProjectStatus(project) {
  if (!project?.status) return DEFAULT_PROJECT_STATUS;
  const candidate = String(project.status).toLowerCase();
  return PROJECT_STATUS_LABELS[candidate] ? candidate : DEFAULT_PROJECT_STATUS;
}

/**
 * Resolves project title or fallback name.
 * @param {object|null|undefined} project - Candidate project object.
 * @returns {string} Clean project title string.
 */
export function resolveProjectTitle(project) {
  if (!project) return DEFAULT_PROJECT_TITLE;
  const title = (project.title || project.name || '').trim();
  return title || DEFAULT_PROJECT_TITLE;
}

/**
 * Formats ISO timestamp for project list presentation.
 * @param {string|null|undefined} isoString - ISO date string.
 * @returns {string} Human-readable timestamp or fallback.
 */
export function formatProjectTimestamp(isoString) {
  if (!isoString) return PROJECT_EMPTY_TIMESTAMP;
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) return PROJECT_EMPTY_TIMESTAMP;
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function resolveContextServices(customRepo, customLogger) {
  const context = useContext(StudioContext);
  return {
    repo: customRepo || context?.projectRepository || null,
    logger: customLogger || context?.logger || null,
  };
}

export function buildProjectFilterParams(filterType, searchQuery) {
  const type = filterType === PROJECT_FILTER_ALL ? undefined : filterType;
  const search = searchQuery.trim() || undefined;
  return { type, search, limit: PROJECT_PAGE_SIZE, offset: 0 };
}

export async function fetchProjectList({ repo, filterType, searchQuery, currentId, requestIdRef, setProjects, setError, logger }) {
  try {
    const params = buildProjectFilterParams(filterType, searchQuery);
    const result = await repo.listProjects(params);
    if (currentId !== requestIdRef.current) return;
    setProjects(result.items || []);
  } catch (error) {
    if (currentId !== requestIdRef.current) return;
    setError(error?.message || 'Failed to load projects.');
    logger?.error?.('useProjects.loadProjects', error);
  }
}

function useProjectListState({ repo, filterType, searchQuery, logger, initialProjects = [] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestIdRef = useRef(0);

  const loadProjects = useCallback(async () => {
    if (!repo) { setProjects([]); return; }
    const currentId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    await fetchProjectList({ repo, filterType, searchQuery, currentId, requestIdRef, setProjects, setError, logger });
    if (currentId === requestIdRef.current) setLoading(false);
  }, [repo, filterType, searchQuery, logger]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  return { projects, loading, error, setError, loadProjects };
}

async function persistNewProject(repo, trimmed, type) {
  const id = generateProjectId();
  const entity = createProject({
    id,
    name: trimmed,
    title: trimmed,
    type: type || DEFAULT_PROJECT_TYPE,
    status: DEFAULT_PROJECT_STATUS,
  });
  const saveAction = repo.createProject ? repo.createProject.bind(repo) : repo.saveProject.bind(repo);
  const saved = await saveAction(entity);
  return saved?.project || entity;
}

function useCreateProjectHandler({ repo, loadProjects, onNotify, logger, setBusy, setError, setCreateModalOpen }) {
  return useCallback(async ({ title, type }) => {
    const trimmed = (title || '').trim();
    if (!trimmed) { setError('Project title is required.'); return null; }
    if (!repo) return null;
    setBusy(true);
    try {
      const created = await persistNewProject(repo, trimmed, type);
      setCreateModalOpen(false);
      await loadProjects();
      onNotify?.({ kind: 'success', title: 'Project created', message: `Created "${trimmed}".` });
      return created;
    } catch (error) {
      setError(error?.message || 'Failed to create project.');
      logger?.error?.('useProjects.createProject', error);
      return null;
    } finally { setBusy(false); }
  }, [repo, loadProjects, onNotify, logger, setBusy, setError, setCreateModalOpen]);
}

async function persistProjectRename(repo, project, trimmed) {
  const existing = await repo.getProject(project.id);
  if (!existing) throw new Error('Project not found.');
  const updated = createProject({ ...existing, name: trimmed, title: trimmed });
  await repo.saveProject(updated, { expectedRevision: existing.revision });
}

function useRenameProjectHandler({ repo, loadProjects, onNotify, logger, setBusy, setError, setRenameTarget }) {
  return useCallback(async (project, newTitle) => {
    const trimmed = (newTitle || '').trim();
    if (!project?.id || !trimmed || !repo) return false;
    setBusy(true);
    try {
      await persistProjectRename(repo, project, trimmed);
      setRenameTarget(null);
      await loadProjects();
      onNotify?.({ kind: 'success', title: 'Project renamed', message: `Renamed to "${trimmed}".` });
      return true;
    } catch (error) {
      setError(error?.message || 'Failed to rename project.');
      logger?.error?.('useProjects.renameProject', error);
      return false;
    } finally { setBusy(false); }
  }, [repo, loadProjects, onNotify, logger, setBusy, setError, setRenameTarget]);
}

function useDuplicateProjectHandler({ repo, loadProjects, onNotify, logger, setBusy, setError }) {
  return useCallback(async project => {
    if (!project?.id || !repo) return null;
    setBusy(true);
    try {
      const originalTitle = resolveProjectTitle(project);
      const result = await repo.duplicateProject(project.id, { title: `${originalTitle}${PROJECT_COPY_SUFFIX}` });
      await loadProjects();
      onNotify?.({ kind: 'success', title: 'Project duplicated', message: `Duplicated "${originalTitle}".` });
      return result?.project || null;
    } catch (error) {
      setError(error?.message || 'Failed to duplicate project.');
      logger?.error?.('useProjects.duplicateProject', error);
      return null;
    } finally { setBusy(false); }
  }, [repo, loadProjects, onNotify, logger, setBusy, setError]);
}

function useDeleteProjectHandler({ repo, loadProjects, onNotify, logger, setBusy, setError, setDeleteTarget }) {
  return useCallback(async projectId => {
    if (!projectId || !repo) return false;
    setBusy(true);
    try {
      await repo.deleteProject(projectId);
      setDeleteTarget(null);
      await loadProjects();
      onNotify?.({ kind: 'success', title: 'Project deleted', message: 'Project removed successfully.' });
      return true;
    } catch (error) {
      setError(error?.message || 'Failed to delete project.');
      logger?.error?.('useProjects.deleteProject', error);
      return false;
    } finally { setBusy(false); }
  }, [repo, loadProjects, onNotify, logger, setBusy, setError, setDeleteTarget]);
}

function useOpenProjectHandler({ repo, onOpenProject, logger, setError }) {
  return useCallback(async project => {
    if (!project?.id) return;
    try {
      let fullProject = project;
      if (repo && (!project.payload && !project.segments)) {
        const fetched = await repo.getProject(project.id);
        if (fetched) fullProject = fetched;
      }
      onOpenProject?.(fullProject);
    } catch (error) {
      setError(error?.message || 'Failed to open project.');
      logger?.error?.('useProjects.openProject', error);
    }
  }, [repo, onOpenProject, logger, setError]);
}

function useProjectModalState(setError) {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  return {
    createModalOpen, setCreateModalOpen,
    renameTarget, setRenameTarget,
    deleteTarget, setDeleteTarget,
    openCreateModal: () => { setError(null); setCreateModalOpen(true); },
    closeCreateModal: () => { setError(null); setCreateModalOpen(false); },
    openRenameModal: project => { setError(null); setRenameTarget(project); },
    closeRenameModal: () => { setError(null); setRenameTarget(null); },
    openDeleteModal: project => { setError(null); setDeleteTarget(project); },
    closeDeleteModal: () => { setError(null); setDeleteTarget(null); },
  };
}

function buildProjectsController({ list, modals, actions, busy, filterState }) {
  return {
    projects: list.projects, loading: list.loading, busy, error: list.error,
    filterType: filterState.filterType, searchQuery: filterState.searchQuery,
    createModalOpen: modals.createModalOpen, renameTarget: modals.renameTarget, deleteTarget: modals.deleteTarget,
    setFilterType: filterState.setFilterType, setSearchQuery: filterState.setSearchQuery,
    setError: list.setError, loadProjects: list.loadProjects,
    openCreateModal: modals.openCreateModal, closeCreateModal: modals.closeCreateModal,
    openRenameModal: modals.openRenameModal, closeRenameModal: modals.closeRenameModal,
    openDeleteModal: modals.openDeleteModal, closeDeleteModal: modals.closeDeleteModal,
    createProject: actions.create, renameProject: actions.rename, duplicateProject: actions.duplicate, deleteProject: actions.remove,
    confirmDelete: targetId => actions.remove(targetId || modals.deleteTarget?.id), openProject: actions.open,
  };
}

/**
 * Presentation hook managing Voice Studio project listing, filtering, search, and CRUD lifecycle.
 * Inputs: `{ onOpenProject, onNotify, projectRepository, initialProjects, logger }`.
 * Outputs: Project state bundle with query actions, modal toggles, and mutation triggers.
 * Side effects: queries project repository on mount and filter changes; triggers toasts on mutations.
 * Failure modes: captures errors into error state and logs diagnostic traces.
 * @param {object} [options] - Hook options.
 * @returns {object} Projects controller bundle.
 */
export function useProjects({ onOpenProject, onNotify, projectRepository: customRepo, initialProjects = [], logger: customLogger } = {}) {
  const { repo, logger } = resolveContextServices(customRepo, customLogger);
  const [filterType, setFilterType] = useState(PROJECT_FILTER_ALL);
  const [searchQuery, setSearchQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useProjectListState({ repo, filterType, searchQuery, logger, initialProjects });
  const modals = useProjectModalState(list.setError);
  const create = useCreateProjectHandler({ repo, loadProjects: list.loadProjects, onNotify, logger, setBusy, setError: list.setError, setCreateModalOpen: modals.setCreateModalOpen });
  const rename = useRenameProjectHandler({ repo, loadProjects: list.loadProjects, onNotify, logger, setBusy, setError: list.setError, setRenameTarget: modals.setRenameTarget });
  const duplicate = useDuplicateProjectHandler({ repo, loadProjects: list.loadProjects, onNotify, logger, setBusy, setError: list.setError });
  const remove = useDeleteProjectHandler({ repo, loadProjects: list.loadProjects, onNotify, logger, setBusy, setError: list.setError, setDeleteTarget: modals.setDeleteTarget });
  const open = useOpenProjectHandler({ repo, onOpenProject, logger, setError: list.setError });

  return buildProjectsController({
    list, modals, actions: { create, rename, duplicate, remove, open }, busy,
    filterState: { filterType, searchQuery, setFilterType, setSearchQuery },
  });
}
