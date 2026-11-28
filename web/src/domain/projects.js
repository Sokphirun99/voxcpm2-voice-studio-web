/**
 * @fileoverview Pure domain entities, validators, snapshot builders, and schema migrations for Voice Studio projects.
 */

import { ValidationError } from './errors.js';
import { normalizeExportHistory } from './exportHistory.js';
import { normalizeProjectTerminology } from './terminology.js';

export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_TYPES = Object.freeze(['tts', 'subtitles', 'dubbing']);
export const PROJECT_STATUSES = Object.freeze(['draft', 'ready', 'archived']);
export const ASSET_KINDS = Object.freeze(['video', 'audio', 'subtitle', 'other']);

const LEGACY_PROJECT_KINDS = Object.freeze(['subtitle', 'tts']);
const DEFAULT_PROJECT_PAGE_LIMIT = 50;
const MAX_PROJECT_PAGE_LIMIT = 200;
const MAX_PROJECT_TITLE_LENGTH = 200;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MIME_TYPE = 'application/octet-stream';
const DEFAULT_UNTITLED_NAME = 'Untitled project';
const DEFAULT_STATUS = 'draft';
const DEFAULT_REVISION = 1;

const UUID_BYTE_LENGTH = 16;
const UUID_V4_VERSION_MASK = 0x0f;
const UUID_V4_VERSION_SET = 0x40;
const UUID_V4_VARIANT_MASK = 0x3f;
const UUID_V4_VARIANT_SET = 0x80;
const RANDOM_BYTE_CEILING = 256;

/**
 * Validates a project id is a non-empty UUID string.
 * Inputs: id (unknown).
 * Outputs: Normalized project id UUID string.
 * Side effects: none.
 * Failure modes: Throws ValidationError if id is empty, non-string, or invalid UUID format.
 * @param {unknown} id - Candidate project id.
 * @returns {string} Normalized project id.
 */
export function assertProjectId(id) {
  const normalized = typeof id === 'string' ? id.trim() : '';
  if (!normalized || !PROJECT_ID_PATTERN.test(normalized)) {
    throw new ValidationError('Project id must be a UUID.', 'id', 'INVALID_PROJECT_ID');
  }
  return normalized;
}

/**
 * Validates a legacy project kind.
 * Inputs: kind (unknown).
 * Outputs: Normalized kind string.
 * Side effects: none.
 * Failure modes: Throws ValidationError if kind is not 'subtitle' or 'tts'.
 * @param {unknown} kind - Candidate project kind.
 * @returns {string} Normalized kind.
 */
export function assertProjectKind(kind) {
  if (!LEGACY_PROJECT_KINDS.includes(kind)) {
    throw new ValidationError("Project kind must be 'subtitle' or 'tts'.", 'kind', 'INVALID_PROJECT_KIND');
  }
  return kind;
}

/**
 * Validates a project type against supported project types.
 * Inputs: type (unknown).
 * Outputs: Normalized project type ('tts' | 'subtitles' | 'dubbing').
 * Side effects: none.
 * Failure modes: Throws ValidationError if type is not one of PROJECT_TYPES.
 * @param {unknown} type - Candidate project type.
 * @returns {string} Normalized project type.
 */
export function assertProjectType(type) {
  const raw = typeof type === 'string' ? type.trim().toLowerCase() : '';
  const candidate = raw === 'subtitle' ? 'subtitles' : (raw === 'dub' ? 'dubbing' : raw);
  if (!PROJECT_TYPES.includes(candidate)) {
    throw new ValidationError(
      `Project type must be one of: ${PROJECT_TYPES.join(', ')}.`,
      'type',
      'INVALID_PROJECT_TYPE'
    );
  }
  return candidate;
}

/**
 * Validates a project status.
 * Inputs: status (unknown).
 * Outputs: Normalized status string ('draft' | 'ready' | 'archived').
 * Side effects: none.
 * Failure modes: Throws ValidationError if status is not one of PROJECT_STATUSES.
 * @param {unknown} status - Candidate status.
 * @returns {string} Normalized status.
 */
export function assertProjectStatus(status) {
  const candidate = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!PROJECT_STATUSES.includes(candidate)) {
    throw new ValidationError(
      `Project status must be one of: ${PROJECT_STATUSES.join(', ')}.`,
      'status',
      'INVALID_PROJECT_STATUS'
    );
  }
  return candidate;
}

/**
 * Validates a project title or name.
 * Inputs: title (unknown).
 * Outputs: Trimmed title string.
 * Side effects: none.
 * Failure modes: Throws ValidationError if title is empty, non-string, or exceeds max length.
 * @param {unknown} title - Candidate project title.
 * @returns {string} Trimmed title.
 */
export function assertProjectTitle(title) {
  const normalized = typeof title === 'string' ? title.trim() : '';
  if (!normalized) {
    throw new ValidationError('Project title is required.', 'title', 'INVALID_PROJECT_TITLE');
  }
  if (normalized.length > MAX_PROJECT_TITLE_LENGTH) {
    throw new ValidationError('Project title must not exceed 200 characters.', 'title', 'TITLE_TOO_LONG');
  }
  return normalized;
}

/**
 * Validates a project payload is a non-null, non-array object.
 * Inputs: payload (unknown).
 * Outputs: The payload object.
 * Side effects: none.
 * Failure modes: Throws ValidationError if payload is null, array, or non-object.
 * @param {unknown} payload - Candidate project payload.
 * @returns {object} The payload.
 */
export function assertProjectPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('Project payload must be a JSON object.', 'payload', 'INVALID_PROJECT_PAYLOAD');
  }
  return payload;
}

/**
 * Validates that revision is a positive integer >= 1.
 * Inputs: revision (unknown).
 * Outputs: Validated revision integer >= 1.
 * Side effects: none.
 * Failure modes: Throws ValidationError if revision is not an integer >= 1.
 * @param {unknown} revision - Candidate revision number.
 * @returns {number} Validated revision integer.
 */
export function assertProjectRevision(revision) {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ValidationError('Project revision must be an integer >= 1.', 'revision', 'INVALID_PROJECT_REVISION');
  }
  return revision;
}

/**
 * Generates a stable UUID v4 for new project or asset entities.
 * Inputs: none.
 * Outputs: UUID v4 string.
 * Side effects: none.
 * Failure modes: none.
 * @returns {string} UUID v4 string.
 */
export function generateProjectId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(UUID_BYTE_LENGTH);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < UUID_BYTE_LENGTH; i += 1) bytes[i] = Math.floor(Math.random() * RANDOM_BYTE_CEILING);
  }
  bytes[6] = (bytes[6] & UUID_V4_VERSION_MASK) | UUID_V4_VERSION_SET;
  bytes[8] = (bytes[8] & UUID_V4_VARIANT_MASK) | UUID_V4_VARIANT_SET;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateAssetInput(fileName, kind, sizeBytes) {
  const name = typeof fileName === 'string' ? fileName.trim() : '';
  if (!name) throw new ValidationError('Asset fileName is required.', 'fileName', 'INVALID_ASSET_FILENAME');
  if (!ASSET_KINDS.includes(kind)) {
    throw new ValidationError(`Asset kind must be one of: ${ASSET_KINDS.join(', ')}.`, 'kind', 'INVALID_ASSET_KIND');
  }
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new ValidationError('Asset sizeBytes must be an integer >= 0.', 'sizeBytes', 'INVALID_ASSET_SIZE');
  }
  return name;
}

/**
 * Creates and validates an AssetReference entity pointing to durable binary media.
 * Inputs: `{ id, fileName, mimeType, sizeBytes, kind, createdAt }`.
 * Outputs: Frozen AssetReference object.
 * Side effects: none.
 * Failure modes: Throws ValidationError on missing id, empty fileName, invalid kind, or invalid size.
 * @param {object} spec - Asset attributes.
 * @returns {Readonly<{ id: string, fileName: string, mimeType: string, sizeBytes: number, kind: string, createdAt: string }>}
 */
export function createAssetReference({
  id,
  fileName,
  mimeType = DEFAULT_MIME_TYPE,
  sizeBytes = 0,
  kind = 'other',
  createdAt,
} = {}) {
  const normalizedId = assertProjectId(id);
  const name = validateAssetInput(fileName, kind, sizeBytes);
  return Object.freeze({
    id: normalizedId,
    fileName: name,
    mimeType: typeof mimeType === 'string' && mimeType ? mimeType : DEFAULT_MIME_TYPE,
    sizeBytes,
    kind,
    createdAt: typeof createdAt === 'string' && createdAt ? createdAt : new Date().toISOString(),
  });
}

function assertStrictNonNegativeNumber(value, field, code) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative number.`, field, code);
  }
  return value;
}

function validateSegmentInterval(start, end) {
  const numStart = assertStrictNonNegativeNumber(start, 'start', 'INVALID_SEGMENT_START');
  const numEnd = assertStrictNonNegativeNumber(end, 'end', 'INVALID_SEGMENT_END');
  if (numStart !== null && numEnd !== null && numEnd < numStart) {
    throw new ValidationError('Segment end must be >= start.', 'end', 'INVALID_SEGMENT_INTERVAL');
  }
  return { numStart, numEnd };
}

function buildTakeEntity(id, assetId, duration, isSelected, spec) {
  const liveBlob = spec.blob && typeof spec.blob.arrayBuffer === 'function' ? spec.blob : null;
  return Object.freeze({
    id,
    takeId: id,
    audioAssetId: assetId,
    duration,
    isSelected: Boolean(isSelected),
    settings: Object.freeze({ ...(spec.settings || {}) }),
    createdAt: typeof spec.createdAt === 'string' && spec.createdAt ? spec.createdAt : new Date().toISOString(),
    blob: liveBlob,
    audioUrl: typeof spec.audioUrl === 'string' ? spec.audioUrl : null,
  });
}

/**
 * Creates and validates an individual audio take entity.
 * Inputs: `{ id, takeId, audioAssetId, duration, isSelected, settings, createdAt, blob, audioUrl }`.
 * Outputs: Frozen SegmentTake object.
 * Side effects: none.
 * Failure modes: Throws ValidationError on missing id or invalid duration.
 * @param {object} spec - Take attributes.
 * @returns {Readonly<object>} Frozen take object.
 */
export function createSegmentTake(spec = {}) {
  const candidate = spec.id || spec.takeId;
  const normalizedId = typeof candidate === 'string' ? candidate.trim() : '';
  if (!normalizedId) throw new ValidationError('Take id is required.', 'id', 'INVALID_TAKE_ID');
  const normalizedAssetId = spec.audioAssetId ? assertProjectId(spec.audioAssetId) : null;
  const numDuration = assertStrictNonNegativeNumber(spec.duration, 'duration', 'INVALID_TAKE_DURATION');
  return buildTakeEntity(normalizedId, normalizedAssetId, numDuration, spec.isSelected, spec);
}

function normalizeSegmentProps(spec, interval, pauseDuration, takes) {
  const speaker = spec.speaker || spec.speakerId || null;
  return Object.freeze({
    id: typeof spec.id === 'string' ? spec.id.trim() : '',
    text: typeof spec.text === 'string' ? spec.text : '',
    translatedText: typeof spec.translatedText === 'string' ? spec.translatedText : '',
    ...(spec.translationStale ? { translationStale: true } : {}),
    ...(typeof spec.translatedFromText === 'string' ? { translatedFromText: spec.translatedFromText } : {}),
    start: interval.numStart,
    end: interval.numEnd,
    speaker: typeof speaker === 'string' ? speaker : null,
    speakerId: typeof speaker === 'string' ? speaker : null,
    speakerName: typeof spec.speakerName === 'string' ? spec.speakerName : null,
    voiceId: typeof spec.voiceId === 'string' ? spec.voiceId : null,
    status: typeof spec.status === 'string' && spec.status ? spec.status : 'draft',
    takes,
    pauseDuration,
  });
}

/**
 * Creates and validates a ProjectSegment entity for script, subtitle, or dubbing items.
 * Inputs: `{ id, text, translatedText, start, end, speaker, speakerId, speakerName, voiceId, takes, pauseDuration }`.
 * Outputs: Frozen ProjectSegment object.
 * Side effects: none.
 * Failure modes: Throws ValidationError on missing id or invalid timings.
 * @param {object} spec - Segment fields.
 * @returns {Readonly<object>} Frozen ProjectSegment entity.
 */
export function createProjectSegment(spec = {}) {
  if (!spec.id || typeof spec.id !== 'string' || !spec.id.trim()) {
    throw new ValidationError('Segment id is required.', 'id', 'INVALID_SEGMENT_ID');
  }
  const interval = validateSegmentInterval(spec.start, spec.end);
  const pause = assertStrictNonNegativeNumber(spec.pauseDuration, 'pauseDuration', 'INVALID_SEGMENT_PAUSE');
  const takes = Array.isArray(spec.takes) ? Object.freeze(spec.takes.map(createSegmentTake)) : Object.freeze([]);
  return normalizeSegmentProps(spec, interval, pause, takes);
}

function resolveProjectSourceAssetId(type, sourceAssetId) {
  if (!sourceAssetId) return null;
  const normalized = assertProjectId(sourceAssetId);
  if (type === 'tts') {
    throw new ValidationError('Text-to-speech projects must not have a sourceAssetId.', 'sourceAssetId', 'INVALID_SOURCE_ASSET');
  }
  return normalized;
}

function validateProjectHeader(spec) {
  const id = assertProjectId(spec.id);
  const name = assertProjectTitle(spec.name || spec.title);
  const type = assertProjectType(spec.type || spec.kind);
  const status = assertProjectStatus(spec.status || DEFAULT_STATUS);
  const revision = assertProjectRevision(spec.revision || DEFAULT_REVISION);
  if (spec.schemaVersion !== undefined && spec.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported schemaVersion ${spec.schemaVersion}.`, 'schemaVersion', 'UNSUPPORTED_SCHEMA_VERSION');
  }
  return { id, name, type, status, revision };
}

function validateProjectSettings(settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new ValidationError('Project settings must be an object.', 'settings', 'INVALID_PROJECT_SETTINGS');
  }
  return Object.freeze({ ...settings });
}

function buildProjectPayload(type, segments, settings, sourceLang, targetLang, rawPayload = null, terminology = null, exportHistory = null) {
  const extra = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
  const resolvedTerminology = normalizeProjectTerminology(terminology ?? extra.terminology ?? settings.terminology);
  const resolvedExportHistory = normalizeExportHistory(exportHistory ?? extra.exportHistory ?? settings.exportHistory);
  const base = {
    ...extra,
    segments,
    settings: Object.freeze({ ...settings }),
    videoFileName: settings.videoFileName ?? extra.videoFileName ?? null,
    speakerNames: Object.freeze({ ...(extra.speakerNames || {}), ...(settings.speakerNames || {}) }),
    subtitleOptions: Object.freeze({ ...(extra.subtitleOptions || {}), ...(settings.subtitleOptions || settings) }),
    detectedLanguage: sourceLang || extra.detectedLanguage || '',
    translatedLanguage: targetLang || extra.translatedLanguage || '',
    hasTranslation: Boolean(settings.hasTranslation || extra.hasTranslation || segments.some(s => s.translatedText)),
    terminology: resolvedTerminology,
    exportHistory: resolvedExportHistory,
  };
  if (type === 'tts') {
    base.script = settings.script || extra.script || (segments.length ? segments.map(s => s.text).join('\n') : '');
    base.voiceId = settings.voiceId || extra.voiceId || (segments[0]?.voiceId || '');
    base.ttsOptions = Object.freeze({ ...(extra.ttsOptions || {}), ...(settings.ttsOptions || settings) });
  }
  return Object.freeze(base);
}

function buildProjectEntity(hdr, spec, assetId, segments, settings, now) {
  const terminology = normalizeProjectTerminology(spec.terminology ?? spec.settings?.terminology ?? spec.payload?.terminology);
  const exportHistory = normalizeExportHistory(spec.exportHistory ?? spec.payload?.exportHistory ?? spec.settings?.exportHistory);
  const payload = buildProjectPayload(
    hdr.type,
    segments,
    settings,
    spec.sourceLanguage || '',
    spec.targetLanguage || '',
    spec.payload,
    terminology,
    exportHistory
  );
  return Object.freeze({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: hdr.id,
    name: hdr.name,
    title: hdr.name,
    type: hdr.type,
    kind: hdr.type === 'subtitles' ? 'subtitle' : hdr.type,
    status: hdr.status,
    sourceLanguage: typeof spec.sourceLanguage === 'string' ? spec.sourceLanguage : '',
    targetLanguage: typeof spec.targetLanguage === 'string' ? spec.targetLanguage : '',
    sourceAssetId: assetId,
    sourceAsset: spec.sourceAsset ? createAssetReference(spec.sourceAsset) : null,
    segments: Object.freeze(segments),
    settings,
    terminology,
    exportHistory,
    revision: hdr.revision,
    payload,
    createdAt: typeof spec.createdAt === 'string' && spec.createdAt ? spec.createdAt : now,
    updatedAt: typeof spec.updatedAt === 'string' && spec.updatedAt ? spec.updatedAt : now,
    deletedAt: typeof spec.deletedAt === 'string' ? spec.deletedAt : null,
  });
}

/**
 * Creates and validates a complete versioned Project entity.
 * Inputs: `{ id, name, title, type, kind, status, sourceLanguage, targetLanguage, sourceAssetId, sourceAsset, segments, settings, revision, schemaVersion, createdAt, updatedAt, deletedAt }`.
 * Outputs: Frozen versioned Project object.
 * Side effects: none.
 * Failure modes: Throws ValidationError on invalid IDs, types, revisions, or schema mismatches.
 * @param {object} spec - Project specifications.
 * @returns {Readonly<object>} Versioned Project entity.
 */
export function createProject(spec = {}) {
  const hdr = validateProjectHeader(spec);
  const assetId = resolveProjectSourceAssetId(hdr.type, spec.sourceAssetId);
  const settings = validateProjectSettings(spec.settings || {});
  const segments = Array.isArray(spec.segments) ? spec.segments.map(createProjectSegment) : [];
  const now = new Date().toISOString();
  return buildProjectEntity(hdr, spec, assetId, segments, settings, now);
}

function sanitizeMigratedTiming(val) {
  if (val === null || val === undefined) return null;
  const num = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function mapLegacySegment(seg, idx) {
  if (!seg || typeof seg !== 'object') return null;
  const id = typeof seg.id === 'string' && seg.id.trim() ? seg.id.trim() : `seg-${idx + 1}`;
  const start = sanitizeMigratedTiming(seg.start);
  const end = sanitizeMigratedTiming(seg.end);
  const validEnd = start !== null && end !== null && end < start ? start : end;
  return {
    id,
    text: typeof seg.text === 'string' ? seg.text : '',
    translatedText: typeof seg.translatedText === 'string' ? seg.translatedText : '',
    ...(seg.translationStale ? { translationStale: true } : {}),
    ...(typeof seg.translatedFromText === 'string' ? { translatedFromText: seg.translatedFromText } : {}),
    start,
    end: validEnd,
    speaker: seg.speaker || seg.speakerId || null,
    speakerId: seg.speakerId || seg.speaker || null,
    speakerName: seg.speakerName || null,
    voiceId: seg.voiceId || null,
    takes: Array.isArray(seg.takes) ? seg.takes : [],
    pauseDuration: sanitizeMigratedTiming(seg.pauseDuration),
  };
}

function resolveMigratedSegments(payload, type) {
  if (Array.isArray(payload?.segments)) {
    return payload.segments.map(mapLegacySegment).filter(Boolean);
  }
  if (type === 'tts' && typeof payload?.script === 'string' && payload.script.trim()) {
    return [{
      id: 'seg-1',
      text: payload.script,
      translatedText: '',
      start: null,
      end: null,
      speaker: null,
      speakerId: null,
      speakerName: null,
      voiceId: typeof payload.voiceId === 'string' ? payload.voiceId : null,
      takes: [],
      pauseDuration: null,
    }];
  }
  return [];
}

function resolveMigratedSettings(payload, type) {
  const settings = { ...(payload.settings || {}) };
  if (type === 'tts') {
    if (payload.script) settings.script = payload.script;
    if (payload.voiceId) settings.voiceId = payload.voiceId;
    if (payload.ttsOptions) Object.assign(settings, payload.ttsOptions);
  } else {
    if (payload.videoFileName) settings.videoFileName = payload.videoFileName;
    if (payload.speakerNames) settings.speakerNames = payload.speakerNames;
    if (payload.hasTranslation !== undefined) settings.hasTranslation = payload.hasTranslation;
    if (payload.subtitleOptions) Object.assign(settings, payload.subtitleOptions);
  }
  return settings;
}

/**
 * Upgrades a legacy project snapshot to schemaVersion 1.
 * Inputs: raw (object) - Raw legacy or versioned project record.
 * Outputs: Frozen Project entity at schemaVersion 1.
 * Side effects: none.
 * Failure modes: Throws ValidationError on non-object input.
 * @param {unknown} raw - Raw input object.
 * @returns {Readonly<object>} Upgraded Project entity.
 */
export function upgradeProjectSchema(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Project payload to upgrade must be an object.', 'project', 'INVALID_PROJECT_RECORD');
  }
  if (raw.schemaVersion === PROJECT_SCHEMA_VERSION && raw.type) {
    const rawPayload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : {};
    const settings = { ...resolveMigratedSettings(rawPayload, raw.type), ...(raw.settings || {}) };
    return createProject({ ...raw, settings });
  }
  const id = raw.id ? assertProjectId(raw.id) : generateProjectId();
  const title = (raw.name || raw.title || DEFAULT_UNTITLED_NAME).trim() || DEFAULT_UNTITLED_NAME;
  const rawKind = raw.kind || (raw.type === 'subtitles' ? 'subtitle' : 'tts');
  const type = rawKind === 'subtitle' ? 'subtitles' : (rawKind === 'tts' ? 'tts' : 'dubbing');
  const payload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : {};
  const segments = resolveMigratedSegments(payload, type);
  const settings = resolveMigratedSettings(payload, type);
  return createProject({
    id,
    name: title,
    type,
    status: DEFAULT_STATUS,
    sourceLanguage: payload.detectedLanguage || payload.sourceLanguage || '',
    targetLanguage: payload.translatedLanguage || payload.targetLanguage || '',
    sourceAssetId: null,
    segments,
    settings,
    terminology: raw.terminology ?? payload.terminology ?? settings.terminology,
    exportHistory: raw.exportHistory ?? payload.exportHistory ?? settings.exportHistory,
    revision: Number.isInteger(raw.revision) && raw.revision >= 1 ? raw.revision : DEFAULT_REVISION,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    deletedAt: raw.deletedAt || null,
  });
}

/**
 * Normalizes and validates a stored project record for legacy snapshot compatibility.
 * Inputs: raw (unknown).
 * Outputs: Normalized legacy record object.
 * Side effects: none.
 * Failure modes: Throws ValidationError on invalid id, kind, title, or payload.
 * @param {unknown} raw - Raw project record.
 * @returns {{ id: string, kind: string, title: string, payload: object, createdAt: string, updatedAt: string, deletedAt: string|null }} Normalized record.
 */
export function normalizeProjectRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Project record must be an object.', 'project', 'INVALID_PROJECT_RECORD');
  }
  return {
    id: assertProjectId(raw.id),
    kind: assertProjectKind(raw.kind),
    title: assertProjectTitle(raw.title),
    payload: assertProjectPayload(raw.payload),
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date().toISOString(),
    deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : null,
  };
}

/**
 * Returns true when a project record is not soft-deleted.
 * Inputs: record (object|null|undefined).
 * Outputs: Boolean indicating if record is active.
 * Side effects: none.
 * Failure modes: none.
 * @param {object|null|undefined} record - Project record.
 * @returns {boolean} True when active.
 */
export function isProjectActive(record) {
  return Boolean(record && !record.deletedAt);
}

/**
 * Builds a project summary without the full payload.
 * Inputs: record (object).
 * Outputs: Summary object with id, kind, title, createdAt, updatedAt.
 * Side effects: none.
 * Failure modes: none.
 * @param {object} record - Project record.
 * @returns {{ id: string, kind: string, title: string, createdAt: string, updatedAt: string }} Public summary.
 */
export function toProjectSummary(record) {
  const resolvedKind = record.kind || (record.type === 'subtitles' ? 'subtitle' : (record.type || 'tts'));
  const resolvedTitle = record.title || record.name || '';
  return {
    id: record.id,
    kind: resolvedKind,
    title: resolvedTitle,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildSubtitleSnapshotPayload(spec) {
  const rawDur = Number(spec.mediaDuration ?? spec.payload?.mediaDuration);
  const mediaDuration = Number.isFinite(rawDur) && rawDur > 0 ? Math.round(rawDur * 1000) / 1000 : null;
  return {
    videoFileName: typeof spec.videoFileName === 'string' && spec.videoFileName ? spec.videoFileName : null,
    ...(mediaDuration ? { mediaDuration } : {}),
    segments: Array.isArray(spec.segments) ? spec.segments : [],
    speakerNames: typeof spec.speakerNames === 'object' && !Array.isArray(spec.speakerNames) ? spec.speakerNames : {},
    subtitleOptions: typeof spec.subtitleOptions === 'object' && !Array.isArray(spec.subtitleOptions) ? spec.subtitleOptions : {},
    detectedLanguage: typeof spec.detectedLanguage === 'string' ? spec.detectedLanguage : '',
    translatedLanguage: typeof spec.translatedLanguage === 'string' ? spec.translatedLanguage : '',
    hasTranslation: Boolean(spec.hasTranslation),
    terminology: normalizeProjectTerminology(spec.terminology ?? spec.payload?.terminology),
    exportHistory: normalizeExportHistory(spec.exportHistory ?? spec.payload?.exportHistory),
  };
}

/**
 * Builds a subtitle project snapshot for legacy workflows.
 * Inputs: `{ id, title, videoFileName, segments, speakerNames, subtitleOptions, detectedLanguage, translatedLanguage, hasTranslation, terminology, exportHistory, createdAt, updatedAt }`.
 * Outputs: Legacy subtitle project snapshot.
 * Side effects: none.
 * Failure modes: Throws ValidationError on invalid title.
 * @param {object} spec - Snapshot fields.
 * @returns {object} Subtitle project snapshot.
 */
export function createSubtitleProjectSnapshot(spec = {}) {
  const now = new Date().toISOString();
  const payload = buildSubtitleSnapshotPayload(spec);
  return {
    id: spec.id || '',
    kind: 'subtitle',
    title: assertProjectTitle(spec.title),
    terminology: payload.terminology,
    exportHistory: payload.exportHistory,
    payload,
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    deletedAt: null,
  };
}

function buildTtsSnapshotPayload(spec) {
  const segments = Array.isArray(spec.segments)
    ? spec.segments.map(createProjectSegment)
    : (Array.isArray(spec.payload?.segments) ? spec.payload.segments.map(createProjectSegment) : []);
  const sourceLanguage = typeof spec.sourceLanguage === 'string'
    ? spec.sourceLanguage
    : (typeof spec.payload?.detectedLanguage === 'string' ? spec.payload.detectedLanguage : '');
  return {
    script: typeof spec.script === 'string' ? spec.script : '',
    voiceId: typeof spec.voiceId === 'string' ? spec.voiceId : '',
    ttsOptions: typeof spec.ttsOptions === 'object' && !Array.isArray(spec.ttsOptions) ? spec.ttsOptions : {},
    segments,
    ...(sourceLanguage ? { detectedLanguage: sourceLanguage } : {}),
    terminology: normalizeProjectTerminology(spec.terminology ?? spec.payload?.terminology),
    exportHistory: normalizeExportHistory(spec.exportHistory ?? spec.payload?.exportHistory),
  };
}

/**
 * Builds a TTS project snapshot storing script text, voice id, segments, terminology overrides, export history, and synthesis options.
 * Inputs: `{ id, title, script, voiceId, segments, ttsOptions, sourceLanguage, terminology, exportHistory, createdAt, updatedAt }`.
 * Outputs: Complete TTS project snapshot.
 * Side effects: none.
 * Failure modes: Throws ValidationError on invalid title.
 * @param {object} spec - Snapshot fields.
 * @returns {object} TTS project snapshot.
 */
export function createTtsProjectSnapshot(spec = {}) {
  const now = new Date().toISOString();
  const payload = buildTtsSnapshotPayload(spec);
  return {
    id: spec.id || '',
    kind: 'tts',
    type: 'tts',
    title: assertProjectTitle(spec.title),
    ...(payload.detectedLanguage ? { sourceLanguage: payload.detectedLanguage } : {}),
    segments: payload.segments,
    terminology: payload.terminology,
    exportHistory: payload.exportHistory,
    payload,
    createdAt: spec.createdAt || now,
    updatedAt: spec.updatedAt || now,
    deletedAt: null,
  };
}

export { DEFAULT_PROJECT_PAGE_LIMIT, MAX_PROJECT_PAGE_LIMIT };
