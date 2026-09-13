const { openDatabase } = require('./lib/database');

module.exports = function (app) {
  const plugin = {};
  let database = null;

  plugin.id = 'signalk-chiplog';
  plugin.name = 'Chiplog';
  plugin.description = 'Automated digital logbook for Signal K';

  plugin.schema = {
    type: 'object',
    properties: {}
  };

  plugin.start = function (config) {
    try {
      const { db, migrated } = openDatabase(app.getDataDirPath());
      database = db;

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

  return plugin;
};
