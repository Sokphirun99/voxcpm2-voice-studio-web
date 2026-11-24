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
  formatEditableTimestamp,
  formatShortClock,
  getSpeakerColor,
  parseEditableTimestamp,
  resolveSpeakerLabel,
  roundToMs,
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
      error: 'Invalid timestamp format. Use MM:SS.mmm or SS.s.',
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

function parseSecondsInput(raw) {
  const cleaned = String(raw || '').replace(/s$/i, '').trim();
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? roundToMs(parsed) : null;
}

function resolveDurationCommit(raw, segment) {
  const parsed = parseSecondsInput(raw);
  if (parsed === null || parsed < MIN_CUE_DURATION_SEC) {
    return { valid: false, error: `Duration must be at least ${MIN_CUE_DURATION_SEC}s.` };
  }
  return { valid: true, patch: { end: roundToMs(segment.start + parsed) } };
}

function resolvePauseCommit(raw) {
  const parsed = parseSecondsInput(raw);
  if (parsed === null || parsed < 0) {
    return { valid: false, error: 'Pause must be a positive number of seconds.' };
  }
  return { valid: true, pauseSec: roundToMs(parsed) };
}

function computeOverlapWarning(segment, prevSegment, nextSegment) {
  if (prevSegment && roundToMs(prevSegment.end) > roundToMs(segment.start)) {
    const diff = roundToMs(prevSegment.end - segment.start);
    return `Overlaps previous cue by ${diff.toFixed(2)}s`;
  }
  if (nextSegment && roundToMs(segment.end) > roundToMs(nextSegment.start)) {
    const diff = roundToMs(segment.end - nextSegment.start);
    return `Overlaps next cue by ${diff.toFixed(2)}s`;
  }
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

function useTimingDrafts(segment, nextSegment) {
  const [startDraft, setStartDraft] = useState(() => formatEditableTimestamp(segment.start));
  const [endDraft, setEndDraft] = useState(() => formatEditableTimestamp(segment.end));
  const durVal = Math.max(0, roundToMs(segment.end - segment.start));
  const [durDraft, setDurDraft] = useState(() => `${durVal.toFixed(2)}s`);
  const pauseVal = nextSegment ? roundToMs(nextSegment.start - segment.end) : 0;
  const [pauseDraft, setPauseDraft] = useState(() => `${pauseVal.toFixed(2)}s`);
  const [error, setError] = useState('');

  useEffect(() => {
    setStartDraft(formatEditableTimestamp(segment.start));
    setEndDraft(formatEditableTimestamp(segment.end));
    const nextDur = Math.max(0, roundToMs(segment.end - segment.start));
    setDurDraft(`${nextDur.toFixed(2)}s`);
    if (nextSegment) {
      const nextPause = roundToMs(nextSegment.start - segment.end);
      setPauseDraft(`${nextPause.toFixed(2)}s`);
    }
    setError('');
  }, [segment.start, segment.end, nextSegment?.start]);

  return { startDraft, setStartDraft, endDraft, setEndDraft, durDraft, setDurDraft, pauseDraft, setPauseDraft, error, setError };
}

function handleNudgeTiming(segment, delta, onUpdateTiming) {
  const clampedDelta = delta < 0 ? Math.max(delta, -segment.start) : delta;
  const nextStart = Math.max(0, roundToMs(segment.start + clampedDelta));
  const nextEnd = Math.max(roundToMs(nextStart + MIN_SPLIT_GAP_SEC), roundToMs(segment.end + clampedDelta));
  onUpdateTiming(segment.id, { start: nextStart, end: nextEnd });
}

function handleFixOverlapAction(segment, prevSegment, nextSegment, onUpdateTiming) {
  if (prevSegment && roundToMs(prevSegment.end) > roundToMs(segment.start)) {
    const minStart = roundToMs(prevSegment.end);
    const minEnd = Math.max(roundToMs(minStart + MIN_SPLIT_GAP_SEC), segment.end);
    onUpdateTiming(segment.id, { start: minStart, end: minEnd });
    return;
  }
  if (nextSegment && roundToMs(segment.end) > roundToMs(nextSegment.start)) {
    const maxEnd = roundToMs(nextSegment.start);
    const minStart = Math.min(segment.start, Math.max(0, roundToMs(maxEnd - MIN_SPLIT_GAP_SEC)));
    onUpdateTiming(segment.id, { start: minStart, end: maxEnd });
  }
}

export function TimingInlineEditor({
  segment,
  prevSegment = null,
  nextSegment = null,
  busy = false,
  onUpdateTiming,
  onUpdatePause = null,
}) {
  const drafts = useTimingDrafts(segment, nextSegment);
  const cancellingRef = useRef('');
  const overlapNotice = computeOverlapWarning(segment, prevSegment, nextSegment);

  const commitField = (field, raw) => {
    if (field === 'duration') {
      const outcome = resolveDurationCommit(raw, segment);
      if (!outcome.valid) return drafts.setError(outcome.error);
      drafts.setError('');
      return onUpdateTiming(segment.id, outcome.patch);
    }
    if (field === 'pause') {
      const outcome = resolvePauseCommit(raw);
      if (!outcome.valid) return drafts.setError(outcome.error);
      drafts.setError('');
      return onUpdatePause?.(segment.id, outcome.pauseSec);
    }
    const outcome = resolveTimingCommit(field, raw, segment);
    if (outcome.unchanged) return drafts.setError('');
    if (!outcome.valid) {
      if (outcome.startDraft !== undefined) drafts.setStartDraft(outcome.startDraft);
      if (outcome.endDraft !== undefined) drafts.setEndDraft(outcome.endDraft);
      return drafts.setError(outcome.error || 'Invalid timestamp.');
    }
    drafts.setError('');
    if (outcome.startDraft !== undefined) drafts.setStartDraft(outcome.startDraft);
    if (outcome.endDraft !== undefined) drafts.setEndDraft(outcome.endDraft);
    onUpdateTiming(segment.id, outcome.patch);
  };

  const handleBlur = (field, draft) => {
    if (cancellingRef.current === field) {
      cancellingRef.current = '';
      return;
    }
    cancellingRef.current = '';
    commitField(field, draft);
  };

  const handleKeyDown = (field, draft, e) => {
    if (e.key === 'Enter') {
      cancellingRef.current = '';
      commitField(field, draft);
    } else if (e.key === 'Escape') {
      cancellingRef.current = field;
      drafts.setStartDraft(formatEditableTimestamp(segment.start));
      drafts.setEndDraft(formatEditableTimestamp(segment.end));
      drafts.setError('');
      e.currentTarget.blur?.();
    }
  };

  return (
    <div className="subtitle-timing-bar">
      <TimingInputField label="Start" ariaLabel="Start timestamp" value={drafts.startDraft} disabled={busy}
        onChange={e => { cancellingRef.current = ''; drafts.setStartDraft(e.target.value); }}
        onBlur={() => handleBlur('start', drafts.startDraft)} onKeyDown={e => handleKeyDown('start', drafts.startDraft, e)} />
      <TimingInputField label="End" ariaLabel="End timestamp" value={drafts.endDraft} disabled={busy}
        onChange={e => { cancellingRef.current = ''; drafts.setEndDraft(e.target.value); }}
        onBlur={() => handleBlur('end', drafts.endDraft)} onKeyDown={e => handleKeyDown('end', drafts.endDraft, e)} />
      <TimingInputField label="Duration" ariaLabel="Cue duration" value={drafts.durDraft} disabled={busy} className="subtitle-timing-dur-input"
        onChange={e => { cancellingRef.current = ''; drafts.setDurDraft(e.target.value); }}
        onBlur={() => handleBlur('duration', drafts.durDraft)} onKeyDown={e => handleKeyDown('duration', drafts.durDraft, e)} />
      {nextSegment && (
        <TimingInputField label="Pause" ariaLabel="Pause to next cue" value={drafts.pauseDraft} disabled={busy || !onUpdatePause} className="subtitle-timing-pause-input"
          onChange={e => { cancellingRef.current = ''; drafts.setPauseDraft(e.target.value); }}
          onBlur={() => handleBlur('pause', drafts.pauseDraft)} onKeyDown={e => handleKeyDown('pause', drafts.pauseDraft, e)} />
      )}
      <TimingNudgeButtons busy={busy} onNudge={delta => handleNudgeTiming(segment, delta, onUpdateTiming)} />
      <TimingFeedback error={drafts.error} overlapNotice={overlapNotice} onFixOverlap={() => handleFixOverlapAction(segment, prevSegment, nextSegment, onUpdateTiming)} />
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
  const rowClass = [
    'subtitle-segment-row',
    isActive ? 'is-active' : '',
    isSelected ? 'is-selected' : '',
  ].filter(Boolean).join(' ');
  const targetShortLabel = targetLangMeta?.shortLabel || 'Khmer';
  const isKhmerDisplay = useTranslation ? (targetLangMeta ? Boolean(targetLangMeta.isKhmer) : true) : sourceLanguage === 'km';
  const activeLang = useTranslation ? (targetLangMeta?.bcp47 || 'km') : (sourceLanguage && sourceLanguage !== 'auto' ? sourceLanguage : undefined);

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
      {showTimingEditor && (
        <TimingInlineEditor
          segment={segment}
          prevSegment={prevSegment}
          nextSegment={nextSegment}
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
