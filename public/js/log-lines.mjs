// The lines of a logbook, shared by the passage page and the PDF logbook: which
// reading goes on which line, and what each event says. Pure — the server
// imports it too — so strings only, no markup.

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

export function manoeuvreName(key, t, manoeuvreLabels = {}) {
  const translation = `manoeuvre.${key}`;
  return t.has(translation) ? t(translation) : (manoeuvreLabels[key] ?? key);
}

export function sailName(sail, t) {
  return t.has(`sail.${sail}`) ? t(`sail.${sail}`) : sail;
}

// What an event says: `label` is the emphasised part, `detail` follows it,
// `comment` is the crew's own words, `strokes` a handwritten note, `alarm`
// marks a raised alarm.
export function describeEvent(event, { t, format, manoeuvreLabels = {} }) {
  const payload = event.payload ?? {};
  const line = {
    label: null,
    detail: null,
    comment: event.comment ?? null,
    strokes: null,
    alarm: false
  };

  switch (event.type) {
    case 'manoeuvre':
      line.label = manoeuvreName(event.subtype, t, manoeuvreLabels);
      if (payload.sail) {
        line.detail = `(${t('event.sail', { sail: sailName(payload.sail, t) })})`;
      }
      return line;
    case 'text_annotation':
      return { ...line, detail: event.comment, comment: null };
    case 'handwritten_annotation':
      return { ...line, strokes: payload.strokes ?? [] };
    case 'sk_alarm': {
      const message = payload.message ?? event.subtype;
      // The plugin copies the alarm message into the comment, for the CSV; a
      // comment the crew changed is still shown.
      if (line.comment === payload.message) {
        line.comment = null;
      }
      if (payload.state === 'normal') {
        return { ...line, detail: t('event.alarmCleared', { message }) };
      }
      return { ...line, label: t('event.alarm', { message }), alarm: true };
    }
    case 'autopilot': {
      if (event.subtype === 'disengaged') {
        return { ...line, detail: t('event.autopilotDisengaged') };
      }
      const mode = payload.mode ?? payload.state ?? '';
      const target = autopilotTarget(payload.target, format);
      const detail = [mode, target].filter(Boolean).join(' ');
      return {
        ...line,
        detail:
          event.subtype === 'mode_changed'
            ? t('event.autopilotMode', { mode: detail })
            : `${t('event.autopilotEngaged')}${detail ? ` (${detail})` : ''}`
      };
    }
    case 'weather_threshold':
      if (event.subtype === 'pressure_drop') {
        return {
          ...line,
          detail: t('event.pressureDrop', { drop: format.pressure(payload.drop) })
        };
      }
      return {
        ...line,
        detail:
          event.subtype === 'wind_above'
            ? t('event.windAbove', {
                threshold: format.speed(payload.threshold),
                speed: format.speed(payload.windSpeed)
              })
            : t('event.windBelow', { threshold: format.speed(payload.threshold) })
      };
    case 'manual_correction':
      return {
        ...line,
        detail: t('event.correction', {
          before: t(`type.${payload.before?.type}`),
          after: t(`type.${payload.after?.type}`)
        })
      };
    default:
      return { ...line, detail: event.comment ?? event.type, comment: null };
  }
}

// Events and instrument snapshots in time order. A snapshot taken for an event
// is shown on the event's own line rather than on a line of its own.
export function buildRows(events, observations) {
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
