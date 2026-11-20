/**
 * @fileoverview Draft/save state for the pronunciation rules editor in the Voice pane.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_GLOSSARY_RULES } from '../../domain/pronunciationRules.js';

const SAVED_MESSAGE = 'Pronunciation rules saved.';
const OFFLINE_MESSAGE = 'Saved on this device — the storage service is offline and will sync later.';
const SAVE_FAILURE_MESSAGE = 'Could not save pronunciation rules. Try again.';

/**
 * Detects a row the user added but never filled in.
 * @param {{ source: string, replacement: string }} row - Draft row.
 * @returns {boolean} True when both fields are blank.
 */
function isBlankRow(row) {
  return !row.source.trim() && !row.replacement.trim();
}

/**
 * Manages loading, editing, and saving the pronunciation dictionary.
 * Inputs: `glossaryRepository` port (or null to disable the feature).
 * Outputs: `{ rows, savedCount, isDirty, isSaving, canAdd, status, addRule, updateRule, removeRule, save }`.
 * Side effects: loads rules once on mount and persists through `glossaryRepository.saveRules`.
 * Failure modes: validation/storage errors surface as `status.error` messages; load never throws.
 * @param {import('../../domain/ports.js').GlossaryRepositoryPort|null} glossaryRepository - Glossary port.
 * @returns {object} Editor state and actions.
 */
export function usePronunciationRules(glossaryRepository) {
  const [rows, setRows] = useState([]);
  const [saved, setSaved] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState({ message: '', error: false });
  const idCounter = useRef(0);

  useEffect(() => {
    if (!glossaryRepository) return undefined;
    let isActive = true;
    glossaryRepository.loadRules().then(rules => {
      if (!isActive) return;
      setRows(rules);
      setSaved(rules);
    }).catch(() => {
      if (isActive) setStatus({ message: 'Could not load pronunciation rules.', error: true });
    });
    return () => { isActive = false; };
  }, [glossaryRepository]);

  const addRule = useCallback(() => {
    idCounter.current += 1;
    const id = `rule-${Date.now().toString(36)}-${idCounter.current}`;
    setRows(previous => (previous.length >= MAX_GLOSSARY_RULES ? previous : [...previous, { id, source: '', replacement: '', enabled: true }]));
  }, []);

  const updateRule = useCallback((id, patch) => {
    setRows(previous => previous.map(row => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  const removeRule = useCallback(id => {
    setRows(previous => previous.filter(row => row.id !== id));
  }, []);

  const save = useCallback(async () => {
    if (!glossaryRepository || isSaving) return;
    setIsSaving(true);
    try {
      const result = await glossaryRepository.saveRules(rows.filter(row => !isBlankRow(row)));
      setRows(result.rules);
      setSaved(result.rules);
      setStatus({ message: result.localOnly ? OFFLINE_MESSAGE : SAVED_MESSAGE, error: false });
    } catch (error) {
      setStatus({ message: error?.message || SAVE_FAILURE_MESSAGE, error: true });
    } finally {
      setIsSaving(false);
    }
  }, [glossaryRepository, isSaving, rows]);

  return {
    rows,
    savedCount: saved.filter(rule => rule.enabled).length,
    isDirty: JSON.stringify(rows) !== JSON.stringify(saved),
    isSaving,
    canAdd: rows.length < MAX_GLOSSARY_RULES,
    status,
    addRule, updateRule, removeRule, save,
  };
}
