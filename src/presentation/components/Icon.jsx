/**
 * @fileoverview Lightweight inline SVG icon component powered by Iconoir (MIT License, 24x24 viewBox).
 */

import React from 'react';

const STROKE_STYLE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const ICON_PATHS = {
  // Iconoir: voice
  waveform: (
    <g {...STROKE_STYLE}>
      <path d="M12 4L12 20" />
      <path d="M8 9L8 15" />
      <path d="M20 10L20 14" />
      <path d="M4 10L4 14" />
      <path d="M16 7L16 17" />
    </g>
  ),
  // Iconoir: edit-pencil
  square_pencil: (
    <path
      d="M14.3632 5.65156L15.8431 4.17157C16.6242 3.39052 17.8905 3.39052 18.6716 4.17157L20.0858 5.58579C20.8668 6.36683 20.8668 7.63316 20.0858 8.41421L18.6058 9.8942M14.3632 5.65156L4.74749 15.2672C4.41542 15.5993 4.21079 16.0376 4.16947 16.5054L3.92738 19.2459C3.87261 19.8659 4.39148 20.3848 5.0115 20.33L7.75191 20.0879C8.21972 20.0466 8.65806 19.8419 8.99013 19.5099L18.6058 9.8942M14.3632 5.65156L18.6058 9.8942"
      {...STROKE_STYLE}
    />
  ),
  // Iconoir: list
  list_bullet: (
    <g {...STROKE_STYLE}>
      <path d="M8 6L20 6" />
      <path d="M4 6.01L4.01 5.99889" />
      <path d="M4 12.01L4.01 11.9989" />
      <path d="M4 18.01L4.01 17.9989" />
      <path d="M8 12L20 12" />
      <path d="M8 18L20 18" />
    </g>
  ),
  // Iconoir: sparks (solid)
  sparkles: (
    <g fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M8 15C12.8747 15 15 12.949 15 8C15 12.949 17.1104 15 22 15C17.1104 15 15 17.1104 15 22C15 17.1104 12.8747 15 8 15Z" />
      <path d="M2 6.5C5.13376 6.5 6.5 5.18153 6.5 2C6.5 5.18153 7.85669 6.5 11 6.5C7.85669 6.5 6.5 7.85669 6.5 11C6.5 7.85669 5.13376 6.5 2 6.5Z" />
    </g>
  ),
  // Iconoir: align-left
  text_quote: (
    <g {...STROKE_STYLE}>
      <path d="M3 10L17 10" />
      <path d="M3 6H21" />
      <path d="M3 18L17 18" />
      <path d="M3 14H21" />
    </g>
  ),
  // Iconoir: user
  person: (
    <g {...STROKE_STYLE}>
      <path d="M5 20V19C5 15.134 8.13401 12 12 12C15.866 12 19 15.134 19 19V20" />
      <path d="M12 12C14.2091 12 16 10.2091 16 8C16 5.79086 14.2091 4 12 4C9.79086 4 8 5.79086 8 8C8 10.2091 9.79086 12 12 12Z" />
    </g>
  ),
  // Iconoir: nav-arrow-down
  chevron_down: <path d="M6 9L12 15L18 9" {...STROKE_STYLE} />,
  // Iconoir: play (solid)
  play_fill: (
    <path
      d="M6.90588 4.53682C6.50592 4.2998 6 4.58808 6 5.05299V18.947C6 19.4119 6.50592 19.7002 6.90588 19.4632L18.629 12.5162C19.0211 12.2838 19.0211 11.7162 18.629 11.4838L6.90588 4.53682Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // Iconoir: pause (solid)
  pause_fill: (
    <g fill="currentColor" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 18.4V5.6C6 5.26863 6.26863 5 6.6 5H9.4C9.73137 5 10 5.26863 10 5.6V18.4C10 18.7314 9.73137 19 9.4 19H6.6C6.26863 19 6 18.7314 6 18.4Z" />
      <path d="M14 18.4V5.6C14 5.26863 14.2686 5 14.6 5H17.4C17.7314 5 18 5.26863 18 5.6V18.4C18 18.7314 17.7314 19 17.4 19H14.6C14.2686 19 14 18.7314 14 18.4Z" />
    </g>
  ),
  // Iconoir: square (stop control)
  stop_fill: (
    <path
      d="M18 5.6V18.4C18 18.7314 17.7314 19 17.4 19H6.6C6.26863 19 6 18.7314 6 18.4V5.6C6 5.26863 6.26863 5 6.6 5H17.4C17.7314 5 18 5.26863 18 5.6Z"
      fill="currentColor"
    />
  ),
  // Iconoir: download
  arrow_down_to_line: (
    <g {...STROKE_STYLE}>
      <path d="M6 20L18 20" />
      <path d="M12 4V16M12 16L15.5 12.5M12 16L8.5 12.5" />
    </g>
  ),
  // Iconoir: xmark
  xmark: (
    <path
      d="M6.75827 17.2426L12.0009 12M17.2435 6.75736L12.0009 12M12.0009 12L6.75827 6.75736M12.0009 12L17.2435 17.2426"
      {...STROKE_STYLE}
    />
  ),
  // Iconoir: lock
  lock: (
    <path
      d="M16 12H17.4C17.7314 12 18 12.2686 18 12.6V19.4C18 19.7314 17.7314 20 17.4 20H6.6C6.26863 20 6 19.7314 6 19.4V12.6C6 12.2686 6.26863 12 6.6 12H8M16 12V8C16 6.66667 15.2 4 12 4C8.8 4 8 6.66667 8 8V12M16 12H8"
      {...STROKE_STYLE}
    />
  ),
  // Iconoir: upload
  upload: (
    <g {...STROKE_STYLE}>
      <path d="M6 20L18 20" />
      <path d="M12 16V4M12 4L15.5 7.5M12 4L8.5 7.5" />
    </g>
  ),
  // Iconoir: closed-captions-tag / film-captions
  subtitles: (
    <g {...STROKE_STYLE}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 11H11" />
      <path d="M13 11H17" />
      <path d="M7 15H14" />
      <path d="M16.5 15H17" />
    </g>
  ),
  // Iconoir: copy
  copy: (
    <g {...STROKE_STYLE}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6C16 4.89543 15.1046 4 14 4H6C4.89543 4 4 4.89543 4 6V14C4 15.1046 4.89543 16 6 16H8" />
    </g>
  ),
  // Iconoir: check-circle
  check_circle: (
    <g {...STROKE_STYLE}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5L10.8 14.8L15.5 9.5" />
    </g>
  ),
  // Iconoir: warning-circle
  alert_circle: (
    <g {...STROKE_STYLE}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13" />
      <path d="M12 16.5L12.01 16.49" />
    </g>
  ),
  // Iconoir: sound-high
  volume_on: (
    <g {...STROKE_STYLE}>
      <path d="M3 10V14H7L12 18V6L7 10H3Z" />
      <path d="M16 9.5C16.8 10.3 17.2 11.1 17.2 12C17.2 12.9 16.8 13.7 16 14.5" />
      <path d="M18.8 7C20.2 8.4 21 10.1 21 12C21 13.9 20.2 15.6 18.8 17" />
    </g>
  ),
  // Iconoir: sound-off
  volume_off: (
    <g {...STROKE_STYLE}>
      <path d="M3 10V14H7L12 18V6L7 10H3Z" />
      <path d="M16 9.5L21 14.5" />
      <path d="M21 9.5L16 14.5" />
    </g>
  ),
  // Iconoir: search
  search: (
    <g {...STROKE_STYLE}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16L20.5 20.5" />
    </g>
  ),
  // Iconoir: scissor
  scissors: (
    <g {...STROKE_STYLE}>
      <circle cx="6.5" cy="7.5" r="2.5" />
      <circle cx="6.5" cy="16.5" r="2.5" />
      <path d="M8.7 8.9L19 16" />
      <path d="M8.7 15.1L19 8" />
    </g>
  ),
  // Iconoir: merge / arrow-down-to-row
  merge: (
    <g {...STROKE_STYLE}>
      <path d="M12 4V14" />
      <path d="M8.5 10.5L12 14L15.5 10.5" />
      <path d="M5 19H19" />
    </g>
  ),
  // Iconoir: trash
  trash: (
    <g {...STROKE_STYLE}>
      <path d="M4 7H20" />
      <path d="M10 4H14" />
      <path d="M6 7L7 19C7.1 19.6 7.5 20 8.1 20H15.9C16.5 20 16.9 19.6 17 19L18 7" />
    </g>
  ),
  // Iconoir: clock
  clock: (
    <g {...STROKE_STYLE}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12L15 13.5" />
    </g>
  ),
};

/**
 * Renders a crisp decorative inline Iconoir SVG icon.
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
