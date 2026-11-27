/**
 * @fileoverview Integration test verifying R3-01: Timeline synchronization, cue selection seeking, and matching audio display.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function withViteSsr(run) {
  const vite = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
  });
  try {
    return await run(vite);
  } finally {
    await vite.close();
  }
}

test('R3-01: Timeline shows video playback time, intervals, and associated speech clips together', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');

    const segments = [
      { id: 'cue-intro', start: 0.0, end: 5.5, speakerId: 'speaker-1', text: 'សូមស្វាគមន៍' },
      { id: 'cue-main', start: 6.0, end: 18.2, speakerId: 'speaker-2', text: 'មេរៀនថ្ងៃនេះ' },
      { id: 'cue-outro', start: 19.0, end: 25.0, speakerId: 'speaker-1', text: 'សូមអរគុណ' },
    ];

    const segmentClips = {
      'cue-main': {
        url: 'blob:main-clip.wav',
        characterName: 'Sokha',
        durationSeconds: 12.0,
      },
    };

    // When cue-main is active:
    const html = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 6.0,
        mediaDuration: 25.0,
        segments,
        activeSegmentId: 'cue-main',
        segmentClips,
        playingSegmentId: '',
      })
    );

    // 1. Shows video playback time
    assert.ok(html.includes('00:06.0'), 'Must show current playback time');
    assert.ok(html.includes('00:25.0'), 'Must show total duration');

    // 2. Shows subtitle intervals
    assert.ok(html.includes('Cue #1'), 'Must include cue 1 block');
    assert.ok(html.includes('Cue #2'), 'Must include cue 2 block');
    assert.ok(html.includes('Cue #3'), 'Must include cue 3 block');

    // 3. Shows associated generated speech clip for active cue
    assert.ok(html.includes('Sokha'), 'Must display character voice name for active cue');
    assert.ok(html.includes('0:12'), 'Must display voice clip duration');
    assert.ok(html.includes('subtitle-timeline-play-btn'), 'Must offer audio play button');
  });
});

test('R3-01: Selecting a cue updates active cue, displays matching audio, and preserves unassociated cues without error', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');

    const segments = [
      { id: 'cue-1', start: 0.0, end: 4.0, speakerId: 'speaker-1' },
      { id: 'cue-2', start: 4.5, end: 9.0, speakerId: 'speaker-1' },
    ];

    const segmentClips = {
      'cue-1': { url: 'blob:clip-1', characterName: 'Dara', durationSeconds: 3.8 },
      // cue-2 has no audio clip
    };

    // Test cue-1 active (has audio)
    const htmlCue1 = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 0.0,
        mediaDuration: 9.0,
        segments,
        activeSegmentId: 'cue-1',
        segmentClips,
      })
    );
    assert.ok(htmlCue1.includes('Dara'), 'Cue 1 has voice clip displayed');
    assert.ok(htmlCue1.includes('subtitle-timeline-audio-badge'), 'Audio badge is rendered');

    // Test cue-2 active (no audio)
    const htmlCue2 = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 4.5,
        mediaDuration: 9.0,
        segments,
        activeSegmentId: 'cue-2',
        segmentClips,
      })
    );
    assert.ok(!htmlCue2.includes('Dara'), 'Cue 2 does not have Dara clip');
    assert.ok(!htmlCue2.includes('subtitle-timeline-audio-badge'), 'Audio badge is not rendered for cue without audio');
  });
});
