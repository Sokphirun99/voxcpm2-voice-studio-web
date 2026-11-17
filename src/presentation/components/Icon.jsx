/**
 * @fileoverview Lightweight inline SVG icon component replacing icon fonts.
 */

import React from 'react';

const ICON_PATHS = {
  waveform: (
    <path d="M3 10v4m3.5-7v10M10 4v16m3.5-13v10m3.5-8v6M20 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  ),
  square_pencil: (
    <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M18.5 3.5a2.1 2.1 0 0 1 3 3L12 16l-4 1 1-4 9.5-9.5Z"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
  list_bullet: (
    <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  ),
  sparkles: (
    <path d="m12 3 1.9 4.7L18.6 9.6l-4.7 1.9L12 16.2l-1.9-4.7-4.7-1.9 4.7-1.9L12 3Zm6.5 11.5.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1ZM5.5 15l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7.7-1.7Z"
      fill="currentColor" />
  ),
  text_quote: (
    <path d="M4 6h16M4 12h10M10 18h10M4 18h3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  ),
  person: (
    <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  ),
  chevron_down: (
    <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  ),
  play_fill: <path d="M7 5.5v13l11-6.5-11-6.5Z" fill="currentColor" />,
  pause_fill: <path d="M6.5 5.5h3.5v13H6.5zm7.5 0h3.5v13H14z" fill="currentColor" />,
  stop_fill: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />,
  arrow_down_to_line: (
    <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  ),
  xmark: <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  lock: (
    <path d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z"
      fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
  ),
  upload: (
    <path d="M12 15V4m0 0-4.5 4.5M12 4l4.5 4.5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  ),
};

/**
 * Renders a crisp decorative inline SVG icon.
 * Inputs: `{ name, className }`.
 * Outputs: `<svg>` element with `aria-hidden="true"`.
 * Side effects: none.
 * Failure modes: renders an empty `<svg>` shell for unknown icon names.
 * @param {{ name: string, className?: string }} props - Icon props.
 * @returns {React.ReactElement} Inline SVG icon.
 */
export function Icon({ name, className = '' }) {
  const classes = className ? `studio-icon ${className}` : 'studio-icon';
  return (
    <svg className={classes} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICON_PATHS[name] || null}
    </svg>
  );
}
