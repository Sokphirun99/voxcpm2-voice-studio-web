/**
 * @fileoverview Pure domain tests for saved subtitle/TTS project validators and snapshot builders.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertProjectId,
  assertProjectKind,
  assertProjectTitle,
  assertProjectPayload,
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
