/**
 * @fileoverview Accessible Voice Studio workspace for browsing, searching, creating, and managing projects.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Blocks } from 'loading-dev';
import {
  PROJECT_STATUS_LABELS,
  PROJECT_TYPE_LABELS,
  PROJECT_TYPE_OPTIONS,
  formatProjectTimestamp,
  resolveProjectStatus,
  resolveProjectTitle,
  resolveProjectType,
  useProjects,
} from '../hooks/useProjects.js';
import { useStudioServices } from '../StudioContext.jsx';
import { useTerminology } from '../hooks/useTerminology.js';
import { Icon } from './Icon.jsx';
import { TerminologyManagerModal } from './TerminologyManagerModal.jsx';

const TYPE_ICONS = Object.freeze({
  tts: 'square_pencil',
  subtitles: 'subtitles',
  dubbing: 'waveform',
});

function useDialogSync(dialogRef, isOpen) {
  useEffect(() => {
    const element = dialogRef.current;
    if (!element) return;
    if (isOpen && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    } else if (!isOpen && element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [dialogRef, isOpen]);
}

function handleBackdropClick(event, dialogRef, onClose) {
  if (event.target !== dialogRef.current) return;
  const rect = dialogRef.current.getBoundingClientRect();
  const isOutside = (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
  if (isOutside) onClose();
}

function ProjectsToolbar({ onCreate, onOpenTerminology, termCount = 0, busy }) {
  return (
    <header className="studio-toolbar">
      <h1>Projects</h1>
      <div className="toolbar-actions">
        {onOpenTerminology && (
          <button
            type="button"
            id="open-global-terminology"
            className="button subtle-button"
            disabled={busy}
            onClick={onOpenTerminology}
          >
            <Icon name="list_bullet" />
            <span>Terminology{termCount > 0 ? ` (${termCount})` : ''}</span>
          </button>
        )}
        <button
          type="button"
          id="new-project-btn"
          className="button generate"
          disabled={busy}
          onClick={onCreate}
        >
          <Icon name="plus" />
          <span>New project</span>
        </button>
      </div>
    </header>
  );
}

function ProjectsSearchField({ searchQuery, onSearchChange }) {
  return (
    <div className="projects-search-wrap">
      <Icon name="search" className="search-icon" />
      <input
        type="search"
        id="projects-search-input"
        className="projects-search-input"
        placeholder="Search projects by title…"
        value={searchQuery}
        onChange={event => onSearchChange(event.target.value)}
        aria-label="Search projects by title"
      />
    </div>
  );
}

function handleChipArrowNav(event, index, onFilterChange) {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  const total = PROJECT_TYPE_OPTIONS.length;
  const nextOption = PROJECT_TYPE_OPTIONS[(index + delta + total) % total];
  if (!nextOption) return;
  onFilterChange(nextOption.id);
  document.getElementById(`filter-type-${nextOption.id}`)?.focus();
}

function FilterChipButton({ option, index, filterType, onFilterChange }) {
  const isActive = filterType === option.id;
  return (
    <button
      type="button"
      id={`filter-type-${option.id}`}
      className={`button subtle-button filter-chip ${isActive ? 'is-active' : ''}`}
      role="radio"
      aria-checked={isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={() => onFilterChange(option.id)}
      onKeyDown={event => handleChipArrowNav(event, index, onFilterChange)}
    >
      <span>{option.label}</span>
    </button>
  );
}

function ProjectsFilterChips({ filterType, onFilterChange }) {
  return (
    <div className="projects-filter-chips" role="radiogroup" aria-label="Filter by project type">
      {PROJECT_TYPE_OPTIONS.map((option, index) => (
        <FilterChipButton
          key={option.id}
          option={option}
          index={index}
          filterType={filterType}
          onFilterChange={onFilterChange}
        />
      ))}
    </div>
  );
}

function ProjectsFilterBar({ filterType, searchQuery, projectCount, onFilterChange, onSearchChange }) {
  const countLabel = `${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`;
  return (
    <nav className="projects-filter-bar" aria-label="Project search and filters">
      <ProjectsSearchField searchQuery={searchQuery} onSearchChange={onSearchChange} />
      <ProjectsFilterChips filterType={filterType} onFilterChange={onFilterChange} />
      <span id="projects-status-count" className="projects-count" role="status">{countLabel}</span>
    </nav>
  );
}

function ProjectCardHeader({ type, status }) {
  const iconName = TYPE_ICONS[type] || 'folder';
  const typeLabel = PROJECT_TYPE_LABELS[type] || type;
  const statusLabel = PROJECT_STATUS_LABELS[status] || status;
  return (
    <div className="project-card-header">
      <span className={`project-type-badge type-${type}`}>
        <Icon name={iconName} />
        <span>{typeLabel}</span>
      </span>
      <span className={`project-status-badge status-${status}`}>
        {statusLabel}
      </span>
    </div>
  );
}

function ProjectSecondaryActions({ project, onRename, onDuplicate, onDelete }) {
  return (
    <>
      <button type="button" id={`project-rename-${project.id}`} className="button subtle-button" title="Rename project" onClick={() => onRename(project)}>
        <Icon name="square_pencil" /><span>Rename</span>
      </button>
      <button type="button" id={`project-duplicate-${project.id}`} className="button subtle-button" title="Duplicate project" onClick={() => onDuplicate(project)}>
        <Icon name="copy" /><span>Duplicate</span>
      </button>
      <button type="button" id={`project-delete-${project.id}`} className="button subtle-button project-delete-btn" title="Delete project" onClick={() => onDelete(project)}>
        <Icon name="trash" /><span>Delete</span>
      </button>
    </>
  );
}

function ProjectCardActions({ project, onOpen, onRename, onDuplicate, onDelete }) {
  return (
    <div className="project-card-actions">
      <button type="button" id={`project-open-${project.id}`} className="button button-primary" onClick={() => onOpen(project)}>Open</button>
      <ProjectSecondaryActions project={project} onRename={onRename} onDuplicate={onDuplicate} onDelete={onDelete} />
    </div>
  );
}

function handleCardSelect(event, onOpen, project) {
  if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
    event.preventDefault();
    onOpen(project);
  }
}

function ProjectCard({ project, onOpen, onRename, onDuplicate, onDelete }) {
  const title = resolveProjectTitle(project);
  const type = resolveProjectType(project);
  const status = resolveProjectStatus(project);
  const updatedText = `Updated ${formatProjectTimestamp(project.updatedAt)}`;
  const onClick = event => (!event.defaultPrevented && !event.target.closest('button')) && onOpen(project);
  return (
    <article className="project-card" role="listitem" tabIndex={0}
      aria-labelledby={`project-title-${project.id}`} onClick={onClick} onKeyDown={e => handleCardSelect(e, onOpen, project)}>
      <ProjectCardHeader type={type} status={status} />
      <h3 id={`project-title-${project.id}`} className="project-card-title" title={title}>{title}</h3>
      <p className="project-card-timestamp">{updatedText}</p>
      <ProjectCardActions project={project} onOpen={onOpen} onRename={onRename} onDuplicate={onDuplicate} onDelete={onDelete} />
    </article>
  );
}

function EmptyProjectsView({ onCreateOpen }) {
  return (
    <div className="projects-empty" role="status">
      <Icon name="folder" className="empty-icon" />
      <p className="empty-title">No projects found</p>
      <p className="empty-description">Create a project or clear filters to start.</p>
      <button type="button" className="button button-primary" onClick={onCreateOpen}>
        Create project
      </button>
    </div>
  );
}

function ProjectsContent({ loading, projects, onOpen, onRename, onDuplicate, onDelete, onCreateOpen }) {
  if (loading && projects.length === 0) {
    return (
      <div className="projects-loading" role="status">
        <Blocks size={24} className="generate-spinner" />
        <span>Loading projects…</span>
      </div>
    );
  }
  if (projects.length === 0) {
    return <EmptyProjectsView onCreateOpen={onCreateOpen} />;
  }
  return (
    <div className="projects-grid" role="list" aria-label="Projects list">
      {projects.map(project => (
        <ProjectCard key={project.id} project={project} onOpen={onOpen} onRename={onRename} onDuplicate={onDuplicate} onDelete={onDelete} />
      ))}
    </div>
  );
}

function NewProjectTitleField({ title, setTitle }) {
  return (
    <>
      <label htmlFor="new-project-title-input">Project title</label>
      <input type="text" id="new-project-title-input" className="text-input" value={title}
        onChange={event => setTitle(event.target.value)} placeholder="e.g. Khmer News Podcast Ep 1" autoFocus required />
    </>
  );
}

function NewProjectTypeField({ type, setType }) {
  return (
    <>
      <label htmlFor="new-project-type-select">Workspace type</label>
      <select id="new-project-type-select" className="select-input" value={type} onChange={event => setType(event.target.value)}>
        <option value="tts">Text to speech</option>
        <option value="subtitles">Video to subtitle</option>
        <option value="dubbing">Dubbing</option>
      </select>
    </>
  );
}

function NewProjectForm({ title, type, busy, setTitle, setType, onSubmit, onClose }) {
  return (
    <form className="project-modal-form" onSubmit={onSubmit}>
      <NewProjectTitleField title={title} setTitle={setTitle} />
      <NewProjectTypeField type={type} setType={setType} />
      <div className="project-modal-actions">
        <button type="button" className="button subtle-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" id="create-project-submit-btn" className="button button-primary" disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </form>
  );
}

function ModalHeader({ titleId, title, onClose }) {
  return (
    <div className="project-modal-header">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="button subtle-button close-btn" onClick={onClose} aria-label="Close modal">
        <Icon name="xmark" />
      </button>
    </div>
  );
}

function useNewProjectState(isOpen) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('tts');
  useEffect(() => { if (isOpen) { setTitle(''); setType('tts'); } }, [isOpen]);
  return { title, setTitle, type, setType, reset: () => { setTitle(''); setType('tts'); } };
}

function submitNewProject(event, { title, type, busy, onCreate, onComplete }) {
  event.preventDefault();
  if (!title.trim() || busy) return;
  onCreate({ title: title.trim(), type }).then(res => { if (res) onComplete(); });
}

function NewProjectModal({ isOpen, busy, error, onClose, onCreate }) {
  const dialogRef = useRef(null);
  const { title, setTitle, type, setType, reset } = useNewProjectState(isOpen);
  useDialogSync(dialogRef, isOpen);
  const handleClose = () => { reset(); onClose(); };
  const handleSubmit = e => submitNewProject(e, { title, type, busy, onCreate, onComplete: handleClose });
  return (
    <dialog ref={dialogRef} className="project-modal" id="new-project-modal" aria-labelledby="new-project-title"
      onClose={handleClose} onCancel={handleClose} onKeyDown={e => { if (e.key === 'Escape') handleClose(); }}
      onClick={e => handleBackdropClick(e, dialogRef, handleClose)}>
      <ModalHeader titleId="new-project-title" title="New Project" onClose={handleClose} />
      {error && <div className="project-modal-error" role="alert">{error}</div>}
      <NewProjectForm title={title} type={type} busy={busy} setTitle={setTitle} setType={setType} onSubmit={handleSubmit} onClose={handleClose} />
    </dialog>
  );
}

function RenameProjectForm({ title, setTitle, busy, onSubmit, onClose }) {
  return (
    <form className="project-modal-form" onSubmit={onSubmit}>
      <label htmlFor="rename-project-title-input">Title</label>
      <input type="text" id="rename-project-title-input" className="text-input" value={title} onChange={e => setTitle(e.target.value)} autoFocus required />
      <div className="project-modal-actions">
        <button type="button" className="button subtle-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" id="rename-project-submit-btn" className="button button-primary" disabled={busy || !title.trim()}>Save</button>
      </div>
    </form>
  );
}

function submitRenameProject(event, { title, target, busy, onRename }) {
  event.preventDefault();
  if (title.trim() && !busy && target) onRename(target, title.trim());
}

function RenameProjectModal({ target, busy, error, onClose, onRename }) {
  const dialogRef = useRef(null);
  const [title, setTitle] = useState('');
  useDialogSync(dialogRef, Boolean(target));
  useEffect(() => { if (target) setTitle(target.title || target.name || ''); }, [target]);
  const handleSubmit = e => submitRenameProject(e, { title, target, busy, onRename });
  return (
    <dialog ref={dialogRef} className="project-modal" id="rename-project-modal" aria-labelledby="rename-project-title"
      onClose={onClose} onCancel={onClose} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
      onClick={e => handleBackdropClick(e, dialogRef, onClose)}>
      <ModalHeader titleId="rename-project-title" title="Rename Project" onClose={onClose} />
      {error && <div className="project-modal-error" role="alert">{error}</div>}
      <RenameProjectForm title={title} setTitle={setTitle} busy={busy} onSubmit={handleSubmit} onClose={onClose} />
    </dialog>
  );
}

function DeleteModalBody({ title, error }) {
  return (
    <div className="project-modal-body">
      <p>Are you sure you want to delete <strong>&ldquo;{title}&rdquo;</strong>?</p>
      <p className="delete-warning">This action removes the project and cannot be undone.</p>
      {error && <div className="project-modal-error" role="alert">{error}</div>}
    </div>
  );
}

function DeleteModalActions({ busy, onClose, onConfirm }) {
  return (
    <div className="project-modal-actions">
      <button type="button" id="delete-project-cancel-btn" className="button subtle-button" autoFocus onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" id="delete-project-confirm-btn" className="button button-danger" onClick={() => { void onConfirm(); }} disabled={busy}>
        {busy ? 'Deleting…' : 'Delete project'}
      </button>
    </div>
  );
}

function DeleteConfirmModal({ target, busy, error, onClose, onConfirm }) {
  const dialogRef = useRef(null);
  useDialogSync(dialogRef, Boolean(target));
  const title = target ? resolveProjectTitle(target) : '';
  return (
    <dialog ref={dialogRef} className="project-modal delete-modal" id="delete-project-modal" aria-labelledby="delete-project-title"
      onClose={onClose} onCancel={onClose} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
      onClick={e => handleBackdropClick(e, dialogRef, onClose)}>
      <div className="project-modal-header">
        <h2 id="delete-project-title">Delete Project</h2>
        <button type="button" className="button subtle-button close-btn" onClick={onClose} aria-label="Close modal"><Icon name="xmark" /></button>
      </div>
      <DeleteModalBody title={title} error={error} />
      <DeleteModalActions busy={busy} onClose={onClose} onConfirm={onConfirm} />
    </dialog>
  );
}

function ProjectModals({ api }) {
  return (
    <>
      <NewProjectModal isOpen={api.createModalOpen} busy={api.busy} error={api.error} onClose={api.closeCreateModal} onCreate={api.createProject} />
      <RenameProjectModal target={api.renameTarget} busy={api.busy} error={api.error} onClose={api.closeRenameModal} onRename={api.renameProject} />
      <DeleteConfirmModal target={api.deleteTarget} busy={api.busy} error={api.error} onClose={api.closeDeleteModal} onConfirm={api.confirmDelete} />
    </>
  );
}

function ProjectsErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div className="projects-error-banner" role="alert">
      <span>{error}</span>
      <button type="button" className="button subtle-button" onClick={onDismiss} aria-label="Dismiss error"><Icon name="xmark" /></button>
    </div>
  );
}

function ProjectsBannerAndContent({ api }) {
  const hasOpenModal = Boolean(api.createModalOpen || api.renameTarget || api.deleteTarget);
  return (
    <>
      <ProjectsErrorBanner error={hasOpenModal ? null : api.error} onDismiss={() => api.setError(null)} />
      <ProjectsContent
        loading={api.loading}
        projects={api.projects}
        onOpen={api.openProject}
        onRename={api.openRenameModal}
        onDuplicate={api.duplicateProject}
        onDelete={api.openDeleteModal}
        onCreateOpen={api.openCreateModal}
      />
    </>
  );
}

/**
 * Renders the top-level Projects workspace panel.
 * Inputs: `{ hidden, onOpenProject, onDeleteProject, onNotify, projectRepository, initialProjects, globalTerminology }`.
 * Outputs: `<div className="workspace-panel projects-workspace">` container.
 * Side effects: loads and mutates project resources via injected project repository; refreshes when shown.
 * Failure modes: displays errors inside status banner or active modal alert without crashing.
 * @param {object} [props] - Workspace props.
 * @returns {React.ReactElement} Projects workspace component.
 */
export function ProjectsWorkspace({
  hidden = false,
  onOpenProject,
  onDeleteProject,
  onNotify,
  projectRepository,
  initialProjects = [],
  globalTerminology = null,
} = {}) {
  const api = useProjects({ hidden, onOpenProject, onDeleteProject, onNotify, projectRepository, initialProjects });
  const services = useStudioServices();
  const [terminologyOpen, setTerminologyOpen] = useState(false);
  const terminologyCtrl = useTerminology({
    globalController: globalTerminology,
    terminologyRepository: services?.terminologyRepository,
    glossaryRepository: services?.glossaryRepository,
    onNotify,
    logger: services?.logger,
  });
  const canManageTerminology = Boolean(globalTerminology || services?.terminologyRepository);
  return (
    <div className="workspace-panel projects-workspace" hidden={hidden} aria-label="Projects workspace">
      <ProjectsToolbar
        onCreate={api.openCreateModal}
        onOpenTerminology={canManageTerminology ? () => setTerminologyOpen(true) : null}
        termCount={terminologyCtrl.counts.approved}
        busy={api.busy}
      />
      <ProjectsFilterBar
        filterType={api.filterType}
        searchQuery={api.searchQuery}
        projectCount={api.projects.length}
        onFilterChange={api.setFilterType}
        onSearchChange={api.setSearchQuery}
      />
      <ProjectsBannerAndContent api={api} />
      <ProjectModals api={api} />
      {canManageTerminology && (
        <TerminologyManagerModal
          open={terminologyOpen}
          terminologyCtrl={terminologyCtrl}
          canEditProject={false}
          onClose={() => setTerminologyOpen(false)}
        />
      )}
    </div>
  );
}
