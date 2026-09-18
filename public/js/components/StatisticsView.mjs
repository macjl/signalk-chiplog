import { html, useEffect, useState } from '../../vendor/preact-htm.mjs';
import { get } from '../api.mjs';
import { useLocale } from '../context.mjs';
import {
  activePreset,
  countryName,
  flagEmoji,
  presetRange,
  RANGE_PRESETS,
  rangeQuery
} from '../statistics.mjs';
import { ErrorNotice, Loading, passageTitle } from './common.mjs';

// The two years whose numbers label their own shortcuts; the months are words.
function presetLabel(preset, t, today) {
  if (preset === 'thisYear') {
    return String(today.getFullYear());
  }
  if (preset === 'lastYear') {
    return String(today.getFullYear() - 1);
  }
  return t(`statistics.range.${preset}`);
}

function PeriodPicker({ from, to, onChange, invalid }) {
  const { t } = useLocale();
  const today = new Date();
  const active = activePreset(from, to, today);

  return html`
    <section class="card" aria-label=${t('statistics.period')}>
      <div class="presets" role="group" aria-label=${t('statistics.period')}>
        ${RANGE_PRESETS.map(
          (preset) => html`
            <button
              type="button"
              key=${preset}
              class=${active === preset ? 'preset preset-on' : 'preset'}
              aria-pressed=${active === preset}
              onClick=${() => onChange(presetRange(preset, today))}
            >
              ${presetLabel(preset, t, today)}
            </button>
          `
        )}
      </div>
      <div class="date-range">
        <label>
          ${t('statistics.from')}
          <input
            type="date"
            value=${from}
            onInput=${(event) => onChange({ from: event.currentTarget.value, to })}
          />
        </label>
        <label>
          ${t('statistics.to')}
          <input
            type="date"
            value=${to}
            onInput=${(event) => onChange({ from, to: event.currentTarget.value })}
          />
        </label>
      </div>
      ${invalid && html`<p class="notice notice-error">${t('statistics.invalidRange')}</p>`}
    </section>
  `;
}

function Summary({ stats }) {
  const { t, format } = useLocale();
  const wind = format.speed(stats.maxWindSpeed);
  const tiles = [
    [t('statistics.count'), stats.count],
    [t('statistics.first'), format.date(stats.firstTime)],
    [t('statistics.last'), format.date(stats.lastTime)],
    [t('statistics.distance'), format.distance(stats.distance)],
    [t('statistics.duration'), format.duration(stats.duration)],
    [t('statistics.maxSpeed'), format.speed(stats.maxSpeed) || '—'],
    [
      t('statistics.maxWind'),
      wind ? (stats.maxWindApparent ? t('statistics.apparent', { speed: wind }) : wind) : '—'
    ]
  ];
  return html`
    <dl class="facts">
      ${tiles.map(
        ([label, value]) => html`
          <div key=${label}>
            <dt>${label}</dt>
            <dd>${value}</dd>
          </div>
        `
      )}
    </dl>
  `;
}

function LongestNonStop({ leg }) {
  const { t, format } = useLocale();
  return html`
    <section class="card">
      <h2>${t('statistics.longest')}</h2>
      ${
        leg
          ? html`
              <p class="longest-facts">
                ${t('statistics.longestFacts', {
                  distance: format.distance(leg.distance),
                  duration: format.duration(leg.duration)
                })}
              </p>
              <p>
                <a href=${`#/passages/${leg.entryId}`}>${passageTitle(leg, t)}</a>
                <span class="muted"> · ${format.date(leg.startTime)}</span>
              </p>
            `
          : html`<p class="muted">${t('statistics.noData')}</p>`
      }
    </section>
  `;
}

function Countries({ countries }) {
  const { t, language } = useLocale();
  return html`
    <section class="card">
      <h2>${t('statistics.countries')}</h2>
      ${
        countries.length > 0
          ? html`
              <ul class="countries">
                ${countries.map(({ code }) => {
                  const name = countryName(code, language);
                  return html`
                    <li key=${code} title=${name}>
                      <span class="flag" aria-hidden="true">${flagEmoji(code) || code}</span>
                      <span>${name}</span>
                    </li>
                  `;
                })}
              </ul>
            `
          : html`<p class="muted">${t('statistics.noCountries')}</p>`
      }
    </section>
  `;
}

function Ranking({ title, passages, value }) {
  const { t, format } = useLocale();
  return html`
    <section class="card">
      <h2>${title}</h2>
      ${
        passages.length > 0
          ? html`
              <ol class="ranking">
                ${passages.map(
                  (passage) => html`
                    <li key=${passage.id}>
                      <a href=${`#/passages/${passage.id}`}>
                        <span class="ranking-what">
                          <span class="ranking-route">${passageTitle(passage, t)}</span>
                          <span class="muted">${format.date(passage.startTime)}</span>
                        </span>
                        <strong class="ranking-value">${value(passage)}</strong>
                      </a>
                    </li>
                  `
                )}
              </ol>
            `
          : html`<p class="muted">${t('statistics.noData')}</p>`
      }
    </section>
  `;
}

function Rankings({ top }) {
  const { t, format } = useLocale();
  const wind = (passage) => {
    const speed = format.speed(passage.maxWindSpeed);
    return passage.maxWindApparent ? t('statistics.apparent', { speed }) : speed;
  };
  return html`
    <div class="card-row">
      <${Ranking}
        title=${t('statistics.topDuration')}
        passages=${top.duration}
        value=${(passage) => format.duration(passage.duration)}
      />
      <${Ranking}
        title=${t('statistics.topDistance')}
        passages=${top.distance}
        value=${(passage) => format.distance(passage.distance)}
      />
      <${Ranking}
        title=${t('statistics.topAverageSpeed')}
        passages=${top.averageSpeed}
        value=${(passage) => format.speed(passage.averageSpeed)}
      />
      <${Ranking}
        title=${t('statistics.topMaxSpeed')}
        passages=${top.maxSpeed}
        value=${(passage) => format.speed(passage.maxSpeed)}
      />
      <${Ranking} title=${t('statistics.topMaxWind')} passages=${top.maxWindSpeed} value=${wind} />
    </div>
  `;
}

export function StatisticsView() {
  const { t } = useLocale();
  const [range, setRange] = useState({ from: '', to: '' });
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const { from, to } = range;
  const invalid = Boolean(from && to && to < from);

  useEffect(() => {
    if (invalid) {
      return undefined;
    }
    let current = true;
    const query = rangeQuery(from, to);
    setLoading(true);
    get(`/statistics${query ? `?${query}` : ''}`)
      .then((next) => {
        if (current) {
          setStats(next);
          setError(null);
        }
      })
      .catch((failure) => current && setError(failure))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [from, to, invalid, attempt]);

  return html`
    <h1 class="page-title">${t('statistics.title')}</h1>
    <${PeriodPicker} from=${from} to=${to} invalid=${invalid} onChange=${setRange} />
    <${ErrorNotice} error=${error} onRetry=${() => setAttempt(attempt + 1)} />
    ${!stats && !error && html`<${Loading} />`}
    ${
      stats &&
      html`
        <div class=${loading ? 'statistics statistics-loading' : 'statistics'} aria-busy=${loading}>
          ${
            stats.count === 0
              ? html`<p class="empty">${t('statistics.empty')}</p>`
              : html`
                  <${Summary} stats=${stats} />
                  <div class="card-row">
                    <${LongestNonStop} leg=${stats.longestNonStop} />
                    <${Countries} countries=${stats.countries} />
                  </div>
                  <${Rankings} top=${stats.top} />
                `
          }
        </div>
      `
    }
  `;
}
