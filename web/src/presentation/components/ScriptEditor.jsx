/**
 * @fileoverview Script editor pane with Khmer sample loader, live grapheme counter, structured segment editor, and clear action.
 */

import React, { useState } from 'react';
import { expandKhmerNumbers, hasConvertibleKhmerNumbers } from '../../domain/khmerText.js';
import { MAX_SCRIPT_LENGTH } from '../../domain/presets.js';
import { Icon } from './Icon.jsx';
import { SegmentEditor } from './SegmentEditor.jsx';

const KHMER_EXAMPLE = 'សួស្តីអ្នកទាំងអស់គ្នា។ ថ្ងៃនេះយើងនឹងសាកល្បងបម្លែងអត្ថបទជាភាសាខ្មែរទៅជាសំឡេងដោយប្រើតួអង្គតែមួយគត់។';

function EditorViewToggle({ segmentsCount, effectiveMode, onToggleMode }) {
  if (segmentsCount === 0) return null;
  return (
    <div className="editor-mode-toggle" role="tablist" aria-label="Editor view mode">
      <button type="button" role="tab" id="view-mode-segments" aria-selected={effectiveMode === 'segments'}
        className={effectiveMode === 'segments' ? 'is-active' : ''} onClick={() => onToggleMode('segments')}>
        Segments ({segmentsCount})
      </button>
      <button type="button" role="tab" id="view-mode-script" aria-selected={effectiveMode === 'script'}
        className={effectiveMode === 'script' ? 'is-active' : ''} onClick={() => onToggleMode('script')}>
        Script
      </button>
    </div>
  );
}

function EditorSegmentAudioActions({ effectiveMode, hasTakesToRestitch, onRestitchSegments, onExportNarration, disabled }) {
  if (effectiveMode !== 'segments' || !hasTakesToRestitch) return null;
  return (
    <>
      {onRestitchSegments && (
        <button type="button" className="button subtle-button" id="restitch-segments"
          onClick={onRestitchSegments} disabled={disabled}
          title="Stitch active segment takes into a single smooth audio track with pauses">
          <Icon name="waveform" /><span>Restitch audio</span>
        </button>
      )}
      {onExportNarration && (
        <button type="button" className="button subtle-button" id="export-narration"
          onClick={onExportNarration} disabled={disabled}
          title="Assemble and download full narration WAV">
          <Icon name="arrow_down_to_line" /><span>Export narration</span>
        </button>
      )}
    </>
  );
}

function EditorHeadingActions(props) {
  const { canFormatNumbers, canApplySpelling, onApplySpelling, script, onReplaceScript, segmentsCount, effectiveMode, onToggleMode, disabled } = props;
  return (
    <div className="editor-heading-actions">
      <EditorViewToggle segmentsCount={segmentsCount} effectiveMode={effectiveMode} onToggleMode={onToggleMode} />
      <EditorSegmentAudioActions {...props} />
      {canApplySpelling && onApplySpelling && (
        <button type="button" className="button subtle-button" id="apply-tts-spelling"
          disabled={disabled} onClick={onApplySpelling}>
          <Icon name="sparkles" />Apply spelling
        </button>
      )}
      {canFormatNumbers && (
        <button type="button" className="button subtle-button" id="format-khmer-numbers"
          onClick={() => onReplaceScript(expandKhmerNumbers(script))}>
          Speak numbers in Khmer
        </button>
      )}
      <button type="button" className="button subtle-button" id="khmer-example"
        onClick={() => onReplaceScript(KHMER_EXAMPLE)}>
        <Icon name="text_quote" />Khmer example
      </button>
    </div>
  );
}

function EditorSegmentView({ props }) {
  const { segments, activeSegmentId, disabled, onScriptKey } = props;
  return (
    <SegmentEditor
      segments={segments} activeSegmentId={activeSegmentId} disabled={disabled} onScriptKey={onScriptKey}
      onSelectSegment={props.onSelectSegment} onUpdateSegment={props.onUpdateSegment}
      onAddSegment={props.onAddSegment} onDeleteSegment={props.onDeleteSegment}
      onMoveSegmentUp={props.onMoveSegmentUp} onMoveSegmentDown={props.onMoveSegmentDown}
      onMergeSegment={props.onMergeSegment} onSplitSegment={props.onSplitSegment} onReorderSegments={props.onReorderSegments}
      onGenerateSegment={props.onGenerateSegment} onTogglePlaySegment={props.onTogglePlaySegment}
      generatingSegmentId={props.generatingSegmentId} playingSegmentId={props.playingSegmentId}
      onSelectSegmentTake={props.onSelectSegmentTake} onDeleteSegmentTake={props.onDeleteSegmentTake}
      onTogglePlayTake={props.onTogglePlayTake} playingTakeId={props.playingTakeId}
      onCycleSegmentTake={props.onCycleSegmentTake}
      pronunciationSignature={props.pronunciationSignature}
      voices={props.voices || props.characters} defaultVoiceId={props.defaultVoiceId}
    />
  );
}

function EditorContent({ props, effectiveMode }) {
  const isSegments = effectiveMode === 'segments' && props.segments?.length > 0;
  return (
    <>
      <textarea id="script" ref={props.scriptInput} aria-describedby="character-count"
        placeholder="Write or paste the text you want to hear…" spellCheck={false}
        required={!isSegments} style={isSegments ? { display: 'none' } : undefined}
        value={props.script} onChange={event => props.onScriptChange(event.target.value)} onKeyDown={props.onScriptKey} />
      {isSegments && <EditorSegmentView props={props} />}
    </>
  );
}

function EditorFooter({ count, isOverLimit, script, onReplaceScript }) {
  return (
    <div className="editor-footer">
      <span id="character-count" className={isOverLimit ? 'is-limit' : undefined}>
        {count.toLocaleString()} / {MAX_SCRIPT_LENGTH.toLocaleString()} {count === 1 ? 'character' : 'characters'}
      </span>
      <button type="button" className="button subtle-button clear-button" id="clear-script"
        disabled={!script} onClick={() => onReplaceScript('')}>Clear</button>
    </div>
  );
}

/**
 * Renders the text script input area, segment editor toggle, Khmer sample button, character counter, and clear button.
 * Inputs: `{ scriptInput, script, count, isOverLimit, onReplaceScript, onScriptChange, onScriptKey, segmentsPanel, segments, ... }`.
 * Outputs: `<section className="editor">` element.
 * Side effects: updates controlled script state and focuses textarea on example/clear/format actions.
 * Failure modes: none.
 * @param {object} props - Script editor props.
 * @returns {React.ReactElement} Script editor section.
 */
export function ScriptEditor(props) {
  const { script, count, isOverLimit, onReplaceScript, segmentsPanel = null, segments = [], viewMode, onViewModeChange } = props;
  const [localMode, setLocalMode] = useState(viewMode || 'script');
  const effectiveMode = (segments.length === 0) ? 'script' : (viewMode || localMode);
  const handleToggle = mode => (onViewModeChange ? onViewModeChange(mode) : setLocalMode(mode));
  const canFormatNumbers = hasConvertibleKhmerNumbers(script);

  return (
    <section className="editor" aria-labelledby="editor-title">
      <div className="pane-heading">
        <h2 id="editor-title"><label htmlFor="script">Script</label></h2>
        <EditorHeadingActions canFormatNumbers={canFormatNumbers}
          canApplySpelling={props.canApplySpelling} onApplySpelling={props.onApplySpelling}
          script={script}
          onReplaceScript={onReplaceScript} segmentsCount={segments.length}
          effectiveMode={effectiveMode} onToggleMode={handleToggle}
          onRestitchSegments={props.onRestitchSegments}
          onExportNarration={props.onExportNarration}
          hasTakesToRestitch={props.hasTakesToRestitch} disabled={props.disabled} />
      </div>
      <EditorContent props={props} effectiveMode={effectiveMode} />
      <EditorFooter count={count} isOverLimit={isOverLimit} script={script} onReplaceScript={onReplaceScript} />
      {segmentsPanel}
    </section>
  );
}
