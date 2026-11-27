/**
 * @fileoverview Accessible visual badge indicating local AI model offline readiness and network state.
 */

import React from 'react';
import { OFFLINE_STATUS } from '../../domain/offlineReadiness.js';
import { Icon } from './Icon.jsx';

const STATUS_ICONS = Object.freeze({
  [OFFLINE_STATUS.OFFLINE_READY]: 'check_circle',
  [OFFLINE_STATUS.DOWNLOADS_REQUIRED]: 'arrow_down_to_line',
  [OFFLINE_STATUS.OFFLINE_CACHED_AVAILABLE]: 'alert_circle',
  [OFFLINE_STATUS.SERVICES_OFFLINE]: 'alert_circle',
  [OFFLINE_STATUS.DEGRADED]: 'alert_circle',
});

function resolveStatusIcon(status) {
  return STATUS_ICONS[status] || 'alert_circle';
}

function handleKeyActivation(event, onSelect) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onSelect?.();
  }
}

function buildBadgeAttributes(isClickable, onSelect, readiness, baseClass) {
  return {
    className: baseClass,
    id: 'offline-readiness-badge',
    role: isClickable ? 'button' : 'status',
    tabIndex: isClickable ? 0 : undefined,
    'aria-live': 'polite',
    'aria-label': `Offline readiness: ${readiness.label}`,
    title: readiness.description || readiness.label,
    onClick: onSelect,
    onKeyDown: isClickable ? e => handleKeyActivation(e, onSelect) : undefined,
  };
}

/**
 * Renders the Offline Readiness status indicator badge.
 * Inputs: `{ readiness, onSelect, className }`.
 * Outputs: accessible badge button or status element.
 * Side effects: triggers onSelect on click or keyboard activation.
 * Failure modes: safely renders default indicator if readiness is missing.
 * @param {{ readiness?: object, onSelect?: () => void, className?: string }} props - Badge props.
 * @returns {React.ReactElement|null} Offline readiness badge element.
 */
export function OfflineReadinessBadge({ readiness, onSelect, className = '' }) {
  if (!readiness) return null;
  const status = readiness.status || OFFLINE_STATUS.OFFLINE_READY;
  const isClickable = typeof onSelect === 'function';
  const baseClass = `offline-readiness-badge status-${status} ${className}`.trim();
  const attrs = buildBadgeAttributes(isClickable, onSelect, readiness, baseClass);

  return (
    <div {...attrs}>
      <Icon name={resolveStatusIcon(status)} />
      <span className="readiness-label">{readiness.label}</span>
    </div>
  );
}
