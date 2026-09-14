import { html, useState } from '../../vendor/preact-htm.mjs';
import { get } from '../api.mjs';
import { useLocale, usePolling } from '../context.mjs';
import { fallbackMessage } from '../status.mjs';
import { ErrorNotice } from './common.mjs';

const REFRESH_MS = 15 * 1000;

function motionLabel(state, t) {
  if (state.motion === 'underway') {
    if (state.propulsion === 'engine') {
      return t('status.underwayEngine');
    }
    return state.propulsion === 'sail' ? t('status.underwaySail') : t('status.underway');
  }
  return state.motion === 'stopped' ? t('status.stopped') : t('status.unknown');
}

export function StatusBar() {
  const { t, format } = useLocale();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  usePolling((isCurrent) => {
    get('/state')
      .then((next) => {
        if (isCurrent()) {
          setState(next);
          setError(null);
        }
      })
      .catch((err) => isCurrent() && setError(err));
  }, REFRESH_MS);

  if (error) {
    return html`<div class="statusbar"><${ErrorNotice} error=${error} /></div>`;
  }
  if (!state) {
    return html`<div class="statusbar">${t('common.loading')}</div>`;
  }
  return html`
    <div class=${`statusbar statusbar-${state.motion}`}>
      <span class="status-dot" aria-hidden="true"></span>
      <strong>${motionLabel(state, t)}</strong>
      ${
        state.activeEntryId !== null &&
        html`<a href=${`#/passages/${state.activeEntryId}`}>${t('status.currentPassage')}</a>`
      }
      ${
        state.detection === 'fallback' &&
        html`<span class="status-fallback">${fallbackMessage(state.stateIssue, t, format)}</span>`
      }
    </div>
  `;
}
