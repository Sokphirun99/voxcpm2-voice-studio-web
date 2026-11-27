/**
 * @fileoverview Pure domain entities, validation, bounded queue rules, and lifecycle transitions for persistent batch jobs.
 */

import { ConflictError, ValidationError } from './errors.js';
import { computeSegmentStatus, getSegmentActiveTake } from './projectSegments.js';

export const JOB_SCHEMA_VERSION = 1;
export const MAX_STORED_JOBS = 100;
export const MAX_ACTIVE_QUEUED_JOBS = 25;
export const MAX_JOB_ITEMS = 500;
export const MAX_JOB_TITLE_LENGTH = 200;
export const DEFAULT_MAX_RETRIES = 3;
export const MAX_ALLOWED_RETRIES = 10;
export const STALE_WORKER_HEARTBEAT_MS = 30_000;

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  PREPARING: 'preparing',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCEL_REQUESTED: 'cancel_requested',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
});

export const JOB_STATUSES = Object.freeze(Object.values(JOB_STATUS));
export const JOB_TYPES = Object.freeze([
  'tts_batch',
  'subtitle_voiceover',
  'subtitle_extract',
  'subtitle_translate',
  'video_burn',
  'video_dub',
]);
export const JOB_ITEM_STATUSES = Object.freeze([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'skipped',
]);

export const ACTIVE_JOB_STATUSES = Object.freeze(new Set([
  JOB_STATUS.QUEUED,
  JOB_STATUS.PREPARING,
  JOB_STATUS.RUNNING,
  JOB_STATUS.CANCEL_REQUESTED,
]));
export const IN_FLIGHT_JOB_STATUSES = Object.freeze(new Set([
  JOB_STATUS.PREPARING,
  JOB_STATUS.RUNNING,
  JOB_STATUS.CANCEL_REQUESTED,
]));
export const RETRYABLE_JOB_STATUSES = Object.freeze(new Set([
  JOB_STATUS.FAILED,
  JOB_STATUS.INTERRUPTED,
  JOB_STATUS.CANCELLED,
]));
export const CANCELLABLE_JOB_STATUSES = Object.freeze(new Set([
  JOB_STATUS.QUEUED,
  JOB_STATUS.PREPARING,
  JOB_STATUS.RUNNING,
  JOB_STATUS.CANCEL_REQUESTED,
]));
export const PRUNABLE_HISTORY_STATUSES = Object.freeze(new Set([
  JOB_STATUS.COMPLETED,
  JOB_STATUS.CANCELLED,
  JOB_STATUS.FAILED,
]));

export const VALID_JOB_TRANSITIONS = Object.freeze({
  [JOB_STATUS.QUEUED]: Object.freeze(new Set([
    JOB_STATUS.PREPARING,
    JOB_STATUS.RUNNING,
    JOB_STATUS.CANCEL_REQUESTED,
    JOB_STATUS.CANCELLED,
    JOB_STATUS.FAILED,
    JOB_STATUS.INTERRUPTED,
  ])),
  [JOB_STATUS.PREPARING]: Object.freeze(new Set([
    JOB_STATUS.RUNNING,
    JOB_STATUS.COMPLETED,
    JOB_STATUS.FAILED,
    JOB_STATUS.CANCEL_REQUESTED,
    JOB_STATUS.CANCELLED,
    JOB_STATUS.INTERRUPTED,
  ])),
  [JOB_STATUS.RUNNING]: Object.freeze(new Set([
    JOB_STATUS.COMPLETED,
    JOB_STATUS.FAILED,
    JOB_STATUS.CANCEL_REQUESTED,
    JOB_STATUS.CANCELLED,
    JOB_STATUS.INTERRUPTED,
  ])),
  [JOB_STATUS.CANCEL_REQUESTED]: Object.freeze(new Set([
    JOB_STATUS.CANCELLED,
    JOB_STATUS.COMPLETED,
    JOB_STATUS.FAILED,
    JOB_STATUS.INTERRUPTED,
  ])),
  [JOB_STATUS.FAILED]: Object.freeze(new Set([JOB_STATUS.QUEUED])),
  [JOB_STATUS.INTERRUPTED]: Object.freeze(new Set([JOB_STATUS.QUEUED])),
  [JOB_STATUS.CANCELLED]: Object.freeze(new Set([JOB_STATUS.QUEUED])),
  [JOB_STATUS.COMPLETED]: Object.freeze(new Set()),
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_BYTE_LENGTH = 16;
const UUID_V4_VERSION_MASK = 0x0f;
const UUID_V4_VERSION_SET = 0x40;
const UUID_V4_VARIANT_MASK = 0x3f;
const UUID_V4_VARIANT_SET = 0x80;
const RANDOM_BYTE_CEILING = 256;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const EVICTION_PRIORITY = Object.freeze({
  [JOB_STATUS.COMPLETED]: 0,
  [JOB_STATUS.CANCELLED]: 1,
  [JOB_STATUS.FAILED]: 2,
});

/**
 * Validates that a job identifier is a non-empty UUID string.
 * Inputs: candidate id and optional error field name.
 * Outputs: trimmed UUID string.
 * Side effects: none.
 * Failure modes: throws ValidationError when id is missing or malformed.
 * @param {unknown} id - Candidate job UUID.
 * @param {string} [field='jobId'] - Error field label.
 * @returns {string} Validated UUID string.
 */
export function assertJobId(id, field = 'jobId') {
  const normalized = typeof id === 'string' ? id.trim() : '';
  if (!normalized || !UUID_PATTERN.test(normalized)) {
    throw new ValidationError('Job id must be a UUID.', field, 'INVALID_JOB_ID');
  }
  return normalized;
}

/**
 * Generates a UUID v4 identifier for durable production jobs.
 * Inputs: none.
 * Outputs: UUID v4 string.
 * Side effects: reads cryptographic RNG when available.
 * Failure modes: none.
 * @returns {string} UUID v4 string.
 */
export function generateJobId() {
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

/**
 * Validates a production job type against supported batch workflows.
 * Inputs: raw type string.
 * Outputs: normalized job type string.
 * Side effects: none.
 * Failure modes: throws ValidationError for unsupported job types.
 * @param {unknown} type - Candidate job type.
 * @returns {string} Validated job type.
 */
export function assertJobType(type) {
  const candidate = typeof type === 'string' ? type.trim().toLowerCase() : '';
  if (!JOB_TYPES.includes(candidate)) {
    throw new ValidationError(`Job type must be one of: ${JOB_TYPES.join(', ')}.`, 'type', 'INVALID_JOB_TYPE');
  }
  return candidate;
}

/**
 * Validates a job lifecycle status string.
 * Inputs: candidate status.
 * Outputs: normalized status string.
 * Side effects: none.
 * Failure modes: throws ValidationError for unknown status values.
 * @param {unknown} status - Candidate status.
 * @returns {string} Validated status.
 */
export function assertJobStatus(status) {
  const candidate = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!JOB_STATUSES.includes(candidate)) {
    throw new ValidationError(`Job status must be one of: ${JOB_STATUSES.join(', ')}.`, 'status', 'INVALID_JOB_STATUS');
  }
  return candidate;
}

/**
 * Validates and trims a human-readable batch job title.
 * Inputs: candidate title string.
 * Outputs: trimmed title string.
 * Side effects: none.
 * Failure modes: throws ValidationError if empty or exceeding max length.
 * @param {unknown} title - Candidate job title.
 * @returns {string} Validated title.
 */
export function assertJobTitle(title) {
  const normalized = typeof title === 'string' ? title.trim() : '';
  if (!normalized) {
    throw new ValidationError('Job title is required.', 'title', 'INVALID_JOB_TITLE');
  }
  if (normalized.length > MAX_JOB_TITLE_LENGTH) {
    throw new ValidationError(`Job title must not exceed ${MAX_JOB_TITLE_LENGTH} characters.`, 'title', 'JOB_TITLE_TOO_LONG');
  }
  return normalized;
}

/**
 * Checks whether transitioning from `fromStatus` to `toStatus` is permitted by the lifecycle state machine.
 * Inputs: current status, target status.
 * Outputs: boolean indicating whether transition is legal.
 * Side effects: none.
 * Failure modes: returns false for unknown statuses.
 * @param {string} fromStatus - Current job status.
 * @param {string} toStatus - Candidate next job status.
 * @returns {boolean} True when transition is allowed.
 */
export function canTransitionJobStatus(fromStatus, toStatus) {
  const allowed = VALID_JOB_TRANSITIONS[fromStatus];
  return Boolean(allowed && allowed.has(toStatus));
}

function assertTransition(job, nextStatus, actionLabel) {
  if (!job || typeof job !== 'object') {
    throw new ValidationError('Job record is required.', 'job', 'INVALID_JOB_RECORD');
  }
  if (!canTransitionJobStatus(job.status, nextStatus)) {
    throw new ConflictError(`Cannot ${actionLabel} job from status '${job.status}'.`, {
      code: 'INVALID_JOB_TRANSITION',
    });
  }
}

function sanitizeOptionalUuid(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  const clean = typeof raw === 'string' ? raw.trim() : '';
  if (!clean || !UUID_PATTERN.test(clean)) {
    throw new ValidationError(`${field} must be a UUID.`, field, 'INVALID_UUID');
  }
  return clean;
}

function sanitizeErrorInfo(rawError) {
  if (!rawError) return null;
  if (typeof rawError === 'string') {
    return Object.freeze({ code: 'JOB_ERROR', message: rawError.slice(0, MAX_ERROR_MESSAGE_LENGTH), itemId: null });
  }
  if (typeof rawError !== 'object') return null;
  const message = typeof rawError.message === 'string' && rawError.message.trim()
    ? rawError.message.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH)
    : 'Batch job failed.';
  const code = typeof rawError.code === 'string' && rawError.code.trim() ? rawError.code.trim() : 'JOB_ERROR';
  const itemId = typeof rawError.itemId === 'string' && rawError.itemId.trim() ? rawError.itemId.trim() : null;
  return Object.freeze({ code, message, itemId });
}

function normalizePositiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function normalizeIntegerField(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function validateItemStatus(status) {
  const candidate = typeof status === 'string' ? status.trim().toLowerCase() : 'pending';
  if (!JOB_ITEM_STATUSES.includes(candidate)) {
    throw new ValidationError(`Job item status must be one of: ${JOB_ITEM_STATUSES.join(', ')}.`, 'items', 'INVALID_JOB_ITEM_STATUS');
  }
  return candidate;
}

/**
 * Normalizes and validates one unit of work inside a production batch job.
 * Inputs: raw item object, zero-based index.
 * Outputs: frozen normalized JobItem object.
 * Side effects: none.
 * Failure modes: throws ValidationError on non-object item or invalid UUID asset reference.
 * @param {object} rawItem - Candidate job item.
 * @param {number} [index=0] - Item index.
 * @returns {Readonly<object>} Normalized JobItem.
 */
export function normalizeJobItem(rawItem, index = 0) {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new ValidationError('Each job item must be an object.', 'items', 'INVALID_JOB_ITEM');
  }
  const rawId = rawItem.itemId ?? rawItem.segmentId ?? rawItem.id;
  const itemId = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : `item-${index + 1}`;
  const segmentId = typeof rawItem.segmentId === 'string' && rawItem.segmentId.trim() ? rawItem.segmentId.trim() : null;
  const label = typeof rawItem.label === 'string' && rawItem.label.trim() ? rawItem.label.trim() : `Item #${index + 1}`;
  const status = validateItemStatus(rawItem.status);
  const outputAssetId = sanitizeOptionalUuid(rawItem.outputAssetId, 'outputAssetId');
  return Object.freeze({
    itemId,
    segmentId,
    label,
    status,
    attemptCount: normalizeIntegerField(rawItem.attemptCount, status === 'completed' ? 1 : 0),
    inputSignature: typeof rawItem.inputSignature === 'string' ? rawItem.inputSignature : '',
    outputAssetId,
    takeId: typeof rawItem.takeId === 'string' && rawItem.takeId.trim() ? rawItem.takeId.trim() : null,
    durationSeconds: normalizePositiveNumber(rawItem.durationSeconds),
    seed: rawItem.seed !== undefined && rawItem.seed !== null && Number.isFinite(Number(rawItem.seed)) ? Number(rawItem.seed) : null,
    error: sanitizeErrorInfo(rawItem.error),
    completedAt: typeof rawItem.completedAt === 'string' && rawItem.completedAt ? rawItem.completedAt : null,
    metadata: rawItem.metadata && typeof rawItem.metadata === 'object' && !Array.isArray(rawItem.metadata)
      ? Object.freeze({ ...rawItem.metadata })
      : Object.freeze({}),
  });
}

function buildArtifactKey(artifact) {
  const itemKey = artifact.itemId || artifact.segmentId || '';
  const kindKey = artifact.kind || 'other';
  if (itemKey) return `${itemKey}::${kindKey}`;
  return `asset::${artifact.assetId || artifact.id}`;
}

/**
 * Normalizes and validates a durable job output artifact descriptor.
 * Inputs: raw artifact object.
 * Outputs: frozen JobArtifact object.
 * Side effects: none.
 * Failure modes: throws ValidationError when artifact lacks an identifier or has invalid asset UUID.
 * @param {object} rawArtifact - Candidate artifact descriptor.
 * @returns {Readonly<object>} Frozen JobArtifact.
 */
export function normalizeJobArtifact(rawArtifact) {
  if (!rawArtifact || typeof rawArtifact !== 'object' || Array.isArray(rawArtifact)) {
    throw new ValidationError('Job artifact must be an object.', 'artifacts', 'INVALID_JOB_ARTIFACT');
  }
  const assetId = sanitizeOptionalUuid(rawArtifact.assetId, 'assetId');
  const rawId = rawArtifact.id || assetId || rawArtifact.takeId || rawArtifact.itemId;
  const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : generateJobId();
  return Object.freeze({
    id,
    itemId: typeof rawArtifact.itemId === 'string' && rawArtifact.itemId.trim() ? rawArtifact.itemId.trim() : null,
    segmentId: typeof rawArtifact.segmentId === 'string' && rawArtifact.segmentId.trim() ? rawArtifact.segmentId.trim() : null,
    assetId,
    kind: typeof rawArtifact.kind === 'string' && rawArtifact.kind.trim() ? rawArtifact.kind.trim().toLowerCase() : 'audio',
    fileName: typeof rawArtifact.fileName === 'string' && rawArtifact.fileName.trim() ? rawArtifact.fileName.trim() : 'artifact.bin',
    mimeType: typeof rawArtifact.mimeType === 'string' && rawArtifact.mimeType.trim() ? rawArtifact.mimeType.trim() : 'application/octet-stream',
    sizeBytes: normalizeIntegerField(rawArtifact.sizeBytes, 0),
    takeId: typeof rawArtifact.takeId === 'string' && rawArtifact.takeId.trim() ? rawArtifact.takeId.trim() : null,
    durationSeconds: normalizePositiveNumber(rawArtifact.durationSeconds),
    signature: typeof rawArtifact.signature === 'string' ? rawArtifact.signature : '',
    createdAt: typeof rawArtifact.createdAt === 'string' && rawArtifact.createdAt ? rawArtifact.createdAt : new Date().toISOString(),
  });
}

function mergeDeduplicatedArtifacts(existingArtifacts, additions) {
  const byKey = new Map();
  const order = [];
  for (const item of [...(existingArtifacts || []), ...(additions || [])]) {
    if (!item) continue;
    const normalized = normalizeJobArtifact(item);
    const key = buildArtifactKey(normalized);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, normalized);
  }
  return Object.freeze(order.map(k => byKey.get(k)));
}

function countItemsByStatus(items) {
  const counts = { completed: 0, skipped: 0, failed: 0, running: 0, pending: 0, interrupted: 0, cancelled: 0 };
  for (const item of items) {
    if (item.status in counts) counts[item.status] += 1;
  }
  return counts;
}

/**
 * Computes normalized progress metrics from job items and lifecycle state.
 * Inputs: normalized items array, job status, optional active item id.
 * Outputs: frozen progress object `{ completed, total, failed, pending, running, skipped, currentItemId, currentItemLabel, percent }`.
 * Side effects: none.
 * Failure modes: handles empty item lists gracefully.
 * @param {Array<object>} items - Normalized job items.
 * @param {string} status - Current job status.
 * @param {string|null} [currentItemId=null] - Active item identifier.
 * @returns {Readonly<object>} Progress summary.
 */
export function computeJobProgress(items = [], status = JOB_STATUS.QUEUED, currentItemId = null) {
  const list = Array.isArray(items) ? items : [];
  const counts = countItemsByStatus(list);
  const doneCount = counts.completed + counts.skipped;
  const total = list.length;
  const activeItem = list.find(i => i.itemId === currentItemId) || list.find(i => i.status === 'running') || null;
  let percent = 0;
  if (total > 0) percent = Math.min(100, Math.round((doneCount / total) * 100));
  else if (status === JOB_STATUS.COMPLETED) percent = 100;
  return Object.freeze({
    completed: doneCount,
    total,
    failed: counts.failed,
    pending: counts.pending + counts.interrupted + counts.cancelled,
    running: counts.running,
    skipped: counts.skipped,
    currentItemId: activeItem?.itemId ?? null,
    currentItemLabel: activeItem?.label ?? null,
    percent,
  });
}

function normalizeJobItemsList(rawItems) {
  if (rawItems === undefined || rawItems === null) return Object.freeze([]);
  if (!Array.isArray(rawItems)) {
    throw new ValidationError('Job items must be an array.', 'items', 'INVALID_JOB_ITEMS');
  }
  if (rawItems.length > MAX_JOB_ITEMS) {
    throw new ValidationError(`Job cannot exceed ${MAX_JOB_ITEMS} items.`, 'items', 'TOO_MANY_JOB_ITEMS');
  }
  const seen = new Set();
  const normalized = rawItems.map((item, idx) => {
    const entry = normalizeJobItem(item, idx);
    if (seen.has(entry.itemId)) {
      throw new ValidationError(`Duplicate job itemId '${entry.itemId}'.`, 'items', 'DUPLICATE_JOB_ITEM_ID');
    }
    seen.add(entry.itemId);
    return entry;
  });
  return Object.freeze(normalized);
}

function normalizeRetryBounds(maxRetries, retryCount) {
  const rawMax = maxRetries === undefined ? DEFAULT_MAX_RETRIES : Number(maxRetries);
  if (!Number.isInteger(rawMax) || rawMax < 0 || rawMax > MAX_ALLOWED_RETRIES) {
    throw new ValidationError(`maxRetries must be an integer between 0 and ${MAX_ALLOWED_RETRIES}.`, 'maxRetries', 'INVALID_MAX_RETRIES');
  }
  const cleanRetry = normalizeIntegerField(retryCount, 0);
  return { maxRetries: rawMax, retryCount: cleanRetry };
}

function normalizeJobMetadata(rawMeta) {
  if (!rawMeta) return Object.freeze({});
  if (typeof rawMeta !== 'object' || Array.isArray(rawMeta)) {
    throw new ValidationError('Job metadata must be a plain object.', 'metadata', 'INVALID_JOB_METADATA');
  }
  return Object.freeze({ ...rawMeta });
}

function resolveJobHeader(spec) {
  if (spec.schemaVersion !== undefined && spec.schemaVersion !== JOB_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported job schemaVersion ${spec.schemaVersion}.`, 'schemaVersion', 'UNSUPPORTED_JOB_SCHEMA');
  }
  const id = spec.id ? assertJobId(spec.id, 'id') : generateJobId();
  const type = assertJobType(spec.type);
  const title = assertJobTitle(spec.title);
  const status = spec.status ? assertJobStatus(spec.status) : JOB_STATUS.QUEUED;
  const projectId = sanitizeOptionalUuid(spec.projectId, 'projectId');
  return { id, type, title, status, projectId };
}

function assembleJobEntity({ header, spec, items, artifacts, progress, bounds, nowIso }) {
  const attempt = Math.max(1, normalizeIntegerField(spec.attempt, 1));
  const revision = Math.max(1, normalizeIntegerField(spec.revision, 1));
  return Object.freeze({
    schemaVersion: JOB_SCHEMA_VERSION,
    id: header.id,
    projectId: header.projectId,
    projectTitle: typeof spec.projectTitle === 'string' ? spec.projectTitle.trim().slice(0, MAX_JOB_TITLE_LENGTH) : '',
    type: header.type,
    title: header.title,
    status: header.status,
    items,
    artifacts,
    progress,
    attempt,
    retryCount: bounds.retryCount,
    maxRetries: bounds.maxRetries,
    error: sanitizeErrorInfo(spec.error),
    workerSessionId: typeof spec.workerSessionId === 'string' && spec.workerSessionId.trim() ? spec.workerSessionId.trim() : null,
    lastHeartbeatAt: typeof spec.lastHeartbeatAt === 'string' && spec.lastHeartbeatAt ? spec.lastHeartbeatAt : null,
    cancelRequestedAt: typeof spec.cancelRequestedAt === 'string' && spec.cancelRequestedAt ? spec.cancelRequestedAt : null,
    startedAt: typeof spec.startedAt === 'string' && spec.startedAt ? spec.startedAt : null,
    completedAt: typeof spec.completedAt === 'string' && spec.completedAt ? spec.completedAt : null,
    createdAt: typeof spec.createdAt === 'string' && spec.createdAt ? spec.createdAt : nowIso,
    updatedAt: typeof spec.updatedAt === 'string' && spec.updatedAt ? spec.updatedAt : nowIso,
    revision,
    metadata: normalizeJobMetadata(spec.metadata),
    deletedAt: typeof spec.deletedAt === 'string' ? spec.deletedAt : null,
  });
}

/**
 * Creates and validates a persistent ProductionJob domain entity.
 * Inputs: `{ id, projectId, projectTitle, type, title, status, items, artifacts, maxRetries, metadata, ... }`.
 * Outputs: Frozen versioned ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ValidationError on invalid fields, limits, or malformed identifiers.
 * @param {object} [spec={}] - Job attributes.
 * @returns {Readonly<object>} Frozen ProductionJob entity.
 */
export function createProductionJob(spec = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ValidationError('Job specification must be an object.', 'job', 'INVALID_JOB_RECORD');
  }
  const nowIso = new Date().toISOString();
  const header = resolveJobHeader(spec);
  const items = normalizeJobItemsList(spec.items);
  const artifacts = mergeDeduplicatedArtifacts([], spec.artifacts || []);
  const currentItemId = spec.progress?.currentItemId ?? null;
  const progress = computeJobProgress(items, header.status, currentItemId);
  const bounds = normalizeRetryBounds(spec.maxRetries, spec.retryCount);
  return assembleJobEntity({ header, spec, items, artifacts, progress, bounds, nowIso });
}

/**
 * Creates a clean newly-enqueued ProductionJob with server-owned lifecycle fields reset to initial defaults.
 * Inputs: user/client job creation specification object.
 * Outputs: Frozen ProductionJob entity in `queued` status at revision 1 with `deletedAt: null`.
 * Side effects: none.
 * Failure modes: throws ValidationError on invalid specification fields.
 * @param {object} [spec={}] - Candidate enqueue specification.
 * @returns {Readonly<object>} Frozen queued ProductionJob entity.
 */
export function createQueuedProductionJob(spec = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ValidationError('Job specification must be an object.', 'job', 'INVALID_JOB_RECORD');
  }
  return createProductionJob({
    ...spec,
    status: JOB_STATUS.QUEUED,
    revision: 1,
    attempt: 1,
    retryCount: 0,
    error: null,
    workerSessionId: null,
    lastHeartbeatAt: null,
    cancelRequestedAt: null,
    startedAt: null,
    completedAt: null,
    deletedAt: null,
  });
}

/**
 * Normalizes a persisted raw job record from disk or storage into a frozen ProductionJob entity.
 * Inputs: raw object.
 * Outputs: Frozen ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ValidationError on corrupted or invalid records.
 * @param {unknown} raw - Raw job snapshot.
 * @returns {Readonly<object>} Normalized ProductionJob entity.
 */
export function normalizeProductionJob(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Stored job record must be an object.', 'job', 'INVALID_JOB_RECORD');
  }
  return createProductionJob(raw);
}

function buildUpdatedJob(job, patch, { bumpRevision = true, nowIso = new Date().toISOString() } = {}) {
  const nextItems = patch.items !== undefined ? Object.freeze(patch.items) : job.items;
  const nextStatus = patch.status ?? job.status;
  const nextArtifacts = patch.artifacts !== undefined ? Object.freeze(patch.artifacts) : job.artifacts;
  const currentItemId = patch.currentItemId !== undefined ? patch.currentItemId : job.progress?.currentItemId;
  return createProductionJob({
    ...job,
    ...patch,
    status: nextStatus,
    items: nextItems,
    artifacts: nextArtifacts,
    progress: computeJobProgress(nextItems, nextStatus, currentItemId),
    updatedAt: nowIso,
    revision: bumpRevision ? (job.revision || 1) + 1 : (job.revision || 1),
  });
}

/**
 * Transitions a queued job into the `preparing` stage.
 * Inputs: job entity and optional `{ workerSessionId, nowIso }`.
 * Outputs: updated ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ConflictError if transition from current status is illegal.
 * @param {object} job - Current job.
 * @param {{ workerSessionId?: string|null, nowIso?: string }} [options] - Transition options.
 * @returns {Readonly<object>} Updated job.
 */
export function transitionToPreparing(job, { workerSessionId = null, nowIso = new Date().toISOString() } = {}) {
  assertTransition(job, JOB_STATUS.PREPARING, 'prepare');
  return buildUpdatedJob(job, {
    status: JOB_STATUS.PREPARING,
    workerSessionId: workerSessionId || job.workerSessionId || null,
    lastHeartbeatAt: nowIso,
    startedAt: job.startedAt || nowIso,
    error: null,
  }, { nowIso });
}

function assertWorkerSessionOwner(job, workerSessionId, actionLabel) {
  if (job?.workerSessionId && workerSessionId && job.workerSessionId !== workerSessionId) {
    throw new ConflictError(`Cannot ${actionLabel} job owned by another worker session.`, {
      code: 'WORKER_SESSION_MISMATCH',
    });
  }
}

/**
 * Transitions a `queued` or `preparing` job into the `running` stage.
 * Inputs: job entity and optional `{ workerSessionId, currentItemId, nowIso }`.
 * Outputs: updated ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ConflictError if transition from current status is illegal or owned by another worker.
 * @param {object} job - Current job.
 * @param {{ workerSessionId?: string|null, currentItemId?: string|null, nowIso?: string }} [options] - Transition options.
 * @returns {Readonly<object>} Updated job.
 */
export function transitionToRunning(job, { workerSessionId = null, currentItemId = null, nowIso = new Date().toISOString() } = {}) {
  assertTransition(job, JOB_STATUS.RUNNING, 'start');
  assertWorkerSessionOwner(job, workerSessionId, 'start');
  return buildUpdatedJob(job, {
    status: JOB_STATUS.RUNNING,
    workerSessionId: job.workerSessionId || workerSessionId || null,
    lastHeartbeatAt: nowIso,
    startedAt: job.startedAt || nowIso,
    currentItemId,
    error: null,
  }, { nowIso });
}

/**
 * Updates the active worker heartbeat timestamp without altering completed items.
 * Inputs: job entity and `{ workerSessionId, nowIso }`.
 * Outputs: updated ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ConflictError if job is not in-flight or owned by another worker.
 * @param {object} job - Current job.
 * @param {{ workerSessionId?: string|null, nowIso?: string }} [options] - Heartbeat options.
 * @returns {Readonly<object>} Updated job.
 */
export function touchJobHeartbeat(job, { workerSessionId = null, nowIso = new Date().toISOString() } = {}) {
  if (!IN_FLIGHT_JOB_STATUSES.has(job?.status)) {
    throw new ConflictError(`Cannot send heartbeat for job in status '${job?.status}'.`, { code: 'INVALID_JOB_TRANSITION' });
  }
  assertWorkerSessionOwner(job, workerSessionId, 'heartbeat');
  return buildUpdatedJob(job, {
    workerSessionId: job.workerSessionId || workerSessionId || null,
    lastHeartbeatAt: nowIso,
  }, { nowIso });
}

function assertItemExists(items, itemId) {
  const idx = items.findIndex(item => item.itemId === itemId);
  if (idx < 0) {
    throw new ValidationError(`Job item '${itemId}' was not found.`, 'itemId', 'JOB_ITEM_NOT_FOUND');
  }
  return idx;
}

/**
 * Marks a specific pending/interrupted item as `running` and updates job progress.
 * Inputs: job entity, itemId, optional `{ workerSessionId, nowIso }`.
 * Outputs: updated ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ValidationError if item missing or ConflictError if job is not running/preparing or owned by another worker.
 * @param {object} job - Current job.
 * @param {string} itemId - Item identifier.
 * @param {{ workerSessionId?: string|null, nowIso?: string }} [options] - Execution metadata.
 * @returns {Readonly<object>} Updated job.
 */
export function markJobItemRunning(job, itemId, { workerSessionId = null, nowIso = new Date().toISOString() } = {}) {
  if (job?.status !== JOB_STATUS.RUNNING && job?.status !== JOB_STATUS.PREPARING) {
    throw new ConflictError(`Cannot start item while job status is '${job?.status}'.`, { code: 'INVALID_JOB_TRANSITION' });
  }
  assertWorkerSessionOwner(job, workerSessionId, 'start item on');
  const idx = assertItemExists(job.items, itemId);
  const current = job.items[idx];
  if (current.status === 'completed' || current.status === 'skipped') return job;
  const updatedItem = normalizeJobItem({
    ...current,
    status: 'running',
    attemptCount: (current.attemptCount || 0) + 1,
    error: null,
  }, idx);
  const nextItems = [...job.items.slice(0, idx), updatedItem, ...job.items.slice(idx + 1)];
  return buildUpdatedJob(job, {
    status: JOB_STATUS.RUNNING,
    items: nextItems,
    currentItemId: itemId,
    workerSessionId: job.workerSessionId || workerSessionId || null,
    lastHeartbeatAt: nowIso,
    startedAt: job.startedAt || nowIso,
  }, { nowIso });
}

function buildItemArtifactAddition(item, spec, nowIso) {
  if (spec.artifact) {
    return normalizeJobArtifact({
      ...spec.artifact,
      itemId: spec.artifact.itemId || item.itemId,
      segmentId: spec.artifact.segmentId || item.segmentId,
      assetId: spec.artifact.assetId || spec.outputAssetId || item.outputAssetId,
      takeId: spec.artifact.takeId || spec.takeId || item.takeId,
      durationSeconds: spec.artifact.durationSeconds ?? spec.durationSeconds ?? item.durationSeconds,
      createdAt: spec.artifact.createdAt || nowIso,
    });
  }
  if (!spec.outputAssetId && !spec.takeId) return null;
  return normalizeJobArtifact({
    itemId: item.itemId,
    segmentId: item.segmentId,
    assetId: spec.outputAssetId || null,
    takeId: spec.takeId || null,
    durationSeconds: spec.durationSeconds ?? null,
    fileName: `${item.itemId}.wav`,
    mimeType: 'audio/wav',
    kind: 'audio',
    signature: item.inputSignature || '',
    createdAt: nowIso,
  });
}

function buildCompletedItemRecord(current, spec, idx, nowIso) {
  return normalizeJobItem({
    ...current,
    status: 'completed',
    outputAssetId: spec.resolvedAssetId,
    takeId: spec.resolvedTakeId,
    durationSeconds: spec.durationSeconds ?? current.durationSeconds,
    seed: spec.seed ?? current.seed,
    error: null,
    completedAt: current.completedAt || nowIso,
  }, idx);
}

/**
 * Records completion of a single job item idempotently while deduplicating artifacts.
 * Inputs: job entity and `{ itemId, outputAssetId, takeId, durationSeconds, seed, artifact, nowIso }`.
 * Outputs: updated ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ValidationError if itemId is missing or ConflictError if job is terminal.
 * @param {object} job - Current job.
 * @param {object} spec - Completion payload.
 * @returns {Readonly<object>} Updated job.
 */
export function markJobItemCompleted(job, spec = {}) {
  const { itemId, outputAssetId = null, takeId = null, durationSeconds = null, seed = null, artifact = null, nowIso = new Date().toISOString() } = spec;
  if (!IN_FLIGHT_JOB_STATUSES.has(job?.status)) {
    throw new ConflictError(`Cannot complete item while job status is '${job?.status}'.`, { code: 'INVALID_JOB_TRANSITION' });
  }
  const idx = assertItemExists(job.items, itemId);
  const current = job.items[idx];
  const resolvedAssetId = outputAssetId || artifact?.assetId || current.outputAssetId || null;
  const resolvedTakeId = takeId || artifact?.takeId || current.takeId || null;
  const addition = buildItemArtifactAddition(current, { outputAssetId: resolvedAssetId, takeId: resolvedTakeId, durationSeconds, artifact }, nowIso);
  const nextArtifacts = addition ? mergeDeduplicatedArtifacts(job.artifacts, [addition]) : job.artifacts;
  if (current.status === 'completed' && current.outputAssetId === resolvedAssetId && nextArtifacts.length === job.artifacts.length) {
    return buildUpdatedJob(job, { lastHeartbeatAt: nowIso }, { nowIso });
  }
  const updatedItem = buildCompletedItemRecord(current, { resolvedAssetId, resolvedTakeId, durationSeconds, seed }, idx, nowIso);
  const nextItems = [...job.items.slice(0, idx), updatedItem, ...job.items.slice(idx + 1)];
  return buildUpdatedJob(job, { items: nextItems, artifacts: nextArtifacts, currentItemId: null, lastHeartbeatAt: nowIso }, { nowIso });
}

/**
 * Records a failure for a specific job item without discarding previously completed items.
 * Inputs: job entity and `{ itemId, error, nowIso }`.
 * Outputs: updated ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ValidationError if item missing or ConflictError if job is not active.
 * @param {object} job - Current job.
 * @param {{ itemId: string, error?: unknown, nowIso?: string }} spec - Failure payload.
 * @returns {Readonly<object>} Updated job.
 */
export function markJobItemFailed(job, { itemId, error, nowIso = new Date().toISOString() } = {}) {
  if (!IN_FLIGHT_JOB_STATUSES.has(job?.status)) {
    throw new ConflictError(`Cannot fail item while job status is '${job?.status}'.`, { code: 'INVALID_JOB_TRANSITION' });
  }
  const idx = assertItemExists(job.items, itemId);
  const current = job.items[idx];
  if (current.status === 'completed') return job;
  const updatedItem = normalizeJobItem({ ...current, status: 'failed', error: sanitizeErrorInfo(error) }, idx);
  const nextItems = [...job.items.slice(0, idx), updatedItem, ...job.items.slice(idx + 1)];
  return buildUpdatedJob(job, { items: nextItems, currentItemId: null, lastHeartbeatAt: nowIso }, { nowIso });
}

/**
 * Transitions an in-flight job to `completed` and merges any final output artifacts without duplication.
 * Inputs: job entity and optional `{ artifact, artifacts, nowIso }`.
 * Outputs: completed ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ConflictError if job cannot transition to completed.
 * @param {object} job - Current job.
 * @param {{ artifact?: object|null, artifacts?: Array<object>, nowIso?: string }} [options] - Completion options.
 * @returns {Readonly<object>} Completed job.
 */
export function completeProductionJob(job, { artifact = null, artifacts = [], nowIso = new Date().toISOString() } = {}) {
  assertTransition(job, JOB_STATUS.COMPLETED, 'complete');
  const blockedItem = job.items.find(item => item.status === 'failed' || item.status === 'interrupted' || item.status === 'cancelled');
  if (blockedItem) {
    throw new ConflictError(`Cannot complete job while items are in '${blockedItem.status}' status.`, {
      code: 'INVALID_JOB_TRANSITION',
    });
  }
  const additions = [...(Array.isArray(artifacts) ? artifacts : []), ...(artifact ? [artifact] : [])];
  const nextArtifacts = additions.length > 0 ? mergeDeduplicatedArtifacts(job.artifacts, additions) : job.artifacts;
  const nextItems = job.items.map((item, idx) => (
    item.status === 'running' || item.status === 'pending'
      ? normalizeJobItem({ ...item, status: 'completed', error: null, completedAt: item.completedAt || nowIso }, idx)
      : item
  ));
  return buildUpdatedJob(job, {
    status: JOB_STATUS.COMPLETED,
    items: nextItems,
    artifacts: nextArtifacts,
    currentItemId: null,
    error: null,
    completedAt: nowIso,
    lastHeartbeatAt: nowIso,
  }, { nowIso });
}

/**
 * Transitions an active job to `failed` while preserving all previously completed items and artifacts.
 * Inputs: job entity and `{ code, message, itemId, nowIso }`.
 * Outputs: failed ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ConflictError if job cannot transition to failed.
 * @param {object} job - Current job.
 * @param {{ code?: string, message?: string, itemId?: string|null, nowIso?: string }} [options] - Failure info.
 * @returns {Readonly<object>} Failed job.
 */
export function failProductionJob(job, { code = 'JOB_FAILED', message = 'Batch job failed.', itemId = null, nowIso = new Date().toISOString() } = {}) {
  assertTransition(job, JOB_STATUS.FAILED, 'fail');
  const errInfo = sanitizeErrorInfo({ code, message, itemId });
  const nextItems = job.items.map((item, idx) => (
    item.status === 'running' || (itemId && item.itemId === itemId && item.status !== 'completed')
      ? normalizeJobItem({ ...item, status: 'failed', error: errInfo }, idx)
      : item
  ));
  return buildUpdatedJob(job, {
    status: JOB_STATUS.FAILED,
    items: nextItems,
    currentItemId: null,
    error: errInfo,
    lastHeartbeatAt: nowIso,
  }, { nowIso });
}

/**
 * Requests cancellation (`queued -> cancelled` immediately, or `preparing|running -> cancel_requested`, or finalizes cancellation).
 * Inputs: job entity and optional `{ finalize, nowIso }`.
 * Outputs: updated ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ConflictError if job is already completed, failed, interrupted, or cancelled.
 * @param {object} job - Current job.
 * @param {{ finalize?: boolean, nowIso?: string }} [options] - Cancellation options.
 * @returns {Readonly<object>} Updated job.
 */
export function requestCancelProductionJob(job, { finalize = false, nowIso = new Date().toISOString() } = {}) {
  if (!job || typeof job !== 'object') {
    throw new ValidationError('Job record is required.', 'job', 'INVALID_JOB_RECORD');
  }
  if (finalize || job.status === JOB_STATUS.QUEUED) {
    return finalizeCancelledProductionJob(job, { nowIso });
  }
  if (job.status === JOB_STATUS.CANCEL_REQUESTED) return job;
  assertTransition(job, JOB_STATUS.CANCEL_REQUESTED, 'cancel');
  return buildUpdatedJob(job, {
    status: JOB_STATUS.CANCEL_REQUESTED,
    cancelRequestedAt: job.cancelRequestedAt || nowIso,
    lastHeartbeatAt: nowIso,
  }, { nowIso });
}

/**
 * Finalizes cancellation of an active job while strictly preserving completed items and artifacts.
 * Inputs: job entity and optional `{ nowIso }`.
 * Outputs: cancelled ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ConflictError if job is not cancellable.
 * @param {object} job - Current job.
 * @param {{ nowIso?: string }} [options] - Finalize options.
 * @returns {Readonly<object>} Cancelled job.
 */
export function finalizeCancelledProductionJob(job, { nowIso = new Date().toISOString() } = {}) {
  if (job?.status === JOB_STATUS.CANCELLED) return job;
  assertTransition(job, JOB_STATUS.CANCELLED, 'cancel');
  const nextItems = job.items.map((item, idx) => (
    item.status === 'completed' || item.status === 'skipped'
      ? item
      : normalizeJobItem({ ...item, status: 'cancelled' }, idx)
  ));
  return buildUpdatedJob(job, {
    status: JOB_STATUS.CANCELLED,
    items: nextItems,
    currentItemId: null,
    cancelRequestedAt: job.cancelRequestedAt || nowIso,
    completedAt: nowIso,
    lastHeartbeatAt: nowIso,
  }, { nowIso });
}

/**
 * Marks an active or in-flight job as `interrupted` while preserving all completed outputs.
 * Inputs: job entity and optional `{ reason, nowIso }`.
 * Outputs: interrupted ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ConflictError if job cannot transition to interrupted.
 * @param {object} job - Current job.
 * @param {{ reason?: string, nowIso?: string }} [options] - Interruption metadata.
 * @returns {Readonly<object>} Interrupted job.
 */
export function markJobInterrupted(job, { reason = 'Job interrupted by service restart. Retry to resume remaining items.', nowIso = new Date().toISOString() } = {}) {
  if (job?.status === JOB_STATUS.INTERRUPTED) return job;
  assertTransition(job, JOB_STATUS.INTERRUPTED, 'interrupt');
  const nextItems = job.items.map((item, idx) => (
    item.status === 'running'
      ? normalizeJobItem({ ...item, status: 'interrupted' }, idx)
      : item
  ));
  return buildUpdatedJob(job, {
    status: JOB_STATUS.INTERRUPTED,
    items: nextItems,
    currentItemId: null,
    error: sanitizeErrorInfo({ code: 'JOB_INTERRUPTED', message: reason }),
    lastHeartbeatAt: nowIso,
  }, { nowIso });
}

/**
 * Retries a `failed`, `interrupted`, or `cancelled` job by re-queueing only unfinished items and preserving completed artifacts.
 * Inputs: job entity and optional `{ nowIso }`.
 * Outputs: re-queued ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ConflictError if status is not retryable, or ValidationError when retry budget is exhausted.
 * @param {object} job - Target job.
 * @param {{ nowIso?: string }} [options] - Retry options.
 * @returns {Readonly<object>} Re-queued job.
 */
export function retryProductionJob(job, { nowIso = new Date().toISOString() } = {}) {
  assertTransition(job, JOB_STATUS.QUEUED, 'retry');
  if ((job.retryCount || 0) >= (job.maxRetries ?? DEFAULT_MAX_RETRIES)) {
    throw new ValidationError('Maximum retry attempts reached for this job.', 'retryCount', 'MAX_RETRIES_EXCEEDED');
  }
  const nextItems = job.items.map((item, idx) => {
    if (item.status === 'completed' || item.status === 'skipped') return item;
    return normalizeJobItem({ ...item, status: 'pending', error: null }, idx);
  });
  return buildUpdatedJob(job, {
    status: JOB_STATUS.QUEUED,
    items: nextItems,
    artifacts: job.artifacts,
    attempt: (job.attempt || 1) + 1,
    retryCount: (job.retryCount || 0) + 1,
    error: null,
    workerSessionId: null,
    lastHeartbeatAt: null,
    cancelRequestedAt: null,
    completedAt: null,
    currentItemId: null,
  }, { nowIso });
}

/**
 * Returns only unfinished job items so retry execution never duplicates completed outputs.
 * Inputs: job entity.
 * Outputs: ordered array of unfinished JobItem objects.
 * Side effects: none.
 * Failure modes: returns empty array for invalid job.
 * @param {object|null} job - ProductionJob entity.
 * @returns {Array<object>} Unfinished items.
 */
export function getPendingJobItems(job) {
  if (!job || !Array.isArray(job.items)) return [];
  return job.items.filter(item => item && item.status !== 'completed' && item.status !== 'skipped');
}

/**
 * Checks whether an item already has a completed state or durable artifact in the job.
 * Inputs: job entity, itemId.
 * Outputs: boolean indicating existing completed output.
 * Side effects: none.
 * Failure modes: returns false for missing inputs.
 * @param {object|null} job - ProductionJob entity.
 * @param {string} itemId - Target item identifier.
 * @returns {boolean} True when item is already completed.
 */
export function hasCompletedItemArtifact(job, itemId) {
  if (!job || !itemId) return false;
  const item = (job.items || []).find(entry => entry.itemId === itemId);
  if (item?.status === 'completed') return true;
  return (job.artifacts || []).some(art => art.itemId === itemId && Boolean(art.assetId || art.takeId));
}

/**
 * Counts jobs across lifecycle statuses for UI badges and API metadata.
 * Inputs: array of job entities.
 * Outputs: summary count object `{ total, active, queued, preparing, running, cancel_requested, completed, failed, cancelled, interrupted }`.
 * Side effects: none.
 * Failure modes: handles non-array input gracefully.
 * @param {Array<object>} jobs - Job records.
 * @returns {Readonly<object>} Job status summary counts.
 */
export function summarizeJobs(jobs = []) {
  const counts = Object.fromEntries(JOB_STATUSES.map(status => [status, 0]));
  const list = Array.isArray(jobs) ? jobs : [];
  for (const job of list) {
    if (job && !job.deletedAt && job.status in counts) counts[job.status] += 1;
  }
  const active = counts.queued + counts.preparing + counts.running + counts.cancel_requested;
  const total = list.filter(job => job && !job.deletedAt).length;
  return Object.freeze({ total, active, ...counts });
}

/**
 * Selects oldest finished history jobs (`completed`, `cancelled`, `failed`) to evict when enforcing `maxJobs`.
 * Never selects `active` or `interrupted` jobs so recovery candidates are preserved.
 * Inputs: existing jobs array, maxJobs ceiling.
 * Outputs: `{ evictIds: string[], canAdmit: boolean }`.
 * Side effects: none.
 * Failure modes: sets `canAdmit=false` if active + interrupted jobs already saturate `maxJobs`.
 * @param {Array<object>} jobs - Existing non-deleted job records.
 * @param {number} [maxJobs=MAX_STORED_JOBS] - Maximum stored job ceiling.
 * @returns {{ evictIds: string[], canAdmit: boolean }} Eviction plan.
 */
export function selectEvictableJobs(jobs = [], maxJobs = MAX_STORED_JOBS) {
  const activeList = (Array.isArray(jobs) ? jobs : []).filter(job => job && !job.deletedAt);
  const neededFree = activeList.length - Math.max(1, maxJobs) + 1;
  if (neededFree <= 0) return { evictIds: [], canAdmit: true };
  const prunable = activeList
    .filter(job => PRUNABLE_HISTORY_STATUSES.has(job.status))
    .sort((a, b) => {
      const pDiff = (EVICTION_PRIORITY[a.status] ?? 9) - (EVICTION_PRIORITY[b.status] ?? 9);
      if (pDiff !== 0) return pDiff;
      return String(a.updatedAt || a.createdAt || '').localeCompare(String(b.updatedAt || b.createdAt || ''));
    });
  if (prunable.length < neededFree) return { evictIds: [], canAdmit: false };
  return { evictIds: prunable.slice(0, neededFree).map(job => job.id), canAdmit: true };
}

/**
 * Determines whether an in-flight job belongs to a crashed/reloaded client worker and should be marked interrupted.
 * Inputs: job record and session/clock context `{ currentSessionId, previousSessionId, nowMs, staleAfterMs }`.
 * Outputs: boolean indicating stale orphaned execution.
 * Side effects: none.
 * Failure modes: returns false for non-in-flight jobs or synthetic mock jobs lacking workerSessionId.
 * @param {object} job - ProductionJob entity.
 * @param {object} [context={}] - Session & heartbeat context.
 * @returns {boolean} True when job worker is stale/dead.
 */
export function isJobWorkerStale(job, context = {}) {
  if (!job || !IN_FLIGHT_JOB_STATUSES.has(job.status) || !job.workerSessionId) return false;
  const {
    currentSessionId = '',
    previousSessionId = '',
    activeJobIds = null,
    nowMs = Date.now(),
    staleAfterMs = STALE_WORKER_HEARTBEAT_MS,
  } = context;
  if (currentSessionId && job.workerSessionId === currentSessionId) {
    if (!activeJobIds || activeJobIds.has(job.id)) return false;
  }
  if (previousSessionId && job.workerSessionId === previousSessionId) return true;
  const beatMs = Date.parse(job.lastHeartbeatAt || job.updatedAt || '');
  return Number.isFinite(beatMs) && (nowMs - beatMs) > staleAfterMs;
}

/**
 * Strips heavy internal metadata from a ProductionJob for lightweight list endpoints if needed.
 * Inputs: job record.
 * Outputs: summarized job view preserving progress, artifacts, status, and error.
 * Side effects: none.
 * Failure modes: returns null for falsy input.
 * @param {object|null} job - ProductionJob entity.
 * @returns {object|null} Public job summary.
 */
export function toJobSummary(job) {
  if (!job) return null;
  return {
    schemaVersion: job.schemaVersion,
    id: job.id,
    projectId: job.projectId,
    projectTitle: job.projectTitle,
    type: job.type,
    title: job.title,
    status: job.status,
    progress: job.progress,
    items: job.items,
    artifacts: job.artifacts,
    attempt: job.attempt,
    retryCount: job.retryCount,
    maxRetries: job.maxRetries,
    error: job.error,
    workerSessionId: job.workerSessionId,
    lastHeartbeatAt: job.lastHeartbeatAt,
    cancelRequestedAt: job.cancelRequestedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    revision: job.revision,
    metadata: job.metadata,
  };
}

/**
 * Ensures admitting or re-queueing an active job will not exceed `maxActiveJobs`.
 * Inputs: existing non-deleted jobs array and `maxActiveJobs` ceiling.
 * Outputs: void when capacity permits.
 * Side effects: none.
 * Failure modes: throws ValidationError with code `JOB_QUEUE_FULL` when active queue ceiling is reached.
 * @param {Array<object>} allJobs - Existing active and history jobs.
 * @param {number} [maxActiveJobs=MAX_ACTIVE_QUEUED_JOBS] - Active queue ceiling.
 */
export function assertActiveQueueCapacity(allJobs = [], maxActiveJobs = MAX_ACTIVE_QUEUED_JOBS) {
  const activeCount = (Array.isArray(allJobs) ? allJobs : [])
    .filter(job => job && !job.deletedAt && ACTIVE_JOB_STATUSES.has(job.status)).length;
  if (activeCount >= maxActiveJobs) {
    throw new ValidationError(
      `Active batch queue limit (${maxActiveJobs}) reached. Wait for jobs to finish or cancel queued items.`,
      'queue',
      'JOB_QUEUE_FULL'
    );
  }
}

/**
 * Evaluates bounded queue admission (`maxActiveJobs` & `maxJobs`) and returns eviction IDs.
 * Inputs: existing non-deleted jobs array and `{ maxJobs, maxActiveJobs }`.
 * Outputs: `string[]` of finished history job IDs to evict before admitting a new job.
 * Side effects: none.
 * Failure modes: throws ValidationError with code `JOB_QUEUE_FULL` when capacity cannot admit a new job.
 * @param {Array<object>} allJobs - Existing active and history jobs.
 * @param {{ maxJobs?: number, maxActiveJobs?: number }} [limits] - Queue capacity ceilings.
 * @returns {string[]} Evictable history job IDs.
 */
export function evaluateQueueAdmission(allJobs = [], { maxJobs = MAX_STORED_JOBS, maxActiveJobs = MAX_ACTIVE_QUEUED_JOBS } = {}) {
  assertActiveQueueCapacity(allJobs, maxActiveJobs);
  const eviction = selectEvictableJobs(allJobs, maxJobs);
  if (!eviction.canAdmit) {
    throw new ValidationError(
      `Durable job queue capacity (${maxJobs}) is full with active or interrupted jobs. Clear or retry jobs first.`,
      'queue',
      'JOB_QUEUE_FULL'
    );
  }
  return eviction.evictIds;
}

/**
 * Dispatches one validated lifecycle mutation action onto a ProductionJob entity.
 * Inputs: existing job entity and `{ action, ...fields }`.
 * Outputs: next ProductionJob entity.
 * Side effects: none.
 * Failure modes: throws ValidationError for unknown action or ConflictError for invalid state transition.
 * @param {object} existing - Current ProductionJob entity.
 * @param {object} patch - Action payload.
 * @returns {Readonly<object>} Updated ProductionJob entity.
 */
export function applyJobLifecycleAction(existing, patch = {}) {
  const action = typeof patch?.action === 'string' ? patch.action.trim().toLowerCase() : '';
  switch (action) {
    case 'prepare': return transitionToPreparing(existing, patch);
    case 'start': return transitionToRunning(existing, patch);
    case 'heartbeat': return touchJobHeartbeat(existing, patch);
    case 'item_start': return markJobItemRunning(existing, patch.itemId, patch);
    case 'item_complete': return markJobItemCompleted(existing, patch);
    case 'item_fail': return markJobItemFailed(existing, patch);
    case 'complete': return completeProductionJob(existing, patch);
    case 'fail': return failProductionJob(existing, patch);
    case 'cancel': return requestCancelProductionJob(existing, { finalize: Boolean(patch.finalize) });
    case 'finalize_cancel': return finalizeCancelledProductionJob(existing, patch);
    case 'interrupt': return markJobInterrupted(existing, patch);
    case 'retry': return retryProductionJob(existing, patch);
    default: throw new ValidationError('Valid job lifecycle action is required.', 'action', 'INVALID_JOB_ACTION');
  }
}

function toTtsBatchItem(seg, idx, { defaultVoiceId, pronunciationSignature }) {
  const voiceId = seg.voiceId || defaultVoiceId;
  const status = computeSegmentStatus(seg, pronunciationSignature !== undefined ? { pronunciationSignature } : {});
  const activeTake = getSegmentActiveTake(seg);
  const isAlreadyReady = status === 'ready' && Boolean(activeTake?.audioAssetId);
  return {
    itemId: seg.id,
    segmentId: seg.id,
    label: `Segment #${idx + 1}`,
    status: isAlreadyReady ? 'completed' : 'pending',
    outputAssetId: isAlreadyReady ? activeTake.audioAssetId : null,
    takeId: isAlreadyReady ? activeTake.id : null,
    durationSeconds: isAlreadyReady ? activeTake.duration : null,
    seed: isAlreadyReady ? (activeTake.settings?.seed ?? null) : null,
    metadata: { text: seg.text, voiceId },
  };
}

/**
 * Converts script segments into durable TTS batch job items, marking already-ready segments completed.
 * Inputs: `{ segments, defaultVoiceId, pronunciationSignature }`.
 * Outputs: ordered array of JobItem input specs.
 * Side effects: none.
 * Failure modes: filters empty-text segments safely.
 * @param {{ segments: Array<object>, defaultVoiceId?: string, pronunciationSignature?: string }} spec - Conversion inputs.
 * @returns {Array<object>} JobItem specifications.
 */
export function buildTtsBatchJobItems({ segments = [], defaultVoiceId = '', pronunciationSignature } = {}) {
  return (Array.isArray(segments) ? segments : [])
    .filter(seg => Boolean((seg?.text || '').trim()))
    .map((seg, idx) => toTtsBatchItem(seg, idx, { defaultVoiceId, pronunciationSignature }));
}

/**
 * Extracts initial durable audio artifacts from already-completed TTS batch job items.
 * Inputs: job items array.
 * Outputs: array of JobArtifact descriptors for pre-completed items.
 * Side effects: none.
 * Failure modes: returns empty array for missing items.
 * @param {Array<object>} items - Normalized or raw job items.
 * @returns {Array<object>} Initial audio artifacts.
 */
export function buildReadyJobArtifacts(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter(item => item.status === 'completed' && item.outputAssetId)
    .map((item, idx) => ({
      itemId: item.itemId,
      segmentId: item.segmentId,
      assetId: item.outputAssetId,
      takeId: item.takeId || null,
      kind: 'audio',
      fileName: `segment-${String(idx + 1).padStart(2, '0')}.wav`,
      mimeType: 'audio/wav',
      durationSeconds: item.durationSeconds ?? null,
    }));
}

/**
 * Builds a compact TTS batch job creation spec keeping shared options/terminology once at job metadata level.
 * Inputs: `{ projectId, projectTitle, savedProject, activeCharacter, items, options, terminology, projectTerminology, sourceLanguage, pronunciationSignature }`.
 * Outputs: enqueue-ready ProductionJob specification object.
 * Side effects: none.
 * Failure modes: safely falls back to defaults when project metadata is partial.
 * @param {object} spec - Batch job builder parameters.
 * @returns {object} Job specification ready for `jobRepository.enqueueJob`.
 */
export function buildTtsBatchJobSpec({
  projectId = '',
  projectTitle = '',
  savedProject = null,
  activeCharacter = null,
  items = [],
  options = {},
  terminology,
  projectTerminology,
  sourceLanguage = '',
  pronunciationSignature = '',
} = {}) {
  const targetProjectId = savedProject?.id || projectId || null;
  const resolvedTitle = savedProject?.title || projectTitle || 'TTS Narration';
  const sharedOptions = {
    ...options,
    ...(terminology !== undefined ? { terminology } : {}),
    ...(projectTerminology !== undefined ? { projectTerminology } : {}),
    ...(sourceLanguage ? { sourceLanguage } : {}),
    ...(pronunciationSignature !== undefined ? { pronunciationSignature } : {}),
  };
  return {
    type: 'tts_batch',
    title: `${resolvedTitle} (${items.length} segments)`,
    projectId: targetProjectId,
    projectTitle: resolvedTitle,
    items,
    artifacts: buildReadyJobArtifacts(items),
    metadata: {
      sourceWorkspace: 'tts',
      voiceId: activeCharacter?.id || '',
      options: sharedOptions,
    },
  };
}

/**
 * Merges newly persisted takes from reloaded project segments into dirty UI segments without discarding text edits.
 * Inputs: current UI segments array and saved project segments array.
 * Outputs: merged segments array preserving existing takes and appending new persisted takes.
 * Side effects: none.
 * Failure modes: returns currentSegments copy when inputs are empty.
 * @param {Array<object>} currentSegments - Local UI segments.
 * @param {Array<object>} savedSegments - Reloaded project segments from persistence.
 * @returns {Array<object>} Segments with merged takes.
 */
export function mergeUpdatedTakesIntoSegments(currentSegments = [], savedSegments = []) {
  const byId = new Map((Array.isArray(savedSegments) ? savedSegments : []).map(seg => [seg.id, seg]));
  return (Array.isArray(currentSegments) ? currentSegments : []).map(seg => {
    const saved = byId.get(seg.id);
    if (!saved || !Array.isArray(saved.takes) || saved.takes.length === 0) return seg;
    const existingIds = new Set((seg.takes || []).map(t => t.id));
    const additions = saved.takes.filter(t => !existingIds.has(t.id));
    if (additions.length === 0) return seg;
    const hasNewSelected = additions.some(t => t.isSelected);
    const priorTakes = hasNewSelected
      ? (seg.takes || []).map(t => (t.isSelected ? { ...t, isSelected: false } : t))
      : (seg.takes || []);
    const mergedTakes = [...priorTakes, ...additions];
    const candidate = { ...seg, takes: mergedTakes, activeTakeId: saved.activeTakeId || seg.activeTakeId };
    return { ...candidate, status: computeSegmentStatus(candidate) };
  });
}
