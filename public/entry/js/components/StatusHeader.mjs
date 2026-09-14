import { html } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { elapsedSeconds } from '../../../js/components/common.mjs';

function motionLabel(state, t) {
  if (!state) {
    return t('common.loading');
  }
  if (state.motion === 'underway') {
    if (state.propulsion === 'engine') {
      return t('status.underwayEngine');
    }
    return state.propulsion === 'sail' ? t('status.underwaySail') : t('status.underway');
  }
  return state.motion === 'stopped' ? t('status.stopped') : t('status.unknown');
}

// A passage opened by casting off stays stopped from its start until the
// vessel moves.
function passageLine(entry, t, format) {
  if (!entry) {
    return t('entry.noPassage');
  }
  if (entry.stoppedSince) {
    const waiting = entry.openedByEventId !== null && entry.stoppedSince === entry.startTime;
    return waiting
      ? t('entry.waitingToLeave', { time: format.time(entry.stoppedSince) })
      : t('passage.stoppedSince', { time: format.time(entry.stoppedSince) });
  }
  return t('entry.passageFrom', {
    place: entry.startPlaceName ?? t('place.unknown'),
    duration: format.duration(elapsedSeconds(entry))
  });
}

export function StatusHeader({ state, entry, online, queued, night, onToggleNight }) {
  const { t, format } = useLocale();
  const connection = online ? t('entry.online') : t('entry.offline');
  return html`
    <header class="entry-header">
      <div class="entry-status">
        <strong class=${`entry-motion motion-${state?.motion ?? 'unknown'}`}>
          ${motionLabel(state, t)}
        </strong>
        <span class="entry-passage">${state ? passageLine(entry, t, format) : ''}</span>
        ${
          state?.detection === 'fallback' &&
          html`<span class="entry-fallback" title=${t('status.fallback')}>⚠</span>`
        }
      </div>
      <div class="entry-tools">
        <span class=${online ? 'connection connection-online' : 'connection connection-offline'}>
          <span class="connection-dot" aria-hidden="true"></span>
          ${queued > 0 ? `${connection} · ${t('entry.queued', { count: queued })}` : connection}
        </span>
        <button
          type="button"
          class="tool-button"
          aria-pressed=${night ? 'true' : 'false'}
          onClick=${onToggleNight}
        >
          ${t('entry.night')}
        </button>
        <a class="tool-button" href="../">${t('entry.logbook')}</a>
      </div>
    </header>
  `;
}
