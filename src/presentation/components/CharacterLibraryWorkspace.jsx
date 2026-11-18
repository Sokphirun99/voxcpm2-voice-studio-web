/**
 * @fileoverview Standalone Character Library workspace function rendered independently of Text-to-Speech and Video-to-Subtitle.
 */

import React, { useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import { LibraryBrowseSection, SaveVoiceForm } from './VoiceLibrary.jsx';

function CharacterLibraryToolbar({ showSaveForm, onOpenSave, onCancelSave }) {
  return (
    <header className="studio-toolbar">
      <h1>{showSaveForm ? 'New character' : 'Character library'}</h1>
      <div className="toolbar-actions">
        {showSaveForm ? (
          <button type="button" id="cancel-create-character" className="button button-secondary" onClick={onCancelSave}>
            Back to characters
          </button>
        ) : (
          <button type="button" id="new-saved-voice" className="button generate" onClick={onOpenSave}>
            <Icon name="person" /><span>New character</span>
          </button>
        )}
      </div>
    </header>
  );
}

function CharacterStatusDock({ activeCharacter, status }) {
  const defaultMsg = activeCharacter
    ? `Active character for Text to speech: ${activeCharacter.name} (${activeCharacter.id}).`
    : 'Pick or create a character voice to share across Voice Studio.';
  return (
    <section className="playback character-status-dock" aria-label="Character library status">
      <div id="character-status" className={status?.error ? 'status is-error' : 'status'} role="status" aria-live="polite">
        {status?.message || defaultMsg}
      </div>
    </section>
  );
}

/**
 * Self-contained Character Library workspace function allowing browsing, filtering, creation, deletion, and voice reset.
 * Inputs: `{ hidden, showSaveForm, activeCharacter, selectedCharacterId, library, anchors, busy, status, ...callbacks }`.
 * Outputs: `<div className="workspace-panel character-workspace" id="voice-library">` element.
 * Side effects: triggers shared library persistence and anchor mutations via `Studio` callbacks.
 * Failure modes: displays inline form errors and library storage warnings without touching TTS state.
 * @param {object} props - Standalone character workspace props.
 * @returns {React.ReactElement} Character Library workspace panel.
 */
export function CharacterLibraryWorkspace({
  hidden = false,
  showSaveForm = false,
  activeCharacter,
  selectedCharacterId,
  library,
  anchors,
  busy = false,
  status,
  notices = null,
  onOpenSave,
  onCancelSave,
  onSelectVoice,
  onCreateCharacter,
  onDeleteCharacter,
  onUnpinAnchor,
}) {
  const scroller = useRef(null);
  const { matches, warning, storageStats, refreshStats, filters, updateFilter } = library;
  useEffect(() => {
    if (!hidden) refreshStats?.();
  }, [hidden, refreshStats]);
  const handleSave = input => onCreateCharacter(input).then(() => onCancelSave?.(true));
  return (
    <div className="workspace-panel character-workspace" id="voice-library" hidden={hidden}>
      <div className="workspace-notices">{notices}</div>
      <CharacterLibraryToolbar showSaveForm={showSaveForm} onOpenSave={onOpenSave} onCancelSave={() => onCancelSave?.(false)} />
      <div className="character-workspace-body">
        {showSaveForm ? (
          <section className="character-save-card" aria-label="Create new character">
            <p className="character-save-hint">Describe a voice or attach a 5–15s audio sample for instant cloning.</p>
            <SaveVoiceForm onSave={handleSave} onCancel={() => onCancelSave?.(false)} />
          </section>
        ) : (
          <section className="character-browse-card" aria-label="Character directory">
            <LibraryBrowseSection filters={filters} scroller={scroller} matches={matches} warning={warning}
              storageStats={storageStats} anchors={anchors} selectedCharacterId={selectedCharacterId} busy={busy}
              updateFilter={updateFilter} onSelectVoice={onSelectVoice} onDeleteCharacter={onDeleteCharacter}
              onUnpinAnchor={onUnpinAnchor} />
          </section>
        )}
      </div>
      <CharacterStatusDock activeCharacter={activeCharacter} status={status} />
    </div>
  );
}
