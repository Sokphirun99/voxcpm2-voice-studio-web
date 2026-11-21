/**
 * @fileoverview Pure domain tests for saved subtitle/TTS/dubbing project validators, entities, and schema migrations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_SCHEMA_VERSION,
  PROJECT_TYPES,
  PROJECT_STATUSES,
  ASSET_KINDS,
  assertProjectId,
  assertProjectKind,
  assertProjectType,
  assertProjectStatus,
  assertProjectTitle,
  assertProjectPayload,
  assertProjectRevision,
  generateProjectId,
  createAssetReference,
  createSegmentTake,
  createProjectSegment,
  createProject,
  upgradeProjectSchema,
  normalizeProjectRecord,
  isProjectActive,
  toProjectSummary,
  createSubtitleProjectSnapshot,
  createTtsProjectSnapshot,
} from '../../src/domain/projects.js';
import { ValidationError } from '../../src/domain/errors.js';

test('domain projects: assertProjectId accepts UUID and rejects invalid', () => {
  const id = assertProjectId('11111111-1111-1111-1111-111111111111');
  assert.equal(id, '11111111-1111-1111-1111-111111111111');

  assert.throws(() => assertProjectId('not-a-uuid'), ValidationError);
  assert.throws(() => assertProjectId('12345'), ValidationError);
  assert.throws(() => assertProjectId(null), ValidationError);
  assert.throws(() => assertProjectId(''), ValidationError);
});

test('domain projects: assertProjectKind accepts subtitle|tts and rejects others', () => {
  assert.equal(assertProjectKind('subtitle'), 'subtitle');
  assert.equal(assertProjectKind('tts'), 'tts');
  assert.throws(() => assertProjectKind('audio'), ValidationError);
  assert.throws(() => assertProjectKind(null), ValidationError);
});

test('domain projects: assertProjectType validates tts, subtitles, dubbing and normalizes subtitle', () => {
  assert.equal(assertProjectType('tts'), 'tts');
  assert.equal(assertProjectType('subtitles'), 'subtitles');
  assert.equal(assertProjectType('dubbing'), 'dubbing');
  assert.equal(assertProjectType('subtitle'), 'subtitles');
  assert.throws(() => assertProjectType('video'), ValidationError);
  assert.throws(() => assertProjectType(null), ValidationError);
});

test('domain projects: assertProjectStatus validates draft, ready, archived', () => {
  assert.equal(assertProjectStatus('draft'), 'draft');
  assert.equal(assertProjectStatus('ready'), 'ready');
  assert.equal(assertProjectStatus('archived'), 'archived');
  assert.throws(() => assertProjectStatus('published'), ValidationError);
  assert.throws(() => assertProjectStatus(null), ValidationError);
});

test('domain projects: assertProjectRevision validates positive integers >= 1', () => {
  assert.equal(assertProjectRevision(1), 1);
  assert.equal(assertProjectRevision(42), 42);
  assert.throws(() => assertProjectRevision(0), ValidationError);
  assert.throws(() => assertProjectRevision(-1), ValidationError);
  assert.throws(() => assertProjectRevision(1.5), ValidationError);
  assert.throws(() => assertProjectRevision('1'), ValidationError);
  assert.throws(() => assertProjectRevision(null), ValidationError);
});

test('domain projects: generateProjectId produces valid UUID v4 format', () => {
  const id = generateProjectId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('domain projects: assertProjectTitle trims and rejects empty', () => {
  assert.equal(assertProjectTitle('  My Project  '), 'My Project');
  assert.throws(() => assertProjectTitle(''), ValidationError);
  assert.throws(() => assertProjectTitle(null), ValidationError);
  assert.throws(() => assertProjectTitle(123), ValidationError);
});

test('domain projects: assertProjectPayload accepts object, rejects null/array/primitive', () => {
  const payload = { key: 'value' };
  assert.equal(assertProjectPayload(payload), payload);
  assert.throws(() => assertProjectPayload(null), ValidationError);
  assert.throws(() => assertProjectPayload([]), ValidationError);
  assert.throws(() => assertProjectPayload('string'), ValidationError);
  assert.throws(() => assertProjectPayload(42), ValidationError);
});

test('domain projects: createAssetReference validates inputs and freezes output', () => {
  const asset = createAssetReference({
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    fileName: 'sample.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1024,
    kind: 'video',
  });
  assert.equal(asset.id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(asset.fileName, 'sample.mp4');
  assert.equal(asset.mimeType, 'video/mp4');
  assert.equal(asset.sizeBytes, 1024);
  assert.equal(asset.kind, 'video');
  assert.ok(asset.createdAt);
  assert.ok(Object.isFrozen(asset));

  // Rejections
  assert.throws(() => createAssetReference({ id: 'bad', fileName: 'sample.mp4' }), ValidationError);
  assert.throws(() => createAssetReference({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fileName: '' }), ValidationError);
  assert.throws(() => createAssetReference({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', fileName: 'test.mp4', kind: 'invalid' }), ValidationError);
});

test('domain projects: createProjectSegment validates timings and freezes output', () => {
  const seg = createProjectSegment({
    id: 'seg-1',
    text: 'Hello world',
    start: 1.5,
    end: 3.0,
    speaker: 'spk1',
    voiceId: 'voice-a',
    takes: [{ takeId: 't1' }],
    pauseDuration: 0.5,
  });
  assert.equal(seg.id, 'seg-1');
  assert.equal(seg.text, 'Hello world');
  assert.equal(seg.start, 1.5);
  assert.equal(seg.end, 3.0);
  assert.equal(seg.speaker, 'spk1');
  assert.equal(seg.voiceId, 'voice-a');
  assert.equal(seg.takes.length, 1);
  assert.equal(seg.pauseDuration, 0.5);
  assert.ok(Object.isFrozen(seg));

  // Missing ID
  assert.throws(() => createProjectSegment({ id: '' }), ValidationError);
  // Negative timing
  assert.throws(() => createProjectSegment({ id: 's2', start: -1 }), ValidationError);
  assert.throws(() => createProjectSegment({ id: 's2', end: -0.5 }), ValidationError);
  // end < start
  assert.throws(() => createProjectSegment({ id: 's2', start: 2.0, end: 1.0 }), ValidationError);
  // Negative pauseDuration
  assert.throws(() => createProjectSegment({ id: 's2', pauseDuration: -1 }), ValidationError);
});

test('domain projects: createProject validates versioned project schema and rules', () => {
  const projectId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const assetId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  // TTS project cannot have sourceAssetId
  assert.throws(() => createProject({
    id: projectId,
    name: 'TTS with asset',
    type: 'tts',
    sourceAssetId: assetId,
  }), ValidationError);

  // Valid TTS project without sourceAssetId
  const ttsProject = createProject({
    id: projectId,
    name: 'Khmer Narration',
    type: 'tts',
    settings: { guidance: 1.5 },
    segments: [{ id: 's1', text: 'សួស្តី' }],
  });
  assert.equal(ttsProject.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(ttsProject.id, projectId);
  assert.equal(ttsProject.name, 'Khmer Narration');
  assert.equal(ttsProject.type, 'tts');
  assert.equal(ttsProject.status, 'draft');
  assert.equal(ttsProject.sourceAssetId, null);
  assert.equal(ttsProject.revision, 1);
  assert.equal(ttsProject.segments.length, 1);
  assert.equal(ttsProject.segments[0].text, 'សួស្តី');
  assert.ok(Object.isFrozen(ttsProject));

  // Valid dubbing project with sourceAssetId
  const dubbingProject = createProject({
    id: projectId,
    name: 'Khmer Dubbing',
    type: 'dubbing',
    sourceAssetId: assetId,
    sourceLanguage: 'km',
    targetLanguage: 'en',
    revision: 3,
  });
  assert.equal(dubbingProject.type, 'dubbing');
  assert.equal(dubbingProject.sourceAssetId, assetId);
  assert.equal(dubbingProject.revision, 3);
  assert.equal(dubbingProject.sourceLanguage, 'km');
  assert.equal(dubbingProject.targetLanguage, 'en');

  // Unsupported schemaVersion throws
  assert.throws(() => createProject({
    id: projectId,
    name: 'Bad version',
    type: 'tts',
    schemaVersion: 999,
  }), ValidationError);
});

test('domain projects: upgradeProjectSchema upgrades legacy records cleanly', () => {
  const legacySubtitle = {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    kind: 'subtitle',
    title: 'Legacy Subtitle',
    payload: {
      detectedLanguage: 'km',
      translatedLanguage: 'en',
      segments: [{ id: 's1', start: 0, end: 2, text: 'ជំរាបសួរ' }],
      subtitleOptions: { bilingual: true },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  const upgraded = upgradeProjectSchema(legacySubtitle);
  assert.equal(upgraded.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(upgraded.id, 'dddddddd-dddd-dddd-dddd-dddddddddddd');
  assert.equal(upgraded.name, 'Legacy Subtitle');
  assert.equal(upgraded.type, 'subtitles');
  assert.equal(upgraded.sourceLanguage, 'km');
  assert.equal(upgraded.targetLanguage, 'en');
  assert.equal(upgraded.segments.length, 1);
  assert.equal(upgraded.segments[0].text, 'ជំរាបសួរ');
  assert.equal(upgraded.settings.bilingual, true);
  assert.equal(upgraded.revision, 1);
  assert.equal(upgraded.createdAt, '2026-01-01T00:00:00.000Z');

  // Idempotent for already versioned projects
  const doubleUpgraded = upgradeProjectSchema(upgraded);
  assert.equal(doubleUpgraded.id, upgraded.id);
  assert.equal(doubleUpgraded.schemaVersion, PROJECT_SCHEMA_VERSION);

  // Invalid payload throws
  assert.throws(() => upgradeProjectSchema(null), ValidationError);
  assert.throws(() => upgradeProjectSchema('string'), ValidationError);
});

test('domain projects: normalizeProjectRecord normalizes and validates', () => {
  const now = new Date().toISOString();
  const record = normalizeProjectRecord({
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    kind: 'subtitle',
    title: 'Test',
    payload: { segments: [] },
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  assert.equal(record.id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(record.kind, 'subtitle');
  assert.equal(record.title, 'Test');
  assert.deepEqual(record.payload, { segments: [] });
  assert.equal(record.createdAt, now);
  assert.equal(record.updatedAt, now);
  assert.equal(record.deletedAt, null);

  // Missing timestamps default to now
  const partial = normalizeProjectRecord({
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    kind: 'tts',
    title: 'Partial',
    payload: { script: 'hello' },
  });
  assert.ok(partial.createdAt);
  assert.ok(partial.updatedAt);
  assert.equal(partial.deletedAt, null);

  // Invalid record throws
  assert.throws(() => normalizeProjectRecord(null), ValidationError);
  assert.throws(() => normalizeProjectRecord({ id: 'bad', kind: 'subtitle', title: 'T', payload: {} }), ValidationError);
});

test('domain projects: isProjectActive returns false for deleted', () => {
  assert.equal(isProjectActive({ deletedAt: null }), true);
  assert.equal(isProjectActive({ deletedAt: '2026-01-01T00:00:00.000Z' }), false);
  assert.equal(isProjectActive(null), false);
  assert.equal(isProjectActive(undefined), false);
});

test('domain projects: toProjectSummary strips payload', () => {
  const summary = toProjectSummary({
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    kind: 'subtitle',
    title: 'Summary',
    payload: { big: 'data' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    deletedAt: null,
  });
  assert.deepEqual(summary, {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    kind: 'subtitle',
    title: 'Summary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
});

test('domain projects: createSubtitleProjectSnapshot stores metadata not blobs', () => {
  const snapshot = createSubtitleProjectSnapshot({
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    title: 'Subtitle Project',
    videoFileName: 'video.mp4',
    segments: [{ id: 's1', start: 0, end: 1, text: 'Hello' }],
    speakerNames: { spk1: 'Narrator' },
    subtitleOptions: { sourceLanguage: 'en' },
    detectedLanguage: 'en',
    translatedLanguage: 'km',
    hasTranslation: true,
  });
  assert.equal(snapshot.kind, 'subtitle');
  assert.equal(snapshot.title, 'Subtitle Project');
  assert.equal(snapshot.payload.videoFileName, 'video.mp4');
  assert.equal(snapshot.payload.segments.length, 1);
  assert.equal(snapshot.payload.speakerNames.spk1, 'Narrator');
  assert.equal(snapshot.payload.subtitleOptions.sourceLanguage, 'en');
  assert.equal(snapshot.payload.detectedLanguage, 'en');
  assert.equal(snapshot.payload.translatedLanguage, 'km');
  assert.equal(snapshot.payload.hasTranslation, true);
  assert.ok(snapshot.createdAt);
  assert.ok(snapshot.updatedAt);
  assert.equal(snapshot.deletedAt, null);
  // No raw video blob in payload
  assert.equal(snapshot.payload.videoFile, undefined);
  assert.equal(snapshot.payload.videoBlob, undefined);

  // Defaults
  const minimal = createSubtitleProjectSnapshot({ title: 'Minimal' });
  assert.equal(minimal.kind, 'subtitle');
  assert.equal(minimal.payload.videoFileName, null);
  assert.deepEqual(minimal.payload.segments, []);
  assert.deepEqual(minimal.payload.speakerNames, {});
  assert.deepEqual(minimal.payload.subtitleOptions, {});
  assert.equal(minimal.payload.hasTranslation, false);
});

test('domain projects: createTtsProjectSnapshot stores script and voice options', () => {
  const snapshot = createTtsProjectSnapshot({
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    title: 'TTS Project',
    script: 'Hello world',
    voiceId: 'voice-1',
    ttsOptions: { guidance: 1.5, steps: 10 },
  });
  assert.equal(snapshot.kind, 'tts');
  assert.equal(snapshot.title, 'TTS Project');
  assert.equal(snapshot.payload.script, 'Hello world');
  assert.equal(snapshot.payload.voiceId, 'voice-1');
  assert.equal(snapshot.payload.ttsOptions.guidance, 1.5);
  assert.equal(snapshot.payload.ttsOptions.steps, 10);

  // Defaults
  const minimal = createTtsProjectSnapshot({ title: 'TTS Minimal' });
  assert.equal(minimal.kind, 'tts');
  assert.equal(minimal.payload.script, '');
  assert.equal(minimal.payload.voiceId, '');
  assert.deepEqual(minimal.payload.ttsOptions, {});
});

test('domain projects: title validation propagates from snapshot builders', () => {
  assert.throws(() => createSubtitleProjectSnapshot({ title: '' }), ValidationError);
  assert.throws(() => createTtsProjectSnapshot({ title: null }), ValidationError);
});

test('domain projects: assertProjectTitle rejects titles exceeding length bounds', () => {
  const tooLong = 'a'.repeat(201);
  assert.throws(() => assertProjectTitle(tooLong), ValidationError);
  assert.equal(assertProjectTitle('a'.repeat(200)), 'a'.repeat(200));
});

test('domain projects: createSegmentTake validates attributes and freezes output', () => {
  const take = createSegmentTake({
    id: 'take-1',
    audioAssetId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    duration: 3.5,
    isSelected: true,
    settings: { ditSteps: 10 },
  });
  assert.equal(take.id, 'take-1');
  assert.equal(take.takeId, 'take-1');
  assert.equal(take.audioAssetId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(take.duration, 3.5);
  assert.equal(take.isSelected, true);
  assert.equal(take.settings.ditSteps, 10);
  assert.ok(Object.isFrozen(take));
  assert.ok(Object.isFrozen(take.settings));

  // Rejections
  assert.throws(() => createSegmentTake({ id: '' }), ValidationError);
  assert.throws(() => createSegmentTake({ id: 't2', duration: -1 }), ValidationError);
  assert.throws(() => createSegmentTake({ id: 't2', duration: 'invalid' }), ValidationError);
});

test('domain projects: createAssetReference rejects negative or non-integer sizeBytes', () => {
  const validId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  assert.throws(() => createAssetReference({ id: validId, fileName: 'a.mp4', sizeBytes: -10 }), ValidationError);
  assert.throws(() => createAssetReference({ id: validId, fileName: 'a.mp4', sizeBytes: 1.5 }), ValidationError);
  assert.throws(() => createAssetReference({ id: validId, fileName: 'a.mp4', sizeBytes: '100' }), ValidationError);
});

test('domain projects: createProjectSegment enforces strict timings and supports translation', () => {
  const seg = createProjectSegment({
    id: 'seg-10',
    text: 'សួស្តី',
    translatedText: 'Hello',
    start: 0,
    end: 2,
    speakerId: 'spk-1',
    speakerName: 'Narrator',
    takes: [{ id: 'take-1', duration: 2.0 }],
  });
  assert.equal(seg.translatedText, 'Hello');
  assert.equal(seg.speaker, 'spk-1');
  assert.equal(seg.speakerId, 'spk-1');
  assert.equal(seg.speakerName, 'Narrator');
  assert.equal(seg.takes.length, 1);
  assert.ok(Object.isFrozen(seg.takes[0]));

  // Strict non-numeric timing rejections
  assert.throws(() => createProjectSegment({ id: 's', start: false }), ValidationError);
  assert.throws(() => createProjectSegment({ id: 's', start: true }), ValidationError);
  assert.throws(() => createProjectSegment({ id: 's', start: '' }), ValidationError);
  assert.throws(() => createProjectSegment({ id: 's', start: [] }), ValidationError);
});

test('domain projects: createProject enforces deep freezing on payload and settings', () => {
  const project = createProject({
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Frozen Test',
    type: 'tts',
    settings: { speed: 1.0 },
    segments: [{ id: 's1', text: 'Hello' }],
  });
  assert.ok(Object.isFrozen(project));
  assert.ok(Object.isFrozen(project.settings));
  assert.ok(Object.isFrozen(project.payload));
  assert.ok(Object.isFrozen(project.payload.settings));
  assert.ok(Object.isFrozen(project.segments));
});

test('domain projects: upgradeProjectSchema migrates legacy TTS without losing script or voiceId', () => {
  const legacyTts = {
    id: '22222222-2222-2222-2222-222222222222',
    kind: 'tts',
    title: 'My Narration',
    payload: {
      script: 'Hello world! Welcome to the studio.',
      voiceId: 'female-1',
      ttsOptions: { guidance: 2.0 },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const upgraded = upgradeProjectSchema(legacyTts);
  assert.equal(upgraded.type, 'tts');
  assert.equal(upgraded.segments.length, 1);
  assert.equal(upgraded.segments[0].text, 'Hello world! Welcome to the studio.');
  assert.equal(upgraded.segments[0].voiceId, 'female-1');
  assert.equal(upgraded.settings.script, 'Hello world! Welcome to the studio.');
  assert.equal(upgraded.settings.voiceId, 'female-1');
  assert.equal(upgraded.settings.guidance, 2.0);
  assert.equal(upgraded.payload.script, 'Hello world! Welcome to the studio.');
  assert.equal(upgraded.payload.voiceId, 'female-1');
});

test('domain projects: upgradeProjectSchema migrates legacy Subtitle preserving videoFileName, speakers, and translation', () => {
  const legacySub = {
    id: '33333333-3333-3333-3333-333333333333',
    kind: 'subtitle',
    title: 'Khmer Lesson',
    payload: {
      videoFileName: 'lesson.mp4',
      speakerNames: { 'spk-1': 'Teacher' },
      detectedLanguage: 'km',
      translatedLanguage: 'en',
      hasTranslation: true,
      segments: [
        { id: 'c1', start: 0, end: 2.5, text: 'សួស្តី', translatedText: 'Hello', speakerId: 'spk-1' },
      ],
      subtitleOptions: { bilingual: true },
    },
  };

  const upgraded = upgradeProjectSchema(legacySub);
  assert.equal(upgraded.type, 'subtitles');
  assert.equal(upgraded.sourceLanguage, 'km');
  assert.equal(upgraded.targetLanguage, 'en');
  assert.equal(upgraded.settings.videoFileName, 'lesson.mp4');
  assert.deepEqual(upgraded.settings.speakerNames, { 'spk-1': 'Teacher' });
  assert.equal(upgraded.settings.hasTranslation, true);
  assert.equal(upgraded.segments.length, 1);
  assert.equal(upgraded.segments[0].text, 'សួស្តី');
  assert.equal(upgraded.segments[0].translatedText, 'Hello');
  assert.equal(upgraded.segments[0].speaker, 'spk-1');
  assert.equal(upgraded.payload.videoFileName, 'lesson.mp4');
});

test('domain projects: upgradeProjectSchema handles null and corrupted legacy segment rows safely', () => {
  const corrupted = {
    id: '44444444-4444-4444-4444-444444444444',
    kind: 'subtitle',
    title: 'Corrupted Legacy',
    payload: {
      segments: [
        null,
        undefined,
        'not-an-object',
        { id: 'c1', start: 5, end: 2, text: 'Inverted timing' },
        { id: 'c2', start: -10, end: -5, text: 'Negative timing' },
        { id: 'c3', start: 1, end: 4, text: 'Valid segment' },
      ],
    },
  };

  const upgraded = upgradeProjectSchema(corrupted);
  assert.equal(upgraded.segments.length, 3);
  assert.equal(upgraded.segments[0].id, 'c1');
  assert.equal(upgraded.segments[0].end, 5); // Sanitized inverted timing (end adjusted to start)
  assert.equal(upgraded.segments[1].id, 'c2');
  assert.equal(upgraded.segments[1].start, null); // Sanitized negative timing
  assert.equal(upgraded.segments[2].id, 'c3');
  assert.equal(upgraded.segments[2].text, 'Valid segment');
});
