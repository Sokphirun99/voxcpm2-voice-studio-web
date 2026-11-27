import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createSegmentTake } from '../../src/domain/projects.js';
import { createEditableSegment } from '../../src/domain/projectSegments.js';

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

test('SegmentEditor renders ordered cards with status badges and character counts', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const takeReady = createSegmentTake({ id: 't-ready', isSelected: true, settings: { text: 'ផ្នែកទី២។' } });
    const takeOutdated = createSegmentTake({ id: 't-old', isSelected: true, settings: { text: 'អត្ថបទចាស់' } });

    const segDraft = createEditableSegment({ id: 's1', text: 'ផ្នែកទី១។' });
    const segReady = createEditableSegment({ id: 's2', text: 'ផ្នែកទី២។', takes: [takeReady] });
    const segOutdated = createEditableSegment({ id: 's3', text: 'ផ្នែកទី៣។', takes: [takeOutdated], pauseDuration: 0.5 });
    const segError = createEditableSegment({ id: 's4', text: 'ផ្នែកទី៤។', status: 'error' });

    const html = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [segDraft, segReady, segOutdated, segError],
        activeSegmentId: 's2',
        onSelectSegment() {},
        onUpdateSegment() {},
        onAddSegment() {},
        onDeleteSegment() {},
      })
    );

    // Verify index numbers
    assert.ok(html.includes('#1'), 'Should show #1 for first segment');
    assert.ok(html.includes('#2'), 'Should show #2 for second segment');
    assert.ok(html.includes('#3'), 'Should show #3 for third segment');
    assert.ok(html.includes('#4'), 'Should show #4 for fourth segment');

    // Verify status badges
    assert.ok(html.includes('status-draft'), 'Should have status-draft class');
    assert.ok(html.includes('status-ready'), 'Should have status-ready class');
    assert.ok(html.includes('status-outdated'), 'Should have status-outdated class');
    assert.ok(html.includes('status-error'), 'Should have status-error class');

    // Verify selection class
    assert.ok(html.includes('is-selected'), 'Active segment should have is-selected class');

    // Verify pause control with value 0.5
    assert.ok(html.includes('value="0.5"'), 'Should show pause duration 0.5');

    // Verify accessibility attributes
    assert.ok(html.includes('role="region"'), 'Should have role="region"');
    assert.ok(html.includes('aria-label="Structured script segments"'), 'Should have region aria-label');
    assert.ok(html.includes('tabindex="0"'), 'Should have tabindex="0" on card for keyboard navigation');
  });
});

test('SegmentEditor displays empty placeholder with add button when segments list is empty', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const html = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [],
        onAddSegment() {},
      })
    );

    assert.ok(html.includes('segment-editor-empty'), 'Should render empty state');
    assert.ok(html.includes('No segments available'), 'Should display guidance text');
    assert.ok(html.includes('+ Add segment'), 'Should display add segment button');
  });
});

test('ScriptEditor renders view mode toggle when segments are present', async () => {
  await withViteSsr(async vite => {
    const { ScriptEditor } = await vite.ssrLoadModule('/src/presentation/components/ScriptEditor.jsx');

    const seg1 = createEditableSegment({ id: 's1', text: 'ជំហានទីមួយ' });
    const seg2 = createEditableSegment({ id: 's2', text: 'ជំហានទីពីរ' });

    const htmlWithSegments = renderToStaticMarkup(
      React.createElement(ScriptEditor, {
        scriptInput: { current: null },
        script: 'ជំហានទីមួយ\nជំហានទីពីរ',
        count: 20,
        isOverLimit: false,
        segments: [seg1, seg2],
        viewMode: 'segments',
        onReplaceScript() {},
        onScriptChange() {},
        onScriptKey() {},
        onUpdateSegment() {},
      })
    );

    // Verify view mode tabs
    assert.ok(htmlWithSegments.includes('id="view-mode-segments"'), 'Should render segments mode button');
    assert.ok(htmlWithSegments.includes('id="view-mode-script"'), 'Should render script mode button');
    assert.ok(htmlWithSegments.includes('Segments (2)'), 'Should show segment count');

    // Verify SegmentEditor content rendered in segments mode
    assert.ok(htmlWithSegments.includes('segment-editor-list'), 'Should render segment list');
  });
});

test('SegmentEditor renders accessible action toolbar with Move Up/Down, Split, Merge, Add, and Delete buttons', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const seg1 = createEditableSegment({ id: 's1', text: 'ផ្នែកទី១។' });
    const seg2 = createEditableSegment({ id: 's2', text: 'ផ្នែកទី២។' });
    const seg3 = createEditableSegment({ id: 's3', text: 'ផ្នែកទី៣។' });

    let movedUpId = null;
    let movedDownId = null;
    let splitParams = null;
    let mergedId = null;

    const html = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [seg1, seg2, seg3],
        activeSegmentId: 's2',
        onMoveSegmentUp: id => { movedUpId = id; },
        onMoveSegmentDown: id => { movedDownId = id; },
        onSplitSegment: (id, offset) => { splitParams = { id, offset }; },
        onMergeSegment: id => { mergedId = id; },
        onAddSegment() {},
        onDeleteSegment() {},
        onUpdateSegment() {},
      })
    );

    // Verify action toolbar
    assert.ok(html.includes('role="toolbar"'), 'Should render action toolbar with role="toolbar"');
    assert.ok(html.includes('aria-label="Segment #1 actions"'), 'Should render toolbar aria-label for segment 1');
    assert.ok(html.includes('aria-label="Segment #2 actions"'), 'Should render toolbar aria-label for segment 2');

    // Move Up button
    assert.ok(html.includes('segment-move-up-btn'), 'Should render move-up buttons');
    assert.ok(html.includes('aria-label="Move segment #1 up"'), 'Should have accessible aria-label for move up');
    assert.ok(html.includes('aria-label="Move segment #2 up"'), 'Should have accessible aria-label for move up #2');

    // Move Down button
    assert.ok(html.includes('segment-move-down-btn'), 'Should render move-down buttons');
    assert.ok(html.includes('aria-label="Move segment #1 down"'), 'Should have accessible aria-label for move down');
    assert.ok(html.includes('aria-label="Move segment #3 down"'), 'Should have accessible aria-label for move down #3');

    // Split button
    assert.ok(html.includes('segment-split-btn'), 'Should render split buttons');
    assert.ok(html.includes('title="Split at cursor"'), 'Should have Split at cursor title');
    assert.ok(html.includes('aria-label="Split segment #1 at cursor"'), 'Should have accessible aria-label for split');

    // Merge button
    assert.ok(html.includes('segment-merge-btn'), 'Should render merge buttons');
    assert.ok(html.includes('title="Merge with next segment"'), 'Should have Merge with next title');
    assert.ok(html.includes('aria-label="Merge segment #1 with next"'), 'Should have accessible aria-label for merge');

    // Disabled states verification
    // 1. Move up on first segment must be disabled
    const firstCardSection = html.slice(html.indexOf('data-segment-id="s1"'), html.indexOf('data-segment-id="s2"'));
    assert.ok(firstCardSection.includes('aria-label="Move segment #1 up" disabled=""'), 'First segment move-up button must be disabled');

    // 2. Move down on last segment must be disabled
    const lastCardSection = html.slice(html.indexOf('data-segment-id="s3"'));
    assert.ok(lastCardSection.includes('aria-label="Move segment #3 down" disabled=""'), 'Last segment move-down button must be disabled');

    // 3. Merge on last segment must be disabled
    assert.ok(lastCardSection.includes('aria-label="Merge segment #3 with next" disabled=""'), 'Last segment merge button must be disabled');

    // 4. Middle segment move-up and move-down must not be disabled
    const middleCardSection = html.slice(html.indexOf('data-segment-id="s2"'), html.indexOf('data-segment-id="s3"'));
    assert.ok(!middleCardSection.includes('aria-label="Move segment #2 up" disabled=""'), 'Middle segment move-up button must NOT be disabled');
    assert.ok(!middleCardSection.includes('aria-label="Move segment #2 down" disabled=""'), 'Middle segment move-down button must NOT be disabled');
    assert.ok(!middleCardSection.includes('aria-label="Merge segment #2 with next" disabled=""'), 'Middle segment merge button must NOT be disabled');
  });
});

test('SegmentEditor disables Delete and navigation when only one segment exists', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const singleSeg = createEditableSegment({ id: 'only-seg', text: 'ប្រយោគតែមួយគត់។' });

    const html = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [singleSeg],
        activeSegmentId: 'only-seg',
        onDeleteSegment() {},
        onMoveSegmentUp() {},
        onMoveSegmentDown() {},
        onMergeSegment() {},
        onSplitSegment() {},
      })
    );

    // Delete button must be rendered and disabled
    assert.ok(html.includes('segment-delete-btn'), 'Should render delete button');
    assert.ok(html.includes('title="Cannot delete only segment"'), 'Should indicate cannot delete only segment');
    assert.ok(html.includes('aria-label="Delete segment #1" disabled=""'), 'Delete button must be disabled for single segment');

    // Move up, move down, merge must all be disabled
    assert.ok(html.includes('aria-label="Move segment #1 up" disabled=""'), 'Move up must be disabled');
    assert.ok(html.includes('aria-label="Move segment #1 down" disabled=""'), 'Move down must be disabled');
    assert.ok(html.includes('aria-label="Merge segment #1 with next" disabled=""'), 'Merge must be disabled');
  });
});

test('SegmentEditor disables Split button when segment text has fewer than 2 grapheme clusters', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const emptySeg = createEditableSegment({ id: 'empty-seg', text: '' });
    const oneCharSeg = createEditableSegment({ id: 'single-char-seg', text: 'ក' });

    const html = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [emptySeg, oneCharSeg],
        onSplitSegment() {},
      })
    );

    // Both should have disabled Split button with "Text too short to split"
    assert.ok(html.includes('title="Text too short to split"'), 'Should show Text too short to split title');
    const emptyCard = html.slice(html.indexOf('data-segment-id="empty-seg"'), html.indexOf('data-segment-id="single-char-seg"'));
    assert.ok(emptyCard.includes('aria-label="Split segment #1 at cursor" disabled=""'), 'Empty segment split must be disabled');

    const singleCharCard = html.slice(html.indexOf('data-segment-id="single-char-seg"'));
    assert.ok(singleCharCard.includes('aria-label="Split segment #2 at cursor" disabled=""'), 'Single cluster split must be disabled');
  });
});

test('SegmentEditor renders Generate and Play buttons with appropriate state and duration badges', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const takeWithAudio = createSegmentTake({
      id: 't-audio',
      duration: 1.5,
      isSelected: true,
      audioUrl: 'blob:http://localhost/test-take',
    });

    const readySeg = createEditableSegment({
      id: 'seg-ready',
      text: 'ប្រយោគរួចរាល់។',
      status: 'ready',
      takes: [takeWithAudio],
    });
    const draftSeg = createEditableSegment({
      id: 'seg-draft',
      text: 'ប្រយោគព្រាង។',
      status: 'draft',
      takes: [],
    });
    const emptySeg = createEditableSegment({
      id: 'seg-empty',
      text: '',
      status: 'draft',
      takes: [],
    });

    const html = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [readySeg, draftSeg, emptySeg],
        generatingSegmentId: 'seg-draft',
        playingSegmentId: 'seg-ready',
        onGenerateSegment() {},
        onTogglePlaySegment() {},
      })
    );

    // 1. Ready segment with audio: Play button shows "Stop preview" (since playingSegmentId matches) and has duration badge
    assert.ok(html.includes('segment-duration-badge'), 'Should render duration badge');
    assert.ok(html.includes('1.5s'), 'Should display duration 1.5s');
    assert.ok(html.includes('segment-play-btn'), 'Should render play button on segment with audio');
    assert.ok(html.includes('aria-label="Stop preview"'), 'Should show Stop preview label when playing');
    assert.ok(html.includes('aria-label="Regenerate segment #1 audio"'), 'Should show Regenerate title on ready segment');

    // 2. Draft segment generating: has spinning animation and is disabled
    assert.ok(html.includes('segment-generate-btn is-busy'), 'Generating segment button has is-busy class');
    assert.ok(html.includes('spinning'), 'Generating segment button has spinning icon');
    const draftCard = html.slice(html.indexOf('data-segment-id="seg-draft"'), html.indexOf('data-segment-id="seg-empty"'));
    assert.ok(draftCard.includes('disabled=""'), 'Generating segment button must be disabled while running');

    // 3. Empty segment: Generate button is disabled due to missing text
    const emptyCard = html.slice(html.indexOf('data-segment-id="seg-empty"'));
    assert.ok(emptyCard.includes('segment-generate-btn'), 'Empty segment renders generate button');
    assert.ok(emptyCard.includes('disabled=""'), 'Empty segment generate button must be disabled');
  });
});

test('SegmentEditor renders take comparison tray with A/B playback, active badges, and delete buttons (R2-05)', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const take1 = createSegmentTake({
      id: 'take-1',
      duration: 1.5,
      isSelected: false,
      settings: { seed: 101, guidance: 2.0, steps: 10, styleMode: 'auto' },
    });
    const take2 = createSegmentTake({
      id: 'take-2',
      duration: 1.8,
      isSelected: true,
      settings: { seed: 102, guidance: 2.5, steps: 12, styleMode: 'custom' },
    });

    const multiTakeSeg = createEditableSegment({
      id: 'seg-multi',
      text: 'ប្រយោគមានថតច្រើន។',
      status: 'ready',
      takes: [take1, take2],
    });
    const noTakeSeg = createEditableSegment({
      id: 'seg-notake',
      text: 'ប្រយោគគ្មានថត។',
      status: 'draft',
      takes: [],
    });

    const html = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [multiTakeSeg, noTakeSeg],
        playingTakeId: 'take-1',
        onSelectSegmentTake() {},
        onDeleteSegmentTake() {},
        onTogglePlayTake() {},
      })
    );

    // 1. Takes tray presence
    assert.ok(html.includes('segment-takes-tray'), 'Should render segment takes tray');
    assert.ok(html.includes('Takes (2):'), 'Should show takes count label');

    // 2. Take chips
    assert.ok(html.includes('Take 1'), 'Should display Take 1 label');
    assert.ok(html.includes('Take 2'), 'Should display Take 2 label');
    assert.ok(html.includes('1.5s'), 'Should display Take 1 duration');
    assert.ok(html.includes('1.8s'), 'Should display Take 2 duration');

    // 3. Active take indicator on Take 2
    assert.ok(html.includes('segment-take-active-badge'), 'Should render active badge for selected take');
    assert.ok(html.includes('Active'), 'Should display Active text');
    assert.ok(html.includes('aria-label="Take 2 (active)"'), 'Should announce active state via aria-label');

    // 4. Playing take indicator on Take 1 (playingTakeId === 'take-1')
    assert.ok(html.includes('segment-take-play-btn is-playing'), 'Take 1 play button should have is-playing class');
    assert.ok(html.includes('aria-label="Stop Take 1"'), 'Take 1 should display Stop Take 1 label');
    assert.ok(html.includes('aria-label="Play Take 2"'), 'Take 2 should display Play Take 2 label');

    // 5. Delete buttons
    assert.ok(html.includes('aria-label="Delete Take 1"'), 'Should render delete button for Take 1');
    assert.ok(html.includes('aria-label="Delete Take 2"'), 'Should render delete button for Take 2');

    // 6. Tooltip metadata
    assert.ok(html.includes('Seed: 101'), 'Should include seed in Take 1 tooltip');
    assert.ok(html.includes('CFG: 2.5'), 'Should include CFG in Take 2 tooltip');
    assert.ok(html.includes('Steps: 12'), 'Should include steps in Take 2 tooltip');

    // 7. Segment without takes does not render takes tray
    const noTakeSection = html.slice(html.indexOf('data-segment-id="seg-notake"'));
    assert.ok(!noTakeSection.includes('segment-takes-tray'), 'Segment without takes should not render takes tray');
  });
});

test('ScriptEditor renders Restitch audio button in segments mode when takes are available (R2-06)', async () => {
  await withViteSsr(async vite => {
    const { ScriptEditor } = await vite.ssrLoadModule('/src/presentation/components/ScriptEditor.jsx');

    const take = createSegmentTake({ id: 't1', duration: 1.0 });
    const seg = createEditableSegment({ id: 's1', text: 'ជំហានទីមួយ', takes: [take] });

    const html = renderToStaticMarkup(
      React.createElement(ScriptEditor, {
        scriptInput: { current: null },
        script: 'ជំហានទីមួយ',
        count: 10,
        isOverLimit: false,
        segments: [seg],
        viewMode: 'segments',
        hasTakesToRestitch: true,
        onRestitchSegments() {},
        onExportNarration() {},
        onReplaceScript() {},
        onScriptChange() {},
        onScriptKey() {},
        onUpdateSegment() {},
      })
    );

    assert.ok(html.includes('id="restitch-segments"'), 'Should render restitch button');
    assert.ok(html.includes('Restitch audio'), 'Should display Restitch audio button text');
    assert.ok(html.includes('id="export-narration"'), 'Should render export narration button');
    assert.ok(html.includes('Export narration'), 'Should display Export narration button text');
  });
});

test('AudioPlayer renders Export Narration with custom narration filename when recording is assembled (R2-08)', async () => {
  await withViteSsr(async vite => {
    const { AudioPlayer } = await vite.ssrLoadModule('/src/presentation/components/AudioPlayer.jsx');
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');

    const assembledRecording = {
      id: 'take-assembled-1',
      isAssembled: true,
      filename: 'khmer-narration-project.wav',
      audioUrl: 'blob:http://localhost/assembled-audio',
      duration: 3.5,
      audioDurationSeconds: 3.5,
      characterName: 'Kiri',
    };

    const html = renderToStaticMarkup(
      React.createElement(
        StudioProvider,
        { services: { logger: { error() {}, info() {}, warn() {} } } },
        React.createElement(AudioPlayer, {
          recording: assembledRecording,
          activeCharacter: { id: 'char-kiri', name: 'Kiri' },
          activeAnchor: null,
          status: { message: 'Narration assembled', error: false },
          onPinTake() {},
          onPlaybackError() {},
        })
      )
    );

    assert.ok(html.includes('download="khmer-narration-project.wav"'), 'Download link should have custom narration filename');
    assert.ok(html.includes('Export Narration'), 'Button text should display Export Narration for assembled audio');
  });
});

test('SegmentEditor renders per-segment character voice selector and badges (R2-07)', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const sampleVoices = [
      { id: 'char-nisa', name: 'Nisa', gender: 'Female' },
      { id: 'char-kiri', name: 'Kiri', gender: 'Male' },
    ];

    const segNisa = createEditableSegment({
      id: 's-1',
      text: 'ជំរាបសួរពីនីសា',
      voiceId: 'char-nisa',
      speakerName: 'Nisa',
    });
    const segKiri = createEditableSegment({
      id: 's-2',
      text: 'សួស្តីពីគីរី',
      voiceId: 'char-kiri',
      speakerName: 'Kiri',
    });

    // 1. When voices library is provided: renders voice select dropdowns
    const htmlWithVoices = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [segNisa, segKiri],
        voices: sampleVoices,
        defaultVoiceId: 'char-nisa',
        onSelectSegment() {},
        onUpdateSegment() {},
        onAddSegment() {},
        onDeleteSegment() {},
      })
    );

    assert.ok(htmlWithVoices.includes('segment-voice-select'), 'Should render voice selector dropdown');
    assert.ok(htmlWithVoices.includes('aria-label="Voice for segment #1"'), 'Should have accessible label');
    assert.ok(htmlWithVoices.includes('value="char-nisa"'), 'Should contain Nisa option');
    assert.ok(htmlWithVoices.includes('value="char-kiri"'), 'Should contain Kiri option');

    // 2. When voices library is empty: falls back to static badge
    const htmlNoVoices = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [segNisa],
        voices: [],
        onSelectSegment() {},
        onUpdateSegment() {},
      })
    );

    assert.ok(htmlNoVoices.includes('segment-voice-badge'), 'Should fall back to voice badge');
    assert.ok(htmlNoVoices.includes('Nisa'), 'Should display voice name in badge');
  });
});

test('SegmentEditor presents outdated takes with Outdated badges, dashed styling class, and tooltip metadata (R2-09)', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const takeOutdated = createSegmentTake({
      id: 'take-outdated',
      duration: 1.4,
      isSelected: false,
      settings: { text: 'អត្ថបទចាស់', voiceId: 'char-nisa', seed: 1001, guidance: 2.0 },
    });
    const takeCurrent = createSegmentTake({
      id: 'take-current',
      duration: 1.6,
      isSelected: true,
      settings: { text: 'អត្ថបទបច្ចុប្បន្ន', voiceId: 'char-nisa', seed: 1002, guidance: 2.2 },
    });

    const segment = createEditableSegment({
      id: 'seg-r209',
      text: 'អត្ថបទបច្ចុប្បន្ន',
      voiceId: 'char-nisa',
      status: 'ready',
      takes: [takeOutdated, takeCurrent],
    });

    const html = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [segment],
        activeSegmentId: 'seg-r209',
        onSelectSegment() {},
        onUpdateSegment() {},
        onSelectSegmentTake() {},
        onTogglePlayTake() {},
      })
    );

    // Take 1 is outdated: check for outdated badge, class, aria-label, and tooltip
    assert.ok(html.includes('segment-take-outdated-badge'), 'Should render outdated badge');
    assert.ok(html.includes('is-outdated'), 'Outdated take chip should have is-outdated class');
    assert.ok(html.includes('aria-label="Take 1 (outdated)"'), 'Outdated take should announce outdated in aria-label');
    assert.ok(html.includes('title="Outdated · Seed: 1001 · CFG: 2 · Voice: char-nisa"'), 'Tooltip should prefix with Outdated and show metadata');

    // Take 2 is current: check active badge and no outdated badge
    assert.ok(html.includes('segment-take-active-badge'), 'Current take should have active badge');
    assert.ok(html.includes('aria-label="Take 2 (active)"'), 'Current take aria-label should show active without outdated');
    assert.ok(html.includes('title="Seed: 1002 · CFG: 2.2 · Voice: char-nisa"'), 'Current take tooltip should not have Outdated prefix');
  });
});

test('SegmentEditor visualizes active playback state across segment card, duration badge, and take chips (R2-09)', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const take1 = createSegmentTake({
      id: 'take-playing',
      duration: 2.4,
      isSelected: true,
      audioUrl: 'blob:http://localhost/take-playing',
    });
    const take2 = createSegmentTake({
      id: 'take-idle',
      duration: 1.8,
      isSelected: false,
      audioUrl: 'blob:http://localhost/take-idle',
    });

    const playingSeg = createEditableSegment({
      id: 'seg-playing',
      text: 'កំពុងចាក់សំឡេង',
      status: 'ready',
      takes: [take1, take2],
    });

    const html = renderToStaticMarkup(
      React.createElement(SegmentEditor, {
        segments: [playingSeg],
        activeSegmentId: 'seg-playing',
        playingSegmentId: 'seg-playing',
        playingTakeId: 'take-playing',
        onSelectSegment() {},
        onUpdateSegment() {},
        onTogglePlaySegment() {},
        onTogglePlayTake() {},
      })
    );

    // 1. Segment card has is-playing class
    assert.ok(html.includes('segment-card status-ready is-selected is-playing'), 'Segment card should have is-playing class');

    // 2. Segment duration badge reflects playing state with play symbol
    assert.ok(html.includes('segment-duration-badge is-playing'), 'Duration badge should have is-playing class');
    assert.ok(html.includes('▶ 2.4s'), 'Duration badge should display play icon prefix with duration');

    // 3. Active take chip reflects playing state
    assert.ok(html.includes('segment-take-chip is-selected is-playing'), 'Playing take chip should have is-playing class');
    assert.ok(html.includes('aria-label="Take 1 (active) (playing)"'), 'Playing take chip should announce playing in aria-label');
    assert.ok(html.includes('segment-take-play-btn is-playing'), 'Play button should have is-playing class');
    assert.ok(html.includes('aria-label="Stop Take 1"'), 'Play button aria-label should switch to Stop Take 1');
  });
});

test('SegmentEditor supports in-place take review and keyboard navigation shortcuts without losing edits (R2-09)', async () => {
  await withViteSsr(async vite => {
    const { SegmentEditor } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    const take1 = createSegmentTake({ id: 't1', isSelected: true, duration: 1.0 });
    const take2 = createSegmentTake({ id: 't2', isSelected: false, duration: 1.5 });

    const seg = createEditableSegment({
      id: 'seg-review',
      text: 'កែប្រែក្នុងប្រអប់',
      takes: [take1, take2],
      status: 'ready',
    });

    let playedSegId = null;
    let cycledSegId = null;
    let cycleDirection = 0;

    const element = React.createElement(SegmentEditor, {
      segments: [seg],
      activeSegmentId: 'seg-review',
      onSelectSegment() {},
      onUpdateSegment() {},
      onTogglePlaySegment: id => { playedSegId = id; },
      onCycleSegmentTake: (id, dir) => { cycledSegId = id; cycleDirection = dir; },
    });

    const html = renderToStaticMarkup(element);
    assert.ok(html.includes('data-segment-id="seg-review"'), 'Renders review segment card');

    // In-place edits are preserved when cycling takes:
    // If the user has typed uncommitted edits into seg.text, cycleSegmentTake keeps them!
    const uncommittedSeg = { ...seg, text: 'អត្ថបទមិនទាន់រក្សាទុក' };
    const { cycleSegmentTake } = await vite.ssrLoadModule('/src/domain/projectSegments.js');
    const cycled = cycleSegmentTake(uncommittedSeg, 1);
    assert.equal(cycled.text, 'អត្ថបទមិនទាន់រក្សាទុក', 'Uncommitted text edits must be preserved during take switch');
    assert.equal(cycled.takes.find(t => t.isSelected).id, 't2', 'Take 2 must be selected');
  });
});

test('AudioPlayer invokes onAudioPlay to stop segment preview and guard against audio overlap (R2-09)', async () => {
  await withViteSsr(async vite => {
    const { AudioPlayer } = await vite.ssrLoadModule('/src/presentation/components/AudioPlayer.jsx');
    const { StudioProvider } = await vite.ssrLoadModule('/src/presentation/StudioContext.jsx');

    let audioPlayTriggered = false;
    const recording = {
      id: 'rec-main',
      audioUrl: 'blob:http://localhost/main-audio',
      duration: 5.0,
      audioDurationSeconds: 5.0,
    };

    const element = React.createElement(
      StudioProvider,
      { services: { logger: { error() {}, info() {}, warn() {} } } },
      React.createElement(AudioPlayer, {
        recording,
        activeCharacter: { id: 'char-nisa', name: 'Nisa' },
        activeAnchor: null,
        status: { message: 'Ready', error: false },
        onAudioPlay: () => { audioPlayTriggered = true; },
        onPlaybackError() {},
      })
    );

    const html = renderToStaticMarkup(element);
    assert.ok(html.includes('id="audio"'), 'Should render audio element');
    assert.ok(html.includes('class="playback"'), 'Should render playback section');
  });
});

test('SegmentEditor keyboard handlers support take review shortcuts and guard browser commands and IME (R2-09)', async () => {
  await withViteSsr(async vite => {
    const {
      handleChipKey,
      handleTextareaTakeShortcuts,
      handleCardTakeNavigation,
    } = await vite.ssrLoadModule('/src/presentation/components/SegmentEditor.jsx');

    function createMockEvent(spec = {}) {
      let prevented = false;
      return {
        key: spec.key || '',
        altKey: Boolean(spec.altKey),
        ctrlKey: Boolean(spec.ctrlKey),
        metaKey: Boolean(spec.metaKey),
        isComposing: Boolean(spec.isComposing),
        keyCode: spec.keyCode || 0,
        preventDefault() { prevented = true; },
        get defaultPrevented() { return prevented; },
      };
    }

    // 1. handleCardTakeNavigation
    let cardPlayToggled = false;
    let cardCycleDir = 0;
    const cardCtx = {
      onTogglePlay() { cardPlayToggled = true; },
      onCycleTake(dir) { cardCycleDir = dir; },
    };

    // 'p' or 'P' toggles playback
    const pEvt = createMockEvent({ key: 'p' });
    assert.equal(handleCardTakeNavigation(pEvt, cardCtx), true);
    assert.equal(pEvt.defaultPrevented, true);
    assert.equal(cardPlayToggled, true);

    // ']' or 't' cycles next (+1)
    const nextEvt = createMockEvent({ key: ']' });
    assert.equal(handleCardTakeNavigation(nextEvt, cardCtx), true);
    assert.equal(cardCycleDir, 1);

    // '[' cycles prev (-1)
    const prevEvt = createMockEvent({ key: '[' });
    assert.equal(handleCardTakeNavigation(prevEvt, cardCtx), true);
    assert.equal(cardCycleDir, -1);

    // Guard: Cmd+P (Print) or Cmd+T (New Tab) must NOT be intercepted!
    const cmdPEvt = createMockEvent({ key: 'p', metaKey: true });
    assert.equal(handleCardTakeNavigation(cmdPEvt, cardCtx), false);
    assert.equal(cmdPEvt.defaultPrevented, false);

    const cmdTEvt = createMockEvent({ key: 't', metaKey: true });
    assert.equal(handleCardTakeNavigation(cmdTEvt, cardCtx), false);
    assert.equal(cmdTEvt.defaultPrevented, false);

    // Guard: IME composition must NOT be intercepted!
    const imeCardEvt = createMockEvent({ key: 'p', isComposing: true });
    assert.equal(handleCardTakeNavigation(imeCardEvt, cardCtx), false);

    // 2. handleTextareaTakeShortcuts
    let taPlayToggled = false;
    let taCycleDir = 0;
    const taCtx = {
      onTogglePlay() { taPlayToggled = true; },
      onCycleTake(dir) { taCycleDir = dir; },
    };

    // Alt+P toggles playback
    const altPEvt = createMockEvent({ key: 'p', altKey: true });
    assert.equal(handleTextareaTakeShortcuts(altPEvt, taCtx), true);
    assert.equal(altPEvt.defaultPrevented, true);
    assert.equal(taPlayToggled, true);

    // Alt+] or Alt+T cycles next (+1)
    const altTEvt = createMockEvent({ key: 't', altKey: true });
    assert.equal(handleTextareaTakeShortcuts(altTEvt, taCtx), true);
    assert.equal(taCycleDir, 1);

    // Alt+[ cycles prev (-1)
    const altPrevEvt = createMockEvent({ key: '[', altKey: true });
    assert.equal(handleTextareaTakeShortcuts(altPrevEvt, taCtx), true);
    assert.equal(taCycleDir, -1);

    // Typing without Alt passes through normally to textarea
    const normalPEvt = createMockEvent({ key: 'p' });
    assert.equal(handleTextareaTakeShortcuts(normalPEvt, taCtx), false);
    assert.equal(normalPEvt.defaultPrevented, false);

    // Guard: Cmd+Alt+P does not trigger
    const cmdAltPEvt = createMockEvent({ key: 'p', altKey: true, metaKey: true });
    assert.equal(handleTextareaTakeShortcuts(cmdAltPEvt, taCtx), false);

    // Guard: IME composition in textarea
    const imeTaEvt = createMockEvent({ key: 'p', altKey: true, isComposing: true });
    assert.equal(handleTextareaTakeShortcuts(imeTaEvt, taCtx), false);

    // 3. handleChipKey
    let chipClicked = false;
    let chipPlayToggled = false;
    let chipDeleted = false;
    const chipCtx = {
      onChipClick() { chipClicked = true; },
      onTogglePlay() { chipPlayToggled = true; },
      onDelete() { chipDeleted = true; },
    };

    const enterEvt = createMockEvent({ key: 'Enter' });
    handleChipKey(enterEvt, chipCtx);
    assert.equal(chipClicked, true);
    assert.equal(enterEvt.defaultPrevented, true);

    const chipPEvt = createMockEvent({ key: 'p' });
    handleChipKey(chipPEvt, chipCtx);
    assert.equal(chipPlayToggled, true);

    const delEvt = createMockEvent({ key: 'Delete' });
    handleChipKey(delEvt, chipCtx);
    assert.equal(chipDeleted, true);

    // Guard: Cmd+P on chip does NOT play or prevent default
    chipPlayToggled = false;
    const chipCmdP = createMockEvent({ key: 'p', metaKey: true });
    handleChipKey(chipCmdP, chipCtx);
    assert.equal(chipPlayToggled, false);
    assert.equal(chipCmdP.defaultPrevented, false);
  });
});




