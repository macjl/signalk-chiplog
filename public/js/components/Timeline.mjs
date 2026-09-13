import { html } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';
import { dayKey } from '../days.mjs';

function Strokes({ strokes, label }) {
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
              points=${(stroke.points ?? []).map((point) => `${point.x},${point.y}`).join(' ')}
            />`
        )}
      </g>
    </svg>
  `;
}

function autopilotTarget(target, format) {
  if (typeof target === 'number') {
    return format.bearing(target);
  }
  const heading = target?.headingTrue ?? target?.headingMagnetic;
  if (heading !== undefined) {
    return format.bearing(heading);
  }
  const windAngle = target?.windAngleApparent ?? target?.windAngleTrue;
  return windAngle === undefined ? '' : format.angle(windAngle);
}

function EventRemark({ event, manoeuvreLabels }) {
  const { t, format } = useLocale();
  const payload = event.payload ?? {};
  const comment = event.comment ? html` — ${event.comment}` : '';

  switch (event.type) {
    case 'manoeuvre': {
      const key = `manoeuvre.${event.subtype}`;
      const label = t.has(key) ? t(key) : (manoeuvreLabels[event.subtype] ?? event.subtype);
      const sail = payload.sail ? ` (${t('event.sail', { sail: payload.sail })})` : '';
      return html`<strong>${label}</strong>${sail}${comment}`;
    }
    case 'text_annotation':
      return event.comment;
    case 'handwritten_annotation':
      return html`<${Strokes}
          strokes=${payload.strokes ?? []}
          label=${t('event.handwritten')}
        />${comment}`;
    case 'sk_alarm': {
      const message = payload.message ?? event.subtype;
      return payload.state === 'normal'
        ? t('event.alarmCleared', { message })
        : html`<strong class="alarm">${t('event.alarm', { message })}</strong>`;
    }
    case 'autopilot': {
      if (event.subtype === 'disengaged') {
        return t('event.autopilotDisengaged');
      }
      const mode = payload.mode ?? payload.state ?? '';
      const target = autopilotTarget(payload.target, format);
      const detail = [mode, target].filter(Boolean).join(' ');
      return event.subtype === 'mode_changed'
        ? t('event.autopilotMode', { mode: detail })
        : `${t('event.autopilotEngaged')}${detail ? ` (${detail})` : ''}`;
    }
    case 'weather_threshold':
      if (event.subtype === 'pressure_drop') {
        return t('event.pressureDrop', { drop: format.pressure(payload.drop) });
      }
      return event.subtype === 'wind_above'
        ? t('event.windAbove', {
            threshold: format.speed(payload.threshold),
            speed: format.speed(payload.windSpeed)
          })
        : t('event.windBelow', { threshold: format.speed(payload.threshold) });
    case 'manual_correction':
      return t('event.correction', {
        before: t(`type.${payload.before?.type}`),
        after: t(`type.${payload.after?.type}`)
      });
    default:
      return event.comment ?? event.type;
  }
}

// Instrument snapshots taken for an event are shown on the event's own line.
function buildRows(events, observations) {
  const eventSnapshots = new Map(
    observations
      .filter((observation) => observation.reason === 'event')
      .map((observation) => [observation.time, observation])
  );
  const shown = new Set();
  const rows = events.map((event) => {
    const readings = eventSnapshots.get(event.time) ?? null;
    if (readings) {
      shown.add(readings.id);
    }
    return { key: `event-${event.id}`, time: event.time, event, readings };
  });
  for (const observation of observations) {
    if (!shown.has(observation.id)) {
      rows.push({
        key: `reading-${observation.id}`,
        time: observation.time,
        readings: observation
      });
    }
  }
  return rows.sort(
    (a, b) => a.time.localeCompare(b.time) || Number(Boolean(a.event)) - Number(Boolean(b.event))
  );
}

export function Timeline({ events, observations, manoeuvreLabels }) {
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
                      ? html`<${EventRemark}
                          event=${row.event}
                          manoeuvreLabels=${manoeuvreLabels}
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
