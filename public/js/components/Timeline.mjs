import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';
import { dayKey } from '../days.mjs';
import { buildRows, describeEvent } from '../log-lines.mjs';

// A dot — the stroke of an i or a full stop — has a single point, which a
// polyline only draws when given twice.
function strokePoints(stroke) {
  const points = (stroke.points ?? []).map((point) => `${point.x},${point.y}`);
  return (points.length === 1 ? [points[0], points[0]] : points).join(' ');
}

export function Strokes({ strokes, label }) {
  const points = strokes.flatMap((stroke) => stroke.points ?? []);
  if (points.length === 0) {
    return null;
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 1);
  const pad = size * 0.05;
  return html`
    <svg
      class="strokes"
      viewBox=${`${minX - pad} ${minY - pad} ${Math.max(...xs) - minX + 2 * pad} ${Math.max(...ys) - minY + 2 * pad}`}
      role="img"
      aria-label=${label}
    >
      <g
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width=${size / 120}
      >
        ${strokes.map(
          (stroke, index) =>
            html`<polyline
              key=${index}
              points=${strokePoints(stroke)}
            />`
        )}
      </g>
    </svg>
  `;
}

export function EventRemark({ event, manoeuvreLabels }) {
  const { t, format } = useLocale();
  const line = describeEvent(event, { t, format, manoeuvreLabels });
  const comment = line.comment ? ` — ${line.comment}` : '';
  const label =
    line.label && html`<strong class=${line.alarm ? 'alarm' : undefined}>${line.label}</strong>`;
  const detail = line.detail ? `${line.label ? ' ' : ''}${line.detail}` : '';
  const strokes =
    line.strokes && html`<${Strokes} strokes=${line.strokes} label=${t('event.handwritten')} />`;
  return html`${label}${strokes}${detail}${comment}`;
}

// A logged event's remarks, with edit-comment and delete controls — the only
// corrections the API allows on a line (SPEC: "an edited comment"). Deleting
// is offered only for what the crew themselves logged (`source: "manual"`);
// automatic lines (alarms, autopilot, weather, corrections) can only be
// annotated.
function EventLine({ event, manoeuvreLabels, busy, onEditComment, onDelete }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(event.comment ?? '');
  const field = useRef(null);

  useEffect(() => {
    if (!editing) {
      setDraft(event.comment ?? '');
    }
  }, [event.comment, editing]);

  useEffect(() => {
    if (editing) {
      field.current?.focus();
    }
  }, [editing]);

  if (editing) {
    const submit = (submitEvent) => {
      submitEvent.preventDefault();
      const trimmed = draft.trim();
      setEditing(false);
      onEditComment(event, trimmed === '' ? null : trimmed);
    };
    return html`
      <form class="timeline-comment-form" onSubmit=${submit}>
        <textarea
          ref=${field}
          rows="2"
          maxlength="10000"
          value=${draft}
          aria-label=${t('timeline.comment')}
          onInput=${(inputEvent) => setDraft(inputEvent.currentTarget.value)}
        ></textarea>
        <div class="timeline-actions">
          <button type="submit" disabled=${busy}>${t('common.save')}</button>
          <button type="button" class="link-button" onClick=${() => setEditing(false)}>
            ${t('common.cancel')}
          </button>
        </div>
      </form>
    `;
  }

  return html`
    <${EventRemark} event=${event} manoeuvreLabels=${manoeuvreLabels} />
    <div class="timeline-actions">
      <button
        type="button"
        class="link-button"
        disabled=${busy}
        onClick=${() => setEditing(true)}
      >
        ${t('common.edit')}
      </button>
      ${
        event.source === 'manual' &&
        html`<button
          type="button"
          class="link-button danger"
          disabled=${busy}
          onClick=${() => onDelete(event)}
        >
          ${t('common.delete')}
        </button>`
      }
    </div>
  `;
}

export function Timeline({ events, observations, manoeuvreLabels, busy, onEditComment, onDelete }) {
  const { t, format } = useLocale();
  const rows = buildRows(events, observations);
  if (rows.length === 0) {
    return html`<p class="muted">${t('passage.noLog')}</p>`;
  }

  const course = (readings) =>
    readings?.cog !== null && readings?.cog !== undefined
      ? format.bearing(readings.cog)
      : readings?.heading !== null && readings?.heading !== undefined
        ? `${t('timeline.heading')} ${format.bearing(readings.heading)}`
        : '';
  const wind = (readings) => {
    if (readings?.tws !== null && readings?.tws !== undefined) {
      return `${format.speed(readings.tws)} ${format.bearing(readings.twd)}`.trim();
    }
    if (readings?.aws !== null && readings?.aws !== undefined) {
      return `${format.speed(readings.aws)} ${t('timeline.apparent')} ${format.angle(readings.awa)}`.trim();
    }
    return '';
  };

  let previousDay = null;
  return html`
    <div class="timeline-scroll">
      <table class="timeline">
        <thead>
          <tr>
            <th>${t('timeline.time')}</th>
            <th>${t('timeline.position')}</th>
            <th>${t('timeline.speed')}</th>
            <th>${t('timeline.course')}</th>
            <th>${t('timeline.wind')}</th>
            <th>${t('timeline.depth')}</th>
            <th>${t('timeline.pressure')}</th>
            <th>${t('timeline.remarks')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => {
            const day = dayKey(new Date(row.time));
            const newDay = day !== previousDay;
            previousDay = day;
            const { readings } = row;
            return html`
              ${
                newDay &&
                html`<tr class="timeline-day" key=${`day-${day}`}>
                  <th colspan="8">${format.day(new Date(row.time))}</th>
                </tr>`
              }
              <tr key=${row.key} class=${row.event ? `timeline-event event-${row.event.type}` : ''}>
                <td class="timeline-time">${format.time(row.time)}</td>
                <td class="timeline-position">
                  ${format.position(readings?.position ?? row.event?.position ?? null)}
                </td>
                <td>${format.speed(readings?.sog)}</td>
                <td>${course(readings)}</td>
                <td>${wind(readings)}</td>
                <td>${format.depth(readings?.depth)}</td>
                <td>${format.pressure(readings?.pressure)}</td>
                <td class="timeline-remarks">
                  ${
                    row.event
                      ? html`<${EventLine}
                          event=${row.event}
                          manoeuvreLabels=${manoeuvreLabels}
                          busy=${busy}
                          onEditComment=${onEditComment}
                          onDelete=${onDelete}
                        />`
                      : html`<span class="muted">${t(`observation.${readings.reason}`)}</span>`
                  }
                </td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </div>
  `;
}
