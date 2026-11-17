/**
 * @fileoverview Studio header bar with Generate and Cancel controls.
 */

import React from 'react';
import { Blocks } from 'loading-dev';
import { Icon } from './Icon.jsx';

const GENERATE_SPINNER_SIZE_PX = 16;

/**
 * Renders the top workspace toolbar with synthesis submit and cancel buttons.
 * Inputs: `{ busy, generateDisabled, shortcut, onCancel }`.
 * Outputs: `<header className="studio-toolbar">` element.
 * Side effects: invokes `onCancel` when Cancel is clicked.
 * Failure modes: none.
 * @param {{ busy: boolean, generateDisabled: boolean, shortcut: string, onCancel: () => void }} props - Toolbar props.
 * @returns {React.ReactElement} Toolbar element.
 */
export function Toolbar({ busy, generateDisabled, shortcut, onCancel }) {
  return (
    <header className="studio-toolbar">
      <h1>Text to speech</h1>
      <div className="toolbar-actions">
        {busy && (
          <button type="button" className="button subtle-button cancel-button" id="cancel-generate" onClick={onCancel}>
            <Icon name="stop_fill" /><span>Cancel</span>
          </button>
        )}
        <button type="submit" className={busy ? 'button generate is-generating' : 'button generate'} id="generate"
          form="speech-form" disabled={generateDisabled} aria-busy={busy || undefined}
          title={`Generate speech (${shortcut})`}>
          {busy ? <Blocks size={GENERATE_SPINNER_SIZE_PX} className="generate-spinner" /> : <Icon name="sparkles" />}
          <span id="generate-label">{busy ? 'Generating…' : 'Generate speech'}</span>
        </button>
      </div>
    </header>
  );
}
