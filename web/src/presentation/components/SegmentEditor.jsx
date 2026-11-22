/**
 * @fileoverview Structured segment editor component with status badges, pause controls, and segment actions.
 */

import React, { useCallback, useRef } from 'react';
import {
  MAX_PAUSE_SECONDS,
  countGraphemeClusters,
  getSegmentActiveTake,
  hasSegmentAudio,
} from '../../domain/projectSegments.js';
import { Icon } from './Icon.jsx';

const DEFAULT_CARD_ROWS = 2;
const MIN_PAUSE_STEP = '0.1';
const MIN_SPLIT_GRAPHEMES = 2;

function SegmentIndexBadge({ index }) {
  return <span className="segment-index-badge">#{index + 1}</span>;
}

function SegmentStatusBadge({ status }) {
  return (
    <span className={`segment-status-badge status-${status}`} aria-label={`Status: ${status}`}>
      {status}
    </span>
  );
}

function SegmentDurationBadge({ duration }) {
  if (typeof duration !== 'number' || duration <= 0) return null;
  return (
    <span className="segment-duration-badge" title={`Duration: ${duration.toFixed(1)}s`}>
      {duration.toFixed(1)}s
    </span>
  );
}

function SegmentVoiceBadge({ voiceName }) {
  if (!voiceName) return null;
  return (
    <span className="segment-voice-badge" title={`Voice: ${voiceName}`}>
      {voiceName}
    </span>
  );
}

function SegmentVoiceSelect({ segment, index, voices, disabled, onUpdate, defaultVoiceId }) {
  const currentVoiceId = segment.voiceId || defaultVoiceId || (voices[0]?.id ?? '');
  const onChange = event => {
    event.stopPropagation();
    const nextVoiceId = event.target.value;
    const matched = voices.find(v => v.id === nextVoiceId);
    onUpdate?.(segment.id, { voiceId: nextVoiceId, speakerId: nextVoiceId, speakerName: matched?.name || null });
  };
  return (
    <div className="segment-voice-picker">
      <select id={`segment-voice-${segment.id}`} className="segment-voice-select"
        aria-label={`Voice for segment #${index + 1}`} value={currentVoiceId}
        disabled={disabled} onClick={event => event.stopPropagation()} onChange={onChange}>
        {voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name || voice.id}</option>)}
      </select>
    </div>
  );
}

function SegmentVoiceSelector(props) {
  const { segment, index, voices, disabled, onUpdate, defaultVoiceId } = props;
  if (Array.isArray(voices) && voices.length > 0) {
    return (
      <SegmentVoiceSelect segment={segment} index={index} voices={voices}
        disabled={disabled} onUpdate={onUpdate} defaultVoiceId={defaultVoiceId} />
    );
  }
  const displayVoice = segment?.speakerName || segment?.speaker || segment?.voiceId;
  return <SegmentVoiceBadge voiceName={displayVoice} />;
}

function SegmentTakePlayButton({ isPlaying, onTogglePlay, disabled, takeNumber }) {
  const label = isPlaying ? `Stop Take ${takeNumber}` : `Play Take ${takeNumber}`;
  const onClick = event => { event.stopPropagation(); onTogglePlay(); };
  return (
    <button type="button" className={`button icon-button segment-take-play-btn ${isPlaying ? 'is-playing' : ''}`}
      title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name={isPlaying ? 'stop_fill' : 'play_fill'} />
    </button>
  );
}

function SegmentTakeDeleteButton({ onDelete, disabled, takeNumber }) {
  if (!onDelete) return null;
  const label = `Delete Take ${takeNumber}`;
  const onClick = event => { event.stopPropagation(); onDelete(); };
  return (
    <button type="button" className="button icon-button segment-take-delete-btn"
      title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name="close" />
    </button>
  );
}

function formatTakeTooltip(settings) {
  if (!settings || typeof settings !== 'object') return 'Take audio';
  const parts = [];
  if (settings.seed != null) parts.push(`Seed: ${settings.seed}`);
  if (settings.guidance != null) parts.push(`CFG: ${settings.guidance}`);
  if (settings.steps != null) parts.push(`Steps: ${settings.steps}`);
  if (settings.styleMode) parts.push(`Mode: ${settings.styleMode}`);
  return parts.length > 0 ? parts.join(' · ') : 'Take audio';
}

function SegmentTakeChip(props) {
  const { take, takeIndex, isPlaying, disabled, onSelect, onTogglePlay, onDelete } = props;
  const takeNumber = takeIndex + 1;
  const isSelected = Boolean(take.isSelected);
  const title = formatTakeTooltip(take.settings);
  const onChipClick = () => { if (!isSelected && onSelect) onSelect(); };

  return (
    <div className={`segment-take-chip ${isSelected ? 'is-selected' : ''}`}
      role="button" tabIndex={0} aria-pressed={isSelected}
      aria-label={`Take ${takeNumber}${isSelected ? ' (active)' : ''}`}
      title={title} onClick={onChipClick}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onChipClick(); } }}>
      <SegmentTakePlayButton isPlaying={isPlaying} onTogglePlay={onTogglePlay} disabled={disabled} takeNumber={takeNumber} />
      <span className="segment-take-label">Take {takeNumber}</span>
      {take.duration > 0 && <span className="segment-take-duration">{take.duration.toFixed(1)}s</span>}
      {isSelected && <span className="segment-take-active-badge" title="Active take used in speech">Active</span>}
      <SegmentTakeDeleteButton onDelete={onDelete} disabled={disabled} takeNumber={takeNumber} />
    </div>
  );
}

function SegmentTakesTray(props) {
  const { segment, disabled, playingTakeId, onSelectTake, onTogglePlayTake, onDeleteTake } = props;
  const takes = Array.isArray(segment.takes) ? segment.takes : [];
  if (takes.length === 0) return null;

  return (
    <div className="segment-takes-tray" role="group" aria-label={`Takes for segment #${props.index + 1}`}>
      <span className="segment-takes-label">Takes ({takes.length}):</span>
      <div className="segment-takes-list">
        {takes.map((take, idx) => (
          <SegmentTakeChip
            key={take.id}
            take={take}
            takeIndex={idx}
            isPlaying={playingTakeId === take.id}
            disabled={disabled}
            onSelect={onSelectTake ? () => onSelectTake(segment.id, take.id) : null}
            onTogglePlay={onTogglePlayTake ? () => onTogglePlayTake(segment.id, take.id) : null}
            onDelete={onDeleteTake ? () => onDeleteTake(segment.id, take.id) : null}
          />
        ))}
      </div>
    </div>
  );
}

function SegmentPlayButton({ isPlaying, onTogglePlay, disabled, hasAudio }) {
  if (!onTogglePlay || !hasAudio) return null;
  const label = isPlaying ? 'Stop preview' : 'Play audio';
  const onClick = event => { event.stopPropagation(); onTogglePlay(); };
  return (
    <button type="button" className={`button icon-button segment-action-btn segment-play-btn ${isPlaying ? 'is-playing' : ''}`}
      title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name={isPlaying ? 'stop_fill' : 'play_fill'} />
    </button>
  );
}

function SegmentGenerateButton({ index, isGenerating, isReady, disabled, onGenerate, hasText }) {
  if (!onGenerate) return null;
  const title = isGenerating ? 'Generating audio…' : isReady ? 'Regenerate segment' : 'Generate segment';
  const ariaLabel = `${isReady ? 'Regenerate' : 'Generate'} segment #${index + 1} audio`;
  const isDisabled = disabled || isGenerating || !hasText;
  const icon = isGenerating ? <Icon name="refresh" className="spinning" /> : (isReady ? <Icon name="refresh" /> : <Icon name="sparkles" />);
  const onClick = event => { event.stopPropagation(); onGenerate(); };
  return (
    <button type="button" className={`button icon-button segment-action-btn segment-generate-btn ${isGenerating ? 'is-busy' : ''}`}
      title={title} aria-label={ariaLabel} disabled={isDisabled} onClick={onClick}>
      {icon}
    </button>
  );
}

function SegmentMoveUpButton({ index, onMoveUp, disabled }) {
  if (!onMoveUp) return null;
  const isDisabled = disabled || index === 0;
  const onClick = event => { event.stopPropagation(); onMoveUp(); };
  return (
    <button type="button" className="button icon-button segment-action-btn segment-move-up-btn"
      title={index === 0 ? 'Already at top' : 'Move up'} aria-label={`Move segment #${index + 1} up`}
      disabled={isDisabled} onClick={onClick}>
      <Icon name="chevron_up" />
    </button>
  );
}

function SegmentMoveDownButton({ index, totalCount, onMoveDown, disabled }) {
  if (!onMoveDown) return null;
  const isDisabled = disabled || index >= totalCount - 1;
  const onClick = event => { event.stopPropagation(); onMoveDown(); };
  return (
    <button type="button" className="button icon-button segment-action-btn segment-move-down-btn"
      title={index >= totalCount - 1 ? 'Already at bottom' : 'Move down'} aria-label={`Move segment #${index + 1} down`}
      disabled={isDisabled} onClick={onClick}>
      <Icon name="chevron_down" />
    </button>
  );
}

function SegmentSplitButton({ index, onSplit, disabled, canSplit }) {
  if (!onSplit) return null;
  const isSplitDisabled = disabled || !canSplit;
  const onClick = event => { event.stopPropagation(); onSplit(); };
  return (
    <button type="button" className="button icon-button segment-action-btn segment-split-btn"
      title={canSplit ? 'Split at cursor' : 'Text too short to split'}
      aria-label={`Split segment #${index + 1} at cursor`}
      disabled={isSplitDisabled} onClick={onClick}>
      <Icon name="scissors" />
    </button>
  );
}

function SegmentMergeButton({ index, totalCount, onMerge, disabled }) {
  if (!onMerge) return null;
  const isDisabled = disabled || index >= totalCount - 1;
  const onClick = event => { event.stopPropagation(); onMerge(); };
  return (
    <button type="button" className="button icon-button segment-action-btn segment-merge-btn"
      title={index >= totalCount - 1 ? 'Cannot merge last segment' : 'Merge with next segment'}
      aria-label={`Merge segment #${index + 1} with next`}
      disabled={isDisabled} onClick={onClick}>
      <Icon name="merge" />
    </button>
  );
}

function SegmentAddButton({ index, onAdd, disabled }) {
  if (!onAdd) return null;
  const onClick = event => { event.stopPropagation(); onAdd(); };
  return (
    <button type="button" className="button icon-button segment-action-btn segment-add-btn"
      title="Add segment below" aria-label={`Add segment after #${index + 1}`}
      disabled={disabled} onClick={onClick}>
      <Icon name="add" />
    </button>
  );
}

function SegmentDeleteButton({ index, totalCount, onDelete, disabled }) {
  if (!onDelete) return null;
  const isDeleteDisabled = disabled || totalCount <= 1;
  const onClick = event => { event.stopPropagation(); onDelete(); };
  return (
    <button type="button" className="button icon-button segment-action-btn segment-delete-btn"
      title={totalCount <= 1 ? 'Cannot delete only segment' : 'Delete segment'}
      aria-label={`Delete segment #${index + 1}`}
      disabled={isDeleteDisabled} onClick={onClick}>
      <Icon name="close" />
    </button>
  );
}

function SegmentActionButtons(props) {
  return (
    <div className="segment-card-actions" role="toolbar" aria-label={`Segment #${props.index + 1} actions`}>
      <SegmentPlayButton isPlaying={props.isPlaying} onTogglePlay={props.onTogglePlay} disabled={props.disabled} hasAudio={props.hasAudio} />
      <SegmentGenerateButton index={props.index} isGenerating={props.isGenerating} isReady={props.status === 'ready'} disabled={props.disabled} onGenerate={props.onGenerate} hasText={props.hasText} />
      <SegmentMoveUpButton index={props.index} onMoveUp={props.onMoveUp} disabled={props.disabled} />
      <SegmentMoveDownButton index={props.index} totalCount={props.totalCount} onMoveDown={props.onMoveDown} disabled={props.disabled} />
      <SegmentSplitButton index={props.index} onSplit={props.onSplit} disabled={props.disabled} canSplit={props.canSplit} />
      <SegmentMergeButton index={props.index} totalCount={props.totalCount} onMerge={props.onMerge} disabled={props.disabled} />
      <SegmentAddButton index={props.index} onAdd={props.onAdd} disabled={props.disabled} />
      <SegmentDeleteButton index={props.index} totalCount={props.totalCount} onDelete={props.onDelete} disabled={props.disabled} />
    </div>
  );
}

function SegmentCardHeader(props) {
  return (
    <div className="segment-card-header">
      <div className="segment-header-left">
        <SegmentIndexBadge index={props.index} />
        <SegmentVoiceSelector segment={props.segment} index={props.index} voices={props.voices}
          disabled={props.disabled} onUpdate={props.onUpdate} defaultVoiceId={props.defaultVoiceId} />
        <SegmentStatusBadge status={props.status} />
        <SegmentDurationBadge duration={props.duration} />
      </div>
      <div className="segment-header-right">
        <span className="segment-char-count">{props.count.toLocaleString()} chars</span>
        <SegmentActionButtons {...props} />
      </div>
    </div>
  );
}

function parseClampedPause(raw) {
  if (raw === '') return null;
  const num = Number(raw);
  const clamped = Math.min(MAX_PAUSE_SECONDS, Math.max(0, Math.round(num * 10) / 10));
  return clamped <= 0 ? null : clamped;
}

function SegmentPauseControl({ segmentId, pauseDuration, disabled, onUpdate }) {
  const handleChange = event => {
    onUpdate(segmentId, { pauseDuration: parseClampedPause(event.target.value) });
  };
  return (
    <div className="segment-card-footer">
      <label className="segment-pause-control" htmlFor={`segment-pause-${segmentId}`}>
        <span className="segment-pause-label">Pause after:</span>
        <input id={`segment-pause-${segmentId}`} type="number" className="segment-pause-input"
          min="0" max={MAX_PAUSE_SECONDS} step={MIN_PAUSE_STEP} placeholder="0"
          disabled={disabled} value={pauseDuration ?? ''} onChange={handleChange} />
        <span className="segment-pause-unit">s</span>
      </label>
    </div>
  );
}

function handleTextareaReorder(event, { index, totalCount, onMoveUp, onMoveDown }) {
  const isUp = event.key === 'ArrowUp' && (event.altKey || (event.shiftKey && (event.ctrlKey || event.metaKey)));
  const isDown = event.key === 'ArrowDown' && (event.altKey || (event.shiftKey && (event.ctrlKey || event.metaKey)));
  if (isUp && index > 0 && onMoveUp) {
    event.preventDefault();
    onMoveUp();
    return true;
  }
  if (isDown && index < totalCount - 1 && onMoveDown) {
    event.preventDefault();
    onMoveDown();
    return true;
  }
  return false;
}

function handleTextareaSplit(event, onSplit, canSplit) {
  const isSplitKey = (event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 's' || event.key === 'S' || event.key === 'Enter');
  if (isSplitKey && onSplit && canSplit) {
    event.preventDefault();
    onSplit(event.target.selectionStart);
    return true;
  }
  return false;
}

function handleTextareaFocusNav(event, { index, totalCount, onFocusIndex }) {
  const isNavKey = !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey;
  if (event.key === 'ArrowUp' && event.target.selectionStart === 0 && isNavKey) {
    if (index > 0) {
      event.preventDefault();
      onFocusIndex(index - 1);
      return true;
    }
  }
  if (event.key === 'ArrowDown' && event.target.selectionEnd === event.target.value.length && isNavKey) {
    if (index < totalCount - 1) {
      event.preventDefault();
      onFocusIndex(index + 1);
      return true;
    }
  }
  return false;
}

function handleSegmentTextareaKey(event, ctx) {
  if (handleTextareaReorder(event, ctx)) return;
  if (handleTextareaSplit(event, ctx.onSplit, ctx.canSplit)) return;
  if (handleTextareaFocusNav(event, ctx)) return;
  if (event.key === 'Escape') {
    event.target.blur();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'Enter') {
    if (ctx.onGenerate) {
      event.preventDefault();
      ctx.onGenerate();
      return;
    }
    ctx.onScriptKey?.(event);
  }
}

function SegmentCardBody(props) {
  const { segment, index, totalCount, textareaRef, onFocusIndex, onUpdate, onMoveUp, onMoveDown, onSplit, canSplit, disabled, onScriptKey, onGenerate } = props;
  const onKeyDown = event => handleSegmentTextareaKey(event, {
    index, totalCount, onMoveUp, onMoveDown, onSplit, canSplit, onFocusIndex, onScriptKey, onGenerate,
  });
  return (
    <div className="segment-card-body">
      <textarea ref={textareaRef} id={`segment-text-${segment.id}`} className="segment-textarea"
        aria-label={`Segment ${index + 1} script text`} placeholder="Enter segment text…"
        value={segment.text || ''} disabled={disabled} rows={DEFAULT_CARD_ROWS} spellCheck={false}
        onChange={event => onUpdate(segment.id, { text: event.target.value })} onKeyDown={onKeyDown} />
      <SegmentPauseControl segmentId={segment.id} pauseDuration={segment.pauseDuration} disabled={disabled} onUpdate={onUpdate} />
    </div>
  );
}

function handleCardReorder(event, { index, totalCount, onMoveUp, onMoveDown }) {
  const isUp = event.key === 'ArrowUp' && (event.altKey || (event.shiftKey && (event.ctrlKey || event.metaKey)));
  const isDown = event.key === 'ArrowDown' && (event.altKey || (event.shiftKey && (event.ctrlKey || event.metaKey)));
  if (isUp && index > 0 && onMoveUp) {
    event.preventDefault();
    onMoveUp();
    return true;
  }
  if (isDown && index < totalCount - 1 && onMoveDown) {
    event.preventDefault();
    onMoveDown();
    return true;
  }
  return false;
}

function handleCardKey(event, ctx) {
  if (event.target !== event.currentTarget) return;
  if (handleCardReorder(event, ctx)) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    ctx.textareaEl?.focus();
  } else if (event.key === 'ArrowDown' && ctx.index < ctx.totalCount - 1) {
    event.preventDefault();
    ctx.onFocusIndex(ctx.index + 1);
  } else if (event.key === 'ArrowUp' && ctx.index > 0) {
    event.preventDefault();
    ctx.onFocusIndex(ctx.index - 1);
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && ctx.onDelete && ctx.totalCount > 1) {
    event.preventDefault();
    ctx.onDelete();
  }
}

function resolveSplitOffset(cursor, textareaEl, text) {
  if (typeof cursor === 'number' && !Number.isNaN(cursor)) {
    return cursor;
  }
  const selStart = textareaEl?.selectionStart;
  const len = typeof text === 'string' ? text.length : 0;
  if (typeof selStart === 'number' && selStart > 0 && selStart < len) {
    return selStart;
  }
  return Math.floor(len / 2);
}

function useSegmentCardHandlers(props, localTextareaRef) {
  const { segment, index, totalCount, onFocusIndex, onMoveUp, onMoveDown, onSplit, onDelete, textareaRef } = props;
  const cardDelete = onDelete ? () => onDelete(segment.id) : null;
  const onKeyDown = event => handleCardKey(event, { index, totalCount, onFocusIndex, textareaEl: localTextareaRef.current, onDelete: cardDelete, onMoveUp, onMoveDown });
  const handleSplitClick = onSplit ? cursor => onSplit(segment.id, resolveSplitOffset(cursor, localTextareaRef.current, segment.text)) : null;
  const handleMountTextarea = useCallback(el => {
    localTextareaRef.current = el;
    textareaRef?.(el);
  }, [textareaRef]);
  return { cardDelete, onKeyDown, handleSplitClick, handleMountTextarea };
}

function resolveCardAudioState(segment, props) {
  const activeTake = getSegmentActiveTake(segment);
  return {
    duration: activeTake?.duration ?? null,
    hasAudio: hasSegmentAudio(segment),
    isGenerating: props.generatingSegmentId === segment.id,
    isPlaying: props.playingSegmentId === segment.id,
    hasText: Boolean((segment.text || '').trim()),
    onGenerate: props.onGenerateSegment ? () => props.onGenerateSegment(segment.id) : null,
    onTogglePlay: props.onTogglePlaySegment ? () => props.onTogglePlaySegment(segment.id) : null,
  };
}

function SegmentCard(props) {
  const { segment, index, totalCount, isSelected, onSelect, onFocusIndex, onUpdate, onMoveUp, onMoveDown, onAdd, disabled, onScriptKey, voices, defaultVoiceId } = props;
  const localTextareaRef = useRef(null);
  const { cardDelete, onKeyDown, handleSplitClick, handleMountTextarea } = useSegmentCardHandlers(props, localTextareaRef);
  const audioState = resolveCardAudioState(segment, props);
  const count = countGraphemeClusters(segment.text);
  const canSplit = count >= MIN_SPLIT_GRAPHEMES;

  return (
    <div className={`segment-card status-${segment.status} ${isSelected ? 'is-selected' : ''}`}
      data-segment-id={segment.id} onClick={() => onSelect?.(segment.id)}
      onKeyDown={onKeyDown} tabIndex={0} role="group" aria-label={`Segment ${index + 1}: ${segment.status}`}>
      <SegmentCardHeader index={index} totalCount={totalCount} status={segment.status} count={count}
        segment={segment} voices={voices} defaultVoiceId={defaultVoiceId} onUpdate={onUpdate}
        onMoveUp={onMoveUp} onMoveDown={onMoveDown} onSplit={handleSplitClick} onMerge={props.onMerge}
        onAdd={onAdd ? () => onAdd(segment.id) : null} onDelete={cardDelete} disabled={disabled} canSplit={canSplit}
        {...audioState} />
      <SegmentCardBody segment={segment} index={index} totalCount={totalCount} textareaRef={handleMountTextarea}
        onFocusIndex={onFocusIndex} onUpdate={onUpdate} onMoveUp={onMoveUp} onMoveDown={onMoveDown}
        onSplit={handleSplitClick} canSplit={canSplit} disabled={disabled} onScriptKey={onScriptKey}
        onGenerate={audioState.onGenerate} />
      <SegmentTakesTray segment={segment} index={index} disabled={disabled}
        playingTakeId={props.playingTakeId} onSelectTake={props.onSelectSegmentTake}
        onTogglePlayTake={props.onTogglePlayTake} onDeleteTake={props.onDeleteSegmentTake} />
    </div>
  );
}

function SegmentEditorEmpty({ onAdd }) {
  return (
    <div className="segment-editor-empty" role="status">
      <p>No segments available. Enter text in the script editor to generate segments.</p>
      {onAdd && (
        <button type="button" className="button subtle-button" onClick={() => onAdd(null)}>
          + Add segment
        </button>
      )}
    </div>
  );
}

function renderSegmentCard(segment, index, props, total) {
  const isSelected = props.activeSegmentId === segment.id;
  const setRef = el => { props.textareaRefs.current[segment.id] = el; };
  const onMoveUp = props.onMoveSegmentUp ? () => props.onMoveSegmentUp(segment.id) : (props.onReorderSegments ? () => props.onReorderSegments(index, index - 1) : null);
  const onMoveDown = props.onMoveSegmentDown ? () => props.onMoveSegmentDown(segment.id) : (props.onReorderSegments ? () => props.onReorderSegments(index, index + 1) : null);
  const onMerge = props.onMergeSegment ? () => props.onMergeSegment(segment.id) : null;
  const voices = props.voices || props.characters || [];
  return (
    <SegmentCard
      key={segment.id} segment={segment} index={index} totalCount={total} isSelected={isSelected}
      textareaRef={setRef} onSelect={props.onSelectSegment} onFocusIndex={props.onFocusIndex}
      onUpdate={props.onUpdateSegment} onMoveUp={onMoveUp} onMoveDown={onMoveDown}
      onSplit={props.onSplitSegment} onMerge={onMerge} onAdd={props.onAddSegment}
      onDelete={props.onDeleteSegment} disabled={props.disabled} onScriptKey={props.onScriptKey}
      onGenerateSegment={props.onGenerateSegment} onTogglePlaySegment={props.onTogglePlaySegment}
      generatingSegmentId={props.generatingSegmentId} playingSegmentId={props.playingSegmentId}
      onSelectSegmentTake={props.onSelectSegmentTake} onDeleteSegmentTake={props.onDeleteSegmentTake}
      onTogglePlayTake={props.onTogglePlayTake} playingTakeId={props.playingTakeId}
      voices={voices} defaultVoiceId={props.defaultVoiceId}
    />
  );
}

function SegmentCardsList(props) {
  const { segments } = props;
  return (
    <div className="segment-editor-list" role="region" aria-label="Structured script segments">
      {segments.map((seg, idx) => renderSegmentCard(seg, idx, props, segments.length))}
    </div>
  );
}

/**
 * Structured segment editor component presenting an ordered list of editable segments with management controls.
 * Inputs: `{ segments, activeSegmentId, onSelectSegment, onUpdateSegment, onAddSegment, onDeleteSegment, onMoveSegmentUp, onMoveSegmentDown, onMergeSegment, onSplitSegment, onReorderSegments, disabled, onScriptKey }`.
 * Outputs: `<div className="segment-editor-list">` container.
 * Side effects: focuses textareas on keyboard navigation.
 * Failure modes: renders empty placeholder if segments list is empty.
 * @param {object} props - Component props.
 * @returns {React.ReactElement} Segment editor list.
 */
export function SegmentEditor(props) {
  const { segments = [], onSelectSegment, onAddSegment } = props;
  const textareaRefs = useRef({});
  const handleFocusIndex = useCallback(targetIndex => {
    const target = segments[targetIndex];
    if (target) {
      textareaRefs.current[target.id]?.focus();
      onSelectSegment?.(target.id);
    }
  }, [segments, onSelectSegment]);

  if (!segments || segments.length === 0) {
    return <SegmentEditorEmpty onAdd={onAddSegment} />;
  }
  return <SegmentCardsList {...props} textareaRefs={textareaRefs} onFocusIndex={handleFocusIndex} />;
}
