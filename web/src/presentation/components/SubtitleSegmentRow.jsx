/**
 * @fileoverview Memoized subtitle cue card supporting playback sync, inline timing edits, split/merge/delete, and bilingual reference.
 */

import React, { memo, useEffect, useRef, useState } from 'react';
import { Blocks } from 'loading-dev';
import { formatTime } from '../../domain/audioValidation.js';
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

/**
 * Renders one editable subtitle cue card with selection checkbox, optional speaker badge, playback sync, timing/split/merge/delete, bilingual reference, and inline TTS voice bar.
 * @param {object} props - Segment row props.
 * @returns {React.ReactElement} Memoized subtitle cue card.
 */
export const SubtitleSegmentRow = memo(function SubtitleSegmentRow({
  segment,
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
  onSplit,
  onMergeNext,
  onDelete,
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
      {showTimingEditor && <TimingInlineEditor segment={segment} busy={busy} onUpdateTiming={onUpdateTiming} />}
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
