/**
 * @fileoverview Visual indicator component displaying project autosave status in workspace toolbars.
 */

import React from 'react';
import { AUTOSAVE_STATUS } from '../hooks/useProjectAutosave.js';
import { Icon } from './Icon.jsx';

function renderSavingContent() {
  return (
    <>
      <Icon name="refresh" className="autosave-spin-icon" />
      <span>Saving…</span>
    </>
  );
}

function renderSavedContent() {
  return (
    <>
      <Icon name="check_circle" />
      <span>Saved</span>
    </>
  );
}

function renderErrorContent(autosave) {
  const label = autosave?.isConflict ? 'Conflict' : 'Save failed';
  return (
    <>
      <Icon name="alert_circle" />
      <span>{label}</span>
      <button
        type="button"
        className="autosave-retry-button"
        id="autosave-retry-button"
        onClick={autosave?.retry || autosave?.saveNow}
        title="Retry autosave"
      >
        Retry
      </button>
    </>
  );
}

function renderDirtyContent() {
  return (
    <>
      <span className="autosave-dirty-dot" aria-hidden="true" />
      <span>Unsaved</span>
    </>
  );
}

function renderBadgeContent(autosave) {
  const status = autosave?.status;
  if (status === AUTOSAVE_STATUS.SAVING) return renderSavingContent();
  if (status === AUTOSAVE_STATUS.SAVED) return renderSavedContent();
  if (status === AUTOSAVE_STATUS.ERROR) return renderErrorContent(autosave);
  if (status === AUTOSAVE_STATUS.DIRTY) return renderDirtyContent();
  if (autosave?.lastSavedAt) return renderSavedContent();
  return null;
}

/**
 * Renders the autosave status indicator badge.
 * Inputs: `{ autosave, className }`.
 * Outputs: accessible badge element or null when idle without history.
 * Side effects: none.
 * Failure modes: safely renders nothing if autosave is null/undefined.
 * @param {{ autosave?: object, className?: string }} props - Badge props.
 * @returns {React.ReactElement|null} Autosave status badge or null.
 */
export function ProjectAutosaveBadge({ autosave, className = '' }) {
  if (!autosave) return null;
  const content = renderBadgeContent(autosave);
  if (!content) return null;
  const status = autosave.status || AUTOSAVE_STATUS.IDLE;
  const isAlert = status === AUTOSAVE_STATUS.ERROR;
  const baseClass = `autosave-status-badge status-${status} ${className}`.trim();

  return (
    <div
      className={baseClass}
      id="project-autosave-status"
      role={isAlert ? 'alert' : 'status'}
      aria-live={isAlert ? 'assertive' : 'polite'}
    >
      {content}
    </div>
  );
}
