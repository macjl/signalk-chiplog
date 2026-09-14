import { html, useState } from '../../vendor/preact-htm.mjs';
import { apiUrl, get, request } from '../api.mjs';
import { useLocale, usePolling } from '../context.mjs';
import { ErrorNotice } from './common.mjs';

const PLUGIN_CONFIGURATION = '/admin/#/serverConfiguration/plugins/signalk-chiplog';

// Date inputs give local calendar dates; the API wants instants, `to` exclusive.
function localMidnight(value, dayOffset = 0) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day + dayOffset);
}

// The PDF logbook is written in the webapp's language and the device's time zone.
function exportUrl(format, from, to, language) {
  const params = new URLSearchParams({ format });
  if (format === 'pdf') {
    params.set('lang', language);
    params.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
  if (from) {
    params.set('from', localMidnight(from).toISOString());
  }
  if (to) {
    params.set('to', localMidnight(to, 1).toISOString());
  }
  return apiUrl(`/export?${params}`);
}

const STATUS_REFRESH_MS = 30 * 1000;

function scheduleText({ intervalMinutes, onArrival }, t) {
  if (intervalMinutes > 0) {
    return onArrival
      ? t('export.usbScheduleBoth', { minutes: intervalMinutes })
      : t('export.usbScheduleInterval', { minutes: intervalMinutes });
  }
  return onArrival ? t('export.usbScheduleArrival') : t('export.usbScheduleNone');
}

// What the automatic copy has been doing, so a drive that fell out is noticed
// before it is needed.
function UsbStatus({ status }) {
  const { t, format } = useLocale();
  if (!status?.configured) {
    return null;
  }
  const when = (value) => `${format.shortDate(value)} ${format.time(value)}`;
  const { lastSuccess, lastError, nextAt } = status;
  return html`
    <ul class="usb-status">
      <li>${scheduleText(status, t)}</li>
      ${
        lastError &&
        html`<li class="notice notice-error">
          ${t('export.usbLastError', {
            time: when(lastError.at),
            message:
              lastError.code === 'usb_export_unavailable'
                ? t('export.usbUnavailable')
                : lastError.message
          })}
        </li>`
      }
      <li>
        ${
          lastSuccess
            ? t('export.usbLastCopy', {
                time: when(lastSuccess.at),
                written: lastSuccess.written,
                unchanged: lastSuccess.unchanged
              })
            : t('export.usbNeverCopied')
        }
      </li>
      ${nextAt && html`<li class="muted">${t('export.usbNextCopy', { time: format.time(nextAt) })}</li>`}
    </ul>
  `;
}

function UsbResult({ outcome }) {
  const { t } = useLocale();
  if (!outcome) {
    return null;
  }
  if (outcome.result) {
    return html`<p class="notice notice-ok">
      ${t('export.usbWritten', {
        written: outcome.result.written,
        unchanged: outcome.result.unchanged,
        directory: outcome.result.directory
      })}
    </p>`;
  }
  const { error } = outcome;
  if (error.code === 'usb_export_not_configured') {
    return html`<p class="notice notice-error">
      ${t('export.usbNotConfigured')}
      <a href=${PLUGIN_CONFIGURATION}>${t('export.pluginConfiguration')}</a>
    </p>`;
  }
  if (error.code === 'usb_export_unavailable') {
    return html`<p class="notice notice-error">${t('export.usbUnavailable')}</p>`;
  }
  return html`<${ErrorNotice} error=${error} />`;
}

export function ExportView() {
  const { t, language } = useLocale();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [usb, setUsb] = useState(null);
  const [writing, setWriting] = useState(false);
  const [status, setStatus] = useState(null);
  const [version, setVersion] = useState(0);
  const invalid = Boolean(from && to && to < from);

  usePolling(
    (isCurrent) => {
      get('/export/usb')
        .then((next) => isCurrent() && setStatus(next))
        .catch(() => {
          // The write button reports access and configuration problems itself.
        });
    },
    STATUS_REFRESH_MS,
    [version]
  );

  const writeUsb = async () => {
    setWriting(true);
    setUsb(null);
    try {
      setUsb({ result: await request('POST', '/export/usb') });
    } catch (error) {
      setUsb({ error });
    } finally {
      setWriting(false);
      setVersion((v) => v + 1);
    }
  };

  return html`
    <h1 class="page-title">${t('export.title')}</h1>

    <section class="card">
      <p>${t('export.intro')}</p>
      <div class="date-range">
        <label>
          ${t('export.from')}
          <input
            type="date"
            value=${from}
            onInput=${(event) => setFrom(event.currentTarget.value)}
          />
        </label>
        <label>
          ${t('export.to')}
          <input type="date" value=${to} onInput=${(event) => setTo(event.currentTarget.value)} />
        </label>
      </div>
      <p class="muted">${t('export.allHint')}</p>
      ${invalid && html`<p class="notice notice-error">${t('export.invalidRange')}</p>`}
      <ul class="downloads">
        ${['pdf', 'json', 'csv', 'gpx'].map(
          (format) =>
            html`<li key=${format}>
              ${
                invalid
                  ? html`<span class="muted">${t(`export.${format}`)}</span>`
                  : html`<a href=${exportUrl(format, from, to, language)} download>${t(`export.${format}`)}</a>`
              }
            </li>`
        )}
      </ul>
    </section>

    <section class="card">
      <h2>${t('export.usbTitle')}</h2>
      <p>${t('export.usbIntro')}</p>
      <${UsbStatus} status=${status} />
      <button type="button" disabled=${writing} onClick=${writeUsb}>${t('export.usbWrite')}</button>
      <${UsbResult} outcome=${usb} />
    </section>
  `;
}
