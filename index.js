module.exports = function (app) {
  const plugin = {};

  plugin.id = 'signalk-chiplog';
  plugin.name = 'Chiplog';
  plugin.description = 'Automated digital logbook for Signal K';

  plugin.schema = {
    type: 'object',
    properties: {}
  };

  plugin.start = function (options) {
  };

  plugin.stop = function () {
  };

  return plugin;
};
