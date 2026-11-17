/**
 * @fileoverview Presentation hook managing Voice Library filtering and persistence via injected use cases.
 */

import { useEffect, useMemo, useState } from 'react';
import { BUILT_IN_VOICES, filterLibraryVoices } from '../../domain/voiceLibrary.js';
import { useStudioServices } from '../StudioContext.jsx';

/**
 * Builds save and delete mutations bound to a Voice Library state setter.
 * Inputs: `voiceLibrary` domain use cases and React `setStored` dispatcher.
 * Outputs: `{ saveVoice, deleteVoice, saveVoiceRemote, deleteVoiceRemote }`.
 * Side effects: writes custom characters to storage and updates `warning` on error.
 * Failure modes: propagates `ValidationError` and `StorageError` to callers after setting `warning`.
 * @param {object} voiceLibrary - Domain voice library use cases.
 * @param {Function} setStored - State setter for `{ entries, warning }`.
 * @returns {object} Library mutation actions.
 */
export function createVoiceLibraryActions(voiceLibrary, setStored) {
  return {
    saveVoice(input) {
      const { entry, entries } = voiceLibrary.saveCustom(input);
      setStored({ entries, warning: null });
      return entry;
    },
    deleteVoice(id) {
      try {
        setStored({ entries: voiceLibrary.deleteCustom(id), warning: null });
      } catch (error) {
        setStored(previous => ({ ...previous, warning: error?.message || 'Could not update saved characters.' }));
        throw error;
      }
    },
    saveVoiceRemote: entry => (typeof voiceLibrary.persistCustomRemote === 'function' ? voiceLibrary.persistCustomRemote(entry) : Promise.resolve(entry)),
    deleteVoiceRemote: id => (typeof voiceLibrary.deleteCustomRemote === 'function' ? voiceLibrary.deleteCustomRemote(id) : Promise.resolve()),
  };
}

/**
 * Connects VoiceLibrary component state to injected `voiceLibrary` domain use cases with Docker backend sync.
 * Inputs: none (reads `voiceLibrary` use cases from `StudioContext`).
 * Outputs: `{ allVoices, matches, warning, filters, updateFilter, saveVoice, deleteVoice, saveVoiceRemote, deleteVoiceRemote }`.
 * Side effects: triggers persistence via `voiceLibrary` use cases and hydrates from remote backend on mount.
 * Failure modes: exposes non-blocking storage warning messages in `warning` and rethrows write failures.
 * @returns {object} Voice library state and operations.
 */
export function useVoiceLibrary() {
  const { voiceLibrary, logger } = useStudioServices();
  const [stored, setStored] = useState(() => voiceLibrary.loadSaved());
  const [filters, setFilters] = useState({ search: '', source: '', category: '' });

  useEffect(() => {
    if (typeof voiceLibrary.syncSavedFromRemote !== 'function') return undefined;
    let active = true;
    void voiceLibrary.syncSavedFromRemote()
      .then(synced => { if (active && synced) setStored(synced); })
      .catch(error => {
        logger?.error('useVoiceLibrary.syncRemote', error);
        if (active) setStored(previous => ({ ...previous, warning: error?.message || 'Could not load characters from backend storage.' }));
      });
    return () => { active = false; };
  }, [voiceLibrary, logger]);

  const allVoices = useMemo(() => [...stored.entries, ...BUILT_IN_VOICES], [stored.entries]);
  const matches = useMemo(() => filterLibraryVoices(allVoices, filters), [allVoices, filters]);
  const actions = useMemo(() => createVoiceLibraryActions(voiceLibrary, setStored), [voiceLibrary]);
  const updateFilter = (name, value) => setFilters(previous => ({ ...previous, [name]: value }));
  return { allVoices, matches, warning: stored.warning, filters, updateFilter, ...actions };
}
