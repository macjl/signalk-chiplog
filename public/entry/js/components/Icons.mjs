import { html } from '../../../vendor/preact-htm.mjs';

// Small line icons for the recent-entries actions: plain strokes in
// `currentColor` so they follow the button's text colour (including `.danger`)
// and both themes with no extra styling.

export function PencilIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path
      d="M13.3 2.7 17.3 6.7 7 17 2.5 17.5 3 13 Z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <path d="M11.3 4.7 15.3 8.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>`;
}

export function TrashIcon() {
  return html`<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
    <path d="M4 6h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    <path
      d="M7.5 6V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V6"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M5.5 6l.7 10a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M8.3 8.5v6M10 8.5v6M11.7 8.5v6"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  </svg>`;
}
