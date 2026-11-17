/**
 * @fileoverview Studio navigation sidebar switching independent application functions and the shared Character Library.
 */

import React from 'react';
import { Icon } from './Icon.jsx';

export const DEFAULT_WORKSPACES = Object.freeze([
  { id: 'tts', label: 'Text to speech', icon: 'square_pencil' },
  { id: 'subtitles', label: 'Video to subtitle', icon: 'subtitles' },
]);

/**
 * Renders one workspace switcher button inside the Studio navigation rail.
 * @param {{ item: { id: string, label: string, icon: string }, isActive: boolean, onSelect: (id: string) => void }} props - Nav item props.
 * @returns {React.ReactElement} Workspace nav button.
 */
function WorkspaceNavButton({ item, isActive, onSelect }) {
  return (
    <button type="button" id={`nav-${item.id}`} className="button sidebar-item workspace-nav"
      aria-current={isActive ? 'page' : undefined} onClick={() => onSelect(item.id)}>
      <Icon name={item.icon} /><span>{item.label}</span>
    </button>
  );
}

/**
 * Renders the navigation sidebar for switching Studio functions and opening the Character Library modal.
 * Inputs: `{ activeWorkspace, workspaces, onSelectWorkspace, onFocusScript, onOpenLibrary }`.
 * Outputs: `<aside className="studio-sidebar">` element.
 * Side effects: triggers workspace switch or modal open callbacks on click.
 * Failure modes: none.
 * @param {object} props - Sidebar props.
 * @returns {React.ReactElement} Sidebar element.
 */
export function Sidebar({ activeWorkspace = 'tts', workspaces = DEFAULT_WORKSPACES, onSelectWorkspace, onFocusScript, onOpenLibrary }) {
  const handleSelect = id => {
    if (onSelectWorkspace) onSelectWorkspace(id);
    if (id === 'tts' && onFocusScript) onFocusScript();
  };
  return (
    <aside className="studio-sidebar" aria-label="Voice Studio">
      <div className="brand">
        <span className="brand-mark"><Icon name="waveform" /></span>
        <span className="brand-label">Voice Studio</span>
      </div>
      <nav className="studio-nav" aria-label="Workspace">
        {workspaces.map(item => (
          <WorkspaceNavButton key={item.id} item={item} isActive={activeWorkspace === item.id} onSelect={handleSelect} />
        ))}
        <button type="button" className="button sidebar-item library-nav-button" id="open-voice-library"
          aria-haspopup="dialog" onClick={onOpenLibrary}>
          <Icon name="list_bullet" /><span>Character library</span>
        </button>
      </nav>
    </aside>
  );
}
