/**
 * @fileoverview Narakeet-style Character Voice inspector: per-person selector, 1-voice lock status, sample upload, and advanced controls.
 */

import React, { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_GUIDANCE,
  MAX_SEED,
  MAX_STEPS,
  MIN_GUIDANCE,
  MIN_STEPS,
  STYLE_MODES,
  STYLE_PRESET_OPTIONS,
} from '../../domain/presets.js';
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
        <select id="character-select" name="character"
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
 * @param {{ hasAnchor: boolean, disabled: boolean, onUploadSample: (file: File) => void, onResetVoice: () => void }} props - Action props.
 * @returns {React.ReactElement} Action buttons row.
 */
function CharacterVoiceActions({ hasAnchor, disabled, onUploadSample, onResetVoice }) {
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
        <span>{hasAnchor ? 'Replace sample…' : 'Upload sample…'}</span>
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
 * Renders the top identity header with character title, lock badge, and collapsible details toggle.
 * @param {{ character: object, hasAnchor: boolean, detailsOpen: boolean, onToggleDetails: () => void, onCloseDetails: () => void }} props - Header props.
 * @returns {React.ReactElement} Card header.
 */
function CharacterCardHeader({ character, hasAnchor, detailsOpen, onToggleDetails, onCloseDetails }) {
  return (
    <div className="character-card-head">
      <div className="character-card-title">
        <strong>{character.name}</strong>
        {character.role && <span className="character-role-note">{character.role}</span>}
      </div>
      <div className="character-card-status">
        <span className={hasAnchor ? 'anchor-badge' : 'design-badge'}>
          {hasAnchor ? 'Voice locked' : 'Locks on 1st take'}
        </span>
        <button type="button" className="character-details-toggle" id="character-details-toggle"
          aria-expanded={detailsOpen} aria-controls="character-details-panel" aria-label="Character details"
          onClick={onToggleDetails} onKeyDown={event => { if (event.key === 'Escape') onCloseDetails(); }}>
          <Icon name="chevron_down" />
        </button>
      </div>
    </div>
  );
}

/**
 * Renders collapsible secondary metadata, lock source, and exact-transcript controls.
 * @param {object} props - Details panel props.
 * @returns {React.ReactElement} Collapsible details block.
 */
function CharacterDetailsPanel({ character, anchor, busy, detailsOpen, transcriptRef, onUpdateAnchor }) {
  const lockDetail = anchor?.source === 'upload'
    ? `Locked sample: ${anchor.fileName}`
    : 'Locked from 1st generated take';
  return (
    <div className="character-details-panel" id="character-details-panel" hidden={!detailsOpen}>
      <span className="character-id-code">ID: {character.id}</span>
      {character.traits && <span className="character-traits">{character.traits}</span>}
      <p className="character-description-note">{character.description}</p>
      {anchor?.blob && <p className="character-lock-source">{lockDetail}</p>}
      <UploadedTranscriptMatch anchor={anchor} disabled={busy} transcriptRef={transcriptRef} onUpdateAnchor={onUpdateAnchor} />
    </div>
  );
}

/**
 * Renders the layered Character identity card with primary controls visible and metadata collapsed by default.
 * @param {object} props - Card props.
 * @returns {React.ReactElement} Character card.
 */
function CharacterIdentityCard({ character, anchor, busy, transcriptRef, onUploadSample, onResetVoice, onUpdateAnchor }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasAnchor = Boolean(anchor?.blob);
  return (
    <div className="character-card" id="active-character-card">
      <CharacterCardHeader character={character} hasAnchor={hasAnchor} detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen(prev => !prev)} onCloseDetails={() => setDetailsOpen(false)} />
      <CharacterVoiceActions hasAnchor={hasAnchor} disabled={busy}
        onUploadSample={onUploadSample} onResetVoice={onResetVoice} />
      <CharacterDetailsPanel character={character} anchor={anchor} busy={busy} detailsOpen={detailsOpen}
        transcriptRef={transcriptRef} onUpdateAnchor={onUpdateAnchor} />
    </div>
  );
}

/**
 * Renders the seed field header with quick Reuse-last-seed and Random actions.
 * @param {{ seed: string, lastSeed: number|null, lockedSeed: number|null, onChange: (key: string, value: unknown) => void }} props - Seed header props.
 * @returns {React.ReactElement} Seed label row.
 */
function SeedLabelRow({ seed, lastSeed, lockedSeed, onChange }) {
  const canReuse = lastSeed != null && String(lastSeed) !== String(seed);
  const canClear = seed !== '' || lockedSeed != null;
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
        {canClear && (
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
 * Renders script-format style selection and optional custom prompt inside Advanced settings.
 * @param {{ options: object, isExactClone: boolean, onChange: (key: string, value: unknown) => void }} props - Style control props.
 * @returns {React.ReactElement} Style selector section.
 */
function ScriptStyleControl({ options, isExactClone, onChange }) {
  const styleMode = options.styleMode || STYLE_MODES.AUTO;
  return (
    <div className="style-control-block">
      <label className="field-label" htmlFor="style-mode">Script format &amp; style</label>
      <div className="select-field select-field--plain">
        <select id="style-mode" name="styleMode" value={styleMode} disabled={isExactClone}
          onChange={event => onChange('styleMode', event.target.value)}>
          {STYLE_PRESET_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
        </select>
        <Icon name="chevron_down" className="select-chevron" />
      </div>
      {styleMode === STYLE_MODES.CUSTOM && !isExactClone && (
        <input id="custom-style" name="customStyle" type="text" maxLength={MAX_DESCRIPTION_LENGTH}
          placeholder="e.g. Clear Khmer news anchor, calm steady pace"
          value={options.customStyle || ''} onChange={event => onChange('customStyle', event.target.value)} />
      )}
      {isExactClone && <p className="style-hint">Exact transcript match sets pacing directly from the sample.</p>}
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
    </>
  );
}

/**
 * Renders seed input alongside per-character seed locking toggle.
 * @param {{ options: object, lastSeed: number|null, lockedSeed: number|null, onChange: (key: string, value: unknown) => void, onAutoExpand: () => void }} props - Seed control props.
 * @returns {React.ReactElement} Seed field and lock toggle.
 */
function SeedControl({ options, lastSeed, lockedSeed, onChange, onAutoExpand }) {
  const lockSeed = options.lockSeed !== false;
  const placeholder = lockSeed && lockedSeed != null ? `Locked (${lockedSeed})` : 'Auto';
  return (
    <>
      <SeedLabelRow seed={options.seed} lastSeed={lastSeed} lockedSeed={lockedSeed} onChange={onChange} />
      <input id="seed" name="seed" type="number" min="0" max={MAX_SEED} step="1" placeholder={placeholder}
        value={options.seed} onChange={event => onChange('seed', event.target.value)} onInvalid={onAutoExpand} />
      <label className="locked-checkbox advanced-checkbox">
        <input type="checkbox" id="lock-seed" checked={lockSeed}
          onChange={event => onChange('lockSeed', event.currentTarget.checked)} />
        <span>Keep consistent voice seed</span>
      </label>
    </>
  );
}

/**
 * Renders Khmer formatting, loudness mastering, and reference denoising checkboxes inside Advanced settings.
 * @param {{ options: object, onChange: (key: string, value: unknown) => void }} props - Toggle props.
 * @returns {React.ReactElement} Checkbox toggles.
 */
function AdvancedToggles({ options, onChange }) {
  return (
    <>
      <label className="locked-checkbox advanced-checkbox">
        <input type="checkbox" id="auto-format-khmer" checked={options.autoFormatKhmer !== false}
          onChange={event => onChange('autoFormatKhmer', event.currentTarget.checked)} />
        <span>Auto-speak Khmer numbers &amp; time</span>
      </label>
      <label className="locked-checkbox advanced-checkbox">
        <input type="checkbox" id="master-audio" checked={options.masterAudio !== false}
          onChange={event => onChange('masterAudio', event.currentTarget.checked)} />
        <span>Master loudness for video (-16 LUFS)</span>
      </label>
      <label className="locked-checkbox advanced-checkbox">
        <input type="checkbox" id="denoise-reference" checked={Boolean(options.denoiseReference)}
          onChange={event => onChange('denoiseReference', event.currentTarget.checked)} />
        <span>Clean background noise on voice sample</span>
      </label>
      <label className="locked-checkbox advanced-checkbox">
        <input type="checkbox" id="verify-audio" checked={Boolean(options.verifyAudio)}
          onChange={event => onChange('verifyAudio', event.currentTarget.checked)} />
        <span>Auto-check Khmer words after speech (Whisper)</span>
      </label>
    </>
  );
}

/**
 * Renders collapsible style, guidance, diffusion steps, seed locking, formatting, and denoising controls.
 * @param {{ options: object, lastSeed: number|null, lockedSeed?: number|null, isExactClone?: boolean, onChange: (key: string, value: unknown) => void }} props - Advanced props.
 * @returns {React.ReactElement} Collapsible advanced panel.
 */
function AdvancedSection({ options, lastSeed, lockedSeed = null, isExactClone = false, onChange }) {
  const [advanced, setAdvanced] = useState(false);
  return (
    <div className="advanced">
      <button type="button" className="advanced-button" aria-controls="advanced-fields" aria-expanded={advanced}
        onClick={() => setAdvanced(prev => !prev)} onKeyDown={event => { if (event.key === 'Escape') setAdvanced(false); }}>
        <span>Advanced settings</span>
        <Icon name="chevron_down" />
      </button>
      <div className="advanced-fields" id="advanced-fields" hidden={!advanced}>
        <ScriptStyleControl options={options} isExactClone={isExactClone} onChange={onChange} />
        <InferenceSliders guidance={options.guidance} steps={options.steps} onChange={onChange} />
        <SeedControl options={options} lastSeed={lastSeed} lockedSeed={lockedSeed} onChange={onChange}
          onAutoExpand={() => { if (!advanced) flushSync(() => setAdvanced(true)); }} />
        <AdvancedToggles options={options} onChange={onChange} />
      </div>
    </div>
  );
}

/**
 * Renders the Narakeet-style Character Voice inspector panel.
 * Inputs: `{ characters, anchors, activeCharacter, activeAnchor, anchorWarning, busy, options, lastSeed, lockedSeed, transcriptRef, actions }`.
 * Outputs: `<div className="voice-body">` element.
 * Side effects: triggers callbacks on character selection, sample upload, reset, or option updates.
 * Failure modes: displays storage warnings if persisted voice clips fail to load.
 * @param {object} props - Voice inspector props.
 * @returns {React.ReactElement} Voice controls panel.
 */
export function VoiceControls({ characters, anchors, activeCharacter, activeAnchor, anchorWarning, busy, options, lastSeed, lockedSeed = null, transcriptRef, actions }) {
  const isExactClone = Boolean(activeAnchor?.blob && activeAnchor?.exactClone);
  return (
    <div className="voice-body">
      {anchorWarning && <p className="voice-warning" role="alert">{anchorWarning}</p>}
      <CharacterSelector characters={characters} anchors={anchors} selectedId={activeCharacter.id}
        onSelectId={actions.onSelectCharacter} onNewCharacter={actions.onOpenNewCharacter} />
      <CharacterIdentityCard character={activeCharacter} anchor={activeAnchor} busy={busy} transcriptRef={transcriptRef}
        onUploadSample={actions.onUploadSample} onResetVoice={actions.onResetVoice} onUpdateAnchor={actions.onUpdateAnchor} />
      <AdvancedSection options={options} lastSeed={lastSeed} lockedSeed={lockedSeed}
        isExactClone={isExactClone} onChange={actions.onChangeOption} />
    </div>
  );
}
