/**
 * @fileoverview Presentation unit tests for R3-05 speech duration mismatch alerts, explicit remedies, timeline spill markers, and export gating.
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

test('SubtitleSegmentRow renders all explicit duration mismatch remedies and status badges', async () => {
  await withViteSsr(async vite => {
    const { SubtitleSegmentRow } = await vite.ssrLoadModule('/src/presentation/components/SubtitleSegmentRow.jsx');
    const { detectDurationMismatches, validateSubtitleSegments } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const segments = [
      { id: 'c1', start: 0.0, end: 1.5, speakerId: 'speaker-1', text: 'Long spoken line' },
      { id: 'c2', start: 3.0, end: 4.5, speakerId: 'speaker-1', text: 'Second line' },
    ];
    const segmentClips = {
      c1: {
        url: 'blob:clip-c1',
        blob: new Blob(['wav']),
        characterName: 'Sovath',
        durationSeconds: 2.2,
        signature: 'sig-1',
      },
    };
    const mismatchReport = detectDurationMismatches({ segments, segmentClips, mediaDuration: 6.0, isClipStale: () => true });
    const validation = validateSubtitleSegments({ segments, segmentClips, mediaDuration: 6.0, isClipStale: () => true });

    const html = renderToStaticMarkup(
      React.createElement(SubtitleSegmentRow, {
        segment: segments[0],
        nextSegment: segments[1],
        speakers: ['speaker-1'],
        speakerNames: {},
        validationIssues: validation.issuesBySegmentId.c1,
        mismatch: mismatchReport.bySegmentId.c1,
        voiceClip: segmentClips.c1,
        isVoiceStale: true,
        onUpdate() {},
        onUpdateTiming() {},
        onGenerateVoice() {},
      })
    );

    assert.ok(html.includes('has-multi-remedies'), 'Must render multi-remedy validation pill');
    assert.ok(html.includes('data-remedy-action="extend_cue"'), 'Must offer Extend cue action');
    assert.ok(html.includes('data-remedy-action="allow_spill"'), 'Must offer Allow spill action');
    assert.ok(html.includes('data-remedy-action="trim_clip"'), 'Must offer Trim audio action');
    assert.ok(html.includes('data-remedy-action="regenerate_clip"'), 'Must offer Regenerate action when stale');
    assert.ok(html.includes('data-remedy-action="edit_text"'), 'Must offer Edit text action');
    assert.ok(html.includes('data-remedy-action="adjust_timing"'), 'Must offer Adjust timing action');
    assert.ok(html.includes('+0.70s over 1.50s'), 'Voice bar must show excess over allocated interval');
  });
});

test('SubtitleSegmentRow renders Undo spill and Undo trim controls when spill approved or audio trimmed', async () => {
  await withViteSsr(async vite => {
    const { SubtitleSegmentRow } = await vite.ssrLoadModule('/src/presentation/components/SubtitleSegmentRow.jsx');
    const { detectDurationMismatches } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const segments = [
      { id: 'c1', start: 0.0, end: 1.5, speakerId: 'speaker-1', text: 'Spill line' },
      { id: 'c2', start: 3.0, end: 4.5, speakerId: 'speaker-1', text: 'Next' },
    ];
    const clip = {
      url: 'blob:clip-c1',
      blob: new Blob(['trimmed']),
      characterName: 'Nisa',
      durationSeconds: 2.1,
      signature: 'sig-1',
      preTrimClip: { blob: new Blob(['orig']), durationSeconds: 2.4 },
    };
    const spillApprovals = {
      c1: { segmentId: 'c1', clipSignature: 'sig-1', clipDuration: 2.1, cueStart: 0.0, cueEnd: 1.5 },
    };
    const report = detectDurationMismatches({ segments, segmentClips: { c1: clip }, spillApprovals, mediaDuration: 5.0 });

    const html = renderToStaticMarkup(
      React.createElement(SubtitleSegmentRow, {
        segment: segments[0],
        nextSegment: segments[1],
        speakers: ['speaker-1'],
        speakerNames: {},
        mismatch: report.bySegmentId.c1,
        voiceClip: clip,
        onUpdate() {},
        onUpdateTiming() {},
        onGenerateVoice() {},
        onRevokeSpill() {},
        onUndoTrimVoice() {},
      })
    );

    assert.ok(html.includes('Spill +0.60s'), 'Must display approved spill badge');
    assert.ok(html.includes('Undo spill'), 'Must display Undo spill button');
    assert.ok(html.includes('Trimmed'), 'Must display Trimmed badge');
    assert.ok(html.includes('Undo trim'), 'Must display Undo trim button');
  });
});

test('SubtitleVoiceOutputCard and SubtitleExportDock gate final dub exports until duration mismatches are resolved', async () => {
  await withViteSsr(async vite => {
    const { SubtitleVoiceOutputCard } = await vite.ssrLoadModule('/src/presentation/components/SubtitleVoiceControls.jsx');
    const { SubtitleExportDock } = await vite.ssrLoadModule('/src/presentation/components/SubtitleExportDock.jsx');
    const { detectDurationMismatches } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const segments = [
      { id: 'c1', start: 0.0, end: 1.2, text: 'Overflow cue' },
      { id: 'c2', start: 2.5, end: 4.0, text: 'Clean cue' },
    ];
    const segmentClips = {
      c1: { blob: new Blob(['1']), durationSeconds: 1.9, signature: 's1' },
      c2: { blob: new Blob(['2']), durationSeconds: 1.0, signature: 's2' },
    };
    const durationMismatches = detectDurationMismatches({ segments, segmentClips, mediaDuration: 5.0 });

    const cardHtml = renderToStaticMarkup(
      React.createElement(SubtitleVoiceOutputCard, {
        combinedClip: { url: 'blob:seq', count: 2, durationSeconds: 3.1, characterName: 'Sovath', scope: 'all' },
        alignedClip: { url: 'blob:aligned', count: 2, durationSeconds: 5.0, characterName: 'Sovath', scope: 'all', warnings: [] },
        durationMismatches,
        canExportAlignedVoice: false,
        canExportDub: false,
        hasJobId: true,
        isAudioOnly: false,
        onDownload() {},
        onDownloadAligned() {},
        onExportDub() {},
        onJumpToMismatch() {},
        onFixSafeMismatches() {},
      })
    );

    assert.ok(cardHtml.includes('subtitle-mismatch-export-banner'), 'Must render mismatch export banner');
    assert.ok(cardHtml.includes('Resolve 1 speech duration mismatch before final dub export'), 'Must explain unresolved mismatch count');
    assert.ok(cardHtml.includes('Cue #1 (+0.70s)'), 'Must render jump chip for affected cue');
    assert.ok(cardHtml.includes('Extend safe cues'), 'Must render 1-click Extend safe cues button');
    assert.match(cardHtml, /id="subtitle-download-aligned-voice-btn"[^>]*disabled/, 'Aligned WAV button must be disabled');
    assert.match(cardHtml, /id="subtitle-export-dub-btn"[^>]*disabled/, 'Dubbed MP4 button must be disabled');

    const dockHtml = renderToStaticMarkup(
      React.createElement(SubtitleExportDock, {
        hasSegments: true,
        status: { message: '' },
        hasAlignedVoice: true,
        canExportAlignedVoice: false,
        unresolvedMismatchCount: 1,
        onExportAlignedVoice() {},
      })
    );
    assert.match(dockHtml, /id="subtitle-export-aligned-wav-btn"[^>]*disabled/, 'Dock aligned WAV button must be disabled');
    assert.ok(dockHtml.includes('Resolve 1 speech duration mismatch before exporting time-aligned WAV'));
  });
});

test('SubtitleTimeline distinguishes approved speech spill from unresolved overflow', async () => {
  await withViteSsr(async vite => {
    const { SubtitleTimeline } = await vite.ssrLoadModule('/src/presentation/components/SubtitleTimeline.jsx');
    const segments = [
      { id: 'c1', start: 0, end: 2.0, speakerId: 'speaker-1' },
      { id: 'c2', start: 4.0, end: 6.0, speakerId: 'speaker-2' },
    ];
    const segmentClips = {
      c1: { url: 'blob:1', characterName: 'Sovath', durationSeconds: 2.8, signature: 'sig-1' },
    };
    const spillApprovals = {
      c1: { segmentId: 'c1', clipSignature: 'sig-1', clipDuration: 2.8, cueStart: 0, cueEnd: 2.0 },
    };

    const html = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 0.5,
        mediaDuration: 8.0,
        segments,
        activeSegmentId: 'c1',
        segmentClips,
        spillApprovals,
      })
    );

    assert.ok(html.includes('is-spill-approved'), 'Approved spill cue must have is-spill-approved class');
    assert.ok(!html.includes('is-speech-overflow'), 'Approved spill cue must not show unresolved overflow warning');
    assert.ok(html.includes('Speech: 2.80s (+0.80s spill)'), 'Active cue header must note approved spill');

    // Overlapping cue collision (2.80s clip inside [0, 3.0] colliding with c2 at 2.5s) and media overflow must show overflow, not silence
    const overlapHtml = renderToStaticMarkup(
      React.createElement(SubtitleTimeline, {
        currentTime: 0.5,
        mediaDuration: 9.0,
        segments: [
          { id: 'c1', start: 0.0, end: 3.0, speakerId: 'speaker-1' },
          { id: 'c2', start: 2.5, end: 4.0, speakerId: 'speaker-2' },
          { id: 'c3', start: 7.0, end: 9.5, speakerId: 'speaker-1' },
        ],
        activeSegmentId: 'c1',
        segmentClips: {
          c1: { url: 'blob:1', characterName: 'Sovath', durationSeconds: 2.8, signature: 's1' },
          c3: { url: 'blob:3', characterName: 'Sovath', durationSeconds: 2.4, signature: 's3' },
        },
      })
    );
    assert.ok(overlapHtml.includes('Speech: 2.80s (+0.30s)'), 'Overlapping cue collision must report +0.30s overflow in timeline');
    assert.ok(!overlapHtml.includes('Silence: 0.20s'), 'Overlapping cue collision must never claim trailing silence');
  });
});
