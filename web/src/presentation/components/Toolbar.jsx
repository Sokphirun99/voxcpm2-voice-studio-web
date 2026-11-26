/**
 * @fileoverview Studio header bar with Generate, Cancel, and Autosave status controls.
 */

import React from 'react';
import { Blocks } from 'loading-dev';
import { Icon } from './Icon.jsx';
import { ProjectAutosaveBadge } from './ProjectAutosaveBadge.jsx';
import { OfflineReadinessBadge } from './OfflineReadinessBadge.jsx';

const GENERATE_SPINNER_SIZE_PX = 16;

function GenerateButton({ busy, generateDisabled, shortcut }) {
  const btnClass = busy ? 'button generate is-generating' : 'button generate';
  return (
    <button type="submit" className={btnClass} id="generate" form="speech-form"
      disabled={generateDisabled} aria-busy={busy || undefined} title={`Generate speech (${shortcut})`}>
      {busy ? <Blocks size={GENERATE_SPINNER_SIZE_PX} className="generate-spinner" /> : <Icon name="sparkles" />}
      <span id="generate-label">{busy ? 'Generating…' : 'Generate speech'}</span>
    </button>
  );
}

/**
 * Renders the top workspace toolbar with synthesis submit, cancel, and autosave status controls.
 * Inputs: `{ busy, generateDisabled, shortcut, onCancel, autosave, offlineReadiness, onSelectModels }`.
 * Outputs: `<header className="studio-toolbar">` element.
 * Side effects: invokes `onCancel` when Cancel is clicked.
 * Failure modes: none.
 * @param {{ busy: boolean, generateDisabled: boolean, shortcut: string, onCancel: () => void, autosave?: object, offlineReadiness?: object, onSelectModels?: () => void }} props - Toolbar props.
 * @returns {React.ReactElement} Toolbar element.
 */
export function Toolbar({ busy, generateDisabled, shortcut, onCancel, autosave, offlineReadiness, onSelectModels, onOpenExport, exportHistoryCount = 0 }) {
  return (
    <header className="studio-toolbar">
      <div className="toolbar-heading-group">
        <h1>Text to speech</h1>
        {autosave && <ProjectAutosaveBadge autosave={autosave} />}
        {offlineReadiness && <OfflineReadinessBadge readiness={offlineReadiness} onSelect={onSelectModels} />}
      </div>
      <div className="toolbar-actions">
        {onOpenExport && (
          <button
            type="button"
            id="tts-export-project-btn"
            className="button subtle-button"
            disabled={busy}
            onClick={onOpenExport}
          >
            <Icon name="arrow_down_to_line" />
            <span>Export project{exportHistoryCount > 0 ? ` (${exportHistoryCount})` : ''}</span>
          </button>
        )}
        {busy && (
          <button type="button" className="button subtle-button cancel-button" id="cancel-generate" onClick={onCancel}>
            <Icon name="stop_fill" /><span>Cancel</span>
          </button>
        )}
        <GenerateButton busy={busy} generateDisabled={generateDisabled} shortcut={shortcut} />
      </div>
    </header>
  );
}
