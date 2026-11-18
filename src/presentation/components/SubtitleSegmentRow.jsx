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
 * Inputs: `{ segment, speakers, speakerNames, useTranslation, busy, onSeek, onUpdate }`.
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
  useTranslation = false,
  busy,
  onSeek,
  onUpdate,
}) {
  const activeText = useTranslation ? (segment.translatedText || segment.text || '') : (segment.text || '');
  const handleTextChange = e => {
    const val = e.target.value;
    onUpdate(segment.id, useTranslation ? { translatedText: val } : { text: val });
  };
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
        className={useTranslation ? 'subtitle-line-input subtitle-line-khmer' : 'subtitle-line-input'}
        rows={2}
        lang="km"
        aria-label={useTranslation ? 'Khmer subtitle translation' : 'Subtitle text'}
        value={activeText}
        disabled={busy}
        onChange={handleTextChange}
      />
    </article>
  );
}
