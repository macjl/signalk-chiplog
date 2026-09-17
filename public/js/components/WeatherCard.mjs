import { html } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';
import {
  beaufort,
  compassPoint,
  forecastSteps,
  toDegrees,
  weatherColumns,
  weatherKind
} from '../weather.mjs';

// An arrow pointing where the flow goes: wind, waves and swell are given as
// where they come from, so theirs is turned round; the current's is not.
function Flow({ radians, from }) {
  const { t } = useLocale();
  const degrees = toDegrees(radians);
  if (degrees === null) {
    return null;
  }
  return html`<span class="weather-direction"
    ><span class="weather-arrow" aria-hidden="true" style=${`transform: rotate(${degrees + (from ? 180 : 0)}deg)`}>↑</span
    >${t(`compass.${compassPoint(radians)}`)}</span
  >`;
}

function Sea({ height, period, direction }) {
  const { format } = useLocale();
  if (typeof height !== 'number') {
    return null;
  }
  return html`<span class="weather-main">${format.depth(height)}</span>
    <span class="weather-sub">${format.period(period)} <${Flow} radians=${direction} from /></span>`;
}

export function WeatherCard({ weather, placeName }) {
  const { t, format } = useLocale();
  const steps = forecastSteps(weather.points, 3);
  if (steps.length === 0) {
    return null;
  }
  // Columns the forecast has nothing for are left out: no sea state inland.
  const columns = weatherColumns(steps);

  return html`
    <section class="card weather-card">
      <h2>${t('passage.weather', { place: placeName ?? t('place.unknown') })}</h2>
      <div class="weather-scroll">
        <table class="weather-table" aria-label=${t('weather.tableLabel')}>
          <thead>
            <tr>
              <th scope="col">${t('weather.time')}</th>
              ${columns.sky && html`<th scope="col">${t('weather.sky')}</th>`}
              ${columns.wind && html`<th scope="col">${t('weather.wind')}</th>`}
              ${columns.waves && html`<th scope="col">${t('weather.waves')}</th>`}
              ${columns.swell && html`<th scope="col">${t('weather.swell')}</th>`}
              ${columns.pressure && html`<th scope="col">${t('weather.pressure')}</th>`}
              ${columns.visibility && html`<th scope="col">${t('weather.visibility')}</th>`}
              ${columns.temperature && html`<th scope="col">${t('weather.temperature')}</th>`}
              ${columns.current && html`<th scope="col">${t('weather.current')}</th>`}
            </tr>
          </thead>
          <tbody>
            ${steps.map((step, index) => {
              const newDay =
                index === 0 || format.dayKey(step.time) !== format.dayKey(steps[index - 1].time);
              const kind = weatherKind(step.weatherCode);
              const force = beaufort(step.windSpeed);
              return html`<tr key=${step.time}>
                <th scope="row">
                  <span class="weather-main">${format.time(step.time)}</span>
                  ${newDay && html`<span class="weather-sub">${format.shortDate(step.time)}</span>`}
                </th>
                ${
                  columns.sky &&
                  html`<td class=${kind === 'thunderstorm' ? 'weather-alert' : ''}>
                    <span class="weather-main">${kind ? t(`weather.kind.${kind}`) : ''}</span>
                    ${step.precipitation > 0 && html`<span class="weather-sub">${format.precipitation(step.precipitation)}</span>`}
                  </td>`
                }
                ${
                  columns.wind &&
                  html`<td class=${force >= 7 ? 'weather-alert' : ''}>
                    ${
                      force !== null &&
                      html`<span class="weather-main">${t('weather.beaufort', { force })}</span>
                        <span class="weather-sub"><${Flow} radians=${step.windDirection} from /> ${format.speed(step.windSpeed)}</span>`
                    }
                    ${typeof step.windGust === 'number' && html`<span class="weather-sub">${t('weather.gust', { speed: format.speed(step.windGust) })}</span>`}
                  </td>`
                }
                ${
                  columns.waves &&
                  html`<td>
                    <${Sea} height=${step.waveHeight} period=${step.wavePeriod} direction=${step.waveDirection} />
                  </td>`
                }
                ${
                  columns.swell &&
                  html`<td>
                    <${Sea} height=${step.swellHeight} period=${step.swellPeriod} direction=${step.swellDirection} />
                  </td>`
                }
                ${columns.pressure && html`<td>${format.pressure(step.pressure)}</td>`}
                ${columns.visibility && html`<td>${format.distance(step.visibility)}</td>`}
                ${
                  columns.temperature &&
                  html`<td>
                    <span class="weather-main">${format.temperature(step.airTemperature)}</span>
                    ${
                      typeof step.seaTemperature === 'number' &&
                      html`<span class="weather-sub">${t('weather.lineSea', { temperature: format.temperature(step.seaTemperature) })}</span>`
                    }
                  </td>`
                }
                ${
                  columns.current &&
                  html`<td>
                    ${
                      typeof step.currentSpeed === 'number' &&
                      html`<span class="weather-main">${format.speed(step.currentSpeed)}</span>
                        <span class="weather-sub"><${Flow} radians=${step.currentDirection} /></span>`
                    }
                  </td>`
                }
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
      <p class="muted weather-note">${t('weather.directionNote')}</p>
      <p class="muted weather-note">${t('weather.attribution')}</p>
    </section>
  `;
}
