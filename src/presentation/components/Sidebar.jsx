/**
 * @fileoverview Studio navigation sidebar switching the three standalone Voice Studio workspaces.
 */

import React from 'react';
import { Icon } from './Icon.jsx';

export const DEFAULT_WORKSPACES = Object.freeze([
  { id: 'tts', label: 'Text to speech', icon: 'square_pencil' },
  { id: 'subtitles', label: 'Video to subtitle', icon: 'subtitles' },
  { id: 'characters', label: 'Character library', icon: 'list_bullet', domId: 'open-voice-library' },
]);

/**
 * Renders one workspace switcher button inside the Studio navigation rail.
 * @param {{ item: { id: string, label: string, icon: string, domId?: string }, isActive: boolean, onSelect: (id: string) => void }} props - Nav item props.
 * @returns {React.ReactElement} Workspace nav button.
 */
function WorkspaceNavButton({ item, isActive, onSelect }) {
  const extraClass = item.id === 'characters' ? ' library-nav-button' : ' workspace-nav';
  return (
    <button
      type="button"
      id={item.domId || `nav-${item.id}`}
      className={`button sidebar-item${extraClass}`}
      aria-current={isActive ? 'page' : undefined}
      onClick={() => onSelect(item.id)}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </button>
  );
}

/**
 * Renders the navigation sidebar for switching standalone Voice Studio workspaces.
 * Inputs: `{ activeWorkspace, workspaces, onSelectWorkspace, onFocusScript, onOpenLibrary }`.
 * Outputs: `<aside className="studio-sidebar">` element.
 * Side effects: triggers workspace switch callbacks on click.
 * Failure modes: none.
 * @param {object} props - Sidebar props.
 * @returns {React.ReactElement} Sidebar element.
 */
export function Sidebar({ activeWorkspace = 'tts', workspaces = DEFAULT_WORKSPACES, onSelectWorkspace, onFocusScript, onOpenLibrary }) {
  const handleSelect = id => {
    onSelectWorkspace?.(id);
    if (id === 'characters') onOpenLibrary?.();
    if (id === 'tts') onFocusScript?.();
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
      </nav>
    </aside>
  );
}
