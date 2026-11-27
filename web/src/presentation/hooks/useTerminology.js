/**
 * @fileoverview Presentation hooks coordinating the reusable global terminology library,
 * legacy glossary reload sync, per-project terminology overrides, and stage-separated rules.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TERM_STATUSES,
  buildPronunciationSignature,
  clearProjectTermOverride,
  createEmptyProjectTerminology,
  normalizeProjectTerminology,
  normalizeTerminologyList,
  normalizeTerminologyTerm,
  promoteProjectTermToGlobal,
  removeProjectTerm,
  resolveEffectiveTerminology,
  selectPronunciationRules,
  selectSpellingRules,
  selectTranslationRules,
  setProjectTermOverride,
  upsertProjectTerm,
} from '../../domain/terminology.js';

function createGlobalTermId(existingTerms) {
  const used = new Set((existingTerms || []).map(item => item.id));
  const base = globalThis.crypto?.randomUUID
    ? `term-${globalThis.crypto.randomUUID().slice(0, 8)}`
    : `term-${Date.now().toString(36)}`;
  if (!used.has(base)) return base;
  return `${base}-${(existingTerms?.length || 0) + 1}`;
}

function summarizeCounts(effectiveTerms) {
  let approved = 0;
  let draft = 0;
  let overridden = 0;
  let projectOnly = 0;
  for (const entry of effectiveTerms) {
    if (entry.isOverridden) overridden += 1;
    if (entry.scope === 'project') projectOnly += 1;
    if (entry.isDisabledInProject || entry.enabled === false) continue;
    if (entry.status === TERM_STATUSES.APPROVED) approved += 1;
    else draft += 1;
  }
  return { total: effectiveTerms.length, approved, draft, overridden, projectOnly };
}

/**
 * Manages shared global terminology and legacy glossary rules across workspaces.
 * Inputs: `{ terminologyRepository, glossaryRepository, logger }`.
 * Outputs: `{ globalTerms, glossaryRules, loaded, reload, saveGlobalTerms }`.
 * Side effects: loads/saves via injected repositories.
 * Failure modes: logs storage failures cleanly and surfaces errors on save.
 * @param {{ terminologyRepository?: object|null, glossaryRepository?: object|null, logger?: object }} [deps] - Repositories.
 * @returns {object} Shared global terminology controller.
 */
export function useGlobalTerminology({ terminologyRepository = null, glossaryRepository = null, logger = null } = {}) {
  const [globalTerms, setGlobalTerms] = useState([]);
  const [glossaryRules, setGlossaryRules] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const [termsResult, rulesResult] = await Promise.all([
      terminologyRepository ? terminologyRepository.loadTerms() : Promise.resolve([]),
      glossaryRepository ? glossaryRepository.loadRules() : Promise.resolve([]),
    ]);
    setGlobalTerms(Array.isArray(termsResult) ? termsResult : []);
    setGlossaryRules(Array.isArray(rulesResult) ? rulesResult : []);
    setLoaded(true);
  }, [terminologyRepository, glossaryRepository]);

  useEffect(() => {
    let active = true;
    Promise.all([
      terminologyRepository ? terminologyRepository.loadTerms() : Promise.resolve([]),
      glossaryRepository ? glossaryRepository.loadRules() : Promise.resolve([]),
    ]).then(([termsResult, rulesResult]) => {
      if (!active) return;
      setGlobalTerms(Array.isArray(termsResult) ? termsResult : []);
      setGlossaryRules(Array.isArray(rulesResult) ? rulesResult : []);
      setLoaded(true);
    }).catch(error => {
      logger?.error?.('useGlobalTerminology.load', error);
      if (active) setLoaded(true);
    });
    return () => { active = false; };
  }, [terminologyRepository, glossaryRepository, logger]);

  const saveGlobalTerms = useCallback(async nextRawTerms => {
    const normalized = normalizeTerminologyList(nextRawTerms);
    if (!terminologyRepository?.saveTerms) {
      setGlobalTerms(normalized);
      return { terms: normalized, localOnly: true };
    }
    const result = await terminologyRepository.saveTerms(normalized);
    setGlobalTerms(result.terms);
    return result;
  }, [terminologyRepository]);

  return {
    globalTerms,
    glossaryRules,
    loaded,
    reload,
    saveGlobalTerms,
  };
}

/**
 * Coordinates workspace terminology state combining shared global terms with optional per-project overrides.
 * Inputs: `{ globalController, terminologyRepository, glossaryRepository, projectTerminology, onChangeProjectTerminology, sourceLanguage, targetLanguage, speechLanguage, onNotify, logger }`.
 * Outputs: resolved effective terminology, stage-specific rules, pronunciation signature, and CRUD/override mutations.
 * Side effects: reads/writes global terminology via `terminologyRepository` and invokes `onChangeProjectTerminology`.
 * Failure modes: propagates ValidationError/StorageError from mutations so modals can display inline errors.
 * @param {object} config - Terminology hook config.
 * @returns {object} Effective terminology state and actions.
 */
export function useTerminology({
  globalController = null,
  terminologyRepository = null,
  glossaryRepository = null,
  projectTerminology = null,
  onChangeProjectTerminology = null,
  sourceLanguage = '',
  targetLanguage = '',
  speechLanguage = '',
  onNotify = null,
  logger = null,
} = {}) {
  const localGlobal = useGlobalTerminology({
    terminologyRepository: globalController ? null : terminologyRepository,
    glossaryRepository: globalController ? null : glossaryRepository,
    logger,
  });
  const globalTerms = globalController ? globalController.globalTerms : localGlobal.globalTerms;
  const glossaryRules = globalController ? globalController.glossaryRules : localGlobal.glossaryRules;
  const saveGlobalTerms = globalController ? globalController.saveGlobalTerms : localGlobal.saveGlobalTerms;
  const reload = globalController ? globalController.reload : localGlobal.reload;

  const safeProjectTerminology = useMemo(() => {
    try {
      return normalizeProjectTerminology(projectTerminology);
    } catch (error) {
      logger?.error?.('useTerminology.normalizeProject', error);
      return createEmptyProjectTerminology();
    }
  }, [projectTerminology, logger]);

  const effectiveTerms = useMemo(() => {
    try {
      return resolveEffectiveTerminology(globalTerms, safeProjectTerminology);
    } catch (error) {
      logger?.error?.('useTerminology.resolveEffective', error);
      return globalTerms;
    }
  }, [globalTerms, safeProjectTerminology, logger]);

  const spellingRules = useMemo(
    () => selectSpellingRules(effectiveTerms, { sourceLanguage }),
    [effectiveTerms, sourceLanguage]
  );

  const translationRules = useMemo(
    () => selectTranslationRules(effectiveTerms, { sourceLanguage, targetLanguage }),
    [effectiveTerms, sourceLanguage, targetLanguage]
  );

  const activeSpeechLang = speechLanguage || sourceLanguage;
  const pronunciationRules = useMemo(
    () => selectPronunciationRules(effectiveTerms, { sourceLanguage: activeSpeechLang, glossaryRules }),
    [effectiveTerms, activeSpeechLang, glossaryRules]
  );

  const pronunciationSignature = useMemo(
    () => buildPronunciationSignature(effectiveTerms, glossaryRules, activeSpeechLang),
    [effectiveTerms, glossaryRules, activeSpeechLang]
  );

  const counts = useMemo(() => summarizeCounts(effectiveTerms), [effectiveTerms]);

  const addGlobalTerm = useCallback(async draft => {
    const id = draft?.id?.trim() || createGlobalTermId(globalTerms);
    const candidate = normalizeTerminologyTerm({ ...draft, id, updatedAt: new Date().toISOString() }, globalTerms.length);
    return saveGlobalTerms([...globalTerms, candidate]);
  }, [globalTerms, saveGlobalTerms]);

  const updateGlobalTerm = useCallback(async (termId, patch) => {
    const next = globalTerms.map((item, idx) => (
      item.id === termId ? normalizeTerminologyTerm({ ...item, ...patch, id: termId, updatedAt: new Date().toISOString() }, idx) : item
    ));
    return saveGlobalTerms(next);
  }, [globalTerms, saveGlobalTerms]);

  const deleteGlobalTerm = useCallback(async termId => {
    const nextGlobal = globalTerms.filter(item => item.id !== termId);
    const saved = await saveGlobalTerms(nextGlobal);
    if (onChangeProjectTerminology && safeProjectTerminology.overrides[termId]) {
      onChangeProjectTerminology(clearProjectTermOverride(safeProjectTerminology, termId));
    }
    return saved;
  }, [globalTerms, saveGlobalTerms, onChangeProjectTerminology, safeProjectTerminology]);

  const toggleGlobalTermApproval = useCallback(async termId => {
    const target = globalTerms.find(item => item.id === termId);
    if (!target) return null;
    const nextStatus = target.status === TERM_STATUSES.APPROVED ? TERM_STATUSES.DRAFT : TERM_STATUSES.APPROVED;
    return updateGlobalTerm(termId, { status: nextStatus });
  }, [globalTerms, updateGlobalTerm]);

  const overrideGlobalTerm = useCallback((termId, patch, options = undefined) => {
    if (!onChangeProjectTerminology) return;
    onChangeProjectTerminology(setProjectTermOverride(safeProjectTerminology, termId, patch, globalTerms, options));
  }, [onChangeProjectTerminology, safeProjectTerminology, globalTerms]);

  const disableGlobalTermInProject = useCallback((termId, disabled = true) => {
    if (!onChangeProjectTerminology) return;
    if (disabled) {
      onChangeProjectTerminology(setProjectTermOverride(safeProjectTerminology, termId, { disabled: true }, globalTerms));
      return;
    }
    const existing = safeProjectTerminology.overrides[termId];
    if (!existing) return;
    const { disabled: _omit, updatedAt: _oldTime, ...rest } = existing;
    if (Object.keys(rest).length === 0) {
      onChangeProjectTerminology(clearProjectTermOverride(safeProjectTerminology, termId));
      return;
    }
    const nextOverrides = { ...safeProjectTerminology.overrides, [termId]: { ...rest, updatedAt: new Date().toISOString() } };
    onChangeProjectTerminology(normalizeProjectTerminology({ ...safeProjectTerminology, overrides: nextOverrides }));
  }, [onChangeProjectTerminology, safeProjectTerminology, globalTerms]);

  const resetGlobalTermOverride = useCallback(termId => {
    if (!onChangeProjectTerminology) return;
    onChangeProjectTerminology(clearProjectTermOverride(safeProjectTerminology, termId));
  }, [onChangeProjectTerminology, safeProjectTerminology]);

  const saveProjectTerm = useCallback(rawTerm => {
    if (!onChangeProjectTerminology) return;
    onChangeProjectTerminology(upsertProjectTerm(safeProjectTerminology, {
      ...rawTerm,
      updatedAt: new Date().toISOString(),
    }));
  }, [onChangeProjectTerminology, safeProjectTerminology]);

  const deleteProjectTerm = useCallback(termId => {
    if (!onChangeProjectTerminology) return;
    onChangeProjectTerminology(removeProjectTerm(safeProjectTerminology, termId));
  }, [onChangeProjectTerminology, safeProjectTerminology]);

  const toggleProjectTermApproval = useCallback(termId => {
    if (!onChangeProjectTerminology) return;
    const target = safeProjectTerminology.projectTerms.find(item => item.id === termId);
    if (!target) return;
    const nextStatus = target.status === TERM_STATUSES.APPROVED ? TERM_STATUSES.DRAFT : TERM_STATUSES.APPROVED;
    saveProjectTerm({ ...target, status: nextStatus });
  }, [onChangeProjectTerminology, safeProjectTerminology.projectTerms, saveProjectTerm]);

  const promoteToGlobal = useCallback(async projectTermId => {
    const promoted = promoteProjectTermToGlobal(safeProjectTerminology, projectTermId, globalTerms);
    await saveGlobalTerms(promoted.globalTerms);
    onChangeProjectTerminology?.(promoted.projectTerminology);
    onNotify?.({ kind: 'success', title: 'Promoted to global library', message: `"${promoted.promotedTerm.term}" is now reusable across all projects.` });
    return promoted.promotedTerm;
  }, [safeProjectTerminology, globalTerms, saveGlobalTerms, onChangeProjectTerminology, onNotify]);

  return {
    globalTerms,
    glossaryRules,
    projectTerminology: safeProjectTerminology,
    effectiveTerms,
    spellingRules,
    translationRules,
    pronunciationRules,
    pronunciationSignature,
    counts,
    reload,
    saveGlobalTerms,
    addGlobalTerm,
    updateGlobalTerm,
    deleteGlobalTerm,
    toggleGlobalTermApproval,
    overrideGlobalTerm,
    disableGlobalTermInProject,
    resetGlobalTermOverride,
    saveProjectTerm,
    deleteProjectTerm,
    toggleProjectTermApproval,
    promoteToGlobal,
  };
}
