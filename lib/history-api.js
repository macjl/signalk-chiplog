const { Temporal } = require('@js-temporal/polyfill');
const { AUTOSTATE_SOURCE_PREFIX, MAX_AGE_MS, UNDERWAY_STATES } = require('./detection');

// Paths Chiplog reads while replaying a passage. The History API returns Signal K
// values, so this list deliberately contains paths rather than storage fields.
const STATIC_PATHS = [
  'navigation.position',
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'navigation.magneticVariation',
  'navigation.speedThroughWater',
  'navigation.log',
  'navigation.state',
  'environment.wind.speedTrue',
  'environment.wind.directionTrue',
  'environment.wind.speedApparent',
  'environment.wind.angleApparent',
  'environment.depth.belowSurface',
  'environment.depth.belowTransducer',
  'environment.outside.pressure',
  'environment.outside.temperature',
  'environment.water.temperature',
  'steering.autopilot.target',
  'steering.autopilot.target.headingTrue',
  'steering.autopilot.target.headingMagnetic',
  'steering.autopilot.target.windAngleApparent',
  'steering.autopilot.target.windAngleTrue',
  'steering.autopilot.state',
  'steering.autopilot.mode',
  'steering.autopilot.engaged'
];

const CHUNK_MS = 2 * 60 * 60 * 1000;
const SCAN_CHUNK_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_BUCKET_MS = 60 * 1000;
const HISTORY_SOURCE = 'history-api';

const iso = (ms) => new Date(ms).toISOString();
const instant = (ms) => Temporal.Instant.from(iso(ms));

function lastAtOrBefore(items, atMs) {
  let result;
  for (const item of items ?? []) {
    if (item.time > atMs) break;
    result = item;
  }
  return result;
}

function position(value) {
  if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return { longitude: value[0], latitude: value[1] };
  }
  if (value && typeof value.latitude === 'number' && typeof value.longitude === 'number') {
    return value;
  }
  if (value && typeof value.lat === 'number' && typeof value.lon === 'number') {
    return { longitude: value.lon, latitude: value.lat };
  }
  return value;
}

function createHistoryApiHistory({ getHistoryApi, selfContext, signal }) {
  if (typeof getHistoryApi !== 'function') {
    throw new Error('This Signal K server does not expose the History API to plugins');
  }

  const series = new Map();
  const multiSource = new Map();
  const engineIds = new Set();
  let apiPromise;

  function checkAborted() {
    if (signal?.aborted) throw new DOMException('Replay cancelled', 'AbortError');
  }

  async function api() {
    apiPromise ??= getHistoryApi();
    try {
      return await apiPromise;
    } catch (err) {
      throw new Error(`Signal K History API provider is unavailable: ${err.message}`, {
        cause: err
      });
    }
  }

  async function discover(fromMs, toMs) {
    const paths = await (await api()).getPaths({ from: instant(fromMs), to: instant(toMs) });
    for (const path of paths ?? []) {
      const match = /^propulsion\.([^.]+)\.(revolutions|state|runTime)$/.exec(path);
      if (match) engineIds.add(match[1]);
    }
  }

  function pathSpecs(paths) {
    return paths.map((path) => ({
      path,
      aggregate: path === 'navigation.position' ? 'first' : 'last',
      parameter: []
    }));
  }

  async function values(paths, fromMs, toMs, resolutionMs) {
    checkAborted();
    const result = await (
      await api()
    ).getValues({
      context: selfContext,
      from: instant(fromMs),
      to: instant(toMs),
      resolution: Math.max(1, Math.round(resolutionMs / 1000)),
      pathSpecs: pathSpecs(paths)
    });
    checkAborted();
    return result;
  }

  function append(path, source, time, value) {
    if (value === null || value === undefined || !Number.isFinite(time)) return;
    const item = {
      time,
      node: {
        value: path === 'navigation.position' ? position(value) : value,
        timestamp: iso(time)
      }
    };
    if (path === 'navigation.state') {
      const bySource = multiSource.get(path) ?? new Map();
      multiSource.set(path, bySource);
      const entries = bySource.get(source) ?? [];
      entries.push(item);
      bySource.set(source, entries);
    } else {
      const entries = series.get(path) ?? [];
      entries.push(item);
      series.set(path, entries);
    }
  }

  function load(result) {
    const descriptors = result.values ?? [];
    for (const row of result.data ?? []) {
      const time = Date.parse(row[0]);
      descriptors.forEach((descriptor, index) => {
        const source = descriptor.$source ?? descriptor.sourceRef ?? HISTORY_SOURCE;
        append(descriptor.path, source, time, row[index + 1]);
      });
    }
  }

  function sortLoaded() {
    for (const entries of series.values()) entries.sort((a, b) => a.time - b.time);
    for (const bySource of multiSource.values()) {
      for (const entries of bySource.values()) entries.sort((a, b) => a.time - b.time);
    }
  }

  async function preload(fromMs, toMs, onChunk, { bucketMs } = {}) {
    await discover(fromMs, toMs);
    const paths = [
      ...STATIC_PATHS,
      ...[...engineIds].flatMap((id) => [
        `propulsion.${id}.revolutions`,
        `propulsion.${id}.state`,
        `propulsion.${id}.runTime`
      ])
    ];
    for (let start = fromMs; start < toMs; start += CHUNK_MS) {
      const end = Math.min(start + CHUNK_MS, toMs);
      load(await values(paths, start, end, bucketMs ?? 1_000));
      onChunk?.(end, toMs);
    }
    sortLoaded();
  }

  async function scanMotion(fromMs, toMs, { stoppedSpeed }, onChunk) {
    const intervals = [];
    const states = [];
    for (let start = fromMs; start < toMs; start += SCAN_CHUNK_MS) {
      const end = Math.min(start + SCAN_CHUNK_MS, toMs);
      const result = await values(
        ['navigation.speedOverGround', 'navigation.state'],
        start,
        end,
        SCAN_BUCKET_MS
      );
      const descriptors = result.values ?? [];
      for (const row of result.data ?? []) {
        const time = Date.parse(row[0]);
        descriptors.forEach((descriptor, index) => {
          const value = row[index + 1];
          if (
            descriptor.path === 'navigation.speedOverGround' &&
            typeof value === 'number' &&
            value >= stoppedSpeed
          ) {
            intervals.push({ from: time, to: time + SCAN_BUCKET_MS });
          }
          if (descriptor.path === 'navigation.state' && typeof value === 'string') {
            states.push({
              time,
              value,
              source: descriptor.$source ?? descriptor.sourceRef ?? HISTORY_SOURCE
            });
          }
        });
      }
      onChunk?.(end, toMs);
    }
    const preferred = states.some((item) => item.source.startsWith(AUTOSTATE_SOURCE_PREFIX))
      ? states.filter((item) => item.source.startsWith(AUTOSTATE_SOURCE_PREFIX))
      : states;
    preferred
      .sort((a, b) => a.time - b.time)
      .forEach((item, index, all) => {
        if (!UNDERWAY_STATES.has(item.value)) return;
        const next = all[index + 1];
        intervals.push({
          from: item.time,
          to: Math.min(next?.time ?? Infinity, item.time + MAX_AGE_MS['navigation.state'])
        });
      });
    return intervals.sort((a, b) => a.from - b.from);
  }

  function readSelfPath(path, atMs) {
    if (path === 'propulsion') {
      return Object.fromEntries([...engineIds].map((id) => [id, {}]));
    }
    const bySource = multiSource.get(path);
    if (bySource) {
      const values = {};
      let latest;
      let latestSource;
      for (const [source, entries] of bySource) {
        const item = lastAtOrBefore(entries, atMs);
        if (!item) continue;
        values[source] = item.node;
        if (!latest || item.time >= latest.time) {
          latest = item;
          latestSource = source;
        }
      }
      return latest ? { ...latest.node, $source: latestSource, values } : undefined;
    }
    return lastAtOrBefore(series.get(path), atMs)?.node;
  }

  function clear() {
    series.clear();
    multiSource.clear();
  }

  return { preload, clear, scanMotion, readSelfPath };
}

module.exports = { createHistoryApiHistory };
