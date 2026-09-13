import { html, useState } from '../../vendor/preact-htm.mjs';
import { apiUrl, request } from '../api.mjs';
import { useLocale } from '../context.mjs';
import { ErrorNotice } from './common.mjs';

const PLUGIN_CONFIGURATION = '/admin/#/serverConfiguration/plugins/signalk-chiplog';

// Date inputs give local calendar dates; the API wants instants, `to` exclusive.
function localMidnight(value, dayOffset = 0) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day + dayOffset);
}

function exportUrl(format, from, to) {
  const params = new URLSearchParams({ format });
  if (from) {
    params.set('from', localMidnight(from).toISOString());
  }
  if (to) {
    params.set('to', localMidnight(to, 1).toISOString());
  }
  return apiUrl(`/export?${params}`);
}

function UsbResult({ outcome }) {
  const { t } = useLocale();
  if (!outcome) {
    return null;
  }
  if (outcome.result) {
    return html`<p class="notice notice-ok">
      ${t('export.usbWritten', {
        count: outcome.result.entries,
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
  const { t } = useLocale();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [usb, setUsb] = useState(null);
  const [writing, setWriting] = useState(false);
  const invalid = Boolean(from && to && to < from);

  const writeUsb = async () => {
    setWriting(true);
    setUsb(null);
    try {
      setUsb({ result: await request('POST', '/export/usb') });
    } catch (error) {
      setUsb({ error });
    } finally {
      setWriting(false);
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
        ${['json', 'csv', 'gpx'].map(
          (format) =>
            html`<li key=${format}>
              ${
                invalid
                  ? html`<span class="muted">${t(`export.${format}`)}</span>`
                  : html`<a href=${exportUrl(format, from, to)} download>${t(`export.${format}`)}</a>`
              }
            </li>`
        )}
        <li><span class="muted">${t('export.pdf')}</span></li>
      </ul>
    </section>

    <section class="card">
      <h2>${t('export.usbTitle')}</h2>
      <p>${t('export.usbIntro')}</p>
      <button type="button" disabled=${writing} onClick=${writeUsb}>${t('export.usbWrite')}</button>
      <${UsbResult} outcome=${usb} />
    </section>
  `;
}
