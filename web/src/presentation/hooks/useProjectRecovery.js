/**
 * @fileoverview Hook managing draft recovery prompts and referenced media asset integrity verification.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  assessAssetIntegrity,
  collectReferencedAssets,
  relinkProjectAsset,
  shouldOfferDraftRecovery,
} from '../../domain/projectRecovery.js';
import {
  clearProjectDraft,
  getProjectDraft,
  saveLastActiveProject,
} from '../../data/projectRecoveryStorage.js';

async function checkAssetExists(assetRepository, assetId, logger) {
  try {
    const meta = await assetRepository.getAssetMeta(assetId);
    return Boolean(meta);
  } catch (err) {
    if (err?.status === 404 || err?.code === 'ASSET_NOT_FOUND') return false;
    logger?.error?.('useProjectRecovery.assetCheckFailed', err, { assetId });
    return false;
  }
}

async function scanMissingAssets(project, assetRepository, logger) {
  const referenced = collectReferencedAssets(project);
  if (!assetRepository || referenced.length === 0) {
    return { isIntact: true, missingAssets: [] };
  }
  const statuses = {};
  for (const ref of referenced) {
    const exists = await checkAssetExists(assetRepository, ref.assetId, logger);
    statuses[ref.assetId] = { exists };
  }
  return assessAssetIntegrity(project, statuses);
}

function executeUploadedRelink(ctx, file, uploaded) {
  const { currentProject, targetRef, projectRepository, onProjectUpdated, onNotify } = ctx;
  const updated = relinkProjectAsset(currentProject, targetRef.assetId, uploaded.asset);
  void projectRepository?.saveProject?.(updated);
  onProjectUpdated?.(updated);
  onNotify?.({ type: 'success', message: `Re-linked asset: ${file.name}` });
  return updated;
}

function clearDraftAndNotify({ projectId, workspace, storageOpt, logger, setBanner, onNotify, msg }) {
  clearProjectDraft({ projectId, workspace, storage: storageOpt, logger });
  setBanner(false);
  onNotify?.({ type: 'info', message: msg });
}

function useDraftState({ projectId, workspace, storageOpt, logger, onRestoreDraft, onNotify }) {
  const [recoveredDraft, setRecoveredDraft] = useState(null);
  const [showDraftBanner, setShowDraftBanner] = useState(false);
  const checkForDraft = useCallback(confirmed => {
    const draft = getProjectDraft({ projectId, workspace, storage: storageOpt, logger });
    const shouldOffer = shouldOfferDraftRecovery({ draft, confirmedProject: confirmed });
    setRecoveredDraft(shouldOffer ? draft : null);
    setShowDraftBanner(shouldOffer);
  }, [projectId, workspace, storageOpt, logger]);
  const restoreDraft = useCallback(() => {
    if (!recoveredDraft?.snapshot) return;
    onRestoreDraft?.(recoveredDraft.snapshot);
    clearDraftAndNotify({ projectId, workspace, storageOpt, logger, setBanner: setShowDraftBanner, onNotify, msg: 'Unsaved draft restored.' });
  }, [recoveredDraft, onRestoreDraft, projectId, workspace, storageOpt, logger, onNotify]);
  const discardDraft = useCallback(() => {
    clearDraftAndNotify({ projectId, workspace, storageOpt, logger, setBanner: setShowDraftBanner, onNotify, msg: 'Unsaved draft discarded.' });
  }, [projectId, workspace, storageOpt, logger, onNotify]);
  return { recoveredDraft, showDraftBanner, checkForDraft, restoreDraft, discardDraft };
}

async function executeUploadAndRelink(opts) {
  const { file, missingAssets, assetRepository, projectId, currentProject, projectRepository, onProjectUpdated, onNotify, logger, setMissingAssets, setShowBanner } = opts;
  const targetRef = missingAssets[0];
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const uploaded = await assetRepository.uploadAsset({
      bytes, fileName: file.name, kind: targetRef.kind || 'other',
      mimeType: file.type || 'application/octet-stream', projectId,
    });
    executeUploadedRelink({ currentProject, targetRef, projectRepository, onProjectUpdated, onNotify }, file, uploaded);
    const remaining = missingAssets.slice(1);
    setMissingAssets(remaining);
    if (remaining.length === 0) setShowBanner(false);
  } catch (err) {
    logger?.error?.('useProjectRecovery.relinkFailed', err, { fileName: file.name });
    onNotify?.({ type: 'error', message: 'Failed to re-link asset.' });
  }
}

function useAssetIntegrityState({ projectId, assetRepository, projectRepository, onProjectUpdated, onNotify, logger }) {
  const [missingAssets, setMissingAssets] = useState([]);
  const [showMissingAssetBanner, setShowMissingAssetBanner] = useState(false);
  const verifyAssets = useCallback(async project => {
    if (!project || !assetRepository) return;
    const report = await scanMissingAssets(project, assetRepository, logger);
    setMissingAssets(report.missingAssets);
    setShowMissingAssetBanner(!report.isIntact);
  }, [assetRepository, logger]);
  const relinkAssetFile = useCallback(async (file, currentProject) => {
    if (!file || missingAssets.length === 0 || !assetRepository) return;
    await executeUploadAndRelink({
      file, missingAssets, assetRepository, projectId, currentProject,
      projectRepository, onProjectUpdated, onNotify, logger, setMissingAssets, setShowBanner: setShowMissingAssetBanner,
    });
  }, [missingAssets, assetRepository, projectId, projectRepository, onProjectUpdated, onNotify, logger]);
  return { missingAssets, showMissingAssetBanner, verifyAssets, relinkAssetFile, dismissMissingAssets: () => setShowMissingAssetBanner(false) };
}

function computeAssetKeys(project) {
  if (!project) return '';
  return collectReferencedAssets(project).map(r => r.assetId).sort().join(',');
}

/**
 * Coordinates project draft recovery and missing media asset verification.
 * Inputs: `{ projectId, workspace, currentProject, onRestoreDraft, onProjectUpdated, projectRepository, assetRepository, logger, onNotify }`.
 * Outputs: recovery controller exposing banners, restore, discard, relink, and dismiss functions.
 * Side effects: reads/clears Web Storage; queries asset repository for integrity.
 * Failure modes: logs errors without throwing; keeps referenced assets untouched on missing media.
 * @param {object} options - Hook options.
 * @returns {object} Recovery controller.
 */
export function useProjectRecovery(options = {}) {
  const { projectId = null, workspace = 'tts', currentProject = null, storage: storageOpt, logger, assetRepository } = options;
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  const draft = useDraftState({ ...options, storageOpt });
  const integrity = useAssetIntegrityState(options);

  useEffect(() => {
    draft.checkForDraft(currentProject);
    if (projectId) saveLastActiveProject({ projectId, workspace, storage: storageOpt, logger });
  }, [projectId, workspace]); // eslint-disable-line react-hooks/exhaustive-deps

  const assetKey = useMemo(() => computeAssetKeys(currentProject), [currentProject]);
  useEffect(() => {
    if (currentProject && assetRepository) void integrity.verifyAssets(currentProject);
  }, [projectId, assetKey, assetRepository]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...draft, ...integrity, relinkAssetFile: file => integrity.relinkAssetFile(file, currentProjectRef.current) };
}
