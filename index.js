const { registerRoutes } = require('./lib/api');
const { openDatabase } = require('./lib/database');
const { createPassageDetector, DETECTION_DEFAULTS, TICK_INTERVAL_MS } = require('./lib/detection');
const { ApiError } = require('./lib/errors');
const { createEventWatcher, CHECK_INTERVAL_MS, EVENT_DEFAULTS } = require('./lib/event-watcher');
const { OBSERVATION_DEFAULTS } = require('./lib/observation-recorder');
const { createPlaceNamer, GEOCODING_DEFAULTS } = require('./lib/place-names');
const { PROPULSION_DEFAULTS } = require('./lib/propulsion-detector');
const { createTrackRecorder, SAMPLE_INTERVAL_MS, TRACK_DEFAULTS } = require('./lib/track-recorder');
const {
  createUsbExportScheduler,
  CHECK_INTERVAL_MS: USB_CHECK_INTERVAL_MS,
  USB_EXPORT_DEFAULTS
} = require('./lib/usb-scheduler');

const { version } = require('./package.json');

const DEFAULT_PLACE_MATCH_RADIUS = 200;
const FIRST_NAMING_DELAY_MS = 5 * 1000;
const NAMING_ERROR_RETRY_MS = 5 * 60 * 1000;

const MOTION_LABELS = { underway: 'Under way', stopped: 'Stopped', unknown: 'Waiting for data' };
const MODE_LABELS = { autostate: 'navigation.state', fallback: 'speed fallback' };

function readVesselPosition(app) {
  const value = app.getSelfPath('navigation.position')?.value;
  return value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
    ? { lat: value.latitude, lon: value.longitude }
    : null;
}

function describeDetection({ mode, motion, propulsion, activeEntryId }) {
  const under = propulsion === null ? '' : ` under ${propulsion}`;
  const passage = activeEntryId === null ? '' : `, passage ${activeEntryId} open`;
  return `${MOTION_LABELS[motion]}${under}${passage} (${MODE_LABELS[mode]})`;
}

module.exports = function (app) {
  const plugin = {};
  let database = null;
  let settings = null;
  let detector = null;
  let namer = null;
  let usbExport = null;
  let namingTimer = null;
  let timers = [];
  let lastStatus = null;

  plugin.id = 'signalk-chiplog';
  plugin.name = 'Chiplog';
  plugin.description = 'Automated digital logbook for Signal K';

  plugin.schema = {
    type: 'object',
    properties: {
      stopClosureMinutes: {
        type: 'number',
        title: 'Stop duration that ends a passage (minutes)',
        description:
          'Shorter stops, such as waiting for a lock or a lunch anchorage, stay within the same logbook entry',
        default: DETECTION_DEFAULTS.stopClosureMinutes,
        minimum: 1
      },
      fallbackUnderwaySpeed: {
        type: 'number',
        title: 'Under-way speed when navigation.state is unavailable (knots)',
        description:
          'Used only without signalk-autostate: the vessel counts as under way when its average speed over ground exceeds this, and as stopped below half of it',
        default: DETECTION_DEFAULTS.fallbackUnderwaySpeed,
        minimum: 0.1
      },
      defaultPropulsion: {
        type: 'string',
        title: 'Propulsion assumed without engine data',
        description:
          'Used when neither propulsion.*.revolutions, propulsion.*.state nor navigation.state says whether the engine is running',
        enum: ['sail', 'engine'],
        default: PROPULSION_DEFAULTS.defaultPropulsion
      },
      observationIntervalMinutes: {
        type: 'number',
        title: 'Instrument snapshot interval (minutes)',
        description:
          'During a passage, instrument readings are logged on this clock boundary — on the hour by default — as well as at departure, arrival and each manoeuvre',
        default: OBSERVATION_DEFAULTS.observationIntervalMinutes,
        minimum: 1
      },
      trackIntervalSeconds: {
        type: 'number',
        title: 'Track point interval (seconds)',
        description:
          'A track point is recorded at least this often while moving, plus extra points on turns and speed changes',
        default: TRACK_DEFAULTS.trackIntervalSeconds,
        minimum: 1
      },
      placeMatchRadius: {
        type: 'number',
        title: 'Place matching radius (m)',
        description: 'A departure or arrival within this distance of a known place reuses its name',
        default: DEFAULT_PLACE_MATCH_RADIUS,
        minimum: 1
      },
      geocodingEnabled: {
        type: 'boolean',
        title: 'Name departures and arrivals with online geocoding',
        description:
          "Sends the position of departures and arrivals that match no known place to the geocoding service below. Names come from OpenStreetMap (© OpenStreetMap contributors, ODbL). Without it, they're named after their coordinates until corrected",
        default: GEOCODING_DEFAULTS.geocodingEnabled
      },
      geocodingUrl: {
        type: 'string',
        title: 'Geocoding service (Nominatim-compatible)',
        description: 'The public OpenStreetMap instance by default, or a self-hosted Nominatim',
        default: GEOCODING_DEFAULTS.geocodingUrl
      },
      usbExportPath: {
        type: 'string',
        title: 'USB export directory',
        description:
          'Directory the logbook is copied to for abandon-ship recovery, e.g. the mount point of a USB drive. Leave empty to turn the USB copy off'
      },
      usbExportIntervalMinutes: {
        type: 'number',
        title: 'Automatic USB copy interval (minutes)',
        description:
          'Passages new or changed since the last copy are written to the USB drive this often; 0 turns the periodic copy off',
        default: USB_EXPORT_DEFAULTS.usbExportIntervalMinutes,
        minimum: 0
      },
      usbExportOnArrival: {
        type: 'boolean',
        title: 'Copy to the USB drive at each arrival',
        default: USB_EXPORT_DEFAULTS.usbExportOnArrival
      },
      windSpeedThresholds: {
        type: 'array',
        title: 'Wind speed thresholds (knots)',
        description:
          'The log records when the true wind, averaged over two minutes, rises above or falls back below each of these speeds',
        items: { type: 'number', minimum: 1 },
        default: EVENT_DEFAULTS.windSpeedThresholds
      },
      pressureDropThreshold: {
        type: 'number',
        title: 'Barometric drop warning (hPa over 3 hours)',
        description:
          'The log records a pressure fall of at least this much over three hours; 0 disables it',
        default: EVENT_DEFAULTS.pressureDropThreshold,
        minimum: 0
      }
    }
  };

  function runDetection() {
    try {
      const outcome = detector.tick();
      usbExport.afterDetection(outcome);
      const usbError = usbExport.status().lastError;
      const status = `${describeDetection(outcome)}${usbError ? ` — USB copy failing: ${usbError.message}` : ''}`;
      if (status !== lastStatus) {
        app.setPluginStatus(status);
        lastStatus = status;
      }
    } catch (err) {
      lastStatus = null;
      app.error(`Passage detection failed: ${err.stack ?? err}`);
      app.setPluginError(`Passage detection failed: ${err.message}`);
    }
  }

  // Geocoding is a network call, so it runs as its own chain of timeouts rather
  // than inside detection: each lookup says when the next one is due.
  async function runNaming() {
    const current = namer;
    let result;
    try {
      result = await current.resolveNext();
    } catch (err) {
      app.error(`Place naming failed: ${err.stack ?? err}`);
      result = { retryInMs: NAMING_ERROR_RETRY_MS };
    }
    if (namer !== current || result.outcome === 'stopped') {
      return;
    }
    if (result.outcome === 'failed') {
      // Expected whenever the boat is out of reach of a network.
      app.debug(
        `Geocoding unavailable, retrying in ${Math.round(result.retryInMs / 60000)} min: ${result.error.message}`
      );
    }
    namingTimer = setTimeout(runNaming, result.retryInMs);
  }

  // For work that runs every second: log a failure once, not on every run.
  function guarded(label, work) {
    let failing = false;
    return () => {
      try {
        work();
        failing = false;
      } catch (err) {
        if (!failing) {
          app.error(`${label} failed: ${err.stack ?? err}`);
        }
        failing = true;
      }
    };
  }

  plugin.start = function (config = {}) {
    try {
      const { db, migrated } = openDatabase(app.getDataDirPath());
      database = db;
      settings = {
        stopClosureMinutes: config.stopClosureMinutes ?? DETECTION_DEFAULTS.stopClosureMinutes,
        fallbackUnderwaySpeed:
          config.fallbackUnderwaySpeed ?? DETECTION_DEFAULTS.fallbackUnderwaySpeed,
        defaultPropulsion: config.defaultPropulsion ?? PROPULSION_DEFAULTS.defaultPropulsion,
        observationIntervalMinutes:
          config.observationIntervalMinutes ?? OBSERVATION_DEFAULTS.observationIntervalMinutes,
        trackIntervalSeconds: config.trackIntervalSeconds ?? TRACK_DEFAULTS.trackIntervalSeconds,
        placeMatchRadius: config.placeMatchRadius ?? DEFAULT_PLACE_MATCH_RADIUS,
        geocodingEnabled: config.geocodingEnabled ?? GEOCODING_DEFAULTS.geocodingEnabled,
        geocodingUrl: config.geocodingUrl || GEOCODING_DEFAULTS.geocodingUrl,
        usbExportPath: config.usbExportPath || null,
        usbExportIntervalMinutes:
          config.usbExportIntervalMinutes ?? USB_EXPORT_DEFAULTS.usbExportIntervalMinutes,
        usbExportOnArrival: config.usbExportOnArrival ?? USB_EXPORT_DEFAULTS.usbExportOnArrival,
        windSpeedThresholds: config.windSpeedThresholds ?? EVENT_DEFAULTS.windSpeedThresholds,
        pressureDropThreshold: config.pressureDropThreshold ?? EVENT_DEFAULTS.pressureDropThreshold
      };

      if (migrated.to > migrated.from) {
        app.debug(`Database schema migrated from version ${migrated.from} to ${migrated.to}`);
      }
    } catch (err) {
      app.setPluginError(`Cannot open the logbook database: ${err.message}`);
      throw err;
    }

    const readSelfPath = (path) => app.getSelfPath(path);
    detector = createPassageDetector({ db: database, readSelfPath, settings });
    const recorder = createTrackRecorder({ db: database, readSelfPath, settings });
    const watcher = createEventWatcher({
      db: database,
      readSelfPath,
      settings,
      observe: (entryId, time) => detector.observeEvent(entryId, time)
    });
    namer = createPlaceNamer({
      db: database,
      settings,
      userAgent: `signalk-chiplog/${version}`
    });
    usbExport = createUsbExportScheduler({
      db: database,
      settings,
      log: (level, message) => (level === 'error' ? app.error(message) : app.debug(message))
    });
    namingTimer = setTimeout(runNaming, FIRST_NAMING_DELAY_MS);
    lastStatus = null;
    runDetection();
    timers = [
      setInterval(runDetection, TICK_INTERVAL_MS),
      setInterval(
        guarded('Track recording', () => recorder.sample()),
        SAMPLE_INTERVAL_MS
      ),
      setInterval(
        guarded('Event watching', () => watcher.check()),
        CHECK_INTERVAL_MS
      ),
      setInterval(
        guarded('USB copy scheduling', () => usbExport.tick()),
        USB_CHECK_INTERVAL_MS
      )
    ];
  };

  plugin.stop = function () {
    timers.forEach(clearInterval);
    timers = [];
    clearTimeout(namingTimer);
    namer?.stop();
    namer = null;
    usbExport?.stop();
    usbExport = null;
    detector = null;
    if (database) {
      database.close();
      database = null;
    }
  };

  // The server registers routes once, before start() and even while the plugin
  // is disabled, and never removes them: every request must check the database.
  plugin.registerWithRouter = function (router) {
    registerRoutes(router, {
      getContext() {
        if (!database) {
          throw new ApiError(
            503,
            'plugin_not_started',
            'Chiplog is not running; enable the plugin'
          );
        }
        return {
          db: database,
          config: settings,
          now: () => new Date().toISOString(),
          vesselPosition: () => readVesselPosition(app),
          observeEvent: (entryId, time) => detector.observeEvent(entryId, time),
          usbExport,
          detection: () => ({
            mode: detector.mode(),
            motion: detector.motion(),
            propulsion: detector.propulsion(),
            stateIssue: detector.stateIssue()
          })
        };
      },
      logError: (err) => app.error(`API request failed: ${err.stack ?? err}`)
    });
  };

  return plugin;
};
