const { registerRoutes } = require('./lib/api');
const { openDatabase } = require('./lib/database');
const { createPassageDetector, DETECTION_DEFAULTS, TICK_INTERVAL_MS } = require('./lib/detection');
const { ApiError } = require('./lib/errors');

const DEFAULT_PLACE_MATCH_RADIUS = 200;

const MOTION_LABELS = { underway: 'Under way', stopped: 'Stopped', unknown: 'Waiting for data' };
const MODE_LABELS = { autostate: 'navigation.state', fallback: 'speed fallback' };

function readVesselPosition(app) {
  const value = app.getSelfPath('navigation.position')?.value;
  return value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
    ? { lat: value.latitude, lon: value.longitude }
    : null;
}

function describeDetection({ mode, motion, activeEntryId }) {
  const passage = activeEntryId === null ? '' : `, passage ${activeEntryId} open`;
  return `${MOTION_LABELS[motion]}${passage} (${MODE_LABELS[mode]})`;
}

module.exports = function (app) {
  const plugin = {};
  let database = null;
  let settings = null;
  let detector = null;
  let timer = null;
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
      placeMatchRadius: {
        type: 'number',
        title: 'Place matching radius (m)',
        description: 'A departure or arrival within this distance of a known place reuses its name',
        default: DEFAULT_PLACE_MATCH_RADIUS,
        minimum: 1
      },
      usbExportPath: {
        type: 'string',
        title: 'USB export directory',
        description:
          'Directory the logbook is written to for abandon-ship recovery, e.g. the mount point of a USB drive'
      }
    }
  };

  function runDetection() {
    try {
      const status = describeDetection(detector.tick());
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

  plugin.start = function (config = {}) {
    try {
      const { db, migrated } = openDatabase(app.getDataDirPath());
      database = db;
      settings = {
        stopClosureMinutes: config.stopClosureMinutes ?? DETECTION_DEFAULTS.stopClosureMinutes,
        fallbackUnderwaySpeed:
          config.fallbackUnderwaySpeed ?? DETECTION_DEFAULTS.fallbackUnderwaySpeed,
        placeMatchRadius: config.placeMatchRadius ?? DEFAULT_PLACE_MATCH_RADIUS,
        usbExportPath: config.usbExportPath || null
      };

      if (migrated.to > migrated.from) {
        app.debug(`Database schema migrated from version ${migrated.from} to ${migrated.to}`);
      }
    } catch (err) {
      app.setPluginError(`Cannot open the logbook database: ${err.message}`);
      throw err;
    }

    detector = createPassageDetector({
      db: database,
      readSelfPath: (path) => app.getSelfPath(path),
      settings
    });
    lastStatus = null;
    runDetection();
    timer = setInterval(runDetection, TICK_INTERVAL_MS);
  };

  plugin.stop = function () {
    clearInterval(timer);
    timer = null;
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
          detection: () => ({ mode: detector.mode(), motion: detector.motion() })
        };
      },
      logError: (err) => app.error(`API request failed: ${err.stack ?? err}`)
    });
  };

  return plugin;
};
