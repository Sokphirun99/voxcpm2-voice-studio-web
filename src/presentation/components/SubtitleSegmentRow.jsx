/**
 * @fileoverview Single multi-speaker subtitle cue card with timestamp seek and inline original/Khmer editing.
 */

import React from 'react';
import { formatShortClock, getSpeakerColor, resolveSpeakerLabel } from '../../domain/subtitles.js';

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

/**
 * Renders one editable subtitle utterance attributed to a speaker.
 * Inputs: `{ segment, speakers, speakerNames, showTranslationInput, busy, onSeek, onUpdate }`.
 * Outputs: `<article className="subtitle-segment-row">`.
 * Side effects: triggers seek or segment state mutation callbacks.
 * Failure modes: none.
 * @param {object} props - Segment row props.
 * @returns {React.ReactElement} Subtitle cue card.
 */
export function SubtitleSegmentRow({
  segment,
  speakers,
  speakerNames,
  showTranslationInput,
  busy,
  onSeek,
  onUpdate,
}) {
  const hasTranslation = showTranslationInput || Boolean(segment.translatedText);
  return (
    <article className="subtitle-segment-row" data-segment-id={segment.id}>
      <header className="subtitle-segment-head">
        <SpeakerBadgeSelect
          speakerId={segment.speakerId}
          speakers={speakers}
          speakerNames={speakerNames}
          busy={busy}
          onChangeSpeaker={speakerId => onUpdate(segment.id, { speakerId })}
        />
        <button
          type="button"
          className="button subtitle-time-jump"
          title="Jump video to this line"
          onClick={() => onSeek(segment.start)}
        >
          {formatShortClock(segment.start)} - {formatShortClock(segment.end)}
        </button>
      </header>
      <textarea
        className="subtitle-line-input"
        rows={2}
        aria-label="Original subtitle text"
        value={segment.text}
        disabled={busy}
        onChange={e => onUpdate(segment.id, { text: e.target.value })}
      />
      {hasTranslation && (
        <textarea
          className="subtitle-line-input subtitle-line-khmer"
          rows={2}
          lang="km"
          placeholder="Khmer translation..."
          aria-label="Khmer subtitle translation"
          value={segment.translatedText || ''}
          disabled={busy}
          onChange={e => onUpdate(segment.id, { translatedText: e.target.value })}
        />
      )}
    </article>
  );
}
