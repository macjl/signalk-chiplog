const { getSchemaVersion } = require('./database');
const { ApiError, badRequest, conflict, notFound } = require('./errors');
const entries = require('./entries');
const events = require('./events');
const { renderExport } = require('./export');
const { isTimeZone, PDF_LANGUAGES } = require('./logbook-pdf');
const { toGeoJson, toGpx } = require('./formats');
const manoeuvreTypes = require('./manoeuvre-types');
const places = require('./places');
const propulsion = require('./propulsion');
const { getTideForecast } = require('./tide-forecaster');
const track = require('./track');
const v = require('./validation');

const SQLITE_CONSTRAINT = 19;

// Servers predating router.access() only support admin-only plugin routes.
// Falling back keeps the plugin usable there, at the cost of an admin login.
function scoped(router, level) {
  return typeof router.access === 'function' ? router.access(level) : router;
}

function sendError(res, err, logError) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // Extended SQLite codes carry the primary code in their low byte.
  if (err.code === 'ERR_SQLITE_ERROR' && (err.errcode & 0xff) === SQLITE_CONSTRAINT) {
    res.status(409).json({ error: { code: 'constraint_violation', message: err.message } });
    return;
  }
  logError(err);
  res
    .status(500)
    .json({ error: { code: 'internal_error', message: 'Unexpected error, see the server log' } });
}

function optional(body, field, parse) {
  return field in body ? parse(body[field], field) : undefined;
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function parsePayload(value, name) {
  if (value !== null && !v.isPlainObject(value)) {
    throw badRequest(`${name} must be a JSON object or null`);
  }
  return value;
}

function parseBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw badRequest(`${name} must be a boolean`);
  }
  return value;
}

function parseInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw badRequest(`${name} must be an integer`);
  }
  return value;
}

const nullableString = (maxLength) => (value, name) =>
  v.parseString(value, name, { maxLength, allowNull: true });

const requiredString = (maxLength) => (value, name) => v.parseString(value, name, { maxLength });

function parseRange(query) {
  return {
    from: v.parseOptionalTimestamp(query.from, 'from'),
    to: v.parseOptionalTimestamp(query.to, 'to')
  };
}

function registerRoutes(router, { getContext, logError }) {
  const readonly = scoped(router, 'readonly');
  const readwrite = scoped(router, 'readwrite');
  const admin = router;

  const handle = (fn) => async (req, res) => {
    try {
      const body = await fn(getContext(), req, res);
      if (!res.headersSent) {
        if (body === undefined) {
          res.status(204).end();
        } else {
          res.json(body);
        }
      }
    } catch (err) {
      sendError(res, err, logError);
    }
  };

  const entryId = (req) => v.parseId(req.params.id);

  readonly.get(
    '/api/state',
    handle(({ db, detection }) => {
      const { mode, motion, propulsion: under, stateIssue } = detection();
      return {
        activeEntryId:
          db.prepare("SELECT id FROM log_entries WHERE state = 'active'").get()?.id ?? null,
        detection: mode,
        motion,
        propulsion: under,
        stateIssue,
        schemaVersion: getSchemaVersion(db)
      };
    })
  );

  // Entries

  readonly.get(
    '/api/entries',
    handle(({ db }, req) =>
      entries.listEntries(db, { ...parseRange(req.query), ...v.parsePagination(req.query) })
    )
  );

  readonly.get(
    '/api/entries/stats',
    handle(({ db, now }, req) => entries.getStats(db, { ...parseRange(req.query), now: now() }))
  );

  readonly.get(
    '/api/entries/:id',
    handle(({ db }, req) => entries.getEntry(db, entryId(req)))
  );

  readwrite.patch(
    '/api/entries/:id',
    handle(({ db, config, now }, req) => {
      const id = entryId(req);
      const body = v.requireBody(req.body, [
        'startTime',
        'endTime',
        'startPosition',
        'endPosition',
        'startPlaceName',
        'endPlaceName',
        'distance'
      ]);
      const patch = {
        startTime: optional(body, 'startTime', v.parseTimestamp),
        endTime: optional(body, 'endTime', v.parseTimestamp),
        startPosition: optional(body, 'startPosition', v.parsePosition),
        endPosition: optional(body, 'endPosition', v.parsePosition),
        startPlaceName: optional(body, 'startPlaceName', nullableString(200)),
        endPlaceName: optional(body, 'endPlaceName', nullableString(200)),
        distance: optional(body, 'distance', v.parseNonNegativeNumber)
      };
      return entries.updateEntry(db, id, patch, {
        placeMatchRadius: config.placeMatchRadius,
        now: now()
      });
    })
  );

  readwrite.post(
    '/api/entries/:id/close',
    handle(({ db, config, now, vesselPosition }, req) =>
      entries.closeEntry(db, entryId(req), {
        now: now(),
        position: vesselPosition(),
        placeMatchRadius: config.placeMatchRadius
      })
    )
  );

  readwrite.post(
    '/api/entries/:id/merge',
    handle(({ db, now }, req) => {
      const id = entryId(req);
      const body = v.requireBody(req.body, ['withEntryId']);
      return entries.mergeEntries(db, id, v.parseId(body.withEntryId, 'withEntryId'), now());
    })
  );

  admin.delete(
    '/api/entries/:id',
    handle(({ db }, req) => {
      entries.deleteEntry(db, entryId(req));
    })
  );

  // Track, observations, propulsion

  readonly.get(
    '/api/entries/:id/track',
    handle(({ db }, req, res) => {
      const id = entryId(req);
      const format = v.parseEnum(req.query.format ?? 'geojson', 'format', ['geojson', 'gpx']);
      const entry = entries.getEntry(db, id);
      const trackPoints = track.allTrackPoints(db, id);
      if (format === 'gpx') {
        res.type('application/gpx+xml').send(toGpx([{ entry, trackPoints }]));
        return null;
      }
      return toGeoJson(entry, trackPoints);
    })
  );

  readonly.get(
    '/api/entries/:id/observations',
    handle(({ db }, req) => track.listObservations(db, entryId(req), v.parsePagination(req.query)))
  );

  readonly.get(
    '/api/entries/:id/propulsion',
    handle(({ db }, req) => propulsion.listSegments(db, entryId(req), v.parsePagination(req.query)))
  );

  readwrite.patch(
    '/api/propulsion/:id',
    handle(({ db, now }, req) => {
      const id = v.parseId(req.params.id);
      const body = v.requireBody(req.body, ['type']);
      const type = v.parseEnum(body.type, 'type', ['engine', 'sail']);
      return propulsion.correctSegment(db, id, { type }, { now: now() });
    })
  );

  readonly.get(
    '/api/entries/:id/tide',
    handle(({ db }, req) => {
      const id = entryId(req);
      entries.requireEntryRow(db, id);
      const forecast = getTideForecast(db, id);
      if (!forecast) {
        throw notFound('tide', id);
      }
      return forecast;
    })
  );

  // Events

  readonly.get(
    '/api/entries/:id/events',
    handle(({ db }, req) =>
      events.listEvents(db, entryId(req), {
        type:
          req.query.type === undefined
            ? undefined
            : v.parseEnum(req.query.type, 'type', events.EVENT_TYPES),
        ...v.parsePagination(req.query)
      })
    )
  );

  const EVENT_FIELDS = ['type', 'subtype', 'comment', 'payload', 'time', 'position', 'clientRef'];

  const parseEventInput = (body) => ({
    type: v.parseEnum(body.type, 'type', events.CLIENT_EVENT_TYPES),
    subtype: optional(body, 'subtype', nullableString(200)),
    comment: optional(body, 'comment', nullableString(10000)),
    payload: optional(body, 'payload', parsePayload),
    time: optional(body, 'time', v.parseTimestamp),
    position: optional(body, 'position', v.parsePosition),
    clientRef: optional(body, 'clientRef', requiredString(100))
  });

  // Conditions at a manoeuvre, note or sketch belong in the log — but only as
  // it happens; readings now say nothing about one logged after the fact.
  // Likewise the boat's state, for a passage the crew opened by casting off.
  const observeLiveEvent = (context, input, { event, created, openedEntry }) => {
    if (created && events.CLIENT_EVENT_TYPES.includes(event.type) && input.time === undefined) {
      context.observeEvent(event.entryId, event.time);
      if (openedEntry) {
        context.noteDeparture(event.entryId);
      }
    }
  };

  readwrite.post(
    '/api/entries/:id/events',
    handle((context, req, res) => {
      const { db, now, vesselPosition } = context;
      const id = entryId(req);
      const input = parseEventInput(v.requireBody(req.body, EVENT_FIELDS));
      const outcome = events.createEvent(db, id, input, {
        now: now(),
        vesselPosition: vesselPosition()
      });
      observeLiveEvent(context, input, outcome);
      res.status(outcome.created ? 201 : 200);
      return outcome.event;
    })
  );

  // What the tablet posts: the server finds the passage the entry belongs to.
  readwrite.post(
    '/api/events',
    handle((context, req, res) => {
      const { db, config, now, vesselPosition } = context;
      const input = parseEventInput(v.requireBody(req.body, EVENT_FIELDS));
      const outcome = events.logCrewEvent(db, input, {
        now: now(),
        vesselPosition: vesselPosition(),
        placeMatchRadius: config.placeMatchRadius
      });
      observeLiveEvent(context, input, outcome);
      res.status(outcome.created ? 201 : 200);
      return { ...outcome.event, openedEntry: outcome.openedEntry };
    })
  );

  readwrite.patch(
    '/api/events/:id',
    handle(({ db }, req) => {
      const id = v.parseId(req.params.id);
      const body = v.requireBody(req.body, ['time', 'comment', 'subtype', 'payload']);
      const patch = withoutUndefined({
        time: optional(body, 'time', v.parseTimestamp),
        comment: optional(body, 'comment', nullableString(10000)),
        subtype: optional(body, 'subtype', nullableString(200)),
        payload: optional(body, 'payload', parsePayload)
      });
      return events.updateEvent(db, id, patch);
    })
  );

  readwrite.delete(
    '/api/events/:id',
    handle(({ db }, req) => {
      events.deleteEvent(db, v.parseId(req.params.id));
    })
  );

  // Places

  readonly.get(
    '/api/places',
    handle(({ db }, req) => places.listPlaces(db, v.parsePagination(req.query)))
  );

  readwrite.patch(
    '/api/places/:id',
    handle(({ db, now }, req) => {
      const id = v.parseId(req.params.id);
      const body = v.requireBody(req.body, ['name']);
      return places.renamePlace(
        db,
        id,
        v.parseString(body.name, 'name', { maxLength: 200 }),
        now()
      );
    })
  );

  admin.delete(
    '/api/places/:id',
    handle(({ db }, req) => {
      places.deletePlace(db, v.parseId(req.params.id));
    })
  );

  // Manoeuvre shortcuts

  readonly.get(
    '/api/manoeuvre-types',
    handle(({ db }, req) => manoeuvreTypes.listManoeuvreTypes(db, v.parsePagination(req.query)))
  );

  admin.post(
    '/api/manoeuvre-types',
    handle(({ db }, req, res) => {
      const body = v.requireBody(req.body, ['key', 'label', 'icon', 'sortOrder', 'enabled']);
      const type = manoeuvreTypes.createManoeuvreType(db, {
        key: v.parseString(body.key, 'key', { maxLength: 40 }),
        label: v.parseString(body.label, 'label', { maxLength: 100 }),
        icon: optional(body, 'icon', nullableString(100)),
        sortOrder: optional(body, 'sortOrder', parseInteger),
        enabled: optional(body, 'enabled', parseBoolean)
      });
      res.status(201);
      return type;
    })
  );

  admin.patch(
    '/api/manoeuvre-types/:key',
    handle(({ db }, req) => {
      const body = v.requireBody(req.body, ['label', 'icon', 'sortOrder', 'enabled']);
      return manoeuvreTypes.updateManoeuvreType(db, req.params.key, {
        label: optional(body, 'label', requiredString(100)),
        icon: optional(body, 'icon', nullableString(100)),
        sortOrder: optional(body, 'sortOrder', parseInteger),
        enabled: optional(body, 'enabled', parseBoolean)
      });
    })
  );

  admin.delete(
    '/api/manoeuvre-types/:key',
    handle(({ db }, req) => {
      manoeuvreTypes.deleteManoeuvreType(db, req.params.key);
    })
  );

  // Export

  readonly.get(
    '/api/export',
    handle(async ({ db, now, pdfOptions }, req, res) => {
      const format = v.parseEnum(req.query.format ?? 'json', 'format', [
        'json',
        'csv',
        'gpx',
        'pdf'
      ]);
      const pdf = pdfOptions();
      if (req.query.lang !== undefined) {
        pdf.language = v.parseEnum(req.query.lang, 'lang', PDF_LANGUAGES);
      }
      if (req.query.tz !== undefined) {
        if (!isTimeZone(req.query.tz)) {
          throw badRequest('tz must be an IANA time zone, such as Europe/Paris');
        }
        pdf.timeZone = req.query.tz;
      }
      const { contentType, filename, body } = await renderExport(
        db,
        format,
        parseRange(req.query),
        now(),
        pdf
      );
      res.attachment(filename).type(contentType).send(body);
      return null;
    })
  );

  readonly.get(
    '/api/export/usb',
    handle(({ config, usbExport }) => ({ directory: config.usbExportPath, ...usbExport.status() }))
  );

  // Goes through the scheduler, so it never overlaps an automatic copy.
  admin.post(
    '/api/export/usb',
    handle(({ config, usbExport }) => {
      if (!config.usbExportPath) {
        throw conflict(
          'usb_export_not_configured',
          'Set the USB export directory in the plugin configuration first'
        );
      }
      return usbExport.run('manual');
    })
  );

  readonly.get(
    '/api/replay',
    handle(({ replayJob }) => replayJob.status())
  );

  admin.post(
    '/api/replay',
    handle(({ replayJob }, req) => {
      const from = v.parseTimestamp(req.body.from, 'from');
      const to = v.parseTimestamp(req.body.to, 'to');
      if (to <= from) {
        throw badRequest('to must be after from');
      }
      return replayJob.start(from, to);
    })
  );

  admin.post(
    '/api/replay/cancel',
    handle(({ replayJob }) => {
      if (!replayJob.cancel()) {
        throw conflict('replay_not_running', 'No retrospective replay is running');
      }
    })
  );
}

module.exports = { registerRoutes };
