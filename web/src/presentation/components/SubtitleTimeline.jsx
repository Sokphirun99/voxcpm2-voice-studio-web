/**
 * @fileoverview Accessible timeline component displaying video playback time, interactive scrubber, speaker-colored subtitle intervals, and associated speech clip badges.
 */

import React, { memo, useCallback, useMemo, useRef } from 'react';
import { formatTime } from '../../domain/audioValidation.js';
import {
  clampTimelineTime,
  computeTimelineDuration,
  computeTimelineIntervals,
  formatTimelineClock,
  resolveActiveSpeechClip,
} from '../../domain/timeline.js';
import { Icon } from './Icon.jsx';

const TIMELINE_NUDGE_SECONDS = 1.0;

function resolveTrackClickTime(event, trackEl, totalDuration) {
  if (!trackEl || !totalDuration) return 0;
  const rect = trackEl.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return ratio * totalDuration;
}

function CueVoiceTimingPill({ interval }) {
  if (!interval?.hasVoiceClip || !interval.clipDuration) return null;
  if (interval.isClipOverflowing) {
    return (
      <span className="subtitle-timeline-voice-timing is-overflow" title="Voice duration exceeds cue interval">
        Speech: {interval.clipDuration.toFixed(2)}s (+{interval.overflowDuration.toFixed(2)}s)
      </span>
    );
  }
  if (interval.isSpillApproved) {
    return (
      <span className="subtitle-timeline-voice-timing is-spill-approved" title="Approved speech spill into trailing pause">
        Speech: {interval.clipDuration.toFixed(2)}s (+{interval.overflowDuration.toFixed(2)}s spill)
      </span>
    );
  }
  const silence = interval.trailingSilenceDuration > 0 ? ` · Silence: ${interval.trailingSilenceDuration.toFixed(2)}s` : '';
  return (
    <span className="subtitle-timeline-voice-timing">
      Speech: {interval.clipDuration.toFixed(2)}s{silence}
    </span>
  );
}

function CueBadgeTiming({ activeInterval }) {
  if (!activeInterval) return null;
  const cueLabel = `Cue #${activeInterval.index + 1}`;
  const durLabel = activeInterval.duration ? ` (${activeInterval.duration.toFixed(2)}s)` : '';
  const cueTime = `${formatTimelineClock(activeInterval.start, false)} – ${formatTimelineClock(activeInterval.end, false)}${durLabel}`;
  const issuePill = activeInterval.hasError ? 'Error' : activeInterval.hasWarning ? 'Warning' : '';
  return (
    <div className="subtitle-timeline-cue-badge" style={{ '--spk-color': activeInterval.speakerColor }}>
      <span className="subtitle-speaker-dot" aria-hidden="true" />
      <strong className="subtitle-timeline-cue-title">{cueLabel}</strong>
      <span className="subtitle-timeline-cue-time">{cueTime}</span>
      <CueVoiceTimingPill interval={activeInterval} />
      {activeInterval.hasOverlap && <span className="subtitle-timeline-overlap-pill">Overlap</span>}
      {issuePill && <span className={`subtitle-timeline-issue-pill is-${issuePill.toLowerCase()}`}>{issuePill}</span>}
    </div>
  );
}

function TimelineClockHeader({
  currentTime,
  totalDuration,
  activeInterval,
  activeClip,
  isPlayingVoice,
  onTogglePlayVoice,
}) {
  return (
    <div className="subtitle-timeline-head">
      <div className="subtitle-timeline-clock" aria-label="Playback time">
        <span className="subtitle-timeline-current">{formatTimelineClock(currentTime)}</span>
        <span className="subtitle-timeline-duration">/ {formatTimelineClock(totalDuration)}</span>
      </div>
      <CueBadgeTiming activeInterval={activeInterval} />
      {activeClip && (
        <div className="subtitle-timeline-audio-badge">
          <Icon name="waveform" className="subtitle-timeline-audio-icon" />
          <span className="subtitle-timeline-audio-meta">
            {activeClip.characterName} {activeClip.durationSeconds ? `(${formatTime(activeClip.durationSeconds)})` : ''}
          </span>
          <button
            type="button"
            className={isPlayingVoice ? 'button subtle-button subtitle-timeline-play-btn is-playing' : 'button subtle-button subtitle-timeline-play-btn'}
            aria-label={isPlayingVoice ? 'Pause voice clip' : 'Play voice clip'}
            onClick={() => onTogglePlayVoice?.(activeInterval?.id)}
          >
            <Icon name={isPlayingVoice ? 'pause_fill' : 'play_fill'} />
            <span>{isPlayingVoice ? 'Pause' : 'Play'}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function buildCueTitle(interval) {
  const time = `${formatTimelineClock(interval.start, false)} - ${formatTimelineClock(interval.end, false)}`;
  let voice = '';
  if (interval.hasVoiceClip) {
    if (interval.isClipOverflowing) {
      voice = ` · Voice: ${interval.clipDuration.toFixed(2)}s (+${interval.overflowDuration.toFixed(2)}s overflow)`;
    } else if (interval.isSpillApproved) {
      voice = ` · Voice: ${interval.clipDuration.toFixed(2)}s (+${interval.overflowDuration.toFixed(2)}s spill approved)`;
    } else if (interval.trailingSilenceDuration > 0) {
      voice = ` · Voice: ${interval.clipDuration.toFixed(2)}s · Silence: ${interval.trailingSilenceDuration.toFixed(2)}s`;
    } else {
      voice = ` · Voice: ${interval.clipDuration.toFixed(2)}s`;
    }
  }
  const overlap = interval.hasOverlap ? ' · Overlaps neighbor' : '';
  const validation = interval.issueCount ? ` · ${interval.issueCount} issue(s)` : '';
  return `Cue #${interval.index + 1} (${time})${voice}${overlap}${validation}`;
}

function TimelineIntervalCue({ interval, onClick }) {
  const classNames = [
    'subtitle-timeline-cue',
    interval.isActive ? 'is-active' : '',
    interval.hasVoiceClip ? 'has-voice' : '',
    interval.isClipOverflowing ? 'is-speech-overflow' : '',
    interval.isSpillApproved ? 'is-spill-approved' : '',
    interval.hasOverlap ? 'has-overlap' : '',
    interval.hasError ? 'has-error' : '',
    interval.hasWarning ? 'has-warning' : '',
  ].filter(Boolean).join(' ');
  const style = { left: `${interval.leftPercent}%`, width: `${interval.widthPercent}%`, '--spk-color': interval.speakerColor };
  return (
    <button
      type="button"
      className={classNames}
      style={style}
      aria-label={`Cue ${interval.index + 1}`}
      aria-current={interval.isActive ? 'true' : undefined}
      title={buildCueTitle(interval)}
      onClick={e => {
        e.stopPropagation();
        onClick(interval);
      }}
    >
      {interval.hasVoiceClip && interval.speechPercent > 0 && (
        <span
          className="subtitle-timeline-cue-speech"
          style={{ width: `${Math.min(100, interval.speechPercent)}%` }}
          aria-hidden="true"
        />
      )}
      <span className="subtitle-timeline-cue-label">#{interval.index + 1}</span>
      {interval.hasVoiceClip && <Icon name="waveform" className="subtitle-timeline-cue-wave" />}
    </button>
  );
}

/**
 * Subtitle timeline component rendering playhead progress, speaker intervals, and voice clips.
 * @param {object} props - Component props.
 * @returns {React.ReactElement} Subtitle timeline element.
 */
export const SubtitleTimeline = memo(function SubtitleTimeline({
  currentTime = 0,
  mediaDuration = 0,
  segments = [],
  activeSegmentId = '',
  segmentClips = {},
  spillApprovals = {},
  playingSegmentId = '',
  validationBySegmentId = {},
  busy = false,
  onSeekTime,
  onSelectCue,
  onTogglePlayVoice,
}) {
  const trackRef = useRef(null);
  const totalDuration = useMemo(
    () => computeTimelineDuration(segments, mediaDuration),
    [segments, mediaDuration]
  );
  const intervals = useMemo(
    () => computeTimelineIntervals({
      segments,
      totalDuration,
      mediaDuration,
      activeSegmentId,
      segmentClips,
      spillApprovals,
      validationBySegmentId,
    }),
    [segments, totalDuration, mediaDuration, activeSegmentId, segmentClips, spillApprovals, validationBySegmentId]
  );
  const activeInterval = useMemo(
    () => intervals.find(item => item.id === activeSegmentId) || null,
    [intervals, activeSegmentId]
  );
  const activeClip = useMemo(
    () => resolveActiveSpeechClip(activeSegmentId, segmentClips),
    [activeSegmentId, segmentClips]
  );
  const playheadPercent = Math.min(100, Math.max(0, (currentTime / totalDuration) * 100));

  const handleTrackClick = useCallback(event => {
    if (busy || !onSeekTime) return;
    const targetTime = resolveTrackClickTime(event, trackRef.current, totalDuration);
    onSeekTime(clampTimelineTime(targetTime, totalDuration));
  }, [busy, onSeekTime, totalDuration]);

  const handleCueClick = useCallback(interval => {
    if (!interval) return;
    onSelectCue?.(interval);
  }, [onSelectCue]);

  const handleKeyDown = useCallback(event => {
    if (busy || !onSeekTime) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onSeekTime(clampTimelineTime(currentTime - TIMELINE_NUDGE_SECONDS, totalDuration));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onSeekTime(clampTimelineTime(currentTime + TIMELINE_NUDGE_SECONDS, totalDuration));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onSeekTime(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      onSeekTime(totalDuration);
    }
  }, [busy, currentTime, onSeekTime, totalDuration]);

  if (!segments.length && !mediaDuration) return null;

  return (
    <section className="subtitle-timeline" aria-label="Subtitle timeline workspace">
      <TimelineClockHeader
        currentTime={currentTime}
        totalDuration={totalDuration}
        activeInterval={activeInterval}
        activeClip={activeClip}
        isPlayingVoice={playingSegmentId === activeSegmentId}
        onTogglePlayVoice={onTogglePlayVoice}
      />
      <div
        ref={trackRef}
        className="subtitle-timeline-track"
        role="slider"
        aria-label="Timeline playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalDuration)}
        aria-valuenow={Math.round(currentTime)}
        tabIndex={busy ? -1 : 0}
        onClick={handleTrackClick}
        onKeyDown={handleKeyDown}
      >
        <div className="subtitle-timeline-intervals" aria-hidden="true">
          {intervals.map(interval => (
            <TimelineIntervalCue key={interval.id} interval={interval} onClick={handleCueClick} />
          ))}
        </div>
        <div
          className="subtitle-timeline-playhead"
          style={{ left: `${playheadPercent}%` }}
          aria-hidden="true"
        />
      </div>
    </section>
  );
});
