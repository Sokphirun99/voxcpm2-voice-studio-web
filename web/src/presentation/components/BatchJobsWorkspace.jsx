/**
 * @fileoverview Accessible Batch Jobs workspace showing queued, running, interrupted, failed, completed, and cancelled production jobs.
 */

import React, { useState } from 'react';
import { Blocks } from 'loading-dev';
import {
  ACTIVE_JOB_STATUSES,
  CANCELLABLE_JOB_STATUSES,
  DEFAULT_MAX_RETRIES,
  JOB_STATUS,
  RETRYABLE_JOB_STATUSES,
} from '../../domain/productionJobs.js';
import {
  JOB_FILTER_OPTIONS,
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  formatJobDuration,
  useProductionJobs,
} from '../hooks/useProductionJobs.js';
import { Icon } from './Icon.jsx';

function formatTimestamp(isoString) {
  if (!isoString) return '—';
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function resolveSummaryLine(summary) {
  const parts = [];
  if (summary.running > 0) parts.push(`${summary.running} running`);
  if (summary.queued > 0) parts.push(`${summary.queued} queued`);
  if (summary.interrupted > 0) parts.push(`${summary.interrupted} interrupted`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  return parts.length > 0 ? parts.join(' · ') : 'Queue idle';
}

function BatchJobsToolbar({ summary, loading, busy, hasClearableHistory, onRefresh, onClearHistory }) {
  return (
    <header className="studio-toolbar">
      <div className="toolbar-title-group">
        <h1>Batch Jobs</h1>
        <span className="toolbar-subtitle" id="jobs-summary-subtitle">{resolveSummaryLine(summary)}</span>
      </div>
      <div className="toolbar-actions">
        <button type="button" id="refresh-jobs-btn" className="button subtle-button" disabled={loading} onClick={onRefresh}>
          <Icon name="refresh" className={loading ? 'spinning' : ''} />
          <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
        </button>
        <button type="button" id="clear-job-history-btn" className="button subtle-button"
          disabled={busy || !hasClearableHistory} onClick={onClearHistory}>
          <Icon name="trash" />
          <span>Clear history</span>
        </button>
      </div>
    </header>
  );
}

function handleJobChipArrowNav(event, index, onSelectFilter) {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  const total = JOB_FILTER_OPTIONS.length;
  const nextOption = JOB_FILTER_OPTIONS[(index + delta + total) % total];
  if (!nextOption) return;
  onSelectFilter(nextOption.id);
  document.getElementById(`filter-job-${nextOption.id}`)?.focus();
}

function JobsFilterChips({ filterStatus, summary, onSelectFilter }) {
  return (
    <div className="projects-filter-chips" role="radiogroup" aria-label="Filter jobs by status">
      {JOB_FILTER_OPTIONS.map((option, index) => {
        const isActive = filterStatus === option.id;
        const count = option.id === 'all' ? summary.total : (option.id === 'active' ? summary.active : summary[option.id] || 0);
        return (
          <button
            key={option.id}
            type="button"
            id={`filter-job-${option.id}`}
            className={`button subtle-button filter-chip ${isActive ? 'is-active' : ''}`}
            role="radio"
            aria-checked={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelectFilter(option.id)}
            onKeyDown={event => handleJobChipArrowNav(event, index, onSelectFilter)}
          >
            <span>{option.label}{count > 0 ? ` (${count})` : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

function JobsFilterBar({ filterStatus, summary, filteredCount, onSelectFilter }) {
  const countLabel = `${filteredCount} ${filteredCount === 1 ? 'job' : 'jobs'}`;
  return (
    <nav className="projects-filter-bar jobs-filter-bar" aria-label="Batch job filters">
      <JobsFilterChips filterStatus={filterStatus} summary={summary} onSelectFilter={onSelectFilter} />
      <span id="jobs-status-count" className="projects-count" role="status">{countLabel}</span>
    </nav>
  );
}

function InterruptedRecoveryBanner({ interruptedCount, retryableCount, busy, onRetryAll }) {
  if (!interruptedCount) return null;
  const effectiveRetryable = retryableCount ?? interruptedCount;
  const jobWord = interruptedCount === 1 ? 'job was' : 'jobs were';
  const copy = effectiveRetryable > 0
    ? 'Completed outputs were preserved safely. Retry to resume only remaining items without duplicating work.'
    : 'Completed outputs were preserved safely, but retry attempts are exhausted. Remove or create a new job to continue.';
  return (
    <section className="jobs-recovery-banner" id="jobs-interrupted-banner" role="alert">
      <Icon name="alert_circle" className="jobs-recovery-icon" />
      <div className="jobs-recovery-copy">
        <strong>{interruptedCount} {jobWord} interrupted by a restart or reload</strong>
        <span>{copy}</span>
      </div>
      <button
        type="button"
        id="retry-all-interrupted-btn"
        className="button button-primary"
        disabled={busy || effectiveRetryable === 0}
        title={effectiveRetryable === 0 ? 'All interrupted jobs have reached their maximum retry attempts' : 'Retry all interrupted jobs'}
        onClick={onRetryAll}
      >
        <Icon name="refresh" />
        <span>Retry interrupted</span>
      </button>
    </section>
  );
}

function JobProgressSection({ job }) {
  const progress = job.progress || { completed: 0, total: 0, percent: 0, currentItemLabel: null };
  const total = progress.total || 0;
  const completed = progress.completed || 0;
  const percent = total > 0 ? progress.percent : (job.status === JOB_STATUS.COMPLETED ? 100 : 0);
  const label = total > 0
    ? `${completed} of ${total} items (${percent}%)${progress.currentItemLabel ? ` · ${progress.currentItemLabel}` : ''}`
    : `${JOB_STATUS_LABELS[job.status] || job.status} (${percent}%)`;
  return (
    <div className="job-progress-wrap">
      <div className="job-progress-meta">
        <span>{label}</span>
        {job.attempt > 1 && <span className="job-attempt-badge">Attempt {job.attempt}</span>}
      </div>
      <div
        className="job-progress-track"
        role="progressbar"
        aria-label={`Progress for ${job.title}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={`job-progress-fill status-${job.status}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function JobArtifactsList({ artifacts }) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
  return (
    <div className="job-artifacts-block">
      <span className="job-section-label">Preserved outputs ({artifacts.length})</span>
      <ul className="job-artifacts-list">
        {artifacts.map(art => (
          <li key={art.id || `${art.itemId}-${art.assetId}`} className="job-artifact-chip">
            <Icon name={art.kind === 'video' ? 'subtitles' : 'waveform'} />
            <span className="job-artifact-name">{art.fileName}</span>
            {art.assetId && (
              <a className="job-artifact-download" href={`/api/v1/assets/${encodeURIComponent(art.assetId)}/download`} download={art.fileName}>
                Download
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function JobItemsChecklist({ items }) {
  const [expanded, setExpanded] = useState(false);
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="job-items-disclosure">
      <button type="button" className="button subtle-button job-items-toggle" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
        <Icon name={expanded ? 'chevron_up' : 'chevron_down'} />
        <span>{expanded ? 'Hide items' : `View items (${items.length})`}</span>
      </button>
      {expanded && (
        <ul className="job-items-list">
          {items.map(item => (
            <li key={item.itemId} className={`job-item-row status-${item.status}`}>
              <span className="job-item-label">{item.label}</span>
              <span className={`status-pill status-${item.status}`}>{item.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JobCardActions({ job, busy, onCancel, onRetry, onDelete, onOpenProject }) {
  const canCancel = CANCELLABLE_JOB_STATUSES.has(job.status);
  const isCancelling = job.status === JOB_STATUS.CANCEL_REQUESTED;
  const canRetry = RETRYABLE_JOB_STATUSES.has(job.status);
  const retryExhausted = (job.retryCount || 0) >= (job.maxRetries ?? DEFAULT_MAX_RETRIES);
  const canDelete = !ACTIVE_JOB_STATUSES.has(job.status);
  return (
    <div className="job-card-actions">
      {job.projectId && onOpenProject && (
        <button type="button" className="button subtle-button" onClick={() => onOpenProject(job.projectId)}>
          <Icon name="folder" /><span>Open project</span>
        </button>
      )}
      {canCancel && (
        <button type="button" id={`job-cancel-${job.id}`} className="button subtle-button cancel-button"
          disabled={busy || isCancelling} onClick={() => onCancel(job.id)}>
          <Icon name="stop_fill" /><span>{isCancelling ? 'Cancelling…' : 'Cancel'}</span>
        </button>
      )}
      {canRetry && (
        <button type="button" id={`job-retry-${job.id}`} className="button button-primary"
          disabled={busy || retryExhausted}
          title={retryExhausted ? 'Maximum retry attempts reached' : 'Retry unfinished items without duplicating completed outputs'}
          onClick={() => onRetry(job.id)}>
          <Icon name="refresh" /><span>{job.status === JOB_STATUS.INTERRUPTED ? 'Resume / Retry' : 'Retry'}</span>
        </button>
      )}
      {canDelete && (
        <button type="button" id={`job-delete-${job.id}`} className="button subtle-button project-delete-btn"
          disabled={busy} onClick={() => onDelete(job.id)}>
          <Icon name="trash" /><span>Remove</span>
        </button>
      )}
    </div>
  );
}

function JobCardHeader({ job }) {
  const typeLabel = JOB_TYPE_LABELS[job.type] || job.type;
  const statusLabel = JOB_STATUS_LABELS[job.status] || job.status;
  const durationLabel = formatJobDuration(job.startedAt, job.completedAt);
  return (
    <div className="job-card-header">
      <div className="job-card-title-group">
        <div className="job-card-meta-row">
          <span className="job-type-badge">{typeLabel}</span>
          {job.projectTitle && <span className="job-project-name">{job.projectTitle}</span>}
          <span className="job-timestamp">{formatTimestamp(job.createdAt)}</span>
          {durationLabel && <span className="job-duration">{durationLabel}</span>}
        </div>
        <h3 className="job-card-title">{job.title}</h3>
      </div>
      <span className={`status-pill status-${job.status}`} id={`job-status-${job.id}`}>{statusLabel}</span>
    </div>
  );
}

function JobCard({ job, busy, onCancel, onRetry, onDelete, onOpenProject }) {
  return (
    <article className={`job-card status-${job.status}`} data-job-id={job.id} role="listitem">
      <JobCardHeader job={job} />
      <JobProgressSection job={job} />
      {job.error?.message && (
        <div className="job-error-note" role="alert">
          <Icon name="alert_circle" />
          <span>{job.error.message}</span>
        </div>
      )}
      <JobArtifactsList artifacts={job.artifacts} />
      <JobItemsChecklist items={job.items} />
      <JobCardActions job={job} busy={busy} onCancel={onCancel} onRetry={onRetry} onDelete={onDelete} onOpenProject={onOpenProject} />
    </article>
  );
}

function EmptyJobsView({ filterStatus }) {
  const copy = filterStatus === 'all'
    ? 'Batch TTS segment generation, subtitle voiceover batches, extraction, translation, and MP4 exports will appear here.'
    : `No ${filterStatus} batch jobs found.`;
  return (
    <div className="projects-empty" role="status">
      <Icon name="layers" className="empty-icon" />
      <p className="empty-title">No batch jobs</p>
      <p className="empty-description">{copy}</p>
    </div>
  );
}

function JobsListContent({ loading, jobs, filterStatus, busy, onCancel, onRetry, onDelete, onOpenProject }) {
  if (loading && jobs.length === 0) {
    return (
      <div className="projects-loading" role="status">
        <Blocks size={24} className="generate-spinner" />
        <span>Loading batch jobs…</span>
      </div>
    );
  }
  if (jobs.length === 0) return <EmptyJobsView filterStatus={filterStatus} />;
  return (
    <div className="jobs-list" role="list" aria-label="Batch jobs queue and history">
      {jobs.map(job => (
        <JobCard key={job.id} job={job} busy={busy} onCancel={onCancel} onRetry={onRetry} onDelete={onDelete} onOpenProject={onOpenProject} />
      ))}
    </div>
  );
}

/**
 * Top-level Batch Jobs workspace displaying active queue, progress, cancellation, retry, and preserved artifacts.
 * Inputs: `{ hidden, controller, initialJobs, jobRepository, onOpenProjectById, onNotify }`.
 * Outputs: `<div className="workspace-panel jobs-workspace">` element.
 * Side effects: loads/polls jobs via `controller` or internal `useProductionJobs`.
 * Failure modes: surfaces storage/execution errors inside inline alert banner without losing completed artifacts.
 * @param {object} [props={}] - Workspace props.
 * @returns {React.ReactElement} Batch Jobs workspace.
 */
export function BatchJobsWorkspace({
  hidden = false,
  controller = null,
  initialJobs = [],
  jobRepository = null,
  onOpenProjectById = null,
  onNotify = null,
}) {
  const internal = useProductionJobs({
    jobRepository,
    initialJobs,
    onNotify,
    enabled: !controller,
    autoRecover: !controller,
    autoRun: !controller,
  });
  const api = controller || internal;

  return (
    <div className="workspace-panel jobs-workspace" id="jobs-workspace-pane" hidden={hidden} aria-label="Batch Jobs workspace">
      <BatchJobsToolbar
        summary={api.summary}
        loading={api.loading}
        busy={api.busy}
        hasClearableHistory={api.hasClearableHistory}
        onRefresh={() => void api.refreshJobs()}
        onClearHistory={() => void api.clearHistory()}
      />
      <JobsFilterBar
        filterStatus={api.filterStatus}
        summary={api.summary}
        filteredCount={api.filteredJobs.length}
        onSelectFilter={api.setFilterStatus}
      />
      <div className="jobs-workspace-content">
        {api.error && (
          <div className="projects-error-banner" role="alert">
            <span>{api.error}</span>
            <button type="button" className="button subtle-button" onClick={() => api.setError(null)} aria-label="Dismiss error">
              <Icon name="xmark" />
            </button>
          </div>
        )}
        <InterruptedRecoveryBanner
          interruptedCount={api.interruptedCount}
          retryableCount={api.retryableInterruptedCount}
          busy={api.busy}
          onRetryAll={() => void api.retryAllInterrupted()}
        />
        <JobsListContent
          loading={api.loading}
          jobs={api.filteredJobs}
          filterStatus={api.filterStatus}
          busy={api.busy}
          onCancel={id => void api.cancelJob(id)}
          onRetry={id => void api.retryJob(id)}
          onDelete={id => void api.deleteJob(id)}
          onOpenProject={onOpenProjectById}
        />
      </div>
    </div>
  );
}
