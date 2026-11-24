/**
 * @fileoverview Presentation unit tests for SubtitleTimeline verifying video playback time, intervals, speech clips, and seeking.
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

test('SubtitleTimeline returns null when no segments and zero media duration', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');
    const html = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 0,
        mediaDuration: 0,
        segments: [],
      })
    );
    assert.equal(html, '');
  });
});

test('SubtitleTimeline displays video playback time and total duration accurately', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');
    const segments = [
      { id: 'c1', start: 0, end: 12.5, speakerId: 'speaker-1', text: 'សួស្តី' },
      { id: 'c2', start: 13.0, end: 45.0, speakerId: 'speaker-2', text: 'បាទ' },
    ];
    const html = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 14.2,
        mediaDuration: 45.0,
        segments,
        activeSegmentId: 'c2',
      })
    );

    assert.ok(html.includes('subtitle-timeline'), 'Must render timeline container');
    assert.ok(html.includes('00:14.2'), 'Must display current playhead time');
    assert.ok(html.includes('00:45.0'), 'Must display total media duration');
    assert.ok(html.includes('Cue #2'), 'Must show active cue title');
  });
});

test('SubtitleTimeline renders subtitle intervals with speaker colors and percentage positions', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');
    const segments = [
      { id: 'c1', start: 0, end: 20, speakerId: 'speaker-1' },
      { id: 'c2', start: 20, end: 60, speakerId: 'speaker-2' },
      { id: 'c3', start: 70, end: 100, speakerId: 'speaker-1' },
    ];
    const html = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 5.0,
        mediaDuration: 100,
        segments,
        activeSegmentId: 'c1',
      })
    );

    // Verify cue positions and intervals
    assert.ok(html.includes('left:0%'), 'Cue 1 starts at 0%');
    assert.ok(html.includes('width:20%'), 'Cue 1 width is 20%');
    assert.ok(html.includes('left:20%'), 'Cue 2 starts at 20%');
    assert.ok(html.includes('width:40%'), 'Cue 2 width is 40%');
    assert.ok(html.includes('left:70%'), 'Cue 3 starts at 70%');
    assert.ok(html.includes('width:30%'), 'Cue 3 width is 30%');

    // Verify active cue styling
    assert.ok(html.includes('aria-current="true"'), 'Active cue must have aria-current');
  });
});

test('SubtitleTimeline displays associated speech clip badge and quick play button for active cue', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');
    const segments = [
      { id: 'c1', start: 0, end: 10, speakerId: 'speaker-1', text: 'ជំរាបសួរ' },
    ];
    const segmentClips = {
      c1: {
        url: 'blob:mock-audio-c1',
        characterName: 'Dara (Voice)',
        durationSeconds: 4.8,
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 2.0,
        mediaDuration: 10,
        segments,
        activeSegmentId: 'c1',
        segmentClips,
        playingSegmentId: '',
      })
    );

    assert.ok(html.includes('subtitle-timeline-audio-badge'), 'Must render audio badge');
    assert.ok(html.includes('Dara (Voice)'), 'Must render character name');
    assert.ok(html.includes('subtitle-timeline-play-btn'), 'Must render quick play button');
    assert.ok(html.includes('Play'), 'Must show Play button text when not playing');
    assert.ok(html.includes('has-voice'), 'Cue block must have has-voice class');
  });
});

test('SubtitleTimeline toggles play/pause button label when active voice clip is playing', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');
    const segments = [{ id: 'c1', start: 0, end: 10, speakerId: 'speaker-1' }];
    const segmentClips = { c1: { url: 'blob:audio', characterName: 'Sok' } };

    const html = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 0,
        mediaDuration: 10,
        segments,
        activeSegmentId: 'c1',
        segmentClips,
        playingSegmentId: 'c1',
      })
    );

    assert.ok(html.includes('is-playing'), 'Play button must have is-playing class');
    assert.ok(html.includes('Pause'), 'Play button must show Pause text when playing');
  });
});
