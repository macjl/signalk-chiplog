import { html, useRef, useState } from '../../vendor/preact-htm.mjs';
import { get } from '../api.mjs';
import { useLocale, usePolling } from '../context.mjs';
import { groupByDay } from '../days.mjs';
import { elapsedSeconds, EngineSailBar, ErrorNotice, Loading, PlaceName } from './common.mjs';

const PAGE_SIZE = 50;
const API_PAGE_LIMIT = 500;
const REFRESH_MS = 60 * 1000;

// Reloads everything loaded so far, so a refresh does not drop older pages.
async function loadEntries(count) {
  const items = [];
  let total = 0;
  while (items.length < count) {
    const limit = Math.min(API_PAGE_LIMIT, count - items.length);
    const page = await get(`/entries?limit=${limit}&offset=${items.length}`);
    total = page.total;
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= total) {
      break;
    }
  }
  return { items, total };
}

// Totals across every passage ever logged, not just the pages loaded so far.
function LogStats({ stats }) {
  const { t, format } = useLocale();
  return html`
    <dl class="facts log-stats">
      <div>
        <dt>${t('log.statsCount')}</dt>
        <dd>${stats.count}</dd>
      </div>
      <div>
        <dt>${t('log.statsDistance')}</dt>
        <dd>${format.distance(stats.distance)}</dd>
      </div>
      <div>
        <dt>${t('log.statsDuration')}</dt>
        <dd>${format.duration(stats.duration)}</dd>
      </div>
    </dl>
  `;
}

function PassageCard({ entry, continuesFromPreviousDay, continuesNextDay }) {
  const { t, format } = useLocale();
  const at = (value, withDate) =>
    withDate ? `${format.shortDate(value)} ${format.time(value)}` : format.time(value);

  return html`
    <a
      class=${entry.state === 'active' ? 'passage-card passage-active' : 'passage-card'}
      href=${`#/passages/${entry.id}`}
    >
      <div class="passage-times">
        ${`${at(entry.startTime, continuesFromPreviousDay)} – ${
          entry.endTime ? at(entry.endTime, continuesNextDay) : t('log.inProgress')
        }`}
      </div>
      <div class="passage-places">
        <${PlaceName} name=${entry.startPlaceName} pending=${entry.startPlacePending} />
        <span aria-hidden="true"> → </span>
        ${
          entry.endTime
            ? html`<${PlaceName} name=${entry.endPlaceName} pending=${entry.endPlacePending} />`
            : html`<span class="place">…</span>`
        }
      </div>
      <div class="passage-facts">
        <span>${format.distance(entry.distance)}</span>
        <span>${format.duration(elapsedSeconds(entry))}</span>
      </div>
      <${EngineSailBar} engine=${entry.engineDuration} sail=${entry.sailDuration} />
      ${
        continuesFromPreviousDay &&
        html`<div class="passage-continues">${t('log.fromPreviousDay')}</div>`
      }
      ${continuesNextDay && html`<div class="passage-continues">${t('log.toNextDay')}</div>`}
    </a>
  `;
}

export function LogView() {
  const { t, format } = useLocale();
  const [log, setLog] = useState(null);
  const [error, setError] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const wanted = useRef(PAGE_SIZE);

  const reload = (isCurrent = () => true) =>
    Promise.all([loadEntries(wanted.current), get('/entries/stats')])
      .then(([page, stats]) => {
        if (isCurrent()) {
          setLog({ ...page, stats });
          setError(null);
        }
      })
      .catch((err) => isCurrent() && setError(err));

  usePolling(reload, REFRESH_MS);

  const loadOlder = () => {
    wanted.current += PAGE_SIZE;
    setLoadingOlder(true);
    reload().finally(() => setLoadingOlder(false));
  };

  if (!log) {
    return error
      ? html`<${ErrorNotice} error=${error} onRetry=${() => reload()} />`
      : html`<${Loading} />`;
  }
  if (log.items.length === 0) {
    return html`
      <h1 class="page-title">${t('log.title')}</h1>
      <p class="empty">${t('log.empty')}</p>
    `;
  }

  return html`
    <h1 class="page-title">${t('log.title')}</h1>
    <${ErrorNotice} error=${error} />
    <${LogStats} stats=${log.stats} />
    ${groupByDay(log.items).map(
      (day) => html`
        <section class="day" key=${day.key}>
          <header class="day-header">
            <h2>${format.day(day.date)}</h2>
            ${
              day.distance > 0 &&
              html`<span class="day-distance">
                ${t('log.dayDistance', { distance: format.distance(day.distance) })}
              </span>`
            }
          </header>
          <ul class="passage-list">
            ${day.items.map(
              (item) => html`<li key=${item.entry.id}><${PassageCard} ...${item} /></li>`
            )}
          </ul>
        </section>
      `
    )}
    ${
      log.items.length < log.total &&
      html`<button type="button" class="load-older" disabled=${loadingOlder} onClick=${loadOlder}>
        ${t('log.loadOlder')}
      </button>`
    }
  `;
}
