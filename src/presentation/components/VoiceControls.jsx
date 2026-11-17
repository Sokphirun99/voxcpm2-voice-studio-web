/**
 * @fileoverview Narakeet-style Character Voice inspector: per-person selector, 1-voice lock status, sample upload, and advanced controls.
 */

import React, { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { MAX_GUIDANCE, MAX_SEED, MAX_STEPS, MIN_GUIDANCE, MIN_STEPS } from '../../domain/presets.js';
import { formatCharacterOptionLabel, groupCharactersByCategory } from '../../domain/voiceLibrary.js';
import { Icon } from './Icon.jsx';

/**
 * Renders the Character dropdown grouped by category alongside a New-character button.
 * @param {{ characters: Array<object>, anchors: Record<string, object>, selectedId: string, onSelectId: (id: string) => void, onNewCharacter: () => void }} props - Selector props.
 * @returns {React.ReactElement} Character selector field.
 */
function CharacterSelector({ characters, anchors, selectedId, onSelectId, onNewCharacter }) {
  const groups = groupCharactersByCategory(characters);
  return (
    <div className="character-selector-block">
      <div className="field-label-row">
        <label className="field-label" htmlFor="character-select">Character</label>
        <button type="button" className="button subtle-button save-voice-trigger" id="new-character-button" onClick={onNewCharacter}>
          + New character
        </button>
      </div>
      <div className="select-field">
        <Icon name="person" />
        <select id="character-select" name="character" aria-describedby="character-help"
          value={selectedId} onChange={event => onSelectId(event.target.value)}>
          {groups.map(([groupLabel, items]) => (
            <optgroup label={groupLabel} key={groupLabel}>
              {items.map(item => (
                <option key={item.id} value={item.id}>
                  {formatCharacterOptionLabel(item, { isLocked: Boolean(anchors?.[item.id]) })}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <Icon name="chevron_down" className="select-chevron" />
      </div>
      <p id="character-help" className="field-help">
        Each character has one exclusive speaker voice that stays fixed across every script you generate.
      </p>
    </div>
  );
}

/**
 * Renders optional exact-transcript cloning inputs for any locked character voice (generated or uploaded).
 * @param {{ anchor: object, disabled: boolean, transcriptRef: object, onUpdateAnchor: (patch: object) => void }} props - Exact match props.
 * @returns {React.ReactElement|null} Transcript controls or null.
 */
function UploadedTranscriptMatch({ anchor, disabled, transcriptRef, onUpdateAnchor }) {
  if (!anchor?.blob) return null;
  const isExact = Boolean(anchor.exactClone);
  return (
    <div className="locked-voice-options">
      <label className="locked-checkbox">
        <input type="checkbox" id="exact-voice-match" checked={isExact} disabled={disabled}
          onChange={event => onUpdateAnchor({ exactClone: event.currentTarget.checked })} />
        <span>Exact transcript match</span>
      </label>
      {isExact && (
        <textarea ref={transcriptRef} id="locked-transcript" className="locked-transcript" rows={2}
          disabled={disabled} placeholder="Transcript spoken in the locked voice sample…"
          value={anchor.promptText || ''}
          onChange={event => onUpdateAnchor({ promptText: event.target.value })} />
      )}
    </div>
  );
}

/**
 * Renders sample upload and reset actions for the active speaking character.
 * @param {{ hasAnchor: boolean, characterName: string, disabled: boolean, onUploadSample: (file: File) => void, onResetVoice: () => void }} props - Action props.
 * @returns {React.ReactElement} Action buttons row.
 */
function CharacterVoiceActions({ hasAnchor, characterName, disabled, onUploadSample, onResetVoice }) {
  const fileInput = useRef(null);
  return (
    <div className="character-actions-row">
      <input ref={fileInput} id="reference-audio-input" type="file" accept="audio/*" hidden
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) onUploadSample(file);
        }} />
      <button type="button" className="button subtle-button upload-ref-button" id="upload-reference-audio"
        disabled={disabled} onClick={() => fileInput.current?.click()}>
        <Icon name="upload" />
        <span>{hasAnchor ? `Replace ${characterName}'s sample…` : `Upload voice sample…`}</span>
      </button>
      {hasAnchor && (
        <button type="button" className="button subtle-button seed-helper-button" id="reset-character-voice"
          disabled={disabled} onClick={onResetVoice}>
          Reset voice
        </button>
      )}
    </div>
  );
}

/**
 * Renders the active Character identity card displaying unique ID, lock status, persona traits, and sample actions.
 * @param {object} props - Card props.
 * @returns {React.ReactElement} Character card.
 */
function CharacterIdentityCard({ character, anchor, busy, transcriptRef, onUploadSample, onResetVoice, onUpdateAnchor }) {
  const hasAnchor = Boolean(anchor?.blob);
  const badgeText = hasAnchor ? 'Voice locked' : 'Locks on 1st take';
  const lockDetail = anchor?.source === 'upload'
    ? `Locked sample: ${anchor.fileName}`
    : 'Locked to 1st generated take — same voice reused across scripts';
  return (
    <div className="character-card" id="active-character-card">
      <div className="character-card-head">
        <div>
          <strong>{character.name}{character.role ? ` · ${character.role}` : ''}</strong>
          <span className="character-id-code">ID: {character.id}</span>
          <span className="character-traits">{character.traits}</span>
        </div>
        <span className={hasAnchor ? 'anchor-badge' : 'design-badge'}>{badgeText}</span>
      </div>
      <p className="character-description-note">{character.description}</p>
      {hasAnchor && <p className="character-lock-source">{lockDetail}</p>}
      <UploadedTranscriptMatch anchor={anchor} disabled={busy} transcriptRef={transcriptRef} onUpdateAnchor={onUpdateAnchor} />
      <CharacterVoiceActions hasAnchor={hasAnchor} characterName={character.name} disabled={busy}
        onUploadSample={onUploadSample} onResetVoice={onResetVoice} />
    </div>
  );
}

/**
 * Renders the seed field header with quick Reuse-last-seed and Random actions.
 * @param {{ seed: string, lastSeed: number|null, onChange: (key: string, value: unknown) => void }} props - Seed header props.
 * @returns {React.ReactElement} Seed label row.
 */
function SeedLabelRow({ seed, lastSeed, onChange }) {
  const canReuse = lastSeed != null && String(lastSeed) !== String(seed);
  return (
    <div className="field-label-row">
      <label className="field-label" htmlFor="seed">Seed</label>
      <div className="seed-actions">
        {canReuse && (
          <button type="button" className="button subtle-button seed-helper-button" id="reuse-last-seed"
            onClick={() => onChange('seed', String(lastSeed))}>
            Use last ({lastSeed})
          </button>
        )}
        {seed !== '' && (
          <button type="button" className="button subtle-button seed-helper-button" id="clear-seed"
            onClick={() => onChange('seed', '')}>
            Random
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Renders guidance and diffusion step range inputs inside Advanced settings.
 * @param {{ guidance: number, steps: number, onChange: (key: string, value: unknown) => void }} props - Range props.
 * @returns {React.ReactElement} Slider controls.
 */
function InferenceSliders({ guidance, steps, onChange }) {
  return (
    <>
      <label className="field-label" htmlFor="guidance">
        Voice guidance <output id="guidance-value" htmlFor="guidance">{guidance.toFixed(1)}</output>
      </label>
      <input id="guidance" name="guidance" type="range" min={MIN_GUIDANCE} max={MAX_GUIDANCE} step="0.1"
        value={guidance} onChange={event => onChange('guidance', event.target.valueAsNumber)} />
      <label className="field-label" htmlFor="steps">
        Diffusion steps <output id="steps-value" htmlFor="steps">{steps}</output>
      </label>
      <input id="steps" name="steps" type="range" min={MIN_STEPS} max={MAX_STEPS} step="1"
        value={steps} onChange={event => onChange('steps', event.target.valueAsNumber)} />
      <p className="field-help">Lower (4–6) generates faster when testing; 10 is the balanced default.</p>
    </>
  );
}

/**
 * Renders collapsible guidance, diffusion steps (4–20), seed, and reference denoising controls.
 * @param {{ options: object, lastSeed: number|null, onChange: (key: string, value: unknown) => void }} props - Advanced props.
 * @returns {React.ReactElement} Collapsible advanced panel.
 */
function AdvancedSection({ options, lastSeed, onChange }) {
  const [advanced, setAdvanced] = useState(false);
  return (
    <div className="advanced">
      <button type="button" className="advanced-button" aria-controls="advanced-fields" aria-expanded={advanced}
        onClick={() => setAdvanced(prev => !prev)} onKeyDown={event => { if (event.key === 'Escape') setAdvanced(false); }}>
        <span>Advanced settings</span>
        <Icon name="chevron_down" />
      </button>
      <div className="advanced-fields" id="advanced-fields" hidden={!advanced}>
        <InferenceSliders guidance={options.guidance} steps={options.steps} onChange={onChange} />
        <SeedLabelRow seed={options.seed} lastSeed={lastSeed} onChange={onChange} />
        <input id="seed" name="seed" type="number" min="0" max={MAX_SEED} step="1" placeholder="Auto"
          value={options.seed} onChange={event => onChange('seed', event.target.value)}
          onInvalid={() => { if (!advanced) flushSync(() => setAdvanced(true)); }} />
        <label className="locked-checkbox advanced-checkbox">
          <input type="checkbox" id="denoise-reference" checked={Boolean(options.denoiseReference)}
            onChange={event => onChange('denoiseReference', event.currentTarget.checked)} />
          <span>Clean background noise on voice sample</span>
        </label>
      </div>
    </div>
  );
}

/**
 * Renders the Narakeet-style Character Voice inspector panel.
 * Inputs: `{ characters, anchors, activeCharacter, activeAnchor, anchorWarning, busy, options, lastSeed, transcriptRef, actions }`.
 * Outputs: `<div className="voice-body">` element.
 * Side effects: triggers callbacks on character selection, sample upload, reset, or option updates.
 * Failure modes: displays storage warnings if persisted voice clips fail to load.
 * @param {object} props - Voice inspector props.
 * @returns {React.ReactElement} Voice controls panel.
 */
export function VoiceControls({ characters, anchors, activeCharacter, activeAnchor, anchorWarning, busy, options, lastSeed, transcriptRef, actions }) {
  return (
    <div className="voice-body">
      {anchorWarning && <p className="voice-warning" role="alert">{anchorWarning}</p>}
      <CharacterSelector characters={characters} anchors={anchors} selectedId={activeCharacter.id}
        onSelectId={actions.onSelectCharacter} onNewCharacter={actions.onOpenNewCharacter} />
      <CharacterIdentityCard character={activeCharacter} anchor={activeAnchor} busy={busy} transcriptRef={transcriptRef}
        onUploadSample={actions.onUploadSample} onResetVoice={actions.onResetVoice} onUpdateAnchor={actions.onUpdateAnchor} />
      <AdvancedSection options={options} lastSeed={lastSeed} onChange={actions.onChangeOption} />
    </div>
  );
}
