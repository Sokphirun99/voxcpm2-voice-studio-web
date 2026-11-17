/**
 * @fileoverview Connected Character Library modal dialog for picking, creating, or resetting 1-person speaking characters.
 */

import React, { useEffect, useRef, useState } from 'react';
import { formatByteSize } from '../../domain/audioValidation.js';
import { MAX_DESCRIPTION_LENGTH } from '../../domain/presets.js';
import { MAX_VOICE_NAME_LENGTH } from '../../domain/voiceLibrary.js';
import { Icon } from './Icon.jsx';

const CATEGORY_LABELS = { female: 'Female', male: 'Male', character: 'Character' };

/**
 * Renders action buttons for one character entry row.
 * @param {object} props - Row action props.
 * @returns {React.ReactElement} Action buttons group.
 */
function VoiceRowActions({ voice, isPinned, busy, onSelect, onDelete, onUnpin }) {
  return (
    <div className="library-row-actions">
      <button type="button" className="button library-use" onClick={() => onSelect(voice)}
        aria-label={`Use ${voice.name}`}>Use character</button>
      {isPinned && (
        <button type="button" className="button subtle-button library-unpin" disabled={busy} onClick={() => onUnpin(voice.id)}>
          Reset voice
        </button>
      )}
      {!voice.isBuiltIn && (
        <button type="button" className="button subtle-button library-delete" disabled={busy} onClick={() => onDelete(voice.id)}
          aria-label={`Delete ${voice.name}`}>Delete</button>
      )}
    </div>
  );
}

/**
 * Renders one speaking character entry row with unique ID, lock status, and actions.
 * @param {{ voice: object, isPinned: boolean, busy: boolean, onSelect: (voice: object) => void, onDelete: (id: string) => void, onUnpin: (id: string) => void }} props - Row props.
 * @returns {React.ReactElement} List item element.
 */
function VoiceRow({ voice, isPinned, busy, onSelect, onDelete, onUnpin }) {
  const metaParts = [voice.isBuiltIn ? 'Built-in' : 'Custom', CATEGORY_LABELS[voice.category], `ID: ${voice.id}`];
  return (
    <li>
      <div>
        <div className="library-name-row">
          <strong>{voice.name}{voice.role ? ` — ${voice.role}` : ''}</strong>
          {isPinned && <span className="anchor-badge">Voice locked</span>}
        </div>
        <span className="library-meta">{metaParts.filter(Boolean).join(' · ')}</span>
        <p className="library-prompt">{voice.description}</p>
      </div>
      <VoiceRowActions voice={voice} isPinned={isPinned} busy={busy} onSelect={onSelect} onDelete={onDelete} onUnpin={onUnpin} />
    </li>
  );
}

/**
 * Renders the character name and category fields in the Create Character form.
 * @param {{ name: string, setName: Function, category: string, setCategory: Function }} props - Field props.
 * @returns {React.ReactElement} Identity grid element.
 */
function VoiceIdentityFields({ name, setName, category, setCategory }) {
  return (
    <div className="library-save-grid">
      <label>
        <span>Character name</span>
        <input type="text" id="save-voice-name" maxLength={MAX_VOICE_NAME_LENGTH} required
          placeholder="e.g. Pisey" value={name} onChange={event => setName(event.target.value)} />
      </label>
      <label>
        <span>Category</span>
        <div className="select-field select-field--plain">
          <select id="save-voice-category" value={category} onChange={event => setCategory(event.target.value)}>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="character">Character</option>
          </select>
          <Icon name="chevron_down" className="select-chevron" />
        </div>
      </label>
    </div>
  );
}

/**
 * Renders the optional voice sample file picker and clear button.
 * @param {{ audioFile: File|null, setAudioFile: Function }} props - Audio file props.
 * @returns {React.ReactElement} File input field.
 */
function VoiceAudioField({ audioFile, setAudioFile }) {
  const fileInputRef = useRef(null);
  function clearAudioFile() {
    setAudioFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
  return (
    <label>
      <span>Voice sample (optional)</span>
      <div className="save-file-picker">
        <input ref={fileInputRef} type="file" id="save-voice-audio" accept="audio/*"
          onChange={event => setAudioFile(event.currentTarget.files?.[0] || null)} />
        {audioFile && (
          <button type="button" className="button subtle-button save-file-clear" onClick={clearAudioFile}>Clear</button>
        )}
      </div>
    </label>
  );
}

/**
 * Renders the form fields inside the Create Character form.
 * @param {object} props - Form field state and setters.
 * @returns {React.ReactElement} Form fields fragment.
 */
function SaveVoiceFields({ name, setName, category, setCategory, description, setDescription, audioFile, setAudioFile }) {
  return (
    <>
      <VoiceIdentityFields name={name} setName={setName} category={category} setCategory={setCategory} />
      <label>
        <span>Speaking traits {audioFile ? '(optional with voice sample)' : ''}</span>
        <textarea id="save-voice-description" rows={2} maxLength={MAX_DESCRIPTION_LENGTH} required={!audioFile}
          placeholder="One young woman speaking alone, gentle warm voice, clear articulation"
          value={description} onChange={event => setDescription(event.target.value)} />
      </label>
      <VoiceAudioField audioFile={audioFile} setAudioFile={setAudioFile} />
    </>
  );
}

/**
 * Submits custom character creation and captures validation or storage errors inline.
 * @param {object} spec - Submission state and save handler.
 * @returns {Promise<void>} Completion promise.
 */
async function submitSaveVoice({ input, submitting, setSubmitting, setError, onSave }) {
  if (submitting) return;
  setSubmitting(true);
  setError('');
  try {
    await onSave(input);
  } catch (err) {
    setError(err.message || 'Could not create this character.');
  } finally {
    setSubmitting(false);
  }
}

/**
 * Renders inline error alert and Cancel/Save buttons for the Create Character form.
 * @param {{ error: string, submitting: boolean, onCancel: Function }} props - Action props.
 * @returns {React.ReactElement} Form actions fragment.
 */
function SaveFormActions({ error, submitting, onCancel }) {
  return (
    <>
      {error && <p className="library-form-error" role="alert">{error}</p>}
      <div className="library-save-actions">
        <button type="button" className="button subtle-button" disabled={submitting} onClick={onCancel}>Cancel</button>
        <button type="submit" className="button generate" id="confirm-save-voice" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save character'}
        </button>
      </div>
    </>
  );
}

/**
 * Renders the inline save form for creating a custom speaking character.
 * @param {{ onSave: (input: object) => Promise<void>, onCancel: () => void }} props - Form props.
 * @returns {React.ReactElement} Form element.
 */
function SaveVoiceForm({ onSave, onCancel }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('female');
  const [description, setDescription] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const handleSubmit = event => {
    event.preventDefault();
    void submitSaveVoice({ input: { name, category, description, audioFile, hasVoiceClip: Boolean(audioFile) }, submitting, setSubmitting, setError, onSave });
  };
  return (
    <form className="library-save-form" onSubmit={handleSubmit}>
      <div className="library-save-fields">
        <SaveVoiceFields name={name} setName={setName} category={category} setCategory={setCategory}
          description={description} setDescription={setDescription} audioFile={audioFile} setAudioFile={setAudioFile} />
      </div>
      <SaveFormActions error={error} submitting={submitting} onCancel={onCancel} />
    </form>
  );
}

/**
 * Renders the Character Library header with create toggle and close button.
 * @param {{ showSaveForm: boolean, onOpenSave: () => void, onCloseClick: () => void }} props - Header props.
 * @returns {React.ReactElement} Dialog header.
 */
function LibraryHeader({ showSaveForm, onOpenSave, onCloseClick }) {
  const title = showSaveForm ? 'New character' : 'Character library';
  const subtitle = showSaveForm ? 'Describe a voice or attach a 5–15s audio sample.' : 'Pick a character or create your own.';
  return (
    <div className="library-header">
      <div>
        <h2 id="library-title">{title}</h2>
        <p id="library-description">{subtitle}</p>
      </div>
      <div className="library-header-actions">
        {!showSaveForm && (
          <button type="button" className="button subtle-button" id="new-saved-voice" onClick={onOpenSave}>+ New character</button>
        )}
        <button type="button" className="button subtle-button" id="close-voice-library"
          aria-label="Close character library" onClick={onCloseClick}><Icon name="xmark" /></button>
      </div>
    </div>
  );
}

/**
 * Renders a labeled `<select>` filter field inside the Character Library filter bar.
 * @param {object} props - Select label, attributes, options, and change handler.
 * @returns {React.ReactElement} Select filter element.
 */
function LibrarySelectField({ label, id, name, value, options, onChange }) {
  return (
    <label>
      <span>{label}</span>
      <div className="select-field select-field--plain">
        <select id={id} name={name} value={value} onChange={onChange}>
          {options.map(([optValue, optLabel]) => <option key={optValue} value={optValue}>{optLabel}</option>)}
        </select>
        <Icon name="chevron_down" className="select-chevron" />
      </div>
    </label>
  );
}

/**
 * Renders search, source, and category filters for the Character Library dialog.
 * @param {{ filters: { search: string, source: string, category: string }, onFilterChange: (event: Event) => void }} props - Filter bar props.
 * @returns {React.ReactElement} Filter bar.
 */
function LibraryFilters({ filters, onFilterChange }) {
  return (
    <div className="library-filters">
      <label className="library-search">
        <span>Search characters</span>
        <input type="search" id="library-search" name="search" placeholder="Name, ID, traits, or description"
          value={filters.search} onChange={onFilterChange} />
      </label>
      <LibrarySelectField label="Source" id="library-source" name="source" value={filters.source} onChange={onFilterChange}
        options={[['', 'All characters'], ['saved', 'Custom characters'], ['builtin', 'Built-in characters']]} />
      <LibrarySelectField label="Category" id="library-category" name="category" value={filters.category} onChange={onFilterChange}
        options={[['', 'All categories'], ['female', 'Female'], ['male', 'Male'], ['character', 'Character']]} />
    </div>
  );
}

function formatStorageSummary(storageStats) {
  const st = storageStats?.storage;
  if (!st) return '';
  const parts = [`Storage ${formatByteSize(st.usedBytes || 0)}`];
  if (Number.isFinite(st.cacheEntriesCount) && Number.isFinite(st.maxCacheEntries)) {
    parts.push(`${st.cacheEntriesCount}/${st.maxCacheEntries} cached`);
  }
  if (Number.isFinite(st.volumeFreeBytes) && st.volumeFreeBytes > 0) {
    parts.push(`${formatByteSize(st.volumeFreeBytes)} free`);
  }
  if (Number.isFinite(storageStats?.container?.rssBytes) && storageStats.container.rssBytes > 0) {
    parts.push(`${formatByteSize(storageStats.container.rssBytes)} RAM`);
  }
  return parts.join(' · ');
}

/**
 * Computes human-readable library count text with optional warning and Docker storage stats.
 * @param {number} count - Matching character count.
 * @param {string|null} warning - Storage warning text.
 * @param {object|null} [storageStats] - Optional backend storage capacity payload.
 * @returns {string} Status string.
 */
export function formatLibraryStatus(count, warning, storageStats = null) {
  const countText = count ? `${count.toLocaleString()} ${count === 1 ? 'character' : 'characters'}` : 'No characters match these filters.';
  const parts = [];
  if (warning) parts.push(warning);
  parts.push(countText);
  const storageSummary = formatStorageSummary(storageStats);
  if (storageSummary) parts.push(storageSummary);
  return parts.join(' · ');
}

/**
 * Synchronizes native `<dialog>` open state and initial Create form visibility with React props.
 * @param {{ current: HTMLDialogElement|null }} dialog - Dialog ref.
 * @param {boolean} open - Whether modal should be open.
 * @param {boolean} openSaveForm - Whether to reveal the create form on open.
 * @param {Function} setShowSaveForm - Local form toggle setter.
 */
function useLibraryDialogSync(dialog, open, openSaveForm, setShowSaveForm) {
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [dialog, open]);

  useEffect(() => {
    if (open) setShowSaveForm(Boolean(openSaveForm));
  }, [open, openSaveForm, setShowSaveForm]);
}

/**
 * Renders the scrollable list of matching character rows inside the Character Library dialog.
 * @param {object} props - Scroll ref, matches, anchors, busy flag, and row callbacks.
 * @returns {React.ReactElement} Scrollable results list.
 */
function LibraryResultsList({ scroller, matches, anchors, busy, onSelectVoice, onDeleteCharacter, onUnpinAnchor }) {
  return (
    <div className="library-scroll" ref={scroller}>
      <ul className="library-results" id="library-results" aria-label="Available characters">
        {matches.map(voice => (
          <VoiceRow voice={voice} key={voice.id} isPinned={Boolean(anchors?.[voice.id])} busy={busy}
            onSelect={onSelectVoice} onDelete={onDeleteCharacter} onUnpin={onUnpinAnchor} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Updates library search/select filters and resets list scroll to the top.
 * @param {Event} event - Input or select change event.
 * @param {Function} updateFilter - Library filter state updater.
 * @param {{ current: HTMLElement|null }} scroller - Results scroll container ref.
 */
function applyLibraryFilterChange(event, updateFilter, scroller) {
  updateFilter(event.currentTarget.name, event.currentTarget.value);
  if (scroller.current) scroller.current.scrollTop = 0;
}

/**
 * Renders searchable character filters, count status, and scrollable rows inside the Character Library dialog.
 * @param {object} props - Library filters, list refs, anchors, busy state, and row callbacks.
 * @returns {React.ReactElement} Browse view fragment.
 */
function LibraryBrowseSection({ filters, scroller, matches, warning, storageStats, anchors, busy, updateFilter, onSelectVoice, onDeleteCharacter, onUnpinAnchor }) {
  return (
    <>
      <LibraryFilters filters={filters} onFilterChange={event => applyLibraryFilterChange(event, updateFilter, scroller)} />
      <p className="library-count" id="library-status" role="status">{formatLibraryStatus(matches.length, warning, storageStats)}</p>
      <LibraryResultsList scroller={scroller} matches={matches} anchors={anchors} busy={busy}
        onSelectVoice={onSelectVoice} onDeleteCharacter={onDeleteCharacter} onUnpinAnchor={onUnpinAnchor} />
    </>
  );
}

/**
 * Modal dialog presenting single-speaker Characters, lock status, and custom character creation.
 * Inputs: `{ open, openSaveForm, library, anchors, onSelectVoice, onCreateCharacter, onDeleteCharacter, onUnpinAnchor, onClose }`.
 * Outputs: `<dialog className="voice-library">` element.
 * Side effects: opens/closes native `<dialog>` and triggers library save/delete/reset callbacks.
 * Failure modes: displays storage warnings or validation errors inline.
 * @param {object} props - Dialog props.
 * @returns {React.ReactElement} Character library modal dialog.
 */
export function VoiceLibrary({ open, openSaveForm, busy, library, anchors, onSelectVoice, onCreateCharacter, onDeleteCharacter, onUnpinAnchor, onClose }) {
  const dialog = useRef(null);
  const scroller = useRef(null);
  const [showSaveForm, setShowSaveForm] = useState(Boolean(openSaveForm));
  const { matches, warning, storageStats, refreshStats, filters, updateFilter } = library;
  useLibraryDialogSync(dialog, open, openSaveForm, setShowSaveForm);
  useEffect(() => { if (open) refreshStats?.(); }, [open, refreshStats]);
  const handleSaveCharacter = input => onCreateCharacter(input).then(() => setShowSaveForm(false));
  return (
    <dialog className="voice-library" id="voice-library" aria-labelledby="library-title"
      aria-describedby="library-description" ref={dialog} onClose={onClose}>
      <LibraryHeader showSaveForm={showSaveForm} onOpenSave={() => setShowSaveForm(true)} onCloseClick={() => dialog.current?.close()} />
      {showSaveForm ? (
        <SaveVoiceForm onSave={handleSaveCharacter} onCancel={() => setShowSaveForm(false)} />
      ) : (
        <LibraryBrowseSection filters={filters} scroller={scroller} matches={matches} warning={warning}
          storageStats={storageStats} anchors={anchors} busy={busy} updateFilter={updateFilter}
          onSelectVoice={onSelectVoice} onDeleteCharacter={onDeleteCharacter} onUnpinAnchor={onUnpinAnchor} />
      )}
    </dialog>
  );
}
