/**
 * @fileoverview Floating completion toast stack announcing success or failure across Studio workspaces.
 */

import React from 'react';
import { Icon } from './Icon.jsx';

/**
 * Renders active completion popup notifications with dismiss controls.
 * Inputs: `{ toasts, onDismiss }`.
 * Outputs: floating `<section id="studio-toast-region">` or null when empty.
 * Side effects: triggers `onDismiss(id)` when user closes a toast.
 * Failure modes: none.
 * @param {{ toasts: Array<{ id: string, kind: 'success'|'error', title: string, message: string }>, onDismiss: (id: string) => void }} props - Toast region props.
 * @returns {React.ReactElement|null} Toast region element or null.
 */
export function ToastRegion({ toasts = [], onDismiss }) {
  if (!toasts.length) return null;
  return (
    <section id="studio-toast-region" className="studio-toast-region" aria-label="Notifications">
      {toasts.map(item => (
        <div
          key={item.id}
          className={`studio-toast ${item.kind === 'error' ? 'is-error' : 'is-success'}`}
          role={item.kind === 'error' ? 'alert' : 'status'}
          aria-live={item.kind === 'error' ? 'assertive' : 'polite'}
        >
          <span className="studio-toast-icon" aria-hidden="true">
            <Icon name={item.kind === 'error' ? 'alert_circle' : 'check_circle'} />
          </span>
          <div className="studio-toast-body">
            {item.title ? <strong>{item.title}</strong> : null}
            {item.message ? <span>{item.message}</span> : null}
          </div>
          <button
            type="button"
            className="button subtle-button studio-toast-dismiss"
            aria-label="Dismiss notification"
            onClick={() => onDismiss?.(item.id)}
          >
            <Icon name="xmark" />
          </button>
        </div>
      ))}
    </section>
  );
}
