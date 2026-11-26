import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../../src/domain/errors.js';
import {
  DEFAULT_DUB_MIX_SETTINGS,
  EXPORT_PRESET_IDS,
  VIDEO_AUDIO_MODES,
  VIDEO_SUBTITLE_MODES,
  assertVideoAudioMode,
  assertVideoSubtitleMode,
  clampDubMixField,
  createExportHistoryEntry,
  evaluateExportPreset,
  formatGainDbLabel,
  formatGainPercentLabel,
  formatVideoAudioModeSummary,
  formatVideoSubtitleModeSummary,
  hasCustomDubMixSettings,
  normalizeDubMixSettings,
  normalizeExportHistory,
  normalizeVideoAudioMode,
  normalizeVideoSubtitleMode,
  resolveCanonicalVideoAudioMode,
  resolveCanonicalVideoSubtitleMode,
  resolveDubVideoCodec,
  validateDubMixSettings,
} from '../../src/domain/exportPresets.js';

function createTinyWavBlob(durationSeconds = 0.4) {
  const sampleRate = 48000;
  const frames = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataLen = frames * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const ascii = (off, str) => { for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i)); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataLen, true);
  return new Blob([buf], { type: 'audio/wav' });
}

test('videoDubExport domain: strict audio/subtitle mode validation, aliases, and mixing/ducking gain bounds', () => {
  assert.equal(resolveCanonicalVideoAudioMode('duck'), VIDEO_AUDIO_MODES.DUCK);
  assert.equal(resolveCanonicalVideoAudioMode('REPLACE'), VIDEO_AUDIO_MODES.REPLACE);
  assert.equal(resolveCanonicalVideoAudioMode('mute'), VIDEO_AUDIO_MODES.REPLACE);
  assert.equal(resolveCanonicalVideoAudioMode('MIX'), VIDEO_AUDIO_MODES.MIX);
  assert.equal(resolveCanonicalVideoAudioMode('keep'), VIDEO_AUDIO_MODES.MIX);
  assert.equal(resolveCanonicalVideoAudioMode('original'), VIDEO_AUDIO_MODES.ORIGINAL);
  assert.equal(resolveCanonicalVideoAudioMode('surround'), null);
  assert.equal(resolveCanonicalVideoAudioMode(null), null);

  assert.throws(() => assertVideoAudioMode('surround'), err => err instanceof ValidationError && err.code === 'INVALID_VIDEO_AUDIO_MODE');
  assert.throws(() => assertVideoAudioMode(''), err => err instanceof ValidationError && err.code === 'INVALID_VIDEO_AUDIO_MODE');
  assert.equal(normalizeVideoAudioMode('replace'), 'mute');
  assert.equal(normalizeVideoAudioMode('bad', 'keep'), 'keep');

  assert.equal(resolveCanonicalVideoSubtitleMode('none'), VIDEO_SUBTITLE_MODES.NONE);
  assert.equal(resolveCanonicalVideoSubtitleMode('BURNED'), VIDEO_SUBTITLE_MODES.BURNED);
  assert.equal(resolveCanonicalVideoSubtitleMode('soft'), VIDEO_SUBTITLE_MODES.SOFT);
  assert.equal(resolveCanonicalVideoSubtitleMode('external'), null);
  assert.throws(() => assertVideoSubtitleMode('external'), err => err instanceof ValidationError && err.code === 'INVALID_VIDEO_SUBTITLE_MODE');
  assert.equal(normalizeVideoSubtitleMode('bad', 'soft'), 'soft');

  assert.equal(clampDubMixField('originalVolume', 0.01), 0.05);
  assert.equal(clampDubMixField('originalVolume', 2.2), 1.5);
  assert.equal(clampDubMixField('dubVolume', 0.1), 0.25);
  assert.equal(clampDubMixField('duckVolume', 0.99), 0.85);
  assert.equal(clampDubMixField('duckVolume', ''), 0.15);

  const defaultMix = normalizeDubMixSettings(null);
  assert.deepEqual(defaultMix, DEFAULT_DUB_MIX_SETTINGS);
  assert.equal(hasCustomDubMixSettings(defaultMix), false);
  assert.equal(hasCustomDubMixSettings({ originalVolume: 0.9, dubVolume: 1, duckVolume: 0.15 }), true);

  assert.deepEqual(validateDubMixSettings({ originalVolume: 0.8, dubVolume: 1.25, duckVolume: 0.25 }), {
    originalVolume: 0.8,
    dubVolume: 1.25,
    duckVolume: 0.25,
  });
  assert.throws(() => validateDubMixSettings({ duckVolume: 0.95 }), err => err instanceof ValidationError && err.code === 'INVALID_DUB_MIX_SETTINGS');
  assert.throws(() => validateDubMixSettings({ originalVolume: 0 }), err => err instanceof ValidationError && err.code === 'INVALID_DUB_MIX_SETTINGS');
  assert.throws(() => validateDubMixSettings([]), err => err instanceof ValidationError && err.code === 'INVALID_DUB_MIX_SETTINGS');

  assert.equal(formatGainDbLabel(0.15), '-16 dB');
  assert.equal(formatGainDbLabel(1.0), '0 dB');
  assert.equal(formatGainDbLabel(1.5), '+4 dB');
  assert.equal(formatGainPercentLabel(0.85), '85%');

  assert.match(formatVideoAudioModeSummary('duck', { originalVolume: 0.8, dubVolume: 1.2, duckVolume: 0.25 }), /Auto-duck mix · Duck 25% \(-12 dB\) · Orig 80% · Voice 120%/);
  assert.equal(formatVideoAudioModeSummary('replace'), 'Replacement dubbing (original muted)');
  assert.equal(formatVideoAudioModeSummary('original', { originalVolume: 0.7, dubVolume: 1, duckVolume: 0.15 }), 'Original audio (70%)');
  assert.equal(formatVideoSubtitleModeSummary('none'), 'No subtitles');
  assert.equal(formatVideoSubtitleModeSummary('soft', { languageMode: 'bilingual', bcp47: 'km', label: 'Khmer' }), 'Embedded track (mov_text) · Bilingual · Khmer (km)');

  const histEntry = createExportHistoryEntry({
    filename: 'episode-dubbed.mp4',
    category: 'video',
    format: 'mp4',
    audioMode: 'replace',
    subtitleMode: 'SOFT',
  });
  assert.equal(histEntry.audioMode, 'mute');
  assert.equal(histEntry.subtitleMode, 'soft');
});

test('evaluateExportPreset(VIDEO_DUBBED_MP4): evaluates all audio/subtitle modes, silent-video guards, and rejects invalid modes', () => {
  const wavBlob = createTinyWavBlob(0.4);
  const baseCtx = {
    workspace: 'subtitle',
    videoFileName: 'khmer_lesson.mp4',
    segments: [{ id: 's1', start: 0.1, end: 1.5, text: 'Hello everyone', translatedText: 'សួស្តីអ្នកទាំងអស់គ្នា' }],
    segmentClips: { s1: { blob: wavBlob, durationSeconds: 0.4 } },
    detectedLanguage: 'en',
    sourceLanguage: 'en',
    translatedLanguage: 'khm_Khmr',
    speechLanguage: 'khm_Khmr',
    hasTranslation: true,
    languageMode: 'translated',
    videoDuration: 3.0,
    hasLinkedVideo: true,
    hasAudioStream: true,
    jobId: 'job-r309',
    burnInSupported: true,
  };

  // 1. Original audio + soft subtitles requires zero voice clips and uses source audio language
  const origSoft = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    ...baseCtx,
    segmentClips: {},
    dubAudioMode: 'original',
    dubSubtitleMode: 'soft',
  });
  assert.equal(origSoft.available, true);
  assert.equal(origSoft.expectedOutput.filename, 'khmer_lesson-captioned.mp4');
  assert.equal(origSoft.expectedOutput.languageCode, 'en');
  assert.equal(origSoft.expectedOutput.audioMode, 'original');
  assert.equal(origSoft.expectedOutput.subtitleMode, 'soft');
  assert.match(origSoft.expectedOutput.codec, /mov_text/);

  // Original audio warns when generated dubbed clips exist because they will not be mixed
  const origWithClips = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    ...baseCtx,
    dubAudioMode: 'original',
    dubSubtitleMode: 'none',
  });
  assert.equal(origWithClips.available, true);
  assert.equal(origWithClips.expectedOutput.filename, 'khmer_lesson-original.mp4');
  assert.ok(origWithClips.warnings.some(w => /will not be mixed/i.test(w)));

  // 2. Replacement dubbing + burned subtitles checks libass support
  const repBurnBlocked = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    ...baseCtx,
    dubAudioMode: 'replace',
    dubSubtitleMode: 'burned',
    burnInSupported: false,
  });
  assert.equal(repBurnBlocked.available, false);
  assert.ok(repBurnBlocked.blockers.some(b => /libass/i.test(b)));

  const repBurnReady = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    ...baseCtx,
    dubAudioMode: 'replace',
    dubSubtitleMode: 'burned',
    burnInSupported: true,
  });
  assert.equal(repBurnReady.available, true);
  assert.equal(repBurnReady.expectedOutput.filename, 'khmer_lesson-dubbed-subtitled.mp4');
  assert.equal(repBurnReady.expectedOutput.languageCode, 'km');
  assert.equal(repBurnReady.expectedOutput.audioMode, 'mute');
  assert.equal(repBurnReady.expectedOutput.subtitleMode, 'burned');

  // 3. Silent source video (`hasAudioStream: false`) blocks duck/keep/original, allows replace/mute
  for (const mode of ['duck', 'keep', 'original']) {
    const blocked = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
      ...baseCtx,
      hasAudioStream: false,
      dubAudioMode: mode,
    });
    assert.equal(blocked.available, false, `Expected ${mode} to be blocked on silent video`);
    assert.ok(blocked.blockers.some(b => /no original audio track/i.test(b)));
  }
  const silentReplace = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    ...baseCtx,
    hasAudioStream: false,
    dubAudioMode: 'replace',
  });
  assert.equal(silentReplace.available, true);

  // 4. Unsupported modes or out-of-range mix settings block explicitly rather than changing silently
  const badAudio = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, { ...baseCtx, dubAudioMode: 'unknown_mode' });
  assert.equal(badAudio.available, false);
  assert.ok(badAudio.blockers.some(b => /Select a supported video audio mode/i.test(b)));

  const badSub = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, { ...baseCtx, dubSubtitleMode: 'ass_external' });
  assert.equal(badSub.available, false);
  assert.ok(badSub.blockers.some(b => /Select a supported video subtitle mode/i.test(b)));

  const badMix = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    ...baseCtx,
    dubMixSettings: { originalVolume: 1, dubVolume: 3.0, duckVolume: 0.15 },
  });
  assert.equal(badMix.available, false);
  assert.ok(badMix.blockers.some(b => /dubVolume must be between/i.test(b)));

  // 5. Zero/negative-duration subtitle cues block burned/soft video exports while allowing subtitleMode='none'
  const zeroCueCtx = {
    ...baseCtx,
    segments: [{ id: 's1', start: 1.0, end: 1.0, text: 'Zero duration', translatedText: 'សូន្យ' }],
  };
  const zeroSoft = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, { ...zeroCueCtx, dubSubtitleMode: 'soft' });
  assert.equal(zeroSoft.available, false);
  assert.ok(zeroSoft.blockers.some(b => /zero or negative duration/i.test(b)));
  const zeroBurn = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_BURNED_MP4, zeroCueCtx);
  assert.equal(zeroBurn.available, false);
  assert.ok(zeroBurn.blockers.some(b => /zero or negative duration/i.test(b)));
  const zeroNone = evaluateExportPreset(EXPORT_PRESET_IDS.VIDEO_DUBBED_MP4, {
    ...zeroCueCtx,
    dubAudioMode: 'original',
    dubSubtitleMode: 'none',
  });
  assert.equal(zeroNone.available, true);

  // 6. Mode-specific codec helper and exportHistory validation error discrimination
  assert.match(resolveDubVideoCodec('burned'), /^H\.264 \(yuv420p\) \+ AAC/);
  assert.match(resolveDubVideoCodec('soft'), /\+ mov_text$/);
  assert.equal(normalizeExportHistory([{ filename: '' }, { filename: 'valid.mp4', category: 'video', format: 'mp4' }]).length, 1);
  const poisoned = Object.defineProperty({}, 'filename', { get() { throw new TypeError('unexpectedgetter'); } });
  assert.throws(() => normalizeExportHistory([poisoned]), TypeError);
});
