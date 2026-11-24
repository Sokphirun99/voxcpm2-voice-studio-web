/**
 * @fileoverview Presentation unit and integration tests for time-aligned dub WAV controls, preview mode toggle, and export dock actions.
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

test('SubtitleVoiceOutputCard renders preview mode toggle and time-aligned WAV download button when alignedClip is provided', async () => {
  await withViteSsr(async vite => {
    const { SubtitleVoiceOutputCard } = await vite.ssrLoadModule('/src/presentation/components/SubtitleVoiceControls.jsx');
    const combinedClip = {
      url: 'blob:combined-sequential',
      count: 2,
      durationSeconds: 3.2,
      characterName: 'Sovath',
      pauseGapMs: 200,
      scope: 'all',
    };
    const alignedClip = {
      url: 'blob:aligned-timeline',
      count: 2,
      durationSeconds: 5.0,
      characterName: 'Sovath',
      scope: 'all',
      warnings: [],
    };

    let downloadClicked = false;
    let alignedDownloadClicked = false;

    const html = renderToStaticMarkup(
      React.createElement(SubtitleVoiceOutputCard, {
        combinedClip,
        alignedClip,
        onDownload: () => { downloadClicked = true; },
        onDownloadAligned: () => { alignedDownloadClicked = true; },
      })
    );

    assert.ok(html.includes('subtitle-voice-output'), 'Must render output card');
    assert.ok(html.includes('subtitle-mode-aligned-btn'), 'Must render Time-aligned dub button');
    assert.ok(html.includes('subtitle-mode-sequential-btn'), 'Must render Sequential voice button');
    assert.ok(html.includes('subtitle-download-voice-btn'), 'Must render sequential download button');
    assert.ok(html.includes('subtitle-download-aligned-voice-btn'), 'Must render time-aligned download button');
    assert.ok(html.includes('Time-aligned dub WAV'), 'Must show time-aligned WAV label');
  });
});

test('SubtitleExportDock renders Time-aligned dub WAV button when onExportAlignedVoice provided', async () => {
  await withViteSsr(async vite => {
    const { SubtitleExportDock } = await vite.ssrLoadModule('/src/presentation/components/SubtitleExportDock.jsx');

    let exportAlignedTriggered = false;

    const disabledHtml = renderToStaticMarkup(
      React.createElement(SubtitleExportDock, {
        hasSegments: true,
        status: { message: '' },
        hasAlignedVoice: false,
        onExportAlignedVoice: () => { exportAlignedTriggered = true; },
      })
    );

    assert.ok(disabledHtml.includes('subtitle-export-aligned-wav-btn'), 'Must render aligned dub button in dock');
    assert.ok(disabledHtml.includes('disabled=""') || disabledHtml.includes('disabled'), 'Must be disabled when hasAlignedVoice is false');

    const enabledHtml = renderToStaticMarkup(
      React.createElement(SubtitleExportDock, {
        hasSegments: true,
        status: { message: '' },
        hasAlignedVoice: true,
        onExportAlignedVoice: () => { exportAlignedTriggered = true; },
      })
    );

    assert.ok(enabledHtml.includes('subtitle-export-aligned-wav-btn'), 'Must render aligned dub button in dock');
    assert.ok(enabledHtml.includes('Time-aligned dub WAV'), 'Must show Time-aligned dub WAV label');
  });
});

test('SubtitleVoiceOutputCard gracefully displays alignedClip and warning pill when combinedClip is null', async () => {
  await withViteSsr(async vite => {
    const { SubtitleVoiceOutputCard } = await vite.ssrLoadModule('/src/presentation/components/SubtitleVoiceControls.jsx');
    const alignedClip = {
      url: 'blob:aligned-fallback',
      count: 2,
      durationSeconds: 8.5,
      characterName: 'Sovath',
      scope: 'all',
      warnings: [
        { segmentId: 'c1', message: 'Clip for cue #c1 (2.0s) exceeded window (1.0s); clamped with micro-fade.' },
        { segmentId: 'c2', message: 'Clip for cue #c2 (3.5s) exceeded window (2.0s); clamped with micro-fade.' },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(SubtitleVoiceOutputCard, {
        combinedClip: null,
        alignedClip,
        onDownload: () => {},
        onDownloadAligned: () => {},
      })
    );

    assert.ok(html.includes('subtitle-voice-output'), 'Output card must render even if combinedClip is null');
    assert.ok(html.includes('2 clamped to fit'), 'Must render 2 clamped to fit pill');
    assert.ok(html.includes('Clip for cue #c1'), 'Warning title must include first warning');
    assert.ok(html.includes('Clip for cue #c2'), 'Warning title must include second warning');
  });
});
