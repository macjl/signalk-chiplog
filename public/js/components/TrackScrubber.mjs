import { html } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';
import { trueWindAngle } from '../track.mjs';

// A history scrubber under the track map: dragging it moves the boat marker
// back and forth through the track and shows the readings at that point.
export function TrackScrubber({ points, index, onIndexChange }) {
  const { t, format } = useLocale();
  if (points.length === 0) {
    return null;
  }
  const point = points[index] ?? {};
  const twa = trueWindAngle(point.twd, point.heading);

  return html`
    <div class="track-scrubber">
      <input
        type="range"
        class="scrubber-slider"
        min="0"
        max=${points.length - 1}
        step="1"
        value=${index}
        disabled=${points.length <= 1}
        aria-label=${t('passage.scrubber')}
        onInput=${(event) => onIndexChange(Number(event.currentTarget.value))}
      />
      <dl class="facts scrubber-facts">
        <div>
          <dt>${t('timeline.time')}</dt>
          <dd>${point.time ? format.time(point.time) : ''}</dd>
        </div>
        <div>
          <dt>SOG</dt>
          <dd>${format.speed(point.sog)}</dd>
        </div>
        <div>
          <dt>COG</dt>
          <dd>${format.bearing(point.cog)}</dd>
        </div>
        <div>
          <dt>STW</dt>
          <dd>${format.speed(point.stw)}</dd>
        </div>
        <div>
          <dt>TWS</dt>
          <dd>${format.speed(point.tws)}</dd>
        </div>
        <div>
          <dt>TWD</dt>
          <dd>${format.bearing(point.twd)}</dd>
        </div>
        <div>
          <dt>TWA</dt>
          <dd>${format.angle(twa)}</dd>
        </div>
        <div>
          <dt>AWA</dt>
          <dd>${format.angle(point.awa)}</dd>
        </div>
      </dl>
    </div>
  `;
}
