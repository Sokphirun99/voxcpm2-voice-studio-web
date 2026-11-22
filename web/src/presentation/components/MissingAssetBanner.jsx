/**
 * @fileoverview Accessible missing asset warning banner with re-link and dismiss actions.
 */

import React, { useRef } from 'react';
import { MISSING_ASSET_WARNING_TEXT } from '../../domain/projectRecovery.js';
import { Icon } from './Icon.jsx';

function renderMissingDetails(assets) {
  if (!assets || assets.length === 0) return null;
  const count = assets.length;
  const label = count === 1 ? '1 missing asset' : `${count} missing assets`;
  return <span className="missing-asset-count">({label})</span>;
}

function renderMissingActions({ inputRef, handleFileChange, onDismiss, prefix }) {
  const inputId = prefix ? `${prefix}-missing-asset-file-picker` : 'missing-asset-file-picker';
  const dismissId = prefix ? `${prefix}-dismiss-missing-asset-button` : 'dismiss-missing-asset-button';
  return (
    <div className="missing-asset-actions">
      <button type="button" className="button missing-asset-relink-label" onClick={() => inputRef.current?.click()}>
        Re-link
        <input ref={inputRef} type="file" id={inputId} className="sr-only" onChange={handleFileChange} />
      </button>
      <button type="button" className="button subtle-button missing-asset-dismiss-button" id={dismissId} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * Renders an accessible alert banner when media assets referenced by a project are missing from storage.
 * Inputs: `{ visible, missingAssets, onRelinkFile, onDismiss, workspace }`.
 * Outputs: alert banner element or null.
 * Side effects: triggers onRelinkFile when user selects replacement media.
 * Failure modes: renders nothing when visible is false or missingAssets is empty.
 * @param {{ visible: boolean, missingAssets: Array<object>, onRelinkFile: (file: File) => void, onDismiss: () => void, workspace?: string }} props - Component props.
 * @returns {React.ReactElement|null} Alert banner or null.
 */
export function MissingAssetBanner({ visible, missingAssets = [], onRelinkFile, onDismiss, workspace = '' }) {
  const inputRef = useRef(null);
  if (!visible || !missingAssets || missingAssets.length === 0) return null;
  const handleFileChange = event => {
    if (event.target.files?.[0]) onRelinkFile?.(event.target.files[0]);
    event.target.value = '';
  };
  const bannerId = workspace ? `${workspace}-missing-asset-banner` : 'missing-asset-banner';
  const textId = workspace ? `${workspace}-missing-asset-text` : 'missing-asset-text';
  return (
    <div className="missing-asset-banner" id={bannerId} role="alert" aria-live="polite" onKeyDown={e => e.key === 'Escape' && onDismiss?.()}>
      <span className="missing-asset-icon" aria-hidden="true"><Icon name="alert_circle" /></span>
      <div className="missing-asset-body">
        <span className="missing-asset-message" id={textId}>{MISSING_ASSET_WARNING_TEXT}</span>
        {renderMissingDetails(missingAssets)}
      </div>
      {renderMissingActions({ inputRef, handleFileChange, onDismiss, prefix: workspace })}
    </div>
  );
}
