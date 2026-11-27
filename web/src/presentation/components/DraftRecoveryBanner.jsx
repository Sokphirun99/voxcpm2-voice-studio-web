/**
 * @fileoverview Accessible draft recovery notification banner.
 */

import React from 'react';
import { buildDraftRecoveryPrompt } from '../../domain/projectRecovery.js';
import { Icon } from './Icon.jsx';

function renderDraftActions(onRestore, onDiscard, prefix) {
  const restoreId = prefix ? `${prefix}-restore-draft-button` : 'restore-draft-button';
  const discardId = prefix ? `${prefix}-discard-draft-button` : 'discard-draft-button';
  return (
    <div className="draft-recovery-actions">
      <button type="button" className="button draft-restore-button" id={restoreId} onClick={onRestore}>
        Restore
      </button>
      <button type="button" className="button subtle-button draft-discard-button" id={discardId} onClick={onDiscard}>
        Discard
      </button>
    </div>
  );
}

/**
 * Renders an accessible alert banner offering to restore or discard an uncommitted recovered draft.
 * Inputs: `{ visible, timestamp, onRestore, onDiscard, workspace }`.
 * Outputs: alert banner element or null.
 * Side effects: none.
 * Failure modes: renders nothing when visible is false.
 * @param {{ visible: boolean, timestamp?: string|null, onRestore: () => void, onDiscard: () => void, workspace?: string }} props - Banner props.
 * @returns {React.ReactElement|null} Alert banner or null.
 */
export function DraftRecoveryBanner({ visible, timestamp, onRestore, onDiscard, workspace = '' }) {
  if (!visible) return null;
  const prompt = buildDraftRecoveryPrompt(timestamp);
  const bannerId = workspace ? `${workspace}-draft-recovery-banner` : 'draft-recovery-banner';
  const promptId = workspace ? `${workspace}-draft-recovery-prompt` : 'draft-recovery-prompt';
  const handleKeyDown = event => {
    if (event.key === 'Escape') onDiscard?.();
  };
  return (
    <div className="draft-recovery-banner" id={bannerId} role="alert" aria-live="polite" onKeyDown={handleKeyDown}>
      <span className="draft-recovery-icon" aria-hidden="true"><Icon name="clock" /></span>
      <span className="draft-recovery-text" id={promptId}>{prompt}</span>
      {renderDraftActions(onRestore, onDiscard, workspace)}
    </div>
  );
}
