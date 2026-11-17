/**
 * @fileoverview Studio navigation sidebar and live engine connectivity badge.
 */

import React from 'react';
import { Icon } from './Icon.jsx';

const ENGINE_LABELS = { checking: 'Checking VoxCPM2', ready: 'VoxCPM2 online', offline: 'VoxCPM2 offline' };

/**
 * Renders the navigation sidebar and VoxCPM2 engine status indicator.
 * Inputs: `{ engine, onFocusScript, onOpenLibrary }`.
 * Outputs: `<aside className="studio-sidebar">` element.
 * Side effects: triggers focus or modal open callbacks on click.
 * Failure modes: none.
 * @param {{ engine: string, onFocusScript: () => void, onOpenLibrary: () => void }} props - Sidebar props.
 * @returns {React.ReactElement} Sidebar element.
 */
export function Sidebar({ engine, onFocusScript, onOpenLibrary }) {
  return (
    <aside className="studio-sidebar" aria-label="Voice Studio">
      <div className="brand">
        <span className="brand-mark"><Icon name="waveform" /></span>
        <span className="brand-label">Voice Studio</span>
      </div>
      <nav className="studio-nav" aria-label="Workspace">
        <button type="button" className="button sidebar-item editor-nav" aria-current="page" onClick={onFocusScript}>
          <Icon name="square_pencil" />Text to speech
        </button>
        <button type="button" className="button sidebar-item" id="open-voice-library"
          aria-haspopup="dialog" onClick={onOpenLibrary}>
          <Icon name="list_bullet" />Character library
        </button>
      </nav>
      <div className="engine" id="engine" data-state={engine} role="status"
        aria-label={ENGINE_LABELS[engine]} title={ENGINE_LABELS[engine]}>
        <span className="engine-dot" aria-hidden="true" />
        <span id="engine-label">{ENGINE_LABELS[engine]}</span>
      </div>
    </aside>
  );
}
