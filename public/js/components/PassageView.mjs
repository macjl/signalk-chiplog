import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.mjs';
import { apiUrl, fetchAll, get, request } from '../api.mjs';
import { useLocale, usePolling } from '../context.mjs';
import { dayKey } from '../days.mjs';
import { engineHours, engineName } from '../log-lines.mjs';
import { elapsedSeconds, ErrorNotice, Loading, PlaceName, passageTitle } from './common.mjs';
import { PropulsionStrip } from './PropulsionStrip.mjs';
import { TideCard } from './TideCard.mjs';
import { Timeline } from './Timeline.mjs';
import { TrackMap } from './TrackMap.mjs';

const ACTIVE_REFRESH_MS = 60 * 1000;

async function findPrevious(entry) {
  const page = await get(`/entries?to=${encodeURIComponent(entry.startTime)}&limit=1`);
  return page.items[0] ?? null;
}

// Entries come newest first, so the next passage is the last of those after.
async function findNext(entry) {
  const from = encodeURIComponent(new Date(Date.parse(entry.startTime) + 1).toISOString());
  const { total } = await get(`/entries?from=${from}&limit=1`);
  if (total === 0) {
    return null;
  }
  const page = await get(`/entries?from=${from}&limit=1&offset=${total - 1}`);
  return page.items[0] ?? null;
}

// No forecast is a normal outcome (not yet fetched, or none for the
// position), not an error the page should show.
async function loadTide(id) {
  try {
    return await get(`/entries/${id}/tide`);
  } catch (err) {
    if (err.code === 'tide_not_found') {
      return null;
    }
    throw err;
  }
}

async function loadPassage(id) {
  const [entry, track, segments, events, observations, manoeuvreTypes, tide] = await Promise.all([
    get(`/entries/${id}`),
    get(`/entries/${id}/track`),
    fetchAll(`/entries/${id}/propulsion`),
    fetchAll(`/entries/${id}/events`),
    fetchAll(`/entries/${id}/observations`),
    fetchAll('/manoeuvre-types'),
    loadTide(id)
  ]);
  const [previous, next] = await Promise.all([findPrevious(entry), findNext(entry)]);
  return {
    entry,
    track,
    segments,
    events,
    observations,
    manoeuvreLabels: Object.fromEntries(manoeuvreTypes.map((type) => [type.key, type.label])),
    tide,
    previous,
    next
  };
}

// Each engine's hour counter at departure and arrival (or latest reading for a
// passage in progress), as a paper log records them.
function EngineHours({ observations, active }) {
  const { t, format } = useLocale();
  const engines = engineHours(observations);
  if (engines.length === 0) {
    return null;
  }
  return html`
    <table class="engine-hours">
      <caption>
        ${t('passage.engineHours')}
      </caption>
      <thead>
        <tr>
          <th scope="col">${t('passage.engineHoursEngine')}</th>
          <th scope="col">${t('passage.engineHoursStart')}</th>
          <th scope="col">${active ? t('passage.engineHoursLatest') : t('passage.engineHoursEnd')}</th>
          <th scope="col">${t('passage.engineHoursRun')}</th>
        </tr>
      </thead>
      <tbody>
        ${engines.map(
          (engine) => html`<tr key=${engine.engine}>
            <th scope="row">${engineName(engine.engine, t)}</th>
            <td>${format.hours(engine.start)}</td>
            <td>${format.hours(engine.end)}</td>
            <td>${format.hours(engine.run)}</td>
          </tr>`
        )}
      </tbody>
    </table>
  `;
}

function NameField({ label, name, pending, busy, onSave }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? '');
  const input = useRef(null);

  useEffect(() => {
    if (!editing) {
      setDraft(name ?? '');
    }
  }, [name, editing]);

  // The Edit button disappears when clicked, which would leave focus nowhere.
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const submit = (event) => {
    event.preventDefault();
    const trimmed = draft.trim();
    setEditing(false);
    onSave(trimmed === '' ? null : trimmed);
  };

  return html`
    <div class="name-field">
      <span class="name-label">${label}</span>
      ${
        editing
          ? html`<form class="name-form" onSubmit=${submit}>
              <input
                ref=${input}
                value=${draft}
                maxlength="200"
                aria-label=${label}
                onInput=${(event) => setDraft(event.currentTarget.value)}
              />
              <button type="submit" disabled=${busy}>${t('common.save')}</button>
              <button type="button" class="link-button" onClick=${() => setEditing(false)}>
                ${t('common.cancel')}
              </button>
            </form>`
          : html`<${PlaceName} name=${name} pending=${pending} />
              <button
                type="button"
                class="link-button"
                disabled=${busy}
                onClick=${() => setEditing(true)}
              >
                ${t('common.edit')}
              </button>`
      }
    </div>
  `;
}

export function PassageView({ id }) {
  const { t, format } = useLocale();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const active = data?.entry.state === 'active';

  usePolling(
    (isCurrent) => {
      loadPassage(id)
        .then((next) => {
          if (isCurrent()) {
            setData(next);
            setError(null);
          }
        })
        .catch((err) => isCurrent() && setError(err));
    },
    active ? ACTIVE_REFRESH_MS : 0,
    [id, version, active]
  );

  if (error && (!data || error.code === 'entry_not_found')) {
    return html`
      <a class="back" href="#/">← ${t('passage.back')}</a>
      ${
        error.code === 'entry_not_found'
          ? html`<p class="notice">${t('passage.notFound')}</p>`
          : html`<${ErrorNotice} error=${error} onRetry=${() => setVersion((v) => v + 1)} />`
      }
    `;
  }
  if (!data || data.entry.id !== id) {
    return html`<${Loading} />`;
  }

  const { entry } = data;
  const reload = () => setVersion((v) => v + 1);
  const act = async (action) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const rename = (side, name) =>
    act(async () => {
      await request('PATCH', `/entries/${id}`, { [`${side}PlaceName`]: name });
      reload();
    });
  const switchSegment = (segment) =>
    act(async () => {
      await request('PATCH', `/propulsion/${segment.id}`, {
        type: segment.type === 'engine' ? 'sail' : 'engine'
      });
      reload();
    });
  const close = () =>
    confirm(t('corrections.closeConfirm')) &&
    act(async () => {
      await request('POST', `/entries/${id}/close`);
      reload();
    });
  const merge = (other) =>
    confirm(t('corrections.mergeConfirm', { other: passageTitle(other, t) })) &&
    act(async () => {
      const survivor = await request('POST', `/entries/${id}/merge`, { withEntryId: other.id });
      if (survivor.id === id) {
        reload();
      } else {
        location.hash = `#/passages/${survivor.id}`;
      }
    });
  const remove = () =>
    confirm(t('corrections.deleteConfirm')) &&
    act(async () => {
      await request('DELETE', `/entries/${id}`);
      location.hash = '#/';
    });
  const editComment = (event, comment) =>
    act(async () => {
      await request('PATCH', `/events/${event.id}`, { comment });
      reload();
    });
  const deleteEvent = (event) =>
    confirm(t('timeline.deleteConfirm')) &&
    act(async () => {
      await request('DELETE', `/events/${event.id}`);
      reload();
    });

  const sameDay =
    entry.endTime && dayKey(new Date(entry.startTime)) === dayKey(new Date(entry.endTime));
  const ending = entry.endTime
    ? sameDay
      ? format.time(entry.endTime)
      : `${format.shortDate(entry.endTime)} ${format.time(entry.endTime)}`
    : t('log.inProgress');
  const when = `${format.day(new Date(entry.startTime))}, ${format.time(entry.startTime)} – ${ending}`;
  const underway = entry.engineDuration + entry.sailDuration;
  const hasMap = Boolean(data.track.geometry || entry.startPosition);

  return html`
    <a class="back" href="#/">← ${t('passage.back')}</a>

    <header class="passage-header">
      <h1>
        <${PlaceName} name=${entry.startPlaceName} pending=${entry.startPlacePending} />
        <span aria-hidden="true"> → </span>
        ${
          entry.endTime
            ? html`<${PlaceName} name=${entry.endPlaceName} pending=${entry.endPlacePending} />`
            : '…'
        }
      </h1>
      <p class="passage-when">${when}</p>
      ${
        active &&
        html`<span class="badge">
          ${
            entry.stoppedSince
              ? t('passage.stoppedSince', { time: format.time(entry.stoppedSince) })
              : t('passage.inProgress')
          }
        </span>`
      }
    </header>

    <dl class="facts">
      <div>
        <dt>${t('passage.distance')}</dt>
        <dd>${format.distance(entry.distance)}</dd>
      </div>
      <div>
        <dt>${t('passage.duration')}</dt>
        <dd>${format.duration(elapsedSeconds(entry))}</dd>
      </div>
      <div>
        <dt>${t('passage.underway')}</dt>
        <dd>${format.duration(underway)}</dd>
      </div>
      <div>
        <dt>${t('passage.engine')}</dt>
        <dd class="fact-engine">${format.duration(entry.engineDuration)}</dd>
      </div>
      <div>
        <dt>${t('passage.sail')}</dt>
        <dd class="fact-sail">${format.duration(entry.sailDuration)}</dd>
      </div>
      ${
        underway > 0 &&
        html`<div>
          <dt>${t('passage.averageSpeed')}</dt>
          <dd>${format.speed(entry.distance / underway)}</dd>
        </div>`
      }
      ${
        entry.maxSpeed !== null &&
        html`<div>
          <dt>${t('passage.maxSpeed')}</dt>
          <dd>${format.speed(entry.maxSpeed)}</dd>
        </div>`
      }
      ${
        entry.maxWindSpeed !== null &&
        html`<div>
          <dt>${t('passage.maxWind')}</dt>
          <dd>
            ${
              entry.maxWindApparent
                ? `${format.speed(entry.maxWindSpeed)} ${t('timeline.apparent')}`
                : format.speed(entry.maxWindSpeed)
            }
          </dd>
        </div>`
      }
    </dl>

    <section class="card">
      <header class="card-header">
        <h2>${t('passage.track')}</h2>
        ${
          data.track.geometry &&
          html`<a href=${apiUrl(`/entries/${id}/track?format=gpx`)} download
            >${t('passage.downloadGpx')}</a
          >`
        }
      </header>
      ${
        hasMap
          ? html`<${TrackMap} track=${data.track} entry=${entry} />`
          : html`<p class="muted">${t('passage.noTrack')}</p>`
      }
    </section>

    <div class="card-row">
      ${data.tide && html`<${TideCard} tide=${data.tide} placeName=${entry.startPlaceName} />`}

      <section class="card">
        <h2>${t('passage.propulsion')}</h2>
        <${PropulsionStrip}
          segments=${data.segments}
          entry=${entry}
          busy=${busy}
          onSwitch=${switchSegment}
        />
        <${EngineHours} observations=${data.observations} active=${active} />
      </section>
    </div>

    <section class="card">
      <h2>${t('passage.log')}</h2>
      <${Timeline}
        events=${data.events}
        observations=${data.observations}
        manoeuvreLabels=${data.manoeuvreLabels}
        busy=${busy}
        onEditComment=${editComment}
        onDelete=${deleteEvent}
      />
    </section>

    <section class="card corrections">
      <h2>${t('corrections.title')}</h2>
      <${ErrorNotice} error=${actionError} />
      <p class="muted">${t('corrections.renameHint')}</p>
      <${NameField}
        label=${t('passage.departure')}
        name=${entry.startPlaceName}
        pending=${entry.startPlacePending}
        busy=${busy}
        onSave=${(name) => rename('start', name)}
      />
      ${
        !active &&
        html`<${NameField}
          label=${t('passage.arrival')}
          name=${entry.endPlaceName}
          pending=${entry.endPlacePending}
          busy=${busy}
          onSave=${(name) => rename('end', name)}
        />`
      }
      <div class="actions">
        ${
          active &&
          html`<button type="button" disabled=${busy} onClick=${close}>
            ${t('corrections.close')}
          </button>`
        }
        ${
          data.previous &&
          html`<button type="button" disabled=${busy} onClick=${() => merge(data.previous)}>
            ${t('corrections.mergePrevious')}
          </button>`
        }
        ${
          data.next &&
          !active &&
          html`<button type="button" disabled=${busy} onClick=${() => merge(data.next)}>
            ${t('corrections.mergeNext')}
          </button>`
        }
        <button type="button" class="danger" disabled=${busy} onClick=${remove}>
          ${t('corrections.delete')}
        </button>
      </div>
    </section>
  `;
}
