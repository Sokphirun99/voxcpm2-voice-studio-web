import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../../src/domain/errors.js';
import {
  EXPORT_PRESET_IDS,
  EXPORT_PRESETS,
  MAX_EXPORT_HISTORY,
  appendExportHistory,
  createExportHistoryEntry,
  evaluateExportPreset,
  evaluateExportPresets,
  formatPresetFilename,
  normalizeExportHistory,
  recordPresetExport,
  resolveExportFilenameStem,
} from '../../src/domain/exportPresets.js';

function createTinyWavBlob(durationSeconds = 0.5) {
  const sampleRate = 48000;
  const frames = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataLen = frames * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const writeAscii = (off, str) => { for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i)); };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLen, true);
  return new Blob([buf], { type: 'audio/wav' });
}

test('domain exportPresets: filename sanitization, fallback hierarchy, and language suffix formatting', () => {
  assert.equal(resolveExportFilenameStem({ videoFileName: 'lesson_01.mkv', projectTitle: 'Ignored Title' }), 'lesson_01');
  assert.equal(resolveExportFilenameStem({ projectTitle: 'Episode 1.5 Intro' }), 'Episode-1.5-Intro');
  assert.equal(resolveExportFilenameStem({ filenameStem: 'v1.2 final.mp4' }), 'v1.2-final');
  assert.equal(resolveExportFilenameStem({ filenameStem: 'custom / name?.mp4', videoFileName: 'fallback.mp4' }), 'custom---name');
  assert.equal(resolveExportFilenameStem({ projectTitle: 'Khmer News ២០២៦' }), 'Khmer-News-២០២៦');
  assert.equal(resolveExportFilenameStem({}), 'subtitle');

  assert.equal(
    formatPresetFilename(EXPORT_PRESET_IDS.SUBTITLE_VTT, { videoFileName: 'clip.mp4', languageCode: 'km', includeLanguageSuffix: true }),
    'clip.km.vtt'
  );
  assert.equal(
    formatPresetFilename(EXPORT_PRESET_IDS.SUBTITLE_SRT, { videoFileName: 'clip.mp4', includeLanguageSuffix: false }),
    'clip.srt'
  );
  assert.equal(
    formatPresetFilename(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, { projectTitle: 'Reopened Doc' }),
    'Reopened-Doc-dubbed.mp4'
  );
  assert.equal(
    formatPresetFilename(EXPORT_PRESET_IDS.TTS_NARRATION_WAV, {}),
    'voxcpm2-narration-narration.wav'
  );
  assert.throws(() => formatPresetFilename('unknown_preset', {}), ValidationError);
});

test('domain exportPresets: evaluates subtitle, audio, and supported MP4 presets with expected outputs, warnings, and blockers', () => {
  assert.equal(EXPORT_PRESETS.length, 8);
  const clipBlob = createTinyWavBlob(0.5);
  const segs = [
    { id: 's1', start: 0.0, end: 1.5, speakerId: 'speaker-1', text: 'First --> cue', translatedText: 'ខ្សែទីមួយ' },
    { id: 's2', start: 2.0, end: 4.0, speakerId: 'speaker-2', text: 'Second cue', translatedText: '' },
  ];

  // Active linked MKV video with partial translations & partial audio clips
  const evals = evaluateExportPresets({
    workspace: 'subtitle',
    videoFileName: 'news_interview.mkv',
    segments: segs,
    segmentClips: { s1: { blob: clipBlob, durationSeconds: 2.2 } },
    detectedLanguage: 'en',
    translatedLanguage: 'khm_Khmr',
    hasTranslation: true,
    languageMode: 'translated',
    dubAudioMode: 'mute',
    videoDuration: 4.5,
    videoSize: { width: 1281, height: 720 },
    hasLinkedVideo: true,
    jobId: 'job-1234',
    burnInSupported: true,
  });

  const byId = Object.fromEntries(evals.map(item => [item.id, item]));
  assert.equal(byId.tts_narration_wav, undefined);

  assert.equal(byId.subtitle_vtt.available, true);
  assert.equal(byId.subtitle_vtt.expectedOutput.filename, 'news_interview.vtt');
  assert.equal(byId.subtitle_vtt.expectedOutput.languageCode, 'km');
  assert.equal(byId.subtitle_vtt.expectedOutput.durationSeconds, 4);
  assert.ok(byId.subtitle_vtt.warnings.some(w => /lack translations/.test(w)));

  const origSrt = evaluateExportPreset(EXPORT_PRESET_IDS.SUBTITLE_SRT, {
    workspace: 'subtitle',
    videoFileName: 'news_interview.mkv',
    segments: segs,
    detectedLanguage: 'en',
    languageMode: 'original',
  });
  assert.ok(origSrt.warnings.some(w => /-->/.test(w)));

  assert.equal(byId.subtitle_aligned_wav.available, false);
  assert.equal(byId.subtitle_aligned_wav.expectedOutput.sampleRate, 48000);
  assert.ok(byId.subtitle_aligned_wav.warnings.some(w => /1 of 2 cues/.test(w)));
  assert.ok(byId.subtitle_aligned_wav.blockers.some(b => /duration mismatch/i.test(b)));

  assert.equal(byId.video_burned_mp4.available, true);
  assert.match(byId.video_burned_mp4.expectedOutput.codec, /H\.264.*AAC/);
  assert.ok(byId.video_burned_mp4.warnings.some(w => /Odd video dimensions/.test(w)));

  assert.equal(byId.video_dubbed_mp4.available, false);
  assert.equal(byId.video_dubbed_mp4.expectedOutput.filename, 'news_interview-dubbed.mp4');
  assert.ok(byId.video_dubbed_mp4.warnings.some(w => /Non-MP4 source container/.test(w)));
  assert.ok(byId.video_dubbed_mp4.warnings.some(w => /muted/.test(w)));
  assert.ok(byId.video_dubbed_mp4.blockers.some(b => /duration mismatch/i.test(b)));

  // Approving speech spill clears mismatch blockers, keeps selectedIds scope, and honors speechLanguage for dubbing
  const spillResolved = evaluateExportPresets({
    workspace: 'subtitle',
    videoFileName: 'news_interview.mkv',
    segments: segs,
    segmentClips: {
      s1: { blob: clipBlob, durationSeconds: 2.2 },
      s2: { blob: clipBlob, durationSeconds: 1.1 },
    },
    selectedIds: ['s2'],
    spillApprovals: { s1: { segmentEnd: 1.5, clipDuration: 2.2 } },
    detectedLanguage: 'en',
    translatedLanguage: 'khm_Khmr',
    speechLanguage: 'fra_Latn',
    hasTranslation: true,
    languageMode: 'original',
    dubAudioMode: 'duck',
    videoDuration: 4.5,
    videoSize: { width: 1280, height: 720 },
    hasLinkedVideo: true,
    jobId: 'job-1234',
    burnInSupported: true,
  });
  const spillById = Object.fromEntries(spillResolved.map(item => [item.id, item]));
  assert.equal(spillById.subtitle_aligned_wav.available, true);
  assert.equal(spillById.subtitle_aligned_wav.expectedOutput.languageCode, 'fr');
  assert.equal(spillById.subtitle_voiceover_wav.expectedOutput.durationSeconds, 1.1);
  assert.equal(spillById.video_dubbed_mp4.available, true);
  assert.equal(spillById.video_dubbed_mp4.expectedOutput.languageCode, 'fr');

  // Exceeding media server MAX_DUB_CLIPS (120) blocks dubbed MP4
  const manySegs = Array.from({ length: 121 }, (_, idx) => ({
    id: `m-${idx}`, start: idx, end: idx + 0.8, text: `Line ${idx}`,
  }));
  const manyClips = Object.fromEntries(manySegs.map(seg => [seg.id, { blob: clipBlob, durationSeconds: 0.6 }]));
  const tooManyDub = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    workspace: 'subtitle',
    videoFileName: 'long.mp4',
    segments: manySegs,
    segmentClips: manyClips,
    videoDuration: 122,
    hasLinkedVideo: true,
    jobId: 'job-many',
  });
  assert.equal(tooManyDub.available, false);
  assert.ok(tooManyDub.blockers.some(b => /120.*clips/.test(b)));

  // Reopened project without linked video file or jobId: captions/WAV stay available, MP4 blocks clearly
  const reopened = evaluateExportPresets({
    workspace: 'subtitle',
    projectTitle: 'Saved Documentary',
    videoFileName: 'doc_cut.mp4',
    segments: segs,
    segmentClips: { s1: { blob: clipBlob, durationSeconds: 1.0 } },
    hasLinkedVideo: false,
    jobId: '',
  });
  const reopenedById = Object.fromEntries(reopened.map(item => [item.id, item]));
  assert.equal(reopenedById.subtitle_srt.available, true);
  assert.equal(reopenedById.subtitle_srt.expectedOutput.filename, 'doc_cut.srt');
  assert.equal(reopenedById.video_burned_mp4.available, false);
  assert.ok(reopenedById.video_burned_mp4.blockers.some(b => /Re-link/.test(b)));

  // Audio-only source & missing libass blockers
  const audioOnlyBurn = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_BURNED_MP4, {
    workspace: 'subtitle',
    segments: segs,
    isAudioOnly: true,
    burnInSupported: false,
  });
  assert.equal(audioOnlyBurn.available, false);
  assert.ok(audioOnlyBurn.blockers.some(b => /audio-only/i.test(b)));
  assert.ok(audioOnlyBurn.blockers.some(b => /libass/.test(b)));

  // TTS workspace presets
  const ttsEmpty = evaluateExportPresets({ workspace: 'tts', ttsRecording: null, ttsSegments: [] });
  assert.equal(ttsEmpty.length, 1);
  assert.equal(ttsEmpty[0].id, EXPORT_PRESET_IDS.TTS_NARRATION_WAV);
  assert.equal(ttsEmpty[0].available, false);

  // Partial segment takes block full-narration restitch until generated
  const ttsPartial = evaluateExportPresets({
    workspace: 'tts',
    projectTitle: 'Voice Story',
    detectedLanguage: 'km',
    ttsRecording: { id: 'rec-1', isAssembled: false, audioDurationSeconds: 3.4 },
    ttsSegments: [
      { id: 't1', text: 'First', takes: [{ id: 'a1', audioAssetId: 'as1', durationSeconds: 1.5 }] },
      { id: 't2', text: 'Second', takes: [] },
    ],
  });
  assert.equal(ttsPartial[0].available, false);
  assert.equal(ttsPartial[0].expectedOutput.filename, 'Voice-Story-narration.wav');
  assert.equal(ttsPartial[0].expectedOutput.durationSeconds, 3.4);
  assert.equal(ttsPartial[0].expectedOutput.languageCode, 'km');
  assert.ok(ttsPartial[0].blockers.some(b => /remaining segment/i.test(b)));

  // Reopened TTS project with complete segment takes estimates duration and warns about assembly
  const ttsReopenedComplete = evaluateExportPresets({
    workspace: 'tts',
    projectTitle: 'Voice Story',
    detectedLanguage: 'km',
    ttsRecording: null,
    ttsSegments: [
      { id: 't1', text: 'First', takes: [{ id: 'a1', audioAssetId: 'as1', durationSeconds: 1.5 }] },
      { id: 't2', text: 'Second', takes: [{ id: 'a2', audioAssetId: 'as2', durationSeconds: 2.0 }] },
    ],
  });
  assert.equal(ttsReopenedComplete[0].available, true);
  assert.equal(ttsReopenedComplete[0].expectedOutput.durationSeconds, 3.7);
  assert.ok(ttsReopenedComplete[0].warnings.some(w => /assembled from segment takes/.test(w)));
});

test('domain exportPresets: export history creation, validation, bounding at 50 entries, and corrupt filtering', () => {
  assert.throws(() => createExportHistoryEntry({ filename: '  ' }), ValidationError);

  let history = [];
  for (let i = 0; i < MAX_EXPORT_HISTORY + 7; i += 1) {
    history = recordPresetExport(history, EXPORT_PRESET_IDS.SUBTITLE_SRT, {
      filename: `export-${i}.srt`,
      durationSeconds: 12.345,
      languageCode: 'km',
      languageLabel: 'Khmer',
    });
  }
  assert.equal(history.length, MAX_EXPORT_HISTORY);
  assert.equal(history[0].filename, `export-${MAX_EXPORT_HISTORY + 6}.srt`);
  assert.equal(history[0].format, 'SRT');
  assert.equal(history[0].durationSeconds, 12.35);

  const cleaned = normalizeExportHistory([
    null,
    'bad',
    { filename: '' },
    { presetId: EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, filename: 'clip-dubbed.mp4', category: 'video', format: 'mp4', durationSeconds: 8.1 },
  ]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].format, 'MP4');
  assert.equal(cleaned[0].filename, 'clip-dubbed.mp4');

  const prepended = appendExportHistory(cleaned, { filename: 'track.wav', format: 'wav' });
  assert.equal(prepended.length, 2);
  assert.equal(prepended[0].filename, 'track.wav');
});
