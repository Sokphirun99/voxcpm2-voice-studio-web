/**
 * @fileoverview Compact collapsible Pronunciation rules editor for the Voice pane.
 */

import React, { useState } from 'react';
import { MAX_GLOSSARY_RULES, MAX_GLOSSARY_TERM_LENGTH } from '../../domain/pronunciationRules.js';
import { usePronunciationRules } from '../hooks/usePronunciationRules.js';
import { Icon } from './Icon.jsx';

/**
 * Renders one editable term pair with enable toggle and delete action.
 * @param {{ row: object, position: number, disabled: boolean, onChange: (id: string, patch: object) => void, onRemove: (id: string) => void }} props - Row props.
 * @returns {React.ReactElement} Rule row.
 */
function PronunciationRuleRow({ row, position, disabled, onChange, onRemove }) {
  return (
    <li className={row.enabled ? 'pronunciation-row' : 'pronunciation-row is-disabled'}>
      <input type="checkbox" className="pronunciation-enabled" aria-label={`Enable rule ${position}`}
        checked={row.enabled} disabled={disabled} onChange={event => onChange(row.id, { enabled: event.currentTarget.checked })} />
      <input type="text" className="pronunciation-source" aria-label={`Rule ${position} written term`} placeholder="Written as"
        maxLength={MAX_GLOSSARY_TERM_LENGTH} spellCheck={false} value={row.source} disabled={disabled}
        onChange={event => onChange(row.id, { source: event.target.value })} />
      <input type="text" className="pronunciation-replacement" aria-label={`Rule ${position} spoken as`} placeholder="Spoken as"
        maxLength={MAX_GLOSSARY_TERM_LENGTH} spellCheck={false} value={row.replacement} disabled={disabled}
        onChange={event => onChange(row.id, { replacement: event.target.value })} />
      <button type="button" className="button subtle-button pronunciation-delete" aria-label={`Delete rule ${position}`}
        disabled={disabled} onClick={() => onRemove(row.id)}>×</button>
    </li>
  );
}

/**
 * Renders the Pronunciation rules collapsible: add, toggle, edit, delete, and save term pairs.
 * Inputs: `{ glossaryRepository, disabled }`.
 * Outputs: `<div className="pronunciation">` or null when no repository is injected.
 * Side effects: loads and saves the dictionary through the injected repository.
 * Failure modes: shows validation/storage errors inline without losing the draft.
 * @param {{ glossaryRepository: object|null, disabled?: boolean, onSaved?: Function }} props - Control props.
 * @returns {React.ReactElement|null} Pronunciation rules control.
 */
export function PronunciationRulesControl({ glossaryRepository, disabled = false, onSaved = null }) {
  const [isOpen, setIsOpen] = useState(false);
  const editor = usePronunciationRules(glossaryRepository, { onSaved });
  if (!glossaryRepository) return null;
  const count = editor.savedCount > 0 ? ` (${editor.savedCount})` : '';
  return (
    <div className="advanced pronunciation">
      <button type="button" className="advanced-button" id="pronunciation-rules-toggle" aria-controls="pronunciation-rules-panel"
        aria-expanded={isOpen} onClick={() => setIsOpen(previous => !previous)}
        onKeyDown={event => { if (event.key === 'Escape') setIsOpen(false); }}>
        <span>Pronunciation rules{count}</span>
        <Icon name="chevron_down" />
      </button>
      <div className="advanced-fields pronunciation-panel" id="pronunciation-rules-panel" hidden={!isOpen}>
        <p className="pronunciation-note">Rewrite brand names, acronyms, or mixed terms before speech. Your script text stays unchanged.</p>
        {editor.rows.length > 0 && (
          <ul className="pronunciation-list">
            {editor.rows.map((row, index) => (
              <PronunciationRuleRow key={row.id} row={row} position={index + 1} disabled={disabled || editor.isSaving}
                onChange={editor.updateRule} onRemove={editor.removeRule} />
            ))}
          </ul>
        )}
        <div className="pronunciation-actions">
          <button type="button" className="button subtle-button" id="add-pronunciation-rule"
            disabled={disabled || !editor.canAdd} title={editor.canAdd ? undefined : `Up to ${MAX_GLOSSARY_RULES} rules`} onClick={editor.addRule}>
            + Add rule
          </button>
          <button type="button" className="button subtle-button" id="save-pronunciation-rules"
            disabled={disabled || editor.isSaving || !editor.isDirty} onClick={() => void editor.save()}>
            {editor.isSaving ? 'Saving…' : 'Save rules'}
          </button>
        </div>
        {editor.status.message && (
          <p className={editor.status.error ? 'pronunciation-status is-error' : 'pronunciation-status'} role={editor.status.error ? 'alert' : 'status'}>
            {editor.status.message}
          </p>
        )}
      </div>
    </div>
  );
}
