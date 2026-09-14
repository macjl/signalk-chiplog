import { html, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';

const DEPARTURES = new Set(['cast_off', 'anchor_up']);
export const SAILS = [
  'main',
  'genoa',
  'jib',
  'staysail',
  'spinnaker',
  'gennaker',
  'code0',
  'storm_jib'
];

export function manoeuvreLabel(type, t) {
  const key = `manoeuvre.${type.key}`;
  return t.has(key) ? t(key) : type.label;
}

function SailSheet({ onPick, onClose }) {
  const { t } = useLocale();
  const [other, setOther] = useState('');
  const submitOther = (event) => {
    event.preventDefault();
    if (other.trim()) {
      onPick(other.trim());
    }
  };
  return html`
    <div class="sheet-backdrop" onClick=${(event) => event.target === event.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sail-title">
        <h2 id="sail-title">${t('entry.chooseSail')}</h2>
        <div class="sail-grid">
          ${SAILS.map(
            (sail) =>
              html`<button type="button" class="big-button" key=${sail} onClick=${() => onPick(sail)}>
                ${t(`sail.${sail}`)}
              </button>`
          )}
        </div>
        <form class="sheet-row" onSubmit=${submitOther}>
          <input
            value=${other}
            maxlength="60"
            placeholder=${t('entry.otherSail')}
            aria-label=${t('entry.otherSail')}
            onInput=${(event) => setOther(event.currentTarget.value)}
          />
          <button type="submit" class="big-button primary" disabled=${!other.trim()}>${t('entry.send')}</button>
        </form>
        <button type="button" class="link-button" onClick=${onClose}>${t('common.cancel')}</button>
      </div>
    </div>
  `;
}

export function ManoeuvrePad({ types, noPassage, busy, onLog }) {
  const { t } = useLocale();
  const [choosingSail, setChoosingSail] = useState(null);
  const enabled = types.filter((type) => type.enabled);

  const press = (type) => {
    if (type.key === 'sail_change') {
      setChoosingSail(type);
      return;
    }
    onLog({ type: 'manoeuvre', subtype: type.key }, manoeuvreLabel(type, t));
  };

  return html`
    <section class="panel pad" aria-labelledby="pad-title">
      <h2 id="pad-title" class="panel-title">${t('entry.manoeuvres')}</h2>
      ${noPassage && html`<p class="hint">${t('entry.departHint')}</p>`}
      <div class="pad-grid">
        ${enabled.map((type) => {
          const highlighted = noPassage && DEPARTURES.has(type.key);
          return html`<button
            type="button"
            key=${type.key}
            class=${highlighted ? 'big-button primary' : 'big-button'}
            disabled=${busy}
            onClick=${() => press(type)}
          >
            ${manoeuvreLabel(type, t)}
          </button>`;
        })}
      </div>
      ${
        choosingSail &&
        html`<${SailSheet}
          onClose=${() => setChoosingSail(null)}
          onPick=${(sail) => {
            const type = choosingSail;
            setChoosingSail(null);
            const sailName = t.has(`sail.${sail}`) ? t(`sail.${sail}`) : sail;
            onLog(
              { type: 'manoeuvre', subtype: type.key, payload: { sail } },
              `${manoeuvreLabel(type, t)} (${sailName})`
            );
          }}
        />`
      }
    </section>
  `;
}
