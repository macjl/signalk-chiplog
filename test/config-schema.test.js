const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const chiplog = require('../index');

describe('plugin configuration schema', () => {
  it('shows legacy InfluxDB options only when the legacy source is selected', () => {
    const schema = chiplog({}).schema;

    assert.equal(Object.keys(schema.properties).at(-1), 'retrospectiveHistorySource');
    assert.equal(schema.properties.influxHost, undefined);

    const legacy = schema.dependencies.retrospectiveHistorySource.oneOf.find(
      (branch) => branch.properties?.retrospectiveHistorySource?.const === 'influxdb1'
    );
    assert.ok(legacy, 'the legacy InfluxDB branch is conditional');
    assert.ok(legacy.properties.influxHost);
    assert.ok(legacy.properties.influxSelfContext);
  });
});
