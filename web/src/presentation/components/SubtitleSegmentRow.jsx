/**
 * @fileoverview Memoized subtitle cue card supporting playback sync, inline timing edits, split/merge/delete, and bilingual reference.
 */

import React, { memo, useEffect, useRef, useState } from 'react';
import { Blocks } from 'loading-dev';
import { formatTime } from '../../domain/audioValidation.js';
import { formatVerifyReasonLabel } from '../../domain/speechVerification.js';
import {
  MIN_CUE_DURATION_SEC,
  MIN_SPLIT_GAP_SEC,
  TIMING_NUDGE_COARSE_SEC,
  TIMING_NUDGE_FINE_SEC,
  autoBreakLongLine,
  formatEditableTimestamp,
  formatShortClock,
  getSpeakerColor,
  parseEditableTimestamp,
  resolveSpeakerLabel,
  roundToMs,
  validateCueInterval,
} from '../../domain/subtitles.js';
import { Icon } from './Icon.jsx';

const CUE_VOICE_SPINNER_PX = 12;

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

function checkCurrentTimingValid(segment, mediaDuration) {
  return validateCueInterval({
    start: segment.start,
    end: segment.end,
    minDuration: MIN_CUE_DURATION_SEC,
    maxDuration: mediaDuration,
  }).valid;
}

function resolveCandidateTiming(field, parsed, segment) {
  if (field === 'start') {
    return { start: Math.max(0, parsed), end: segment.end };
  }
  const minEnd = roundToMs(segment.start + MIN_SPLIT_GAP_SEC);
  return { start: segment.start, end: Math.max(minEnd, parsed) };
}

function resolveTimingCommit(field, raw, segment, mediaDuration = null) {
  const currentVal = field === 'start' ? segment.start : segment.end;
  if (raw === formatEditableTimestamp(currentVal) && checkCurrentTimingValid(segment, mediaDuration)) {
    return { valid: true, unchanged: true };
  }
  const parsed = parseEditableTimestamp(raw);
  const cand = parsed !== null ? resolveCandidateTiming(field, parsed, segment) : null;
  const check = cand ? validateCueInterval({ start: cand.start, end: cand.end, minDuration: MIN_CUE_DURATION_SEC, maxDuration: mediaDuration }) : null;
  if (!cand || !check?.valid) {
    return {
      valid: false,
      error: check?.error || 'Invalid timestamp format. Use MM:SS.mmm or SS.s.',
      code: check?.code || 'INVALID_FORMAT',
      startDraft: formatEditableTimestamp(segment.start),
      endDraft: formatEditableTimestamp(segment.end),
    };
  }
  const patch = field === 'start' ? { start: roundToMs(cand.start) } : { end: roundToMs(cand.end) };
  return { valid: true, unchanged: false, patch, startDraft: formatEditableTimestamp(cand.start), endDraft: formatEditableTimestamp(cand.end) };
}

function parseSecondsInput(raw) {
  const cleaned = String(raw || '').replace(/s$/i, '').trim();
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? roundToMs(parsed) : null;
}

function resolveDurationCommit(raw, segment, mediaDuration = null) {
  const parsed = parseSecondsInput(raw);
  if (parsed === null || parsed < MIN_CUE_DURATION_SEC) {
    return { valid: false, error: `Duration must be at least ${MIN_CUE_DURATION_SEC}s.` };
  }
  const candidateEnd = roundToMs(segment.start + parsed);
  const check = validateCueInterval({
    start: segment.start,
    end: candidateEnd,
    minDuration: MIN_CUE_DURATION_SEC,
    maxDuration: mediaDuration,
  });
  if (!check.valid) return { valid: false, error: check.error, code: check.code };
  return { valid: true, patch: { end: candidateEnd } };
}

function resolvePauseCommit(raw) {
  const parsed = parseSecondsInput(raw);
  if (parsed === null || parsed < 0) {
    return { valid: false, error: 'Pause must be a non-negative number of seconds.' };
  }
  return { valid: true, pauseSec: roundToMs(parsed) };
}

function computeCueOverlapAmount(segA, segB) {
  if (!segA || !segB) return 0;
  const start = Math.max(roundToMs(segA.start), roundToMs(segB.start));
  const end = Math.min(roundToMs(segA.end), roundToMs(segB.end));
  return end > start ? roundToMs(end - start) : 0;
}

function computeOverlapWarning(segment, prevSegment, nextSegment) {
  const prevDiff = computeCueOverlapAmount(prevSegment, segment);
  if (prevDiff > 0) return `Overlaps previous cue by ${prevDiff.toFixed(2)}s`;
  const nextDiff = computeCueOverlapAmount(segment, nextSegment);
  if (nextDiff > 0) return `Overlaps next cue by ${nextDiff.toFixed(2)}s`;
  return '';
}

function TimingInputField({ label, ariaLabel, value, disabled, onChange, onBlur, onKeyDown, className = '' }) {
  const inputClass = ['subtitle-timing-input', className].filter(Boolean).join(' ');
  return (
    <label className="subtitle-timing-field">
      <span>{label}</span>
      <input
        type="text"
        className={inputClass}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={onChange}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}

function TimingNudgeButtons({ busy, onNudge }) {
  return (
    <div className="subtitle-timing-nudges">
      <button type="button" className="button subtle-button subtitle-nudge-btn" disabled={busy}
        title="Shift cue earlier by 0.2s" onClick={() => onNudge(-TIMING_NUDGE_COARSE_SEC)}>-0.2s</button>
      <button type="button" className="button subtle-button subtitle-nudge-btn" disabled={busy}
        title="Shift cue later by 0.2s" onClick={() => onNudge(TIMING_NUDGE_COARSE_SEC)}>+0.2s</button>
      <button type="button" className="button subtle-button subtitle-nudge-btn subtitle-nudge-fine" disabled={busy}
        title="Fine shift earlier by 50ms" onClick={() => onNudge(-TIMING_NUDGE_FINE_SEC)}>-0.05s</button>
      <button type="button" className="button subtle-button subtitle-nudge-btn subtitle-nudge-fine" disabled={busy}
        title="Fine shift later by 50ms" onClick={() => onNudge(TIMING_NUDGE_FINE_SEC)}>+0.05s</button>
    </div>
  );
}

function TimingFeedback({ error, overlapNotice, onFixOverlap }) {
  if (!error && !overlapNotice) return null;
  return (
    <div className="subtitle-timing-feedback-row">
      {error && <span className="subtitle-timing-feedback subtitle-timing-error" role="alert">{error}</span>}
      {!error && overlapNotice && (
        <span className="subtitle-timing-feedback subtitle-timing-warning" role="status">
          <span>{overlapNotice}</span>
          {onFixOverlap && (
            <button type="button" className="button subtle-button subtitle-fix-overlap-btn" onClick={onFixOverlap}>
              Fix
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function formatDurationDraft(start, end) {
  return `${Math.max(0, roundToMs(end - start)).toFixed(2)}s`;
}

function formatPauseDraft(seg, nextSeg) {
  if (!nextSeg) return '0.00s';
  return `${roundToMs(nextSeg.start - seg.end).toFixed(2)}s`;
}

function useTimingDrafts(segment, nextSegment) {
  const [startDraft, setStartDraft] = useState(() => formatEditableTimestamp(segment.start));
  const [endDraft, setEndDraft] = useState(() => formatEditableTimestamp(segment.end));
  const [durDraft, setDurDraft] = useState(() => formatDurationDraft(segment.start, segment.end));
  const [pauseDraft, setPauseDraft] = useState(() => formatPauseDraft(segment, nextSegment));
  const [error, setError] = useState('');

  useEffect(() => {
    setStartDraft(formatEditableTimestamp(segment.start));
    setEndDraft(formatEditableTimestamp(segment.end));
    setDurDraft(formatDurationDraft(segment.start, segment.end));
    setPauseDraft(formatPauseDraft(segment, nextSegment));
    setError('');
  }, [segment.id, segment.start, segment.end, nextSegment?.id, nextSegment?.start]);

  return { startDraft, setStartDraft, endDraft, setEndDraft, durDraft, setDurDraft, pauseDraft, setPauseDraft, error, setError };
}

function handleNudgeTiming(segment, delta, onUpdateTiming) {
  const clampedDelta = delta < 0 ? Math.max(delta, -segment.start) : delta;
  const nextStart = Math.max(0, roundToMs(segment.start + clampedDelta));
  const nextEnd = Math.max(roundToMs(nextStart + MIN_SPLIT_GAP_SEC), roundToMs(segment.end + clampedDelta));
  onUpdateTiming(segment.id, { start: nextStart, end: nextEnd });
}

function fixOverlapWithPrev(segment, prevSegment, onUpdateTiming) {
  const minStart = roundToMs(prevSegment.end);
  const minEnd = Math.max(roundToMs(minStart + MIN_SPLIT_GAP_SEC), segment.end);
  onUpdateTiming(segment.id, { start: minStart, end: minEnd });
}

function fixOverlapWithNext(segment, nextSegment, onUpdateTiming) {
  const maxEnd = roundToMs(nextSegment.start);
  const minStart = Math.min(segment.start, Math.max(0, roundToMs(maxEnd - MIN_SPLIT_GAP_SEC)));
  onUpdateTiming(segment.id, { start: minStart, end: maxEnd });
}

function handleFixOverlapAction(segment, prevSegment, nextSegment, onUpdateTiming, conflictingId = null) {
  if (conflictingId && nextSegment?.id === conflictingId) return fixOverlapWithNext(segment, nextSegment, onUpdateTiming);
  if (conflictingId && prevSegment?.id === conflictingId) return fixOverlapWithPrev(segment, prevSegment, onUpdateTiming);
  if (prevSegment && roundToMs(prevSegment.end) > roundToMs(segment.start)) {
    return fixOverlapWithPrev(segment, prevSegment, onUpdateTiming);
  }
  if (nextSegment && roundToMs(segment.end) > roundToMs(nextSegment.start)) {
    return fixOverlapWithNext(segment, nextSegment, onUpdateTiming);
  }
}

function commitMetricField(field, raw, context) {
  const { segment, mediaDuration, drafts, onUpdateTiming, onUpdatePause } = context;
  if (field === 'duration') {
    const outcome = resolveDurationCommit(raw, segment, mediaDuration);
    if (!outcome.valid) return drafts.setError(outcome.error);
    drafts.setError('');
    return onUpdateTiming(segment.id, outcome.patch);
  }
  const outcome = resolvePauseCommit(raw);
  if (!outcome.valid) return drafts.setError(outcome.error);
  drafts.setError('');
  return onUpdatePause?.(segment.id, outcome.pauseSec);
}

function executeTimingCommit(params) {
  const { field, raw, segment, mediaDuration, drafts, onUpdateTiming } = params;
  try {
    if (field === 'duration' || field === 'pause') return commitMetricField(field, raw, params);
    const outcome = resolveTimingCommit(field, raw, segment, mediaDuration);
    if (outcome.unchanged) return drafts.setError('');
    if (outcome.startDraft !== undefined) drafts.setStartDraft(outcome.startDraft);
    if (outcome.endDraft !== undefined) drafts.setEndDraft(outcome.endDraft);
    if (!outcome.valid) return drafts.setError(outcome.error || 'Invalid timestamp.');
    drafts.setError('');
    onUpdateTiming(segment.id, outcome.patch);
  } catch (err) {
    drafts.setError(err?.message || 'Failed to update timing.');
  }
}

function handleTimingKeyDown({ field, draft, e, cancellingRef, drafts, segment, onCommit }) {
  if (e.key === 'Enter') {
    cancellingRef.current = '';
    onCommit(field, draft);
  } else if (e.key === 'Escape') {
    cancellingRef.current = field;
    drafts.setStartDraft(formatEditableTimestamp(segment.start));
    drafts.setEndDraft(formatEditableTimestamp(segment.end));
    drafts.setError('');
    e.currentTarget.blur?.();
  }
}

function TimingFieldsInputs({ drafts, cancellingRef, busy, nextSegment, canPause, onBlur, onKeyDown }) {
  return (
    <>
      <TimingInputField label="Start" ariaLabel="Start timestamp" value={drafts.startDraft} disabled={busy}
        onChange={e => { cancellingRef.current = ''; drafts.setStartDraft(e.target.value); }}
        onBlur={() => onBlur('start', drafts.startDraft)} onKeyDown={e => onKeyDown('start', drafts.startDraft, e)} />
      <TimingInputField label="End" ariaLabel="End timestamp" value={drafts.endDraft} disabled={busy}
        onChange={e => { cancellingRef.current = ''; drafts.setEndDraft(e.target.value); }}
        onBlur={() => onBlur('end', drafts.endDraft)} onKeyDown={e => onKeyDown('end', drafts.endDraft, e)} />
      <TimingInputField label="Duration" ariaLabel="Cue duration" value={drafts.durDraft} disabled={busy} className="subtitle-timing-dur-input"
        onChange={e => { cancellingRef.current = ''; drafts.setDurDraft(e.target.value); }}
        onBlur={() => onBlur('duration', drafts.durDraft)} onKeyDown={e => onKeyDown('duration', drafts.durDraft, e)} />
      {nextSegment && (
        <TimingInputField label="Pause" ariaLabel="Pause to next cue" value={drafts.pauseDraft} disabled={busy || !canPause} className="subtitle-timing-pause-input"
          onChange={e => { cancellingRef.current = ''; drafts.setPauseDraft(e.target.value); }}
          onBlur={() => onBlur('pause', drafts.pauseDraft)} onKeyDown={e => onKeyDown('pause', drafts.pauseDraft, e)} />
      )}
    </>
  );
}

export function TimingInlineEditor({
  segment,
  prevSegment = null,
  nextSegment = null,
  mediaDuration = null,
  busy = false,
  onUpdateTiming,
  onUpdatePause = null,
}) {
  const drafts = useTimingDrafts(segment, nextSegment);
  const cancellingRef = useRef('');
  const overlapNotice = computeOverlapWarning(segment, prevSegment, nextSegment);

  const onCommit = (field, raw) => {
    executeTimingCommit({ field, raw, segment, mediaDuration, drafts, onUpdateTiming, onUpdatePause });
  };
  const onKeyDown = (field, draft, e) => {
    handleTimingKeyDown({ field, draft, e, cancellingRef, drafts, segment, onCommit });
  };
  const onBlur = (field, draft) => {
    if (cancellingRef.current === field) { cancellingRef.current = ''; return; }
    cancellingRef.current = '';
    onCommit(field, draft);
  };

  return (
    <div className="subtitle-timing-bar">
      <TimingFieldsInputs drafts={drafts} cancellingRef={cancellingRef} busy={busy} nextSegment={nextSegment}
        canPause={Boolean(onUpdatePause)} onBlur={onBlur} onKeyDown={onKeyDown} />
      <TimingNudgeButtons busy={busy} onNudge={delta => handleNudgeTiming(segment, delta, onUpdateTiming)} />
      <TimingFeedback error={drafts.error} overlapNotice={overlapNotice}
        onFixOverlap={() => handleFixOverlapAction(segment, prevSegment, nextSegment, onUpdateTiming)} />
    </div>
  );
}

function SegmentHeaderControls({
  segment,
  speakers,
  speakerNames,
  showSpeakerBadge,
  isSelected,
  canMergeNext,
  showTimingEditor,
  busy,
  onToggleSelect,
  onToggleTiming,
  onSeek,
  onChangeSpeaker,
  onSplit,
  onMergeNext,
  onDelete,
}) {
  const timeLabel = `${formatShortClock(segment.start)} - ${formatShortClock(segment.end)}`;
  return (
    <header className="subtitle-segment-head">
      <div className="subtitle-segment-meta">
        {onToggleSelect && (
          <input
            type="checkbox"
            className="subtitle-select-checkbox"
            aria-label={`Select frame ${timeLabel}`}
            checked={Boolean(isSelected)}
            disabled={busy}
            onChange={() => onToggleSelect(segment.id)}
          />
        )}
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
          {timeLabel}
        </button>
        {segment.verifyReason === 'whisper_fallback' && !segment.altText?.trim() && (
          <span className="subtitle-verify-pill" title="Recovered automatically by Whisper Khmer model">
            Whisper recovery
          </span>
        )}
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

function SegmentVoiceBar({
  hasText,
  voiceClip,
  isVoiceStale,
  isGeneratingVoice,
  isPlayingVoice,
  disabled,
  onGenerateVoice,
  onTogglePlayVoice,
  onDownloadVoice,
}) {
  if (!onGenerateVoice) return null;
  const generateLabel = isGeneratingVoice ? 'Generating…' : voiceClip ? 'Regenerate' : 'Generate voice';
  const clipMeta = voiceClip
    ? [voiceClip.characterName, voiceClip.durationSeconds ? formatTime(voiceClip.durationSeconds) : ''].filter(Boolean).join(' · ')
    : '';
  return (
    <div className="subtitle-cue-voice-bar">
      <button
        type="button"
        className="button subtle-button subtitle-cue-btn subtitle-cue-voice-btn"
        disabled={disabled || !hasText}
        aria-busy={isGeneratingVoice || undefined}
        title={hasText ? 'Generate VoxCPM2 voice for this subtitle frame' : 'Add text before generating voice'}
        onClick={onGenerateVoice}
      >
        {isGeneratingVoice ? <Blocks size={CUE_VOICE_SPINNER_PX} className="generate-spinner" /> : <Icon name="waveform" />}
        <span>{generateLabel}</span>
      </button>
      {voiceClip?.url && (
        <div className="subtitle-cue-audio-controls">
          <button
            type="button"
            className={isPlayingVoice ? 'button subtle-button subtitle-cue-btn subtitle-cue-play-btn is-playing' : 'button subtle-button subtitle-cue-btn subtitle-cue-play-btn'}
            aria-label={isPlayingVoice ? 'Pause frame voice' : 'Play frame voice'}
            onClick={onTogglePlayVoice}
          >
            <Icon name={isPlayingVoice ? 'pause_fill' : 'play_fill'} />
            <span>{isPlayingVoice ? 'Pause' : 'Play'}</span>
          </button>
          {clipMeta ? <span className="subtitle-cue-voice-meta">{clipMeta}</span> : null}
          {isVoiceStale ? <span className="subtitle-cue-stale-badge" title="Text or voice changed since generation">Edited</span> : null}
          <button
            type="button"
            className="button subtle-button subtitle-cue-btn"
            aria-label="Download frame voice WAV"
            title="Download frame voice (.wav)"
            onClick={onDownloadVoice}
          >
            <Icon name="arrow_down_to_line" />
          </button>
        </div>
      )}
    </div>
  );
}

function SegmentVerificationBanner({ segment, busy, onApply, onDismiss }) {
  const suggestion = (segment.altText || '').trim();
  const primary = (segment.text || '').trim();
  if (!suggestion || suggestion === primary) return null;
  const label = formatVerifyReasonLabel(segment.verifyReason);
  return (
    <div className="subtitle-verify-banner" role="note">
      <div className="subtitle-verify-body">
        <span className="subtitle-verify-pill">{label}</span>
        <span className="subtitle-verify-text" dir="auto" lang="km">{suggestion}</span>
      </div>
      <div className="subtitle-verify-actions">
        <button type="button" className="button subtle-button subtitle-cue-btn" disabled={busy}
          onClick={onApply}>
          Use suggestion
        </button>
        <button type="button" className="button subtle-button subtitle-cue-btn" disabled={busy}
          aria-label="Dismiss Whisper suggestion" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function resolveRemedyLabel(issue) {
  if (issue.remedyAction === 'resolve_overlap') return 'Fix overlap';
  if (issue.remedyAction === 'split_line') return 'Wrap line';
  if (issue.remedyAction === 'split_segment') return 'Split cue';
  if (issue.remedyAction === 'focus_text' || issue.remedyAction === 'focus_translation') return 'Type text';
  if (issue.remedyAction === 'adjust_timing' || issue.remedyAction === 'extend_duration') return 'Adjust timing';
  if (issue.remedyAction === 'assign_voice') return 'Assign voice';
  return 'Fix';
}

function ValidationAlertPill({ issue, onTriggerRemedy, busy }) {
  const isError = issue.severity === 'error';
  const pillClass = `subtitle-validation-pill is-${isError ? 'error' : 'warning'}`;
  const iconName = isError ? 'alert_circle' : 'warning';
  const remedyLabel = resolveRemedyLabel(issue);
  return (
    <div className={pillClass} role={isError ? 'alert' : 'status'} title={issue.remedyHint || issue.message}>
      <Icon name={iconName} className="subtitle-validation-icon" />
      <span className="subtitle-validation-msg">{issue.message}</span>
      {onTriggerRemedy && (
        <button
          type="button"
          className="button subtle-button subtitle-validation-fix-btn"
          disabled={busy}
          onClick={() => onTriggerRemedy(issue)}
        >
          {remedyLabel}
        </button>
      )}
    </div>
  );
}

function SegmentValidationAlerts({ issues = [], onTriggerRemedy, busy = false }) {
  if (!issues.length) return null;
  return (
    <div className="subtitle-segment-validation-alerts" role="group" aria-label="Cue validation issues">
      {issues.map(issue => (
        <ValidationAlertPill key={issue.id || issue.type} issue={issue} onTriggerRemedy={onTriggerRemedy} busy={busy} />
      ))}
    </div>
  );
}

function executeRemedyAction(issue, context) {
  const { segment, prevSegment, nextSegment, onUpdateTiming, activeText, onUpdate, useTranslation, onSplit, textarea, onOpenTiming, onAssignVoice } = context;
  const action = issue.remedyAction;
  if (action === 'resolve_overlap') {
    return handleFixOverlapAction(segment, prevSegment, nextSegment, onUpdateTiming, issue.metadata?.conflictingSegmentId);
  }
  if (action === 'split_line') {
    const wrapped = autoBreakLongLine(activeText);
    return onUpdate?.(segment.id, useTranslation ? { translatedText: wrapped } : { text: wrapped });
  }
  if (action === 'split_segment') return onSplit?.(segment.id, computeSplitRatio(textarea, activeText.length));
  if (action === 'focus_text' || action === 'focus_translation') return textarea?.focus();
  if (action === 'adjust_timing' || action === 'extend_duration') return onOpenTiming();
  if (action === 'assign_voice') return onAssignVoice?.(segment.id);
}

function resolveRowClass(isActive, isSelected, validationIssues) {
  const hasError = validationIssues.some(iss => iss.severity === 'error');
  const hasWarning = !hasError && validationIssues.some(iss => iss.severity === 'warning');
  return [
    'subtitle-segment-row',
    isActive ? 'is-active' : '',
    isSelected ? 'is-selected' : '',
    hasError ? 'has-validation-error' : '',
    hasWarning ? 'has-validation-warning' : '',
  ].filter(Boolean).join(' ');
}

/**
 * Renders one editable subtitle cue card with selection checkbox, optional speaker badge, playback sync, timing/split/merge/delete, bilingual reference, Whisper second-opinion suggestion, and inline TTS voice bar.
 * @param {object} props - Segment row props.
 * @returns {React.ReactElement} Memoized subtitle cue card.
 */
export const SubtitleSegmentRow = memo(function SubtitleSegmentRow({
  segment,
  prevSegment = null,
  nextSegment = null,
  mediaDuration = null,
  speakers,
  speakerNames,
  useTranslation = false,
  targetLangMeta = null,
  sourceLanguage = '',
  showSpeakerBadge = false,
  isActive = false,
  isSelected = false,
  canMergeNext = false,
  validationIssues = [],
  busy = false,
  voiceClip = null,
  isVoiceStale = false,
  isGeneratingVoice = false,
  isPlayingVoice = false,
  voiceDisabled = false,
  onToggleSelect,
  onSeek,
  onUpdate,
  onUpdateTiming,
  onUpdatePause = null,
  onSplit,
  onMergeNext,
  onDelete,
  onApplySuggestion,
  onDismissSuggestion,
  onGenerateVoice,
  onTogglePlayVoice,
  onDownloadVoice,
  onAssignVoice = null,
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
  const rowClass = resolveRowClass(isActive, isSelected, validationIssues);
  const targetShortLabel = targetLangMeta?.shortLabel || 'Khmer';
  const isKhmerDisplay = useTranslation ? (targetLangMeta ? Boolean(targetLangMeta.isKhmer) : true) : sourceLanguage === 'km';
  const activeLang = useTranslation ? (targetLangMeta?.bcp47 || 'km') : (sourceLanguage && sourceLanguage !== 'auto' ? sourceLanguage : undefined);

  const handleTriggerRemedy = (issue) => {
    if (!issue) return;
    executeRemedyAction(issue, {
      segment,
      prevSegment,
      nextSegment,
      onUpdateTiming,
      activeText,
      onUpdate,
      useTranslation,
      onSplit,
      textarea: textareaRef.current,
      onOpenTiming: () => setShowTimingEditor(true),
      onAssignVoice,
    });
  };

  return (
    <article
      ref={rowRef}
      className={rowClass}
      data-segment-id={segment.id}
      data-active={isActive ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
    >
      <SegmentHeaderControls
        segment={segment}
        speakers={speakers}
        speakerNames={speakerNames}
        showSpeakerBadge={showSpeakerBadge}
        isSelected={isSelected}
        canMergeNext={canMergeNext}
        showTimingEditor={showTimingEditor}
        busy={busy}
        onToggleSelect={onToggleSelect}
        onToggleTiming={() => setShowTimingEditor(prev => !prev)}
        onSeek={onSeek}
        onChangeSpeaker={speakerId => onUpdate(segment.id, { speakerId })}
        onSplit={() => onSplit?.(segment.id, computeSplitRatio(textareaRef.current, activeText.length))}
        onMergeNext={() => onMergeNext?.(segment.id)}
        onDelete={() => onDelete?.(segment.id)}
      />
      <SegmentValidationAlerts
        issues={validationIssues}
        onTriggerRemedy={handleTriggerRemedy}
        busy={busy}
      />
      {showTimingEditor && (
        <TimingInlineEditor
          segment={segment}
          prevSegment={prevSegment}
          nextSegment={nextSegment}
          mediaDuration={mediaDuration}
          busy={busy}
          onUpdateTiming={onUpdateTiming}
          onUpdatePause={onUpdatePause}
        />
      )}
      {showSourceRef && <p className="subtitle-source-ref" dir="auto">{segment.text}</p>}
      <textarea
        ref={textareaRef}
        className={isKhmerDisplay ? 'subtitle-line-input subtitle-line-khmer' : 'subtitle-line-input'}
        rows={2}
        dir="auto"
        lang={activeLang}
        aria-label={useTranslation ? `${targetShortLabel} subtitle translation` : 'Subtitle text'}
        value={activeText}
        disabled={busy}
        onChange={e => onUpdate(segment.id, useTranslation ? { translatedText: e.target.value } : { text: e.target.value })}
      />
      {!useTranslation && (
        <SegmentVerificationBanner
          segment={segment}
          busy={busy}
          onApply={() => onApplySuggestion?.(segment.id)}
          onDismiss={() => onDismissSuggestion?.(segment.id)}
        />
      )}
      <SegmentVoiceBar
        hasText={Boolean(activeText.trim())}
        voiceClip={voiceClip}
        isVoiceStale={isVoiceStale}
        isGeneratingVoice={isGeneratingVoice}
        isPlayingVoice={isPlayingVoice}
        disabled={busy || voiceDisabled}
        onGenerateVoice={onGenerateVoice ? () => onGenerateVoice(segment) : null}
        onTogglePlayVoice={onTogglePlayVoice ? () => onTogglePlayVoice(segment.id) : null}
        onDownloadVoice={onDownloadVoice ? () => onDownloadVoice(segment) : null}
      />
    </article>
  );
});
