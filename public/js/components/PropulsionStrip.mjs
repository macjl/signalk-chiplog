import { html } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';

export function PropulsionStrip({ segments, entry, busy, onSwitch }) {
  const { t, format } = useLocale();
  if (segments.length === 0) {
    return html`<p class="muted">${t('passage.noPropulsion')}</p>`;
  }

  const start = Date.parse(entry.startTime);
  const end = entry.endTime ? Date.parse(entry.endTime) : Date.now();
  const span = Math.max(end - start, 1);
  const percent = (time) => ((Math.min(Math.max(time, start), end) - start) / span) * 100;
  const segmentEnd = (segment) => (segment.endTime ? Date.parse(segment.endTime) : Date.now());

  return html`
    <div class="strip" aria-hidden="true">
      ${segments.map((segment) => {
        const from = percent(Date.parse(segment.startTime));
        const width = Math.max(percent(segmentEnd(segment)) - from, 0.4);
        return html`<span
          key=${segment.id}
          class=${`strip-segment strip-${segment.type}`}
          style=${`left:${from}%;width:${width}%`}
        ></span>`;
      })}
    </div>
    <ul class="segment-list">
      ${segments.map(
        (segment) => html`
          <li key=${segment.id}>
            <span class=${`segment-type segment-${segment.type}`}>
              ${t(segment.type === 'engine' ? 'passage.engine' : 'passage.sail')}
            </span>
            <span>
              ${`${format.time(segment.startTime)} – ${
                segment.endTime ? format.time(segment.endTime) : '…'
              }`}
            </span>
            <span>${format.duration((segmentEnd(segment) - Date.parse(segment.startTime)) / 1000)}</span>
            ${
              segment.averageRpm !== null &&
              html`<span>${t('passage.rpm', { rpm: Math.round(segment.averageRpm) })}</span>`
            }
            <button
              type="button"
              class="link-button"
              disabled=${busy}
              onClick=${() => onSwitch(segment)}
            >
              ${t('corrections.switchTo', {
                type: t(segment.type === 'engine' ? 'type.sail' : 'type.engine')
              })}
            </button>
          </li>
        `
      )}
    </ul>
  `;
}
