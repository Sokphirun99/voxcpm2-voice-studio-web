/**
 * @fileoverview Accessible Project & Reusable Terminology Manager modal covering Spelling,
 * Translation, Names, and TTS Pronunciation without mixing distinct correction stages.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_TERMINOLOGY_NOTES_LENGTH,
  MAX_TERMINOLOGY_TEXT_LENGTH,
  TERM_CATEGORIES,
  TERM_SCOPES,
  TERM_STATUSES,
  normalizeTerminologyTerm,
} from '../../domain/terminology.js';
import { Icon } from './Icon.jsx';

const CATEGORY_META = Object.freeze({
  [TERM_CATEGORIES.SPELLING]: { label: 'Spelling', stage: 'Transcript / script text' },
  [TERM_CATEGORIES.TRANSLATION]: { label: 'Translation', stage: 'Translated text' },
  [TERM_CATEGORIES.NAME]: { label: 'Name / Brand', stage: 'Multi-stage entity' },
  [TERM_CATEGORIES.PRONUNCIATION]: { label: 'TTS Pronunciation', stage: 'Audio synthesis only' },
});

const CATEGORY_FILTER_OPTIONS = Object.freeze([
  { id: 'all', label: 'All types' },
  { id: TERM_CATEGORIES.SPELLING, label: 'Spelling' },
  { id: TERM_CATEGORIES.TRANSLATION, label: 'Translation' },
  { id: TERM_CATEGORIES.NAME, label: 'Names' },
  { id: TERM_CATEGORIES.PRONUNCIATION, label: 'TTS Pronunciation' },
]);

const SCOPE_FILTER_OPTIONS = Object.freeze([
  { id: 'all', label: 'All scopes' },
  { id: 'global', label: 'Global library' },
  { id: 'project', label: 'Project overrides' },
]);

function useDialogSync(dialogRef, open) {
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const isCurrentlyOpen = Boolean(el.open || el.hasAttribute?.('open'));
    if (open && !isCurrentlyOpen) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    } else if (!open && isCurrentlyOpen) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [dialogRef, open]);
}

function buildEmptyDraft({ mode, targetCategory = TERM_CATEGORIES.SPELLING, defaultSourceLang = '', defaultTargetLang = '', existing = null }) {
  if (existing) {
    return {
      mode,
      id: existing.id,
      category: existing.category,
      status: existing.status,
      enabled: existing.enabled !== false,
      term: existing.term || '',
      variantsText: Array.isArray(existing.variants) ? existing.variants.join(', ') : '',
      translation: existing.translation || '',
      preserveInTranslation: Boolean(existing.preserveInTranslation),
      pronunciation: existing.pronunciation || '',
      sourceLanguage: existing.sourceLanguage || '',
      targetLanguage: existing.targetLanguage || '',
      caseSensitive: Boolean(existing.caseSensitive),
      notes: existing.notes || '',
    };
  }
  const initialCategory = targetCategory || TERM_CATEGORIES.SPELLING;
  const cleanSourceLang = defaultSourceLang && defaultSourceLang !== 'auto' ? defaultSourceLang : '';
  const shouldPreFillSource = mode === 'add-project' || initialCategory === TERM_CATEGORIES.TRANSLATION;
  return {
    mode,
    id: '',
    category: initialCategory,
    status: TERM_STATUSES.APPROVED,
    enabled: true,
    term: '',
    variantsText: '',
    translation: '',
    preserveInTranslation: initialCategory === TERM_CATEGORIES.NAME,
    pronunciation: '',
    sourceLanguage: shouldPreFillSource ? cleanSourceLang : '',
    targetLanguage: initialCategory === TERM_CATEGORIES.TRANSLATION ? (defaultTargetLang || '') : '',
    caseSensitive: false,
    notes: '',
  };
}

function describeFormMode(mode) {
  if (mode === 'add-project') return 'Add project-only term';
  if (mode === 'edit-project') return 'Edit project-only term';
  if (mode === 'override') return 'Override global term for this project only';
  if (mode === 'edit-global') return 'Edit reusable global term';
  return 'Add reusable global term';
}

function TermStageFields({ draft, setDraft }) {
  const showSpelling = draft.category === TERM_CATEGORIES.SPELLING || draft.category === TERM_CATEGORIES.NAME;
  const showTranslation = draft.category === TERM_CATEGORIES.TRANSLATION || draft.category === TERM_CATEGORIES.NAME;
  const showPronunciation = draft.category === TERM_CATEGORIES.PRONUNCIATION || draft.category === TERM_CATEGORIES.NAME;
  return (
    <>
      {showSpelling && (
        <label className="terminology-field">
          <span>Source variants / misspellings to correct (comma-separated)</span>
          <input
            type="text"
            id="term-variants-input"
            value={draft.variantsText}
            maxLength={MAX_TERMINOLOGY_TEXT_LENGTH * 3}
            placeholder="e.g. Pnom Penh, Phom Penh"
            onChange={e => setDraft(prev => ({ ...prev, variantsText: e.target.value }))}
          />
          <small>Stage 1: fixes source transcript &amp; script spelling only.</small>
        </label>
      )}
      {showTranslation && (
        <div className="terminology-stage-block">
          <label className="terminology-field">
            <span>
              {draft.category === TERM_CATEGORIES.TRANSLATION ? 'Approved target translation *' : 'Target translation (optional if preserving name)'}
            </span>
            <input
              type="text"
              id="term-translation-input"
              value={draft.translation}
              maxLength={MAX_TERMINOLOGY_TEXT_LENGTH}
              placeholder="e.g. ភ្នំពេញ or បញ្ញាសិប្បនិម្មិត"
              required={draft.category === TERM_CATEGORIES.TRANSLATION}
              onChange={e => setDraft(prev => ({ ...prev, translation: e.target.value }))}
            />
          </label>
          {draft.category === TERM_CATEGORIES.NAME && (
            <label className="terminology-checkbox">
              <input
                type="checkbox"
                id="term-preserve-translation"
                checked={draft.preserveInTranslation}
                onChange={e => setDraft(prev => ({ ...prev, preserveInTranslation: e.target.checked }))}
              />
              <span>Preserve canonical name verbatim when translating</span>
            </label>
          )}
          <small>Stage 2: enforced during translation only; never alters source subtitles.</small>
        </div>
      )}
      {showPronunciation && (
        <label className="terminology-field">
          <span>TTS spoken pronunciation</span>
          <input
            type="text"
            id="term-pronunciation-input"
            value={draft.pronunciation}
            maxLength={MAX_TERMINOLOGY_TEXT_LENGTH}
            placeholder="e.g. វ៉ុកស៊ីភីអឹម or Fonetics"
            onChange={e => setDraft(prev => ({ ...prev, pronunciation: e.target.value }))}
          />
          <small>Stage 3: spoken by VoxCPM2 audio only; visible script &amp; subtitles remain unchanged.</small>
        </label>
      )}
    </>
  );
}

function TermEditorForm({ draft, setDraft, error, saving, onSubmit, onCancel }) {
  const isOverride = draft.mode === 'override';
  return (
    <form className="terminology-form" id="terminology-editor-form" onSubmit={onSubmit}>
      <div className="terminology-form-head">
        <strong>{describeFormMode(draft.mode)}</strong>
        <button type="button" className="button subtle-button" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="terminology-error" role="alert">{error}</p>}
      <div className="terminology-form-grid">
        <label className="terminology-field">
          <span>Category (stage behavior)</span>
          <select
            id="term-category-select"
            value={draft.category}
            disabled={isOverride}
            onChange={e => {
              const nextCategory = e.target.value;
              setDraft(prev => ({
                ...prev,
                category: nextCategory,
                preserveInTranslation: nextCategory === TERM_CATEGORIES.NAME && prev.category !== TERM_CATEGORIES.NAME
                  ? true
                  : prev.preserveInTranslation,
              }));
            }}
          >
            <option value={TERM_CATEGORIES.SPELLING}>Spelling (source transcript)</option>
            <option value={TERM_CATEGORIES.TRANSLATION}>Translation (target cues)</option>
            <option value={TERM_CATEGORIES.NAME}>Name / Brand (per-stage)</option>
            <option value={TERM_CATEGORIES.PRONUNCIATION}>TTS Pronunciation (speech only)</option>
          </select>
        </label>
        <label className="terminology-field">
          <span>Status</span>
          <select
            id="term-status-select"
            value={draft.status}
            onChange={e => setDraft(prev => ({ ...prev, status: e.target.value }))}
          >
            <option value={TERM_STATUSES.APPROVED}>Approved (active)</option>
            <option value={TERM_STATUSES.DRAFT}>Draft (review only)</option>
          </select>
        </label>
        <label className="terminology-field terminology-field-wide">
          <span>Canonical word or phrase *</span>
          <input
            type="text"
            id="term-canonical-input"
            value={draft.term}
            maxLength={MAX_TERMINOLOGY_TEXT_LENGTH}
            placeholder="e.g. Phnom Penh, VoxCPM, AI"
            onChange={e => setDraft(prev => ({ ...prev, term: e.target.value }))}
            required
          />
        </label>
        <label className="terminology-field">
          <span>Source language (blank = any)</span>
          <input
            type="text"
            id="term-source-lang-input"
            value={draft.sourceLanguage}
            maxLength={32}
            placeholder="e.g. en, km, zh"
            onChange={e => setDraft(prev => ({ ...prev, sourceLanguage: e.target.value }))}
          />
        </label>
        {(draft.category === TERM_CATEGORIES.TRANSLATION || draft.category === TERM_CATEGORIES.NAME) && (
          <label className="terminology-field">
            <span>Target language (blank = any)</span>
            <input
              type="text"
              id="term-target-lang-input"
              value={draft.targetLanguage}
              maxLength={32}
              placeholder="e.g. khm_Khmr, eng_Latn"
              onChange={e => setDraft(prev => ({ ...prev, targetLanguage: e.target.value }))}
            />
          </label>
        )}
      </div>
      <TermStageFields draft={draft} setDraft={setDraft} />
      <div className="terminology-form-meta">
        <label className="terminology-checkbox">
          <input
            type="checkbox"
            id="term-case-sensitive"
            checked={draft.caseSensitive}
            onChange={e => setDraft(prev => ({ ...prev, caseSensitive: e.target.checked }))}
          />
          <span>Case-sensitive matching</span>
        </label>
        <label className="terminology-field">
          <span>Notes (optional)</span>
          <input
            type="text"
            id="term-notes-input"
            value={draft.notes}
            maxLength={MAX_TERMINOLOGY_NOTES_LENGTH}
            placeholder="Context for editors or translators"
            onChange={e => setDraft(prev => ({ ...prev, notes: e.target.value }))}
          />
        </label>
      </div>
      <div className="terminology-form-actions">
        <button type="submit" id="term-save-btn" className="button generate" disabled={saving}>
          {saving ? 'Saving…' : 'Save term'}
        </button>
      </div>
    </form>
  );
}

function TermBadges({ entry }) {
  const cat = CATEGORY_META[entry.category] || { label: entry.category };
  const isApproved = entry.status === TERM_STATUSES.APPROVED;
  return (
    <div className="terminology-badges">
      <span className={`terminology-cat-pill is-${entry.category}`}>{cat.label}</span>
      <span className={`terminology-status-pill ${isApproved ? 'is-approved' : 'is-draft'}`}>
        {isApproved ? 'Approved' : 'Draft'}
      </span>
      {entry.scope === TERM_SCOPES.PROJECT && (
        <span className="terminology-scope-pill is-project">Project term</span>
      )}
      {entry.isOverridden && !entry.isDisabledInProject && (
        <span className="terminology-scope-pill is-override">Project override</span>
      )}
      {entry.isDisabledInProject && (
        <span className="terminology-scope-pill is-disabled">Disabled in project</span>
      )}
      {(entry.sourceLanguage || entry.targetLanguage) && (
        <span className="terminology-lang-pill">
          {entry.sourceLanguage || 'any'} → {entry.targetLanguage || 'any'}
        </span>
      )}
    </div>
  );
}

function TermStageDetails({ entry }) {
  return (
    <div className="terminology-details">
      {entry.variants?.length > 0 && (
        <span className="terminology-stage-line">
          <strong>Spelling fixes:</strong> {entry.variants.join(', ')} → {entry.term}
        </span>
      )}
      {(entry.translation || (entry.category === TERM_CATEGORIES.NAME && entry.preserveInTranslation)) && (
        <span className="terminology-stage-line">
          <strong>Translation:</strong> {entry.translation || `${entry.term} (preserve verbatim)`}
        </span>
      )}
      {entry.pronunciation !== '' && (entry.category === TERM_CATEGORIES.PRONUNCIATION || entry.category === TERM_CATEGORIES.NAME) && (
        <span className="terminology-stage-line">
          <strong>TTS pronunciation:</strong> {entry.pronunciation}
        </span>
      )}
      {entry.category === TERM_CATEGORIES.PRONUNCIATION && entry.pronunciation === '' && (
        <span className="terminology-stage-line">
          <strong>TTS pronunciation:</strong> (silence / omit in speech)
        </span>
      )}
      {entry.notes && <span className="terminology-notes-line">{entry.notes}</span>}
    </div>
  );
}

function TermRowActions({ entry, canEditProject, globalSource, busy, handlers }) {
  const isGlobal = entry.scope !== TERM_SCOPES.PROJECT;
  const approvedLabel = entry.status === TERM_STATUSES.APPROVED ? 'Set draft' : 'Approve';
  return (
    <div className="terminology-row-actions">
      {!isGlobal ? (
        <>
          <button type="button" className="button subtle-button" disabled={busy}
            onClick={() => handlers.onToggleProjectApproval(entry.id)}>
            {approvedLabel}
          </button>
          <button type="button" className="button subtle-button" disabled={busy}
            onClick={() => handlers.onEditProject(entry)}>
            Edit
          </button>
          <button type="button" className="button subtle-button" disabled={busy}
            onClick={() => handlers.onPromote(entry.id)}>
            Promote to global
          </button>
          <button type="button" className="button subtle-button terminology-danger-btn" disabled={busy}
            onClick={() => handlers.onDeleteProject(entry.id)}>
            Delete
          </button>
        </>
      ) : (
        <>
          <button type="button" className="button subtle-button" disabled={busy}
            onClick={() => handlers.onToggleGlobalApproval(entry.id)}>
            {approvedLabel}
          </button>
          <button type="button" className="button subtle-button" disabled={busy}
            onClick={() => handlers.onEditGlobal(globalSource || entry)}>
            Edit global
          </button>
          {canEditProject && (
            <>
              <button type="button" className="button subtle-button" disabled={busy || entry.isDisabledInProject}
                onClick={() => handlers.onOverride(entry)}>
                Override
              </button>
              <button type="button" className="button subtle-button" disabled={busy}
                onClick={() => handlers.onToggleDisabledInProject(entry.id, !entry.isDisabledInProject)}>
                {entry.isDisabledInProject ? 'Enable here' : 'Disable here'}
              </button>
              {entry.isOverridden && (
                <button type="button" className="button subtle-button" disabled={busy}
                  onClick={() => handlers.onResetOverride(entry.id)}>
                  Reset
                </button>
              )}
            </>
          )}
          <button type="button" className="button subtle-button terminology-danger-btn" disabled={busy}
            onClick={() => handlers.onDeleteGlobal(entry.id)}>
            Delete
          </button>
        </>
      )}
    </div>
  );
}

function buildPayloadFromDraft(draft) {
  const variants = draft.variantsText
    .split(/[,\n]/)
    .map(v => v.trim())
    .filter(Boolean);
  return {
    id: draft.id || undefined,
    category: draft.category,
    status: draft.status,
    enabled: draft.enabled,
    term: draft.term,
    variants,
    translation: draft.translation,
    preserveInTranslation: Boolean(draft.preserveInTranslation),
    pronunciation: draft.pronunciation,
    sourceLanguage: draft.sourceLanguage,
    targetLanguage: draft.targetLanguage,
    caseSensitive: Boolean(draft.caseSensitive),
    notes: draft.notes,
  };
}

const OVERRIDE_DIFF_KEYS = Object.freeze([
  'status', 'enabled', 'term', 'variants', 'translation', 'preserveInTranslation',
  'pronunciation', 'sourceLanguage', 'targetLanguage', 'caseSensitive', 'notes',
]);

function areFieldValuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    return arrA.length === arrB.length && arrA.every((item, idx) => item === arrB[idx]);
  }
  return a === b;
}

function buildOverrideDiffPatch(payload, globalSource) {
  if (!globalSource) return payload;
  const base = normalizeTerminologyTerm(globalSource);
  const candidate = normalizeTerminologyTerm({ ...base, ...payload, id: base.id });
  const patch = {};
  for (const key of OVERRIDE_DIFF_KEYS) {
    if (!areFieldValuesEqual(candidate[key], base[key])) patch[key] = candidate[key];
  }
  return patch;
}

function handleBackdropClick(event, dialogRef, onClose) {
  if (event.target !== dialogRef.current) return;
  if (typeof dialogRef.current?.getBoundingClientRect !== 'function') {
    onClose?.();
    return;
  }
  const rect = dialogRef.current.getBoundingClientRect();
  const isOutside = (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
  if (isOutside) onClose?.();
}

/**
 * Renders the Terminology Manager modal dialog supporting global reusable terminology and
 * per-project overrides across all 4 isolated stages.
 * Inputs: `{ open, terminologyCtrl, canEditProject, projectTitle, sourceLanguage, targetLanguage, onClose }`.
 * Outputs: `<dialog className="voice-library terminology-dialog">` element.
 * Side effects: saves reusable global terms and updates project-level overrides.
 * Failure modes: displays ValidationError/StorageError messages inline inside the dialog.
 * @param {object} props - Modal props.
 * @returns {React.ReactElement} Terminology dialog element.
 */
export function TerminologyManagerModal({
  open,
  terminologyCtrl,
  canEditProject = false,
  projectTitle = '',
  sourceLanguage = '',
  targetLanguage = '',
  onClose,
}) {
  const dialogRef = useRef(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useDialogSync(dialogRef, open);
  useEffect(() => {
    if (!open) {
      setDraft(null);
      setError('');
    }
  }, [open]);

  const effectiveTerms = terminologyCtrl?.effectiveTerms || [];
  const globalById = useMemo(
    () => new Map((terminologyCtrl?.globalTerms || []).map(item => [item.id, item])),
    [terminologyCtrl?.globalTerms]
  );

  const filteredTerms = useMemo(() => {
    const query = search.trim().toLowerCase();
    return effectiveTerms.filter(entry => {
      if (categoryFilter !== 'all' && entry.category !== categoryFilter) return false;
      if (statusFilter !== 'all' && entry.status !== statusFilter) return false;
      if (scopeFilter === 'global' && entry.scope !== TERM_SCOPES.GLOBAL) return false;
      if (scopeFilter === 'project' && entry.scope !== TERM_SCOPES.PROJECT && !entry.isOverridden) return false;
      if (!query) return true;
      const haystack = [entry.term, ...(entry.variants || []), entry.translation, entry.pronunciation, entry.notes]
        .join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [effectiveTerms, categoryFilter, statusFilter, scopeFilter, search]);

  const runAction = async fn => {
    setError('');
    setSaving(true);
    try {
      await fn();
    } catch (err) {
      setError(err?.message || 'Could not update terminology.');
    } finally {
      setSaving(false);
    }
  };

  const handleFormSubmit = async event => {
    event.preventDefault();
    if (!draft || !terminologyCtrl) return;
    await runAction(async () => {
      const payload = buildPayloadFromDraft(draft);
      if (draft.mode === 'add-global') {
        await terminologyCtrl.addGlobalTerm(payload);
      } else if (draft.mode === 'edit-global') {
        await terminologyCtrl.updateGlobalTerm(draft.id, payload);
      } else if (draft.mode === 'override') {
        const diffPatch = buildOverrideDiffPatch(payload, globalById.get(draft.id));
        if (Object.keys(diffPatch).length === 0) terminologyCtrl.resetGlobalTermOverride(draft.id);
        else terminologyCtrl.overrideGlobalTerm(draft.id, diffPatch, { replace: true });
      } else if (draft.mode === 'add-project' || draft.mode === 'edit-project') {
        terminologyCtrl.saveProjectTerm(payload);
      }
      setDraft(null);
    });
  };

  const handlers = {
    onToggleGlobalApproval: id => void runAction(() => terminologyCtrl.toggleGlobalTermApproval(id)),
    onDeleteGlobal: id => void runAction(() => terminologyCtrl.deleteGlobalTerm(id)),
    onEditGlobal: entry => {
      setError('');
      setDraft(buildEmptyDraft({ mode: 'edit-global', existing: entry }));
    },
    onOverride: entry => {
      setError('');
      setDraft(buildEmptyDraft({ mode: 'override', existing: entry }));
    },
    onToggleDisabledInProject: (id, disabled) => void runAction(() => terminologyCtrl.disableGlobalTermInProject(id, disabled)),
    onResetOverride: id => void runAction(() => terminologyCtrl.resetGlobalTermOverride(id)),
    onToggleProjectApproval: id => void runAction(() => terminologyCtrl.toggleProjectTermApproval(id)),
    onEditProject: entry => {
      setError('');
      setDraft(buildEmptyDraft({ mode: 'edit-project', existing: entry }));
    },
    onDeleteProject: id => void runAction(() => terminologyCtrl.deleteProjectTerm(id)),
    onPromote: id => void runAction(() => terminologyCtrl.promoteToGlobal(id)),
  };

  return (
    <dialog
      ref={dialogRef}
      id="terminology-manager-dialog"
      className="voice-library terminology-dialog"
      aria-modal="true"
      aria-labelledby="terminology-dialog-title"
      aria-describedby="terminology-dialog-desc"
      onClose={onClose}
      onCancel={onClose}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault?.(); dialogRef.current?.close?.(); onClose?.(); } }}
      onClick={e => handleBackdropClick(e, dialogRef, () => { dialogRef.current?.close?.(); onClose?.(); })}
    >
      <div className="library-header">
        <div>
          <h2 id="terminology-dialog-title">Project terminology</h2>
          <p id="terminology-dialog-desc">
            {canEditProject
              ? `Active scope: ${projectTitle || 'Current project'} overrides + reusable global library. Only Approved terms apply.`
              : 'Reusable global terminology across Spelling, Translation, Names, and TTS Pronunciation. Only Approved terms apply.'}
          </p>
        </div>
        <div className="library-header-actions terminology-head-actions">
          <button
            type="button"
            id="terminology-add-global-btn"
            className="button subtle-button"
            disabled={saving}
            onClick={() => {
              setError('');
              setDraft(buildEmptyDraft({
                mode: 'add-global',
                targetCategory: categoryFilter === 'all' ? TERM_CATEGORIES.SPELLING : categoryFilter,
                defaultSourceLang: sourceLanguage,
                defaultTargetLang: targetLanguage,
              }));
            }}
          >
            + Add global term
          </button>
          {canEditProject && (
            <button
              type="button"
              id="terminology-add-project-btn"
              className="button generate"
              disabled={saving}
              onClick={() => {
                setError('');
                setDraft(buildEmptyDraft({
                  mode: 'add-project',
                  targetCategory: categoryFilter === 'all' ? TERM_CATEGORIES.SPELLING : categoryFilter,
                  defaultSourceLang: sourceLanguage,
                  defaultTargetLang: targetLanguage,
                }));
              }}
            >
              + Add project term
            </button>
          )}
          <button
            type="button"
            id="terminology-close-btn"
            className="button subtle-button"
            aria-label="Close terminology manager"
            onClick={() => { dialogRef.current?.close?.(); onClose?.(); }}
          >
            Close
          </button>
        </div>
      </div>

      {draft ? (
        <TermEditorForm
          draft={draft}
          setDraft={setDraft}
          error={error}
          saving={saving}
          onSubmit={handleFormSubmit}
          onCancel={() => { setDraft(null); setError(''); }}
        />
      ) : (
        <>
          <div className="terminology-toolbar">
            <input
              type="search"
              id="terminology-search-input"
              className="terminology-search-input"
              placeholder="Search term, variant, translation, or pronunciation…"
              aria-label="Search terminology entries"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <select
              id="terminology-category-filter"
              aria-label="Filter by terminology category"
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
            >
              {CATEGORY_FILTER_OPTIONS.map(opt => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
            <select
              id="terminology-status-filter"
              aria-label="Filter by approval status"
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value={TERM_STATUSES.APPROVED}>Approved only</option>
              <option value={TERM_STATUSES.DRAFT}>Draft only</option>
            </select>
            {canEditProject && (
              <select
                id="terminology-scope-filter"
                aria-label="Filter by scope"
                value={scopeFilter}
                onChange={e => setScopeFilter(e.target.value)}
              >
                {SCOPE_FILTER_OPTIONS.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            )}
          </div>
          {error && <p className="terminology-error" role="alert">{error}</p>}
          <p className="library-count" role="status">
            {filteredTerms.length} shown · {terminologyCtrl?.counts?.approved || 0} approved active · {terminologyCtrl?.counts?.overridden || 0} project overrides
          </p>
          <div className="library-scroll">
            {filteredTerms.length === 0 ? (
              <div className="terminology-empty">
                <Icon name="list_bullet" />
                <p>No terminology entries match the current filters.</p>
              </div>
            ) : (
              <ul className="terminology-list" id="terminology-list">
                {filteredTerms.map(entry => (
                  <li
                    key={`${entry.scope}-${entry.id}`}
                    className={`terminology-row${entry.isDisabledInProject ? ' is-project-disabled' : ''}`}
                    data-term-id={entry.id}
                    data-term-scope={entry.scope}
                  >
                    <div className="terminology-row-main">
                      <div className="terminology-row-title">
                        <strong>{entry.term}</strong>
                        <TermBadges entry={entry} />
                      </div>
                      <TermStageDetails entry={entry} />
                    </div>
                    <TermRowActions
                      entry={entry}
                      canEditProject={canEditProject}
                      globalSource={globalById.get(entry.id)}
                      busy={saving}
                      handlers={handlers}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
