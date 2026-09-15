import { html } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';
import { smoothPath, tideExtremes } from '../tide.mjs';

const CHART_WIDTH = 600;
const CHART_HEIGHT = 160;
const PADDING = { top: 16, right: 12, bottom: 12, left: 12 };

// Pixel coordinates for the curve, an area fill down to the baseline, and the
// scales used to place the high/low markers at the same spots.
function layout(points) {
  const start = Date.parse(points[0].time);
  const end = Date.parse(points.at(-1).time);
  const span = Math.max(1, end - start);
  const heights = points.map((point) => point.height);
  const minHeight = Math.min(...heights);
  const range = Math.max(0.1, Math.max(...heights) - minHeight);

  const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;
  const x = (time) => PADDING.left + ((Date.parse(time) - start) / span) * innerWidth;
  const y = (height) => PADDING.top + (1 - (height - minHeight) / range) * innerHeight;
  const baseline = PADDING.top + innerHeight;

  const coords = points.map((point) => ({ x: x(point.time), y: y(point.height) }));
  const linePath = smoothPath(coords);
  const areaPath = `${linePath} L ${coords.at(-1).x} ${baseline} L ${coords[0].x} ${baseline} Z`;

  return { x, y, linePath, areaPath, baseline };
}

export function TideCard({ tide, placeName }) {
  const { t, format } = useLocale();
  const { points } = tide;
  if (points.length < 2) {
    return null;
  }
  const chart = layout(points);
  const extremes = tideExtremes(points);

  return html`
    <section class="card tide-card">
      <h2>${t('passage.tide')}</h2>
      <p class="tide-place">
        <span class="name-label">${t('tide.place')}</span> ${placeName ?? t('place.unknown')}
      </p>
      <svg
        class="tide-chart"
        viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}"
        role="img"
        aria-label=${t('tide.chartLabel')}
      >
        <line
          x1="0"
          y1=${chart.baseline}
          x2=${CHART_WIDTH}
          y2=${chart.baseline}
          class="tide-baseline"
        />
        <path d=${chart.areaPath} class="tide-area" />
        <path d=${chart.linePath} class="tide-line" />
        ${extremes.map(
          (extreme) =>
            html`<circle
              key=${extreme.time}
              cx=${chart.x(extreme.time)}
              cy=${chart.y(extreme.height)}
              r="3"
              class="tide-marker"
            />`
        )}
      </svg>
      <ul class="tide-extremes">
        ${extremes.map(
          (extreme) =>
            html`<li key=${extreme.time} class="tide-extreme">
              <span class="tide-extreme-type"
                >${extreme.type === 'high' ? t('tide.high') : t('tide.low')}</span
              >
              <span class="tide-extreme-when">
                <span class="tide-extreme-date">${format.shortDate(extreme.time)}</span>
                <span class="tide-extreme-time">${format.time(extreme.time)}</span>
              </span>
              <span class="tide-extreme-height">${format.depth(extreme.height)}</span>
            </li>`
        )}
      </ul>
      <p class="muted tide-attribution">${t('tide.attribution')}</p>
    </section>
  `;
}
