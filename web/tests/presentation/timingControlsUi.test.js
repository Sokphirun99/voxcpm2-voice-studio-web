/**
 * @fileoverview Presentation unit tests for timing controls UI in SubtitleSegmentRow, TimingInlineEditor, and SubtitleTimeline.
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

test('SubtitleSegmentRow renders header time jump with formatted clocks and edit action', async () => {
  await withViteSsr(async vite => {
    const { SubtitleSegmentRow } = await vite.ssrLoadModule('/src/presentation/components/SubtitleSegmentRow.jsx');
    const segment = { id: 'seg-1', start: 1.25, end: 3.75, speakerId: 'speaker-1', text: 'សួស្តី' };
    const nextSegment = { id: 'seg-2', start: 4.5, end: 6.0, speakerId: 'speaker-1', text: 'បាទ' };

    const html = renderToStaticMarkup(
      React.createElement(SubtitleSegmentRow, {
        segment,
        nextSegment,
        speakers: ['speaker-1'],
        speakerNames: {},
        onUpdate() {},
        onUpdateTiming() {},
        onUpdatePause() {},
      })
    );

    assert.ok(html.includes('00:01 - 00:04'), 'Must display rounded short clock in time jump button');
    assert.ok(html.includes('title="Edit timestamps"'), 'Must have Time toggle button');
  });
});

test('TimingInlineEditor renders start, end, duration, and pause inputs with millisecond formatting', async () => {
  await withViteSsr(async vite => {
    const { TimingInlineEditor } = await vite.ssrLoadModule('/src/presentation/components/SubtitleSegmentRow.jsx');
    const segment = { id: 'seg-1', start: 1.25, end: 3.75 };
    const nextSegment = { id: 'seg-2', start: 4.5, end: 6.0 };

    const html = renderToStaticMarkup(
      React.createElement(TimingInlineEditor, {
        segment,
        nextSegment,
        onUpdateTiming() {},
        onUpdatePause() {},
      })
    );

    // Inputs with labels
    assert.ok(html.includes('aria-label="Start timestamp"'), 'Must render Start input');
    assert.ok(html.includes('value="00:01.250"'), 'Must display millisecond precision Start value');
    assert.ok(html.includes('aria-label="End timestamp"'), 'Must render End input');
    assert.ok(html.includes('value="00:03.750"'), 'Must display millisecond precision End value');

    // Duration input (3.75 - 1.25 = 2.50s)
    assert.ok(html.includes('aria-label="Cue duration"'), 'Must render Duration input');
    assert.ok(html.includes('value="2.50s"'), 'Must display computed duration');

    // Pause input (4.5 - 3.75 = 0.75s)
    assert.ok(html.includes('aria-label="Pause to next cue"'), 'Must render Pause input');
    assert.ok(html.includes('value="0.75s"'), 'Must display computed gap to next cue');

    // Nudge buttons
    assert.ok(html.includes('-0.2s'), 'Must render coarse -0.2s nudge button');
    assert.ok(html.includes('+0.2s'), 'Must render coarse +0.2s nudge button');
    assert.ok(html.includes('-0.05s'), 'Must render fine -0.05s nudge button');
    assert.ok(html.includes('+0.05s'), 'Must render fine +0.05s nudge button');
  });
});

test('TimingInlineEditor renders overlap warning and fix action when cues collide', async () => {
  await withViteSsr(async vite => {
    const { TimingInlineEditor } = await vite.ssrLoadModule('/src/presentation/components/SubtitleSegmentRow.jsx');
    const prevSegment = { id: 'seg-0', start: 0.0, end: 2.0 };
    const segment = { id: 'seg-1', start: 1.6, end: 3.5 }; // overlaps prevSegment by 0.40s
    const nextSegment = { id: 'seg-2', start: 4.0, end: 6.0 };

    const html = renderToStaticMarkup(
      React.createElement(TimingInlineEditor, {
        segment,
        prevSegment,
        nextSegment,
        onUpdateTiming() {},
        onUpdatePause() {},
      })
    );

    assert.ok(html.includes('subtitle-timing-warning'), 'Must render warning banner on overlap');
    assert.ok(html.includes('Overlaps previous cue by 0.40s'), 'Must indicate exact collision amount');
    assert.ok(html.includes('subtitle-fix-overlap-btn'), 'Must provide Fix overlap action');
  });
});

test('SubtitleTimeline displays cue duration, pause gap, and overlap pill when cue collides', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');
    const overlappingSegments = [
      { id: 'c1', start: 0.0, end: 2.5, speakerId: 'speaker-1', text: 'មួយ' },
      { id: 'c2', start: 2.0, end: 4.0, speakerId: 'speaker-2', text: 'ពីរ' }, // overlaps c1 by 0.5s
    ];

    const html = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 1.0,
        mediaDuration: 10.0,
        segments: overlappingSegments,
        activeSegmentId: 'c1',
      })
    );

    // Timeline cues with overlap must have has-overlap CSS class
    assert.ok(html.includes('has-overlap'), 'Must assign has-overlap CSS class to overlapping intervals');
    // Header must display overlap indicator
    assert.ok(html.includes('subtitle-timeline-overlap-pill'), 'Must render overlap pill for active cue with overlap');
    // Header must show duration (2.50s)
    assert.ok(html.includes('2.50s'), 'Must display cue duration in header');
  });
});

test('SubtitleTimeline does not render overlap pill when cues are cleanly spaced', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');
    const cleanSegments = [
      { id: 'c1', start: 0.0, end: 2.0, speakerId: 'speaker-1', text: 'មួយ' },
      { id: 'c2', start: 2.5, end: 4.5, speakerId: 'speaker-2', text: 'ពីរ' },
    ];

    const html = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 1.0,
        mediaDuration: 10.0,
        segments: cleanSegments,
        activeSegmentId: 'c1',
      })
    );

    assert.equal(html.includes('has-overlap'), false, 'Clean cues must not have has-overlap class');
    assert.equal(html.includes('subtitle-timeline-overlap-pill'), false, 'Clean cues must not render overlap pill');
  });
});
