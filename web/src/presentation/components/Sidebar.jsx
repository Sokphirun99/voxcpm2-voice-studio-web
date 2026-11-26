/**
 * @fileoverview Studio navigation sidebar switching the top-level application functions.
 */

import React from 'react';
import { Icon } from './Icon.jsx';

export const DEFAULT_WORKSPACES = Object.freeze([
  { id: 'projects', label: 'Projects', icon: 'folder' },
  { id: 'tts', label: 'Text to speech', icon: 'square_pencil' },
  { id: 'subtitles', label: 'Video to subtitle', icon: 'subtitles' },
  { id: 'jobs', label: 'Batch Jobs', icon: 'layers' },
  { id: 'models', label: 'Models & Setup', icon: 'cpu' },
]);

/**
 * Renders one top-level function switcher button inside the Studio navigation rail.
 * @param {{ item: { id: string, label: string, icon: string }, isActive: boolean, badgeCount?: number, onSelect: (id: string) => void }} props - Nav item props.
 * @returns {React.ReactElement} Workspace nav button.
 */
function WorkspaceNavButton({ item, isActive, badgeCount = 0, onSelect }) {
  return (
    <button
      type="button"
      id={`nav-${item.id}`}
      className="button sidebar-item workspace-nav"
      aria-current={isActive ? 'page' : undefined}
      onClick={() => onSelect(item.id)}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
      {badgeCount > 0 && (
        <span className="nav-badge" aria-label={`${badgeCount} pending or interrupted`}>
          {badgeCount}
        </span>
      )}
    </button>
  );
}

/**
 * Renders the navigation sidebar for switching top-level Studio functions.
 * Inputs: `{ activeWorkspace, workspaces, onSelectWorkspace, onFocusScript, jobsBadgeCount }`.
 * Outputs: `<aside className="studio-sidebar">` element.
 * Side effects: triggers workspace switch callbacks on click.
 * Failure modes: none.
 * @param {object} props - Sidebar props.
 * @returns {React.ReactElement} Sidebar element.
 */
export function Sidebar({
  activeWorkspace = 'tts',
  workspaces = DEFAULT_WORKSPACES,
  onSelectWorkspace,
  onFocusScript,
  jobsBadgeCount = 0,
  soundMuted = false,
  onToggleSoundMuted,
}) {
  const handleSelect = id => {
    onSelectWorkspace?.(id);
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
          <WorkspaceNavButton
            key={item.id}
            item={item}
            isActive={activeWorkspace === item.id}
            badgeCount={item.id === 'jobs' ? jobsBadgeCount : 0}
            onSelect={handleSelect}
          />
        ))}
      </nav>
      {onToggleSoundMuted && (
        <div className="sidebar-footer">
          <button
            type="button"
            id="notification-sound-toggle"
            className="button sidebar-item sound-toggle-button"
            aria-pressed={!soundMuted}
            title={soundMuted ? 'Unmute completion alert sound' : 'Mute completion alert sound'}
            onClick={onToggleSoundMuted}
          >
            <Icon name={soundMuted ? 'volume_off' : 'volume_on'} />
            <span>{soundMuted ? 'Sound muted' : 'Sound alerts'}</span>
          </button>
        </div>
      )}
    </aside>
  );
}
