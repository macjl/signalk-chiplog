import { html } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';

export function ErrorNotice({ error, onRetry }) {
  const { t } = useLocale();
  if (!error) {
    return null;
  }
  let message;
  if (error.code === 'forbidden') {
    message = html`${t('error.forbidden')} <a href="/admin/">${t('error.signIn')}</a>`;
  } else if (error.code === 'plugin_not_started') {
    message = t('error.notRunning');
  } else if (error.code === 'network') {
    message = t('error.network');
  } else {
    message = t('error.generic', { message: error.message });
  }
  return html`
    <div class="notice notice-error" role="alert">
      <p>${message}</p>
      ${onRetry && html`<button type="button" onClick=${onRetry}>${t('common.retry')}</button>`}
    </div>
  `;
}

export function Loading() {
  const { t } = useLocale();
  return html`<p class="loading">${t('common.loading')}</p>`;
}

export function PlaceName({ name, pending }) {
  const { t } = useLocale();
  return html`
    <span
      class=${pending ? 'place place-pending' : 'place'}
      title=${pending ? t('place.pending') : undefined}
    >
      ${name ?? t('place.unknown')}
    </span>
  `;
}

export function passageTitle(entry, t) {
  const from = entry.startPlaceName ?? t('place.unknown');
  return entry.endTime ? `${from} → ${entry.endPlaceName ?? t('place.unknown')}` : `${from} → …`;
}

export function EngineSailBar({ engine, sail }) {
  const { t, format } = useLocale();
  const total = engine + sail;
  if (total <= 0) {
    return null;
  }
  const enginePercent = (engine / total) * 100;
  return html`
    <div
      class="engine-sail"
      title=${`${t('passage.engine')} ${format.duration(engine)} · ${t('passage.sail')} ${format.duration(sail)}`}
    >
      <span class="engine-sail-engine" style=${`width:${enginePercent}%`}></span>
      <span class="engine-sail-sail" style=${`width:${100 - enginePercent}%`}></span>
    </div>
  `;
}

export function elapsedSeconds(entry, now = Date.now()) {
  const end = entry.endTime ? Date.parse(entry.endTime) : now;
  return Math.max(0, (end - Date.parse(entry.startTime)) / 1000);
}
