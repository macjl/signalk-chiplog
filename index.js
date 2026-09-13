const { registerRoutes } = require('./lib/api');
const { openDatabase } = require('./lib/database');
const { ApiError } = require('./lib/errors');

const DEFAULT_PLACE_MATCH_RADIUS = 200;

function readVesselPosition(app) {
  const value = app.getSelfPath('navigation.position')?.value;
  return value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
    ? { lat: value.latitude, lon: value.longitude }
    : null;
}

// navigation.state is published by signalk-autostate; its absence means the
// internal SOG fallback is what detects stopped/underway.
function readDetectionMode(app) {
  return app.getSelfPath('navigation.state')?.value ? 'autostate' : 'fallback';
}

module.exports = function (app) {
  const plugin = {};
  let database = null;
  let settings = null;

  plugin.id = 'signalk-chiplog';
  plugin.name = 'Chiplog';
  plugin.description = 'Automated digital logbook for Signal K';

  plugin.schema = {
    type: 'object',
    properties: {
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

  plugin.start = function (config = {}) {
    try {
      const { db, migrated } = openDatabase(app.getDataDirPath());
      database = db;
      settings = {
        placeMatchRadius: config.placeMatchRadius ?? DEFAULT_PLACE_MATCH_RADIUS,
        usbExportPath: config.usbExportPath || null
      };

      if (migrated.to > migrated.from) {
        app.debug(`Database schema migrated from version ${migrated.from} to ${migrated.to}`);
      }
      app.setPluginStatus('Logbook database ready');
    } catch (err) {
      app.setPluginError(`Cannot open the logbook database: ${err.message}`);
      throw err;
    }
  };

  plugin.stop = function () {
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
          detectionMode: () => readDetectionMode(app)
        };
      },
      logError: (err) => app.error(`API request failed: ${err.stack ?? err}`)
    });
  };

  return plugin;
};
