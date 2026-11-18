/**
 * @fileoverview Memoized subtitle cue card supporting playback sync, inline timing edits, split/merge/delete, and bilingual reference.
 */

import React, { memo, useEffect, useRef, useState } from 'react';
import {
  MIN_SPLIT_GAP_SEC,
  formatEditableTimestamp,
  formatShortClock,
  getSpeakerColor,
  parseEditableTimestamp,
  resolveSpeakerLabel,
} from '../../domain/subtitles.js';
import { Icon } from './Icon.jsx';

const TIMING_NUDGE_SEC = 0.2;

function SpeakerBadgeSelect({ speakerId, speakers, speakerNames, busy, onChangeSpeaker }) {
  const color = getSpeakerColor(speakerId);
  return (
    <label className="subtitle-speaker-badge" style={{ '--spk-color': color }}>
      <span className="subtitle-speaker-dot" aria-hidden="true" />
      <select
        className="subtitle-speaker-select"
        aria-label="Segment speaker"
        value={speakerId}
        disabled={busy}
        onChange={e => onChangeSpeaker(e.target.value)}
      >
        {(speakers.length ? speakers : [speakerId]).map(id => (
          <option key={id} value={id}>{resolveSpeakerLabel(id, speakerNames)}</option>
        ))}
      </select>
    </label>
  );
}

function resolveTimingCommit(field, raw, segment) {
  const currentVal = field === 'start' ? segment.start : segment.end;
  const isAlreadyValid = Number(segment.end) >= Number(segment.start) + MIN_SPLIT_GAP_SEC;
  if (raw === formatEditableTimestamp(currentVal) && isAlreadyValid) {
    return { valid: true, unchanged: true };
  }
  const parsed = parseEditableTimestamp(raw);
  if (parsed === null) {
    return {
      valid: false,
      startDraft: formatEditableTimestamp(segment.start),
      endDraft: formatEditableTimestamp(segment.end),
    };
  }
  if (field === 'start') {
    const nextStart = Math.max(0, parsed);
    return { valid: true, unchanged: false, patch: { start: nextStart }, startDraft: formatEditableTimestamp(nextStart) };
  }
  const clampedEnd = Math.round(Math.max(segment.start + MIN_SPLIT_GAP_SEC, parsed) * 1000) / 1000;
  return { valid: true, unchanged: false, patch: { end: clampedEnd }, endDraft: formatEditableTimestamp(clampedEnd) };
}

function TimingInlineEditor({ segment, busy, onUpdateTiming }) {
  const [startDraft, setStartDraft] = useState(() => formatEditableTimestamp(segment.start));
  const [endDraft, setEndDraft] = useState(() => formatEditableTimestamp(segment.end));
  const cancellingFieldRef = useRef('');

  useEffect(() => {
    setStartDraft(formatEditableTimestamp(segment.start));
    setEndDraft(formatEditableTimestamp(segment.end));
  }, [segment.start, segment.end]);

  const commitTiming = (field, raw) => {
    const outcome = resolveTimingCommit(field, raw, segment);
    if (outcome.unchanged) return;
    if (!outcome.valid) {
      setStartDraft(outcome.startDraft);
      setEndDraft(outcome.endDraft);
      return;
    }
    if (outcome.startDraft !== undefined) setStartDraft(outcome.startDraft);
    if (outcome.endDraft !== undefined) setEndDraft(outcome.endDraft);
    onUpdateTiming(segment.id, outcome.patch);
  };

  const nudge = delta => {
    const clampedDelta = delta < 0 ? Math.max(delta, -segment.start) : delta;
    onUpdateTiming(segment.id, {
      start: Math.max(0, segment.start + clampedDelta),
      end: Math.max(MIN_SPLIT_GAP_SEC, segment.end + clampedDelta),
    });
  };

  const handleKeyDown = (field, draft, e) => {
    if (e.key === 'Enter') {
      cancellingFieldRef.current = '';
      commitTiming(field, draft);
      return;
    }
    if (e.key === 'Escape') {
      cancellingFieldRef.current = field;
      setStartDraft(formatEditableTimestamp(segment.start));
      setEndDraft(formatEditableTimestamp(segment.end));
      e.currentTarget.blur?.();
    }
  };

  const handleBlur = (field, draft) => {
    if (cancellingFieldRef.current === field) {
      cancellingFieldRef.current = '';
      return;
    }
    cancellingFieldRef.current = '';
    commitTiming(field, draft);
  };

  return (
    <div className="subtitle-timing-bar">
      <label className="subtitle-timing-field">
        <span>Start</span>
        <input
          type="text"
          className="subtitle-timing-input"
          aria-label="Start timestamp"
          value={startDraft}
          disabled={busy}
          onFocus={() => { cancellingFieldRef.current = ''; }}
          onChange={e => { cancellingFieldRef.current = ''; setStartDraft(e.target.value); }}
          onBlur={() => handleBlur('start', startDraft)}
          onKeyDown={e => handleKeyDown('start', startDraft, e)}
        />
      </label>
      <label className="subtitle-timing-field">
        <span>End</span>
        <input
          type="text"
          className="subtitle-timing-input"
          aria-label="End timestamp"
          value={endDraft}
          disabled={busy}
          onFocus={() => { cancellingFieldRef.current = ''; }}
          onChange={e => { cancellingFieldRef.current = ''; setEndDraft(e.target.value); }}
          onBlur={() => handleBlur('end', endDraft)}
          onKeyDown={e => handleKeyDown('end', endDraft, e)}
        />
      </label>
      <button type="button" className="button subtle-button subtitle-nudge-btn" disabled={busy}
        title="Shift cue earlier by 0.2s" onClick={() => nudge(-TIMING_NUDGE_SEC)}>-0.2s</button>
      <button type="button" className="button subtle-button subtitle-nudge-btn" disabled={busy}
        title="Shift cue later by 0.2s" onClick={() => nudge(TIMING_NUDGE_SEC)}>+0.2s</button>
    </div>
  );
}

function SegmentHeaderControls({
  segment,
  speakers,
  speakerNames,
  showSpeakerBadge,
  canMergeNext,
  showTimingEditor,
  busy,
  onToggleTiming,
  onSeek,
  onChangeSpeaker,
  onSplit,
  onMergeNext,
  onDelete,
}) {
  return (
    <header className="subtitle-segment-head">
      <div className="subtitle-segment-meta">
        {showSpeakerBadge && (
          <SpeakerBadgeSelect
            speakerId={segment.speakerId}
            speakers={speakers}
            speakerNames={speakerNames}
            busy={busy}
            onChangeSpeaker={onChangeSpeaker}
          />
        )}
        <button
          type="button"
          className="button subtitle-time-jump"
          title="Jump video to this line"
          onClick={() => onSeek(segment.start)}
        >
          {formatShortClock(segment.start)} - {formatShortClock(segment.end)}
        </button>
      </div>
      <div className="subtitle-segment-actions">
        <button type="button" className="button subtle-button subtitle-cue-btn" disabled={busy}
          aria-expanded={showTimingEditor} title="Edit timestamps" onClick={onToggleTiming}>
          <Icon name="clock" /><span>Time</span>
        </button>
        <button type="button" className="button subtle-button subtitle-cue-btn" disabled={busy}
          title="Split segment" onClick={onSplit}>
          <Icon name="scissors" /><span>Split</span>
        </button>
        <button type="button" className="button subtle-button subtitle-cue-btn" disabled={busy || !canMergeNext}
          title="Merge with next segment" onClick={onMergeNext}>
          <Icon name="merge" /><span>Merge</span>
        </button>
        <button type="button" className="button subtle-button subtitle-cue-btn subtitle-cue-delete" disabled={busy}
          aria-label="Delete segment" title="Delete segment" onClick={onDelete}>
          <Icon name="trash" />
        </button>
      </div>
    </header>
  );
}

function computeSplitRatio(textareaEl, textLength) {
  const pos = Number(textareaEl?.selectionStart);
  if (!Number.isFinite(pos) || pos <= 0 || pos >= textLength || textLength <= 1) return 0.5;
  return pos / textLength;
}

/**
 * Renders one editable subtitle cue card with optional speaker badge, playback sync, timing/split/merge/delete, and bilingual reference.
 * @param {object} props - Segment row props.
 * @returns {React.ReactElement} Memoized subtitle cue card.
 */
export const SubtitleSegmentRow = memo(function SubtitleSegmentRow({
  segment,
  speakers,
  speakerNames,
  useTranslation = false,
  showSpeakerBadge = false,
  isActive = false,
  canMergeNext = false,
  busy = false,
  onSeek,
  onUpdate,
  onUpdateTiming,
  onSplit,
  onMergeNext,
  onDelete,
}) {
  const rowRef = useRef(null);
  const textareaRef = useRef(null);
  const [showTimingEditor, setShowTimingEditor] = useState(false);

  useEffect(() => {
    if (!isActive || !rowRef.current) return;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    if (activeEl && rowRef.current.closest?.('.subtitle-cue-list')?.contains?.(activeEl)) return;
    rowRef.current.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [isActive]);

  const activeText = useTranslation ? (segment.translatedText ?? '') : (segment.text ?? '');
  const showSourceRef = Boolean(
    useTranslation && segment.text?.trim() && segment.text.trim() !== (segment.translatedText || '').trim()
  );
  const rowClass = isActive ? 'subtitle-segment-row is-active' : 'subtitle-segment-row';

  return (
    <article ref={rowRef} className={rowClass} data-segment-id={segment.id} data-active={isActive ? 'true' : undefined}>
      <SegmentHeaderControls
        segment={segment}
        speakers={speakers}
        speakerNames={speakerNames}
        showSpeakerBadge={showSpeakerBadge}
        canMergeNext={canMergeNext}
        showTimingEditor={showTimingEditor}
        busy={busy}
        onToggleTiming={() => setShowTimingEditor(prev => !prev)}
        onSeek={onSeek}
        onChangeSpeaker={speakerId => onUpdate(segment.id, { speakerId })}
        onSplit={() => onSplit?.(segment.id, computeSplitRatio(textareaRef.current, activeText.length))}
        onMergeNext={() => onMergeNext?.(segment.id)}
        onDelete={() => onDelete?.(segment.id)}
      />
      {showTimingEditor && <TimingInlineEditor segment={segment} busy={busy} onUpdateTiming={onUpdateTiming} />}
      {showSourceRef && <p className="subtitle-source-ref" dir="auto">{segment.text}</p>}
      <textarea
        ref={textareaRef}
        className={useTranslation ? 'subtitle-line-input subtitle-line-khmer' : 'subtitle-line-input'}
        rows={2}
        lang={useTranslation ? 'km' : undefined}
        aria-label={useTranslation ? 'Khmer subtitle translation' : 'Subtitle text'}
        value={activeText}
        disabled={busy}
        onChange={e => onUpdate(segment.id, useTranslation ? { translatedText: e.target.value } : { text: e.target.value })}
      />
    </article>
  );
});
