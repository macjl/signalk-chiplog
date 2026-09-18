import { html, useState } from '../../vendor/preact-htm.mjs';
import { get, request } from '../api.mjs';
import { useLocale, usePolling } from '../context.mjs';
import { DateRangePicker } from './DateRangePicker.mjs';
import { ErrorNotice } from './common.mjs';

const PLUGIN_CONFIGURATION = '/admin/#/serverConfiguration/plugins/signalk-chiplog';
const REFRESH_MS = 3 * 1000;

// Date inputs give local calendar dates; the API wants instants, `to` exclusive.
function localMidnight(value, dayOffset = 0) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day + dayOffset);
}

function Progress({ progress }) {
  const { t, format } = useLocale();
  const total = Date.parse(progress.to) - Date.parse(progress.from);
  const done = Date.parse(progress.now) - Date.parse(progress.from);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
  return html`
    <div class="replay-progress">
      <progress value=${percent} max="100"></progress>
      <p class="muted">
        ${t('replay.progress', {
          percent,
          time: `${format.shortDate(progress.now)} ${format.time(progress.now)}`
        })}
      </p>
      ${
        progress.retry &&
        html`<p class="notice">
          ${t('replay.retrying', {
            attempt: progress.retry.attempt,
            of: progress.retry.of,
            message: progress.retry.message
          })}
        </p>`
      }
      ${
        progress.phase === 'replaying' &&
        html`<${Summary} summary=${progress.summary} live=${true} />`
      }
    </div>
  `;
}

// What a run added, live while it is still going (so a timeout partway
// through still leaves something to show for it) and again for the final
// outcome -- also after a cancellation, since what was reconstructed up to
// that point stays on record either way.
function Summary({ summary, live = false }) {
  const { t, format } = useLocale();
  if (!summary) {
    return null;
  }
  if (summary.passages === 0) {
    return live ? null : html`<p class="muted">${t('replay.summaryEmpty')}</p>`;
  }
  const facts = [
    ['replay.summaryPassages', format.count(summary.passages)],
    ['replay.summaryDistance', format.distance(summary.distance)],
    ['replay.summaryEngine', format.duration(summary.engineDuration), 'fact-engine'],
    ['replay.summarySail', format.duration(summary.sailDuration), 'fact-sail'],
    ['replay.summaryTrackPoints', format.count(summary.trackPoints)],
    ['replay.summaryEvents', format.count(summary.events)]
  ];
  return html`
    <dl class="facts">
      ${facts.map(
        ([key, value, className]) => html`
          <div>
            <dt>${t(key)}</dt>
            <dd class=${className}>${value}</dd>
          </div>
        `
      )}
    </dl>
  `;
}

function Outcome({ status }) {
  const { t, format } = useLocale();
  if (status.lastError) {
    const { lastError } = status;
    return html`
      <p class="notice notice-error">
        ${t('replay.failed', {
          time: format.time(lastError.at),
          message: lastError.message
        })}
      </p>
      <${Summary} summary=${lastError.summary} />
    `;
  }
  if (status.lastResult) {
    const { lastResult } = status;
    return html`
      <p class="notice ${lastResult.cancelled ? '' : 'notice-ok'}">
        ${t(lastResult.cancelled ? 'replay.cancelled' : 'replay.done', {
          time: format.time(lastResult.at)
        })}
      </p>
      <${Summary} summary=${lastResult.summary} />
    `;
  }
  return null;
}

export function ReplayView() {
  const { t } = useLocale();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  usePolling(
    (isCurrent) => {
      get('/replay')
        .then((next) => isCurrent() && setStatus(next))
        .catch(() => {});
    },
    REFRESH_MS,
    []
  );

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await request('POST', '/replay', {
        from: localMidnight(from).toISOString(),
        to: localMidnight(to, 1).toISOString()
      });
      setStatus(await get('/replay'));
    } catch (err) {
      setError(err);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    try {
      await request('POST', '/replay/cancel');
      setStatus(await get('/replay'));
    } catch (err) {
      setError(err);
    }
  };

  const running = Boolean(status?.running);
  const notConfigured = error?.code === 'replay_not_configured';
  const navigationActive = error?.code === 'replay_navigation_active';

  return html`
    <h1 class="page-title">${t('replay.title')}</h1>

    <section class="card">
      <p>${t('replay.intro')}</p>
      <${DateRangePicker}
        from=${from}
        to=${to}
        label=${t('range.period')}
        allowAny=${false}
        disabled=${running}
        onChange=${(range) => {
          setFrom(range.from);
          setTo(range.to);
        }}
      />
      ${
        notConfigured &&
        html`<p class="notice notice-error">
          ${t('replay.notConfigured')}
          <a href=${PLUGIN_CONFIGURATION}>${t('export.pluginConfiguration')}</a>
        </p>`
      }
      ${
        navigationActive && html`<p class="notice notice-error">${t('replay.navigationActive')}</p>`
      }
      ${error && !notConfigured && !navigationActive && html`<${ErrorNotice} error=${error} />`}
      <div class="replay-actions">
        <button
          type="button"
          disabled=${!from || !to || starting || running}
          onClick=${start}
        >
          ${t('replay.start')}
        </button>
        ${
          running &&
          html`<button type="button" class="danger" onClick=${cancel}>
            ${t('replay.cancel')}
          </button>`
        }
      </div>
      ${status?.progress && html`<${Progress} progress=${status.progress} />`}
      ${status && !status.progress && html`<${Outcome} status=${status} />`}
    </section>
  `;
}
