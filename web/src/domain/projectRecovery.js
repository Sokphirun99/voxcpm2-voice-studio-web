/**
 * @fileoverview Pure domain logic for project recovery, draft comparison, and referenced asset integrity.
 */

import { ValidationError } from './errors.js';
import { assertProjectId, createAssetReference } from './projects.js';

export const RECOVERY_WORKSPACES = Object.freeze(['tts', 'subtitles', 'dubbing']);
export const MISSING_ASSET_WARNING_TEXT =
  'Referenced asset is missing or was deleted from storage. Re-link or re-upload to continue.';
export const RECOVERED_DRAFT_PROMPT_PREFIX = 'Unsaved draft recovered from ';
export const RECOVERED_DRAFT_PROMPT_SUFFIX = '. Restore or Discard?';
export const SOURCE_ASSET_LOCATION = 'sourceAsset';
export const SEGMENT_TAKE_LOCATION = 'segmentTake';
export const REFERENCE_AUDIO_LOCATION = 'referenceAudio';
export const VIDEO_ASSET_LOCATION = 'videoAsset';
const DEFAULT_FALLBACK_TIMESTAMP = 'earlier session';

/**
 * Validates that workspace is a supported recovery workspace.
 * Inputs: workspace (string).
 * Outputs: normalized workspace string.
 * Side effects: none.
 * Failure modes: throws ValidationError if invalid.
 * @param {unknown} workspace - Workspace candidate.
 * @returns {string} Validated workspace.
 */
export function assertRecoveryWorkspace(workspace) {
  const norm = typeof workspace === 'string' ? workspace.trim().toLowerCase() : '';
  const candidate = norm === 'subtitle' ? 'subtitles' : norm;
  if (!RECOVERY_WORKSPACES.includes(candidate)) {
    throw new ValidationError(
      `Workspace must be one of: ${RECOVERY_WORKSPACES.join(', ')}.`,
      'workspace',
      'INVALID_WORKSPACE'
    );
  }
  return candidate;
}

/**
 * Formats an ISO timestamp for display in recovery prompt.
 * Inputs: isoString (string|null|undefined).
 * Outputs: human-readable timestamp string.
 * Side effects: none.
 * Failure modes: falls back to raw string or default timestamp on parse failure.
 * @param {string|null|undefined} isoString - ISO date string.
 * @returns {string} Formatted date string.
 */
export function formatDraftRecoveryTimestamp(isoString) {
  if (!isoString || typeof isoString !== 'string') return DEFAULT_FALLBACK_TIMESTAMP;
  try {
    const parsed = new Date(isoString);
    if (Number.isNaN(parsed.getTime())) return isoString;
    return parsed.toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch (err) {
    return isoString;
  }
}

/**
 * Builds the recovery prompt message for an unsaved draft.
 * Inputs: timestamp (string|null|undefined).
 * Outputs: prompt string.
 * Side effects: none.
 * Failure modes: none.
 * @param {string|null|undefined} timestamp - ISO timestamp string.
 * @returns {string} Prompt string.
 */
export function buildDraftRecoveryPrompt(timestamp) {
  const formatted = formatDraftRecoveryTimestamp(timestamp);
  return `${RECOVERED_DRAFT_PROMPT_PREFIX}${formatted}${RECOVERED_DRAFT_PROMPT_SUFFIX}`;
}

/**
 * Builds and freezes an uncommitted project draft backup entity.
 * Inputs: `{ projectId, workspace, snapshot, revision, timestamp }`.
 * Outputs: frozen draft object.
 * Side effects: none.
 * Failure modes: throws ValidationError if workspace or snapshot is invalid.
 * @param {object} spec - Draft spec.
 * @returns {Readonly<object>} Frozen draft.
 */
export function buildProjectDraft({ projectId = null, workspace, snapshot, revision = 1, timestamp } = {}) {
  const validWorkspace = assertRecoveryWorkspace(workspace);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new ValidationError('Draft snapshot must be an object.', 'snapshot', 'INVALID_DRAFT_SNAPSHOT');
  }
  const normId = projectId ? assertProjectId(projectId) : null;
  const numRev = Number.isInteger(Number(revision)) && Number(revision) >= 1 ? Number(revision) : 1;
  const time = typeof timestamp === 'string' && timestamp ? timestamp : new Date().toISOString();
  return Object.freeze({
    projectId: normId,
    workspace: validWorkspace,
    snapshot: Object.freeze({ ...snapshot }),
    revision: numRev,
    timestamp: time,
  });
}

function hasSubstantiveDraftContent(snapshot, workspace) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (workspace === 'tts') {
    const script = snapshot.payload?.script || snapshot.script || '';
    return typeof script === 'string' && script.trim().length > 0;
  }
  const segments = snapshot.segments || snapshot.payload?.segments || [];
  const fileName = snapshot.videoFileName || snapshot.payload?.videoFileName || '';
  return (Array.isArray(segments) && segments.length > 0) || Boolean(fileName);
}

function isTtsSnapshotModified(draft, confirmed) {
  const draftScript = draft.payload?.script || draft.script || '';
  const confirmedScript = confirmed.payload?.script || confirmed.settings?.script || confirmed.script || '';
  if (draftScript !== confirmedScript) return true;
  const draftOpts = JSON.stringify(draft.payload?.ttsOptions || draft.ttsOptions || {});
  const confOpts = JSON.stringify(confirmed.payload?.ttsOptions || confirmed.settings?.ttsOptions || confirmed.ttsOptions || {});
  return draftOpts !== confOpts;
}

function isSubtitleSnapshotModified(draft, confirmed) {
  const draftSegs = draft.segments || draft.payload?.segments || [];
  const confSegs = confirmed.segments || confirmed.payload?.segments || [];
  if (draftSegs.length !== confSegs.length) return true;
  return JSON.stringify(draftSegs) !== JSON.stringify(confSegs);
}

function isDraftDifferentFromConfirmed(draftSnapshot, confirmedProject, workspace) {
  if (workspace === 'tts') return isTtsSnapshotModified(draftSnapshot, confirmedProject);
  return isSubtitleSnapshotModified(draftSnapshot, confirmedProject);
}

/**
 * Determines whether a recovered draft should be offered to the user.
 * Inputs: `{ draft, confirmedProject }`.
 * Outputs: boolean.
 * Side effects: none.
 * Failure modes: returns false on invalid input.
 * @param {{ draft: object|null|undefined, confirmedProject?: object|null }} params - Comparison input.
 * @returns {boolean} True if draft should be recovered.
 */
export function shouldOfferDraftRecovery({ draft, confirmedProject = null } = {}) {
  if (!draft || typeof draft !== 'object' || !draft.snapshot) return false;
  const workspace = draft.workspace || 'tts';
  if (!confirmedProject) return hasSubstantiveDraftContent(draft.snapshot, workspace);
  const draftTime = new Date(draft.timestamp || 0).getTime();
  const confirmedTime = new Date(confirmedProject.updatedAt || confirmedProject.createdAt || 0).getTime();
  const draftRevision = Number(draft.revision) || 1;
  const confirmedRevision = Number(confirmedProject.revision) || 1;
  if (draftRevision < confirmedRevision) return false;
  if (draftTime > confirmedTime) {
    return isDraftDifferentFromConfirmed(draft.snapshot, confirmedProject, workspace);
  }
  return false;
}

function extractSourceAssetRef(project) {
  if (!project.sourceAssetId) return null;
  return {
    assetId: project.sourceAssetId,
    location: SOURCE_ASSET_LOCATION,
    kind: project.sourceAsset?.kind || 'source',
    fileName: project.sourceAsset?.fileName || null,
  };
}

function extractTakeRefs(segments) {
  if (!Array.isArray(segments)) return [];
  const refs = [];
  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.takes)) continue;
    for (const take of seg.takes) {
      if (take && take.audioAssetId) {
        refs.push({
          assetId: take.audioAssetId,
          location: SEGMENT_TAKE_LOCATION,
          kind: 'audio',
          segmentId: seg.id,
          takeId: take.id || take.takeId,
        });
      }
    }
  }
  return refs;
}

function extractSettingsAssetRefs(settings, payload) {
  const refs = [];
  const refAudio = settings?.referenceAudioAssetId || payload?.referenceAudioAssetId;
  if (refAudio) {
    refs.push({ assetId: refAudio, location: REFERENCE_AUDIO_LOCATION, kind: 'audio' });
  }
  const vidAsset = settings?.videoAssetId || payload?.videoAssetId;
  if (vidAsset) {
    refs.push({ assetId: vidAsset, location: VIDEO_ASSET_LOCATION, kind: 'video' });
  }
  return refs;
}

/**
 * Collects all referenced media asset IDs across source, takes, and settings.
 * Inputs: project (object).
 * Outputs: array of unique referenced asset descriptors.
 * Side effects: none.
 * Failure modes: returns empty array on invalid input.
 * @param {object|null|undefined} project - Project entity or snapshot.
 * @returns {Array<{ assetId: string, location: string, kind: string, segmentId?: string, takeId?: string, fileName?: string|null }>}
 */
export function collectReferencedAssets(project) {
  if (!project || typeof project !== 'object') return [];
  const allRefs = [];
  const src = extractSourceAssetRef(project);
  if (src) allRefs.push(src);
  const segments = project.segments || project.payload?.segments || [];
  allRefs.push(...extractTakeRefs(segments));
  const settings = project.settings || {};
  const payload = project.payload || {};
  allRefs.push(...extractSettingsAssetRefs(settings, payload));
  const seen = new Set();
  return allRefs.filter(ref => {
    if (seen.has(ref.assetId)) return false;
    seen.add(ref.assetId);
    return true;
  });
}

/**
 * Assesses integrity of all referenced assets against a status lookup.
 * Inputs: project (object), assetStatuses (object|Map).
 * Outputs: integrity report with missing assets and actionable warning.
 * Side effects: none.
 * Failure modes: returns intact when project has no assets.
 * @param {object} project - Project entity.
 * @param {object|Map} assetStatuses - Asset status lookup (id -> { exists: boolean, error?: string }).
 * @returns {{ isIntact: boolean, missingAssets: Array<object>, warningMessage: string }} Integrity report.
 */
export function assessAssetIntegrity(project, assetStatuses = {}) {
  const referenced = collectReferencedAssets(project);
  if (referenced.length === 0) {
    return { isIntact: true, missingAssets: [], warningMessage: '' };
  }
  const getStatus = id => (assetStatuses instanceof Map ? assetStatuses.get(id) : assetStatuses[id]);
  const missing = referenced.filter(ref => {
    const status = getStatus(ref.assetId);
    return !status || status.exists === false || Boolean(status.isMissing);
  });
  return {
    isIntact: missing.length === 0,
    missingAssets: missing,
    warningMessage: missing.length > 0 ? MISSING_ASSET_WARNING_TEXT : '',
  };
}

function updateTakeAssetId(takes, oldId, newId) {
  if (!Array.isArray(takes)) return [];
  return takes.map(take => {
    if (!take || take.audioAssetId !== oldId) return take;
    return { ...take, audioAssetId: newId };
  });
}

function relinkSegmentsTakes(segments, oldId, newId) {
  if (!Array.isArray(segments)) return [];
  return segments.map(seg => {
    if (!seg || !Array.isArray(seg.takes)) return seg;
    const updatedTakes = updateTakeAssetId(seg.takes, oldId, newId);
    return { ...seg, takes: updatedTakes };
  });
}

function relinkSettings(settings, oldId, newId) {
  if (!settings || typeof settings !== 'object') return settings;
  const updated = { ...settings };
  if (updated.referenceAudioAssetId === oldId) updated.referenceAudioAssetId = newId;
  if (updated.videoAssetId === oldId) updated.videoAssetId = newId;
  return updated;
}

function relinkPayload(payload, oldId, newId) {
  if (!payload || typeof payload !== 'object') return payload;
  const updated = { ...payload };
  if (Array.isArray(updated.segments)) {
    updated.segments = relinkSegmentsTakes(updated.segments, oldId, newId);
  }
  if (updated.referenceAudioAssetId === oldId) updated.referenceAudioAssetId = newId;
  if (updated.videoAssetId === oldId) updated.videoAssetId = newId;
  return updated;
}

function resolveRelinkedSource(project, oldId, newId, newAsset) {
  const isSource = project.sourceAssetId === oldId;
  const sourceAsset = isSource && typeof newAsset === 'object' ? createAssetReference(newAsset) : project.sourceAsset;
  return { sourceAssetId: isSource ? newId : project.sourceAssetId, sourceAsset };
}

/**
 * Relinks a missing asset reference to a replacement asset without corrupting other project data.
 * Inputs: project (object), oldAssetId (string), newAsset (object).
 * Outputs: updated immutable project entity.
 * Side effects: none.
 * Failure modes: throws ValidationError if IDs are invalid.
 * @param {object} project - Project entity.
 * @param {string} oldAssetId - Missing asset ID to replace.
 * @param {object} newAsset - New asset descriptor or entity with an `id`.
 * @returns {Readonly<object>} Updated project entity.
 */
export function relinkProjectAsset(project, oldAssetId, newAsset) {
  if (!project || typeof project !== 'object') {
    throw new ValidationError('Project is required.', 'project', 'INVALID_PROJECT');
  }
  const validOld = assertProjectId(oldAssetId);
  const validNew = assertProjectId(newAsset?.id || newAsset);
  const source = resolveRelinkedSource(project, validOld, validNew, newAsset);
  const segments = Array.isArray(project.segments) ? relinkSegmentsTakes(project.segments, validOld, validNew) : undefined;
  return Object.freeze({
    ...project, ...source,
    ...(segments !== undefined ? { segments: Object.freeze(segments) } : {}),
    ...(project.payload ? { payload: Object.freeze(relinkPayload(project.payload, validOld, validNew)) } : {}),
    ...(project.settings ? { settings: Object.freeze(relinkSettings(project.settings, validOld, validNew)) } : {}),
    updatedAt: new Date().toISOString(),
  });
}
