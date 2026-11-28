/**
 * @fileoverview Presentation unit tests for subtitle validation badges, remedy buttons, and cue list issue navigation.
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

test('SubtitleSegmentRow renders error validation pills and remedy buttons on affected cues', async () => {
  await withViteSsr(async vite => {
    const { SubtitleSegmentRow } = await vite.ssrLoadModule('/src/presentation/components/SubtitleSegmentRow.jsx');
    const { SUBTITLE_ISSUE_TYPES, REMEDY_ACTIONS, SUBTITLE_ISSUE_SEVERITIES } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const segment = { id: 'seg-1', start: 1.0, end: 1.15, speakerId: 'speaker-1', text: '' };
    const validationIssues = [
      {
        id: 'seg-1-missing_text',
        segmentId: 'seg-1',
        type: SUBTITLE_ISSUE_TYPES.MISSING_TEXT,
        severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
        message: 'Subtitle text is empty.',
        remedyAction: REMEDY_ACTIONS.FOCUS_TEXT,
        remedyHint: 'Enter text for this subtitle cue.',
      },
      {
        id: 'seg-1-invalid_duration',
        segmentId: 'seg-1',
        type: SUBTITLE_ISSUE_TYPES.INVALID_DURATION,
        severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
        message: 'Duration (0.15s) is shorter than minimum 0.2s.',
        remedyAction: REMEDY_ACTIONS.ADJUST_TIMING,
        remedyHint: 'Extend the cue end time.',
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(SubtitleSegmentRow, {
        segment,
        speakers: ['speaker-1'],
        speakerNames: {},
        validationIssues,
        onUpdate() {},
        onUpdateTiming() {},
      })
    );

    assert.ok(html.includes('has-validation-error'), 'Cue card must have has-validation-error class');
    assert.ok(html.includes('subtitle-validation-pill is-error'), 'Must render is-error validation pill');
    assert.ok(html.includes('Subtitle text is empty.'), 'Must display empty text message');
    assert.ok(html.includes('Duration (0.15s) is shorter than minimum 0.2s.'), 'Must display duration message');
    assert.ok(html.includes('Type text'), 'Must render Focus/Type text remedy button');
    assert.ok(html.includes('Adjust timing'), 'Must render Adjust timing remedy button');
  });
});

test('SubtitleSegmentRow renders warning pills for abnormal line lengths, reading speed, and untranslated text', async () => {
  await withViteSsr(async vite => {
    const { SubtitleSegmentRow } = await vite.ssrLoadModule('/src/presentation/components/SubtitleSegmentRow.jsx');
    const { SUBTITLE_ISSUE_TYPES, REMEDY_ACTIONS, SUBTITLE_ISSUE_SEVERITIES } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const segment = { id: 'seg-2', start: 1.0, end: 5.0, speakerId: 'speaker-1', text: 'Some text', translatedText: '' };
    const validationIssues = [
      {
        id: 'seg-2-line_too_long',
        segmentId: 'seg-2',
        type: SUBTITLE_ISSUE_TYPES.LINE_TOO_LONG,
        severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
        message: 'Line length (85 chars) exceeds 80 character limit.',
        remedyAction: REMEDY_ACTIONS.SPLIT_LINE,
        remedyHint: 'Break line into two lines.',
      },
      {
        id: 'seg-2-untranslated',
        segmentId: 'seg-2',
        type: SUBTITLE_ISSUE_TYPES.UNTRANSLATED,
        severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
        message: 'Translation text is missing for this cue.',
        remedyAction: REMEDY_ACTIONS.FOCUS_TRANSLATION,
        remedyHint: 'Provide translated text.',
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(SubtitleSegmentRow, {
        segment,
        speakers: ['speaker-1'],
        speakerNames: {},
        validationIssues,
        onUpdate() {},
        onUpdateTiming() {},
      })
    );

    assert.ok(html.includes('has-validation-warning'), 'Cue card must have has-validation-warning class');
    assert.ok(html.includes('subtitle-validation-pill is-warning'), 'Must render is-warning validation pill');
    assert.ok(html.includes('Line length (85 chars) exceeds 80 character limit.'), 'Must display line length message');
    assert.ok(html.includes('Wrap line'), 'Must render Wrap line remedy button');
    assert.ok(html.includes('Translation text is missing for this cue.'), 'Must display untranslated message');
  });
});

test('SubtitleSegmentRow renders overlap remedy button when cue collides with neighbor', async () => {
  await withViteSsr(async vite => {
    const { SubtitleSegmentRow } = await vite.ssrLoadModule('/src/presentation/components/SubtitleSegmentRow.jsx');
    const { SUBTITLE_ISSUE_TYPES, REMEDY_ACTIONS, SUBTITLE_ISSUE_SEVERITIES } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const segment = { id: 'seg-2', start: 3.0, end: 5.0, speakerId: 'speaker-1', text: 'Second' };
    const validationIssues = [
      {
        id: 'seg-2-overlap',
        segmentId: 'seg-2',
        type: SUBTITLE_ISSUE_TYPES.OVERLAP,
        severity: SUBTITLE_ISSUE_SEVERITIES.ERROR,
        message: 'Overlaps Cue #1 by 0.50s.',
        remedyAction: REMEDY_ACTIONS.RESOLVE_OVERLAP,
        remedyHint: 'Shift start of Cue #2 or trim end of Cue #1.',
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(SubtitleSegmentRow, {
        segment,
        speakers: ['speaker-1'],
        speakerNames: {},
        validationIssues,
        onUpdate() {},
        onUpdateTiming() {},
      })
    );

    assert.ok(html.includes('Overlaps Cue #1 by 0.50s.'), 'Must display overlap error');
    assert.ok(html.includes('Fix overlap'), 'Must display Fix overlap remedy button');
  });
});

test('SubtitleCueList displays validation summary badge and navigation toolbar', async () => {
  await withViteSsr(async vite => {
    const { SubtitleCueList } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');
    const { validateSubtitleSegments } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const segments = [
      { id: 'c1', start: 0, end: 1.0, text: '' }, // Error: missing text
      { id: 'c2', start: 0.8, end: 2.0, text: 'Overlaps' }, // Error: overlap with c1
    ];

    const validation = validateSubtitleSegments({ segments });

    const mockCtrl = {
      state: {
        videoFile: null,
        videoFileName: 'test.mp4',
        videoUrl: '',
        isAudioOnly: false,
        jobId: 'job-1',
        detectedLanguage: 'en',
        segments,
        hasTranslation: false,
        translatedLanguage: '',
        speakerNames: {},
        options: {
          sourceLanguage: 'en',
          targetLanguage: 'khm_Khmr',
          detectSpeakers: false,
          speakerCount: '0',
          includeSpeaker: false,
          previewMode: 'original',
          subtitleStyle: {},
        },
        busyAction: '',
        status: { message: '', error: false },
      },
      speakers: ['speaker-1'],
      effectiveIncludeSpeaker: false,
      hasSubtitleText: true,
      hasTranslation: false,
      translatedLanguageMeta: null,
      useTranslation: false,
      bilingual: false,
      mediaDuration: 10,
      currentTime: 0,
      activeSegmentId: 'c1',
      updateSegment() {},
      updateSegmentTiming() {},
      updateSegmentPause() {},
      splitSegment() {},
      mergeSegmentWithNext() {},
      deleteSegment() {},
      resolveOverlaps() {},
      seekToSegment() {},
      seekToTime() {},
      exportFile() {},
      copyDialogue() {},
      extractSubtitles() {},
      cancel() {},
      refreshHealth() {},
    };

    const mockVoice = {
      characters: [{ id: 'char-1', name: 'Dara' }],
      anchors: {},
      selectedVoiceId: 'char-1',
      selectedIds: [],
      selectedCount: 0,
      allSelected: false,
      pauseGapMs: 200,
      segmentClips: {},
      voiceBusy: false,
      dubBusy: false,
      generatingSegmentId: '',
      playingSegmentId: '',
      combinedClip: null,
      dubAudioMode: 'duck',
      canExportDub: false,
      batchProgress: null,
      isClipStale: () => false,
      toggleSelectSegment() {},
      toggleSelectAll() {},
      clearSelection() {},
      setSelectedVoiceId() {},
      setPauseGapMs() {},
      setDubAudioMode() {},
      generateSegmentVoice() {},
      generateSelectedVoices() {},
      cancelVoiceGeneration() {},
      togglePlaySegment() {},
      downloadSegmentVoice() {},
      downloadCombinedVoice() {},
      exportDubbedVideo() {},
      resetVoiceover() {},
      removeSegmentClip() {},
    };

    const html = renderToStaticMarkup(
      React.createElement(SubtitleCueList, {
        ctrl: mockCtrl,
        voice: mockVoice,
        validation,
        onDeleteSegment() {},
      })
    );

    // Validation summary bar
    assert.ok(html.includes('subtitle-validation-summary-bar'), 'Must render validation summary toolbar');
    assert.ok(html.includes('has-issues is-error'), 'Summary badge must reflect error issues');
    assert.ok(html.includes('Fix overlaps'), 'Must render Fix overlaps quick action button');
    assert.ok(html.includes('Issues only'), 'Must render Issues only filter button');
    assert.ok(html.includes('title="Previous issue"'), 'Must render previous issue button');
    assert.ok(html.includes('title="Next issue"'), 'Must render next issue button');
  });
});

test('SubtitleCueList displays clean Valid badge when all cues pass validation', async () => {
  await withViteSsr(async vite => {
    const { SubtitleCueList } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');
    const { validateSubtitleSegments } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const cleanSegments = [
      { id: 'c1', start: 0, end: 2.0, text: 'Clean cue one' },
      { id: 'c2', start: 2.5, end: 4.5, text: 'Clean cue two' },
    ];
    const validation = validateSubtitleSegments({ segments: cleanSegments });

    const mockCtrl = {
      state: {
        segments: cleanSegments,
        speakerNames: {},
        detectedLanguage: 'en',
        options: {},
      },
      speakers: ['speaker-1'],
      activeSegmentId: 'c1',
    };
    const mockVoice = {
      characters: [],
      selectedIds: [],
      segmentClips: {},
      isClipStale: () => false,
    };

    const html = renderToStaticMarkup(
      React.createElement(SubtitleCueList, {
        ctrl: mockCtrl,
        voice: mockVoice,
        validation,
        onDeleteSegment() {},
      })
    );

    assert.ok(html.includes('subtitle-validation-badge is-clean'), 'Must render is-clean badge');
    assert.ok(html.includes('Valid'), 'Must display Valid status text');
  });
});

test('SubtitleCueList renders all segments and highlights problem cues', async () => {
  await withViteSsr(async vite => {
    const { SubtitleCueList } = await vite.ssrLoadModule('/src/presentation/components/VideoSubtitleWorkspace.jsx');
    const { validateSubtitleSegments } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const segments = [
      { id: 'c1', start: 0, end: 1.0, text: '' }, // Issue: missing text
      { id: 'c2', start: 1.5, end: 2.5, text: 'Clean cue two' }, // Clean
      { id: 'c3', start: 3.0, end: 4.0, text: '' }, // Issue: missing text
    ];

    const validation = validateSubtitleSegments({ segments });

    const mockCtrl = {
      state: {
        segments,
        speakerNames: {},
        detectedLanguage: 'en',
        options: { sourceLanguage: 'en', targetLanguage: 'khm_Khmr' },
      },
      speakers: ['speaker-1'],
      activeSegmentId: 'c1',
      seekToSegment() {},
      updateSegment() {},
      updateSegmentTiming() {},
    };

    const mockVoice = {
      characters: [],
      selectedIds: [],
      segmentClips: {},
      isClipStale: () => false,
    };

    const html = renderToStaticMarkup(
      React.createElement(SubtitleCueList, {
        ctrl: mockCtrl,
        voice: mockVoice,
        validation,
        onDeleteSegment() {},
      })
    );

    assert.ok(html.includes('data-segment-id="c1"'));
    assert.ok(html.includes('data-segment-id="c2"'));
    assert.ok(html.includes('data-segment-id="c3"'));
    assert.ok(html.includes('2 issues'));
  });
});

test('SubtitleSegmentRow renders stale_translation remedy buttons and SubtitleTakesTray when multiple takes exist', async () => {
  await withViteSsr(async vite => {
    const { SubtitleSegmentRow } = await vite.ssrLoadModule('/src/presentation/components/SubtitleSegmentRow.jsx');
    const { SUBTITLE_ISSUE_TYPES, REMEDY_ACTIONS, SUBTITLE_ISSUE_SEVERITIES } = await vite.ssrLoadModule('/src/domain/subtitles.js');

    const singleTakeSeg = {
      id: 'seg-single',
      start: 0,
      end: 2,
      speakerId: 'speaker-1',
      text: 'One take only',
      takes: [
        { id: 't1', audioAssetId: '11111111-1111-4111-8111-111111111111', duration: 1.0, isSelected: true, settings: { text: 'One take only', characterName: 'Nisa' } },
        { id: 't-unpersisted', audioAssetId: null, duration: 1.0, isSelected: false, settings: { text: 'One take only', characterName: 'Nisa' } },
      ],
    };
    const singleHtml = renderToStaticMarkup(
      React.createElement(SubtitleSegmentRow, {
        segment: singleTakeSeg,
        speakers: ['speaker-1'],
        speakerNames: {},
        onUpdate() {},
        onUpdateTiming() {},
      })
    );
    assert.equal(singleHtml.includes('subtitle-takes-tray'), false, 'Single take should not render multi-take tray');

    const multiTakeSeg = {
      id: 'seg-multi',
      start: 0,
      end: 2,
      speakerId: 'speaker-1',
      text: 'Updated source text',
      translatedText: 'អត្ថបទចាស់',
      translatedFromText: 'Old source text',
      translationStale: true,
      takes: [
        { id: 'take-1', audioAssetId: '11111111-1111-4111-8111-111111111111', duration: 1.1, isSelected: false, settings: { text: 'Old source text', characterName: 'Nisa' } },
        { id: 'take-2', audioAssetId: '22222222-2222-4222-8222-222222222222', duration: 1.3, isSelected: true, settings: { text: 'Updated source text', characterName: 'Sovath' } },
      ],
    };
    const staleIssues = [{
      id: 'seg-multi-stale_translation',
      segmentId: 'seg-multi',
      type: SUBTITLE_ISSUE_TYPES.STALE_TRANSLATION,
      severity: SUBTITLE_ISSUE_SEVERITIES.WARNING,
      message: 'Source text changed since translation.',
      remedyAction: REMEDY_ACTIONS.RETRANSLATE_SEGMENT,
    }];
    const multiHtml = renderToStaticMarkup(
      React.createElement(SubtitleSegmentRow, {
        segment: multiTakeSeg,
        speakers: ['speaker-1'],
        speakerNames: {},
        validationIssues: staleIssues,
        playingTakeId: 'take-1',
        onUpdate() {},
        onUpdateTiming() {},
        onSelectTake() {},
        onTogglePlayTake() {},
        onDeleteTake() {},
      })
    );

    assert.ok(multiHtml.includes('Source text changed since translation.'));
    assert.ok(multiHtml.includes('data-remedy-action="retranslate_segment"'));
    assert.ok(multiHtml.includes('data-remedy-action="dismiss_stale_translation"'));
    assert.ok(multiHtml.includes('Re-translate'));
    assert.ok(multiHtml.includes('Keep translation'));
    assert.ok(multiHtml.includes('subtitle-takes-tray'));
    assert.ok(multiHtml.includes('Takes (2):'));
    assert.ok(multiHtml.includes('Take 1'));
    assert.ok(multiHtml.includes('Take 2'));
    assert.ok(multiHtml.includes('Active'));
    assert.ok(multiHtml.includes('Outdated'));
    assert.ok(multiHtml.includes('Stop Take 1'));
  });
});
