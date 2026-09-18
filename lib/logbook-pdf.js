const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { wrapText, textWidth } = require('./pdf/helvetica');
const { createPdf } = require('./pdf/writer');
const { distanceBetween } = require('./places');

// The facsimile logbook (SPEC §4.5): A4 landscape, a page per day in ship's
// time, one line per departure, reading, event and arrival. Its wording and
// units come from the webapp's own modules, so both say the same thing.

const PAGE = { width: 842, height: 595, margin: 28 };
const HEADER_BOTTOM = 62;
const TABLE_HEAD_HEIGHT = 16;
const FOOTER_TOP = PAGE.height - PAGE.margin - 6;
const BODY_BOTTOM = FOOTER_TOP - 12;
const FONT_SIZE = 8;
// The landmark line under a position: set back by its size as well as its grey.
const LANDMARK_FONT_SIZE = 7;
const LINE_HEIGHT = 10;
const CELL_PADDING = 3;
const SKETCH_MAX_HEIGHT = 48;

// A stroke's base width (SketchPanel.mjs's `fine` pen) when it predates the
// toolbar and carries no width of its own.
const DEFAULT_STROKE_WIDTH = 2.5;

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((channel) => channel / 255);
}

const GREY = [0.45, 0.45, 0.45];
const RULE = [0.75, 0.75, 0.75];
const HEAD_FILL = [0.9, 0.92, 0.94];
const PASSAGE_FILL = [0.95, 0.96, 0.97];
const ALARM = [0.72, 0.1, 0.1];

const COLUMNS = [
  { key: 'time', width: 36 },
  // Wide enough for the coordinates and, under them, most of a landmark
  // bearing on one line (SPEC §4.13); the remarks column keeps the rest.
  { key: 'position', width: 142 },
  { key: 'course', width: 42 },
  { key: 'speed', width: 42 },
  { key: 'wind', width: 80 },
  { key: 'pressure', width: 48 },
  { key: 'depth', width: 40 },
  { key: 'propulsion', width: 54 }
];
const REMARKS_WIDTH =
  PAGE.width - 2 * PAGE.margin - COLUMNS.reduce((sum, column) => sum + column.width, 0);

// The weather block (SPEC §4.5.3) is its own row spanning the full page
// width, laid out as the passage page's table: a time column of its own,
// then the columns the forecast has data for, sharing the rest of the width
// by weight -- wind needs more room than pressure.
const WEATHER_TIME_WIDTH = 46;
const WEATHER_COLUMNS = [
  { key: 'sky', weight: 2 },
  { key: 'wind', weight: 3 },
  { key: 'waves', weight: 2 },
  { key: 'swell', weight: 2 },
  { key: 'pressure', weight: 1.3 },
  { key: 'visibility', weight: 1.6 },
  { key: 'temperature', weight: 2 },
  { key: 'current', weight: 2 }
];
const WEATHER_TITLE_HEIGHT = 16;
const WEATHER_ROW_HEIGHT = 2 * LINE_HEIGHT + 4;

// The tide and boat-status blocks (SPEC §4.5.1, §4.5.2): two half-width
// blocks side by side, between the weather block and the day's table -- what
// the skipper notes before casting off, next to the forecast bulletin.
const INFO_GAP = 16;
const INFO_TITLE_HEIGHT = 16;
const INFO_WIDTH = (PAGE.width - 2 * PAGE.margin - INFO_GAP) / 2;

function weatherLayout(columns) {
  const fullWidth = PAGE.width - 2 * PAGE.margin;
  const included = WEATHER_COLUMNS.filter((column) => columns[column.key]);
  const totalWeight = included.reduce((sum, column) => sum + column.weight, 0);
  const layout = [{ key: 'time', x: PAGE.margin, width: WEATHER_TIME_WIDTH }];
  let x = PAGE.margin + WEATHER_TIME_WIDTH;
  for (const column of included) {
    const width = ((fullWidth - WEATHER_TIME_WIDTH) * column.weight) / totalWeight;
    layout.push({ key: column.key, x, width });
    x += width;
  }
  return layout;
}

const HOUR_MS = 60 * 60 * 1000;

// The languages of public/js/i18n.mjs, known synchronously for validation.
const PDF_LANGUAGES = ['en', 'fr'];

let sharedModules = null;

// The webapp's modules are ES modules; loaded once, on first use.
function loadShared() {
  const load = (file) =>
    import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);
  sharedModules ??= Promise.all([
    load('i18n.mjs'),
    load('format.mjs'),
    load('log-lines.mjs'),
    load('weather.mjs'),
    load('tide.mjs'),
    load('landmarks.mjs')
  ]).then(([i18n, format, lines, weather, tide, landmarks]) => ({
    i18n,
    format,
    lines,
    weather,
    tide,
    landmarks
  }));
  return sharedModules;
}

// Milliseconds of [start, end) falling on each calendar day of the formatter's
// time zone. Days are found where the day key changes, so daylight saving
// days of 23 or 25 hours come out right.
function splitByDay(start, end, format) {
  const parts = new Map();
  let cursor = start;
  while (cursor < end) {
    const key = format.dayKey(cursor);
    if (format.dayKey(end - 1) === key) {
      parts.set(key, (parts.get(key) ?? 0) + (end - cursor));
      break;
    }
    // No day lasts 26 hours: `high` is on a later day, `low` on this one.
    let low = cursor;
    let high = Math.min(end - 1, cursor + 26 * HOUR_MS);
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (format.dayKey(middle) === key) {
        low = middle;
      } else {
        high = middle;
      }
    }
    parts.set(key, (parts.get(key) ?? 0) + (high - cursor));
    cursor = high;
  }
  return parts;
}

function propulsionAt(segments, time) {
  const at = Date.parse(time);
  const segment = segments.find(
    (item) =>
      Date.parse(item.startTime) <= at && (item.endTime === null || at < Date.parse(item.endTime))
  );
  return segment ? segment.type : null;
}

// The forecast fetched at departure, as the skipper notes the bulletin before
// casting off: a block of its own, above the day's table (SPEC §4.5.3) --
// not a row mixed into the events and observations it lists.
function passageWeatherBlock(bundle, context) {
  const { t, format } = context;
  const { entry, weather } = bundle;
  const steps = weather ? context.forecastSteps(weather.points, 3) : [];
  if (steps.length === 0) {
    return null;
  }
  const rows = steps.map((step, index) => ({
    time: {
      main: format.time(step.time),
      sub:
        index === 0 || format.dayKey(step.time) !== format.dayKey(steps[index - 1].time)
          ? format.shortDate(step.time)
          : null
    },
    cells: context.describeStepColumns(step, { t, format })
  }));
  return {
    dayKey: format.dayKey(entry.startTime),
    title: t('passage.weather', { place: entry.startPlaceName ?? t('place.unknown') }),
    layout: weatherLayout(context.weatherColumns(steps)),
    rows,
    height: WEATHER_TITLE_HEIGHT + TABLE_HEAD_HEIGHT + rows.length * WEATHER_ROW_HEIGHT
  };
}

// The tide extremes fetched near departure (SPEC §4.5.2), as a line per high
// or low -- the PDF has no room for the passage page's curve.
function tideLines(bundle, context) {
  const { t, format } = context;
  const extremes = bundle.tide ? context.tideExtremes(bundle.tide.points) : [];
  if (extremes.length === 0) {
    return null;
  }
  return extremes.map((extreme, index) => {
    const label = extreme.type === 'high' ? t('tide.high') : t('tide.low');
    const when =
      index === 0 || format.dayKey(extreme.time) !== format.dayKey(extremes[index - 1].time)
        ? `${format.shortDate(extreme.time)} ${format.time(extreme.time)}`
        : format.time(extreme.time);
    return `${label} ${when} — ${format.depth(extreme.height)}`;
  });
}

// The tanks and batteries noted as the passage opened (SPEC §4.5.1) -- not
// the engine hours, already on the departure line.
function statusLines(bundle, context) {
  const { t, format } = context;
  const tanks = bundle.entry.startTanks ?? [];
  const batteries = bundle.entry.startBatteries ?? [];
  if (tanks.length + batteries.length === 0) {
    return null;
  }
  const tankLine = (item) =>
    `${context.tankName(item, t, tanks)}: ${[format.percent(item.level), format.volume(item.volume)]
      .filter(Boolean)
      .join(' · ')}`;
  const batteryLine = (item) =>
    `${context.batteryName(item, t)}: ${[
      format.percent(item.stateOfCharge),
      format.voltage(item.voltage),
      format.current(item.current)
    ]
      .filter(Boolean)
      .join(' · ')}`;
  return [...tanks.map(tankLine), ...batteries.map(batteryLine)];
}

// The tide and boat-status blocks, side by side between the weather block
// and the day's table -- either may be missing (no forecast yet, no sensor
// aboard), in which case only the other is drawn.
function passageInfoRow(bundle, context) {
  const { t, format } = context;
  const tide = tideLines(bundle, context);
  const status = statusLines(bundle, context);
  if (!tide && !status) {
    return null;
  }
  const blockOf = (title, lines) =>
    lines && {
      title,
      lines,
      height: INFO_TITLE_HEIGHT + lines.length * LINE_HEIGHT + CELL_PADDING
    };
  const left = blockOf(t('passage.tide'), tide);
  const right = blockOf(t('passage.boatState'), status);
  return {
    dayKey: format.dayKey(bundle.entry.startTime),
    left,
    right,
    height: Math.max(left?.height ?? 0, right?.height ?? 0)
  };
}

function passageLines(bundle, context) {
  const { t, format, buildRows, describeEvent, engineHours, engineName, manoeuvreLabels } = context;
  const { entry, events, observations, propulsion } = bundle;
  const place = (name) => name ?? t('place.unknown');
  // Readings taken at departure and arrival belong on those lines. A passage
  // that set off again after a stopover has a departure reading for each start.
  const byTime = (a, b) => a.time.localeCompare(b.time) || a.id - b.id;
  const [startReadings, ...resumeReadings] = observations
    .filter((observation) => observation.reason === 'entry_start')
    .sort(byTime);
  // The last arrival reading, once the passage has arrived: an earlier one was
  // taken at a stopover and stays a line of its own.
  const endReadings = entry.endTime
    ? observations
        .filter((observation) => observation.reason === 'entry_end')
        .sort(byTime)
        .at(-1)
    : undefined;
  const otherReadings = observations.filter(
    (observation) =>
      observation !== startReadings &&
      observation !== endReadings &&
      !resumeReadings.includes(observation)
  );
  // Engine hour counters, as a paper log notes them at departure and arrival:
  // named when there are several engines, with the hours run at arrival.
  const engines = engineHours(observations);
  const hoursText = (side) => {
    if (engines.length === 0) {
      return null;
    }
    const list = engines
      .map((engine) => {
        const reading = format.hours(engine[side]);
        const run = side === 'end' ? ` (+${format.hours(engine.run)})` : '';
        const name = engines.length > 1 ? `${engineName(engine.engine, t)} ` : '';
        return `${name}${reading}${run}`;
      })
      .join(', ');
    return { text: t('pdf.engineHours', { hours: list }), newLine: true };
  };
  // Who was aboard (SPEC §4.11), on the true departure line only -- a
  // passage's crew does not change at a mid-passage stopover.
  const crewText = () => {
    const list = bundle.crew ?? [];
    if (list.length === 0) {
      return null;
    }
    const names = list
      .map((member) => (member.role ? `${member.name} (${member.role})` : member.name))
      .join(', ');
    return { text: t('pdf.crew', { crew: names }), newLine: true };
  };
  // The counters as they stood at one reading, for a departure after a stopover.
  const hoursAt = (readings) => {
    const runtimes = Object.entries(readings.engineRuntimes ?? {});
    if (runtimes.length === 0) {
      return null;
    }
    const list = runtimes
      .map(([id, runtime]) => {
        const name = runtimes.length > 1 ? `${engineName(id, t)} ` : '';
        return `${name}${format.hours(runtime)}`;
      })
      .join(', ');
    return { text: t('pdf.engineHours', { hours: list }), newLine: true };
  };
  // Where a departure after a stopover left from: the stopover before it.
  const stopoverBefore = (time) =>
    events
      .filter((event) => event.type === 'stopover' && event.time <= time)
      .sort((a, b) => a.time.localeCompare(b.time))
      .at(-1);
  const lines = [
    {
      time: entry.startTime,
      order: 0,
      entry,
      kind: 'departure',
      readings: startReadings ?? null,
      propulsion: startReadings ? propulsionAt(propulsion, startReadings.time) : null,
      position: entry.startPosition,
      remarks: [
        { text: t('pdf.departure', { place: place(entry.startPlaceName) }), font: 'bold' },
        hoursText('start'),
        crewText()
      ].filter(Boolean)
    }
  ];

  for (const readings of resumeReadings) {
    const stopover = stopoverBefore(readings.time);
    lines.push({
      time: readings.time,
      order: 1,
      entry,
      kind: 'departure',
      readings,
      propulsion: propulsionAt(propulsion, readings.time),
      position: readings.position ?? stopover?.position ?? null,
      remarks: [
        {
          text: t('pdf.departure', { place: place(stopover?.payload?.placeName) }),
          font: 'bold'
        },
        hoursAt(readings)
      ].filter(Boolean)
    });
  }

  for (const row of buildRows(events, otherReadings)) {
    const remarks = [];
    let strokes = null;
    if (row.event) {
      const described = describeEvent(row.event, { t, format, manoeuvreLabels });
      if (described.label) {
        remarks.push({
          text: described.label,
          font: 'bold',
          color: described.alarm ? ALARM : undefined
        });
      }
      if (described.detail) {
        remarks.push({ text: described.detail });
      }
      if (described.comment) {
        remarks.push({ text: `— ${described.comment}` });
      }
      strokes = described.strokes;
    } else {
      remarks.push({ text: t(`observation.${row.readings.reason}`), color: GREY });
    }
    lines.push({
      time: row.time,
      order: 1,
      entry,
      kind: row.event ? 'event' : 'reading',
      readings: row.readings,
      position: row.readings?.position ?? row.event?.position ?? null,
      propulsion: propulsionAt(propulsion, row.time),
      remarks,
      strokes
    });
  }

  if (entry.endTime) {
    const durations = { engine: entry.engineDuration, sail: entry.sailDuration };
    lines.push({
      time: entry.endTime,
      order: 2,
      entry,
      kind: 'arrival',
      readings: endReadings ?? null,
      position: entry.endPosition,
      remarks: [
        { text: t('pdf.arrival', { place: place(entry.endPlaceName) }), font: 'bold' },
        {
          text: t('pdf.passageTotals', {
            distance: format.distance(entry.distance),
            duration: format.duration(
              (Date.parse(entry.endTime) - Date.parse(entry.startTime)) / 1000
            ),
            engine: format.duration(durations.engine),
            sail: format.duration(durations.sail)
          })
        },
        hoursText('end')
      ].filter(Boolean)
    });
  }
  // Every line's position is also read against the nearest amer (SPEC §4.13),
  // printed in grey under the coordinates -- the same wording the passage page
  // shows, from the same module.
  const landmarks = bundle.landmarks ?? [];
  return lines.map((line) => ({
    ...line,
    landmark: context.landmarkLine(line.position ?? null, landmarks, { t, format })
  }));
}

// Distance and engine/sail time of each calendar day, across all passages.
function dayTotals(bundles, format, now) {
  const totals = new Map();
  const totalOf = (key) => {
    if (!totals.has(key)) {
      totals.set(key, { distance: 0, engine: 0, sail: 0 });
    }
    return totals.get(key);
  };
  for (const { trackPoints, propulsion } of bundles) {
    for (let i = 1; i < trackPoints.length; i += 1) {
      totalOf(format.dayKey(trackPoints[i].time)).distance += distanceBetween(
        trackPoints[i - 1],
        trackPoints[i]
      );
    }
    for (const segment of propulsion) {
      const end = segment.endTime === null ? Date.parse(now) : Date.parse(segment.endTime);
      for (const [key, ms] of splitByDay(Date.parse(segment.startTime), end, format)) {
        totalOf(key)[segment.type] += ms / 1000;
      }
    }
  }
  return totals;
}

// Words with their font, laid out greedily over lines of `width`; a part with
// `newLine` starts on a line of its own.
function layoutRemarks(parts, width) {
  const lines = [[]];
  let x = 0;
  for (const part of parts) {
    const font = part.font ?? 'regular';
    if (part.newLine && lines.at(-1).length > 0) {
      lines.push([]);
      x = 0;
    }
    for (const [index, word] of String(part.text).split(' ').entries()) {
      const spaced = x > 0 && (index > 0 || lines.at(-1).length > 0) ? ` ${word}` : word;
      const wordWidth = textWidth(spaced, font, FONT_SIZE);
      if (x > 0 && x + wordWidth > width) {
        lines.push([]);
        x = 0;
      }
      const text = x === 0 ? word : spaced;
      // A single word wider than the column is cut into pieces that fit.
      for (const piece of x === 0 ? wrapText(text, font, FONT_SIZE, width) : [text]) {
        if (x > 0 && lines.at(-1).length > 0 && piece !== text) {
          lines.push([]);
          x = 0;
        }
        // Words in the same style go out as one string: a smaller file, and
        // text that searches and copies as written.
        const previous = lines.at(-1).at(-1);
        if (previous && previous.font === font && previous.color === part.color) {
          previous.text += piece;
        } else if (piece.startsWith(' ')) {
          // The space after a change of style is left as a gap.
          lines.at(-1).push({
            text: piece.slice(1),
            font,
            color: part.color,
            x: x + textWidth(' ', font, FONT_SIZE)
          });
        } else {
          lines.at(-1).push({ text: piece, font, color: part.color, x });
        }
        x += textWidth(piece, font, FONT_SIZE);
      }
    }
  }
  return lines.filter((line) => line.length > 0);
}

function sketchBox(strokes) {
  const points = (strokes ?? []).flatMap((stroke) => stroke.points ?? []);
  if (points.length === 0) {
    return null;
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const box = {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    width: Math.max(Math.max(...xs) - Math.min(...xs), 1),
    height: Math.max(Math.max(...ys) - Math.min(...ys), 1)
  };
  const scale = Math.min(
    SKETCH_MAX_HEIGHT / box.height,
    (REMARKS_WIDTH - 2 * CELL_PADDING) / box.width
  );
  return { ...box, scale, drawnHeight: box.height * scale };
}

function readingCells(line, context) {
  const { t, format } = context;
  const readings = line.readings;
  const cells = {
    time: line.time ? format.time(line.time) : '',
    position: format.position(line.position ?? null),
    positionNote: line.landmark ?? '',
    course: '',
    speed: format.speed(readings?.sog),
    wind: '',
    pressure: format.pressure(readings?.pressure),
    depth: format.depth(readings?.depth),
    propulsion: line.propulsion ? t(`passage.${line.propulsion}`) : ''
  };
  if (readings?.cog !== null && readings?.cog !== undefined) {
    cells.course = format.bearing(readings.cog);
  } else if (readings?.heading !== null && readings?.heading !== undefined) {
    cells.course = `${t('timeline.heading')} ${format.bearing(readings.heading)}`;
  }
  if (readings?.tws !== null && readings?.tws !== undefined) {
    cells.wind = `${format.speed(readings.tws)} ${format.bearing(readings.twd)}`.trim();
  } else if (readings?.aws !== null && readings?.aws !== undefined) {
    cells.wind =
      `${format.speed(readings.aws)} ${t('timeline.apparent')} ${format.angle(readings.awa)}`.trim();
  }
  return cells;
}

const POSITION_WIDTH = COLUMNS.find((column) => column.key === 'position').width;

function measure(line, context) {
  const remarkLines = layoutRemarks(line.remarks, REMARKS_WIDTH - 2 * CELL_PADDING);
  const cells = readingCells(line, context);
  // The landmark line is narrower than the coordinates it sits under, so it
  // wraps rather than running into the course column.
  const positionLines = cells.positionNote
    ? wrapText(cells.positionNote, 'regular', LANDMARK_FONT_SIZE, POSITION_WIDTH - 2 * CELL_PADDING)
    : [];
  const sketch = sketchBox(line.strokes);
  const maxLines = Math.floor(
    (BODY_BOTTOM -
      HEADER_BOTTOM -
      TABLE_HEAD_HEIGHT -
      2 * CELL_PADDING -
      (sketch?.drawnHeight ?? 0)) /
      LINE_HEIGHT
  );
  const shown = remarkLines.slice(0, Math.max(1, maxLines));
  if (shown.length < remarkLines.length) {
    const last = shown.at(-1);
    last.push({ text: ' …', font: 'regular', x: REMARKS_WIDTH - 2 * CELL_PADDING - 10 });
  }
  const height =
    2 * CELL_PADDING +
    Math.max(1, shown.length, 1 + positionLines.length) * LINE_HEIGHT +
    (sketch ? sketch.drawnHeight + (shown.length > 0 ? 2 : 0) : 0);
  return { ...line, cells, remarkLines: shown, positionLines, sketch, height };
}

// Pages as lists of measured rows; nothing is drawn yet, so the page count is
// known for the footers. A day's weather and info blocks only take up room on
// its first page, above the table -- not repeated on a page it continues onto.
function paginate(days, context) {
  const pages = [];
  const baseAvailable = BODY_BOTTOM - HEADER_BOTTOM - TABLE_HEAD_HEIGHT;
  for (const day of days) {
    const weatherHeight = (day.weatherBlocks ?? []).reduce((sum, block) => sum + block.height, 0);
    const infoHeight = (day.infoRows ?? []).reduce((sum, row) => sum + row.height, 0);
    let page = { day, continued: false, rows: [], used: 0 };
    pages.push(page);
    let available = baseAvailable - weatherHeight - infoHeight;
    for (const line of day.lines) {
      const row = measure(line, context);
      if (page.used + row.height > available && page.rows.length > 0) {
        page = { day, continued: true, rows: [], used: 0 };
        pages.push(page);
        available = baseAvailable;
      }
      page.rows.push(row);
      page.used += row.height;
    }
  }
  return pages;
}

function drawTableHead(page, t, top) {
  let x = PAGE.margin;
  page.rect(PAGE.margin, top, PAGE.width - 2 * PAGE.margin, TABLE_HEAD_HEIGHT, {
    fill: HEAD_FILL,
    stroke: RULE
  });
  for (const column of [...COLUMNS, { key: 'remarks', width: REMARKS_WIDTH }]) {
    page.text(x + CELL_PADDING, top + 11, t(`pdf.column.${column.key}`), {
      font: 'bold',
      size: 7.5
    });
    x += column.width;
  }
}

function drawRow(page, row, top) {
  const shaded =
    row.kind === 'departure' ||
    row.kind === 'arrival' ||
    row.kind === 'continues' ||
    row.kind === 'total';
  if (shaded) {
    page.rect(PAGE.margin, top, PAGE.width - 2 * PAGE.margin, row.height, { fill: PASSAGE_FILL });
  }
  const baseline = top + CELL_PADDING + FONT_SIZE;
  let x = PAGE.margin;
  for (const column of COLUMNS) {
    const text = row.cells[column.key];
    if (text) {
      page.text(x + CELL_PADDING, baseline, text, { size: FONT_SIZE });
    }
    if (column.key === 'position') {
      row.positionLines.forEach((text, index) => {
        page.text(x + CELL_PADDING, baseline + (index + 1) * LINE_HEIGHT, text, {
          size: LANDMARK_FONT_SIZE,
          color: GREY
        });
      });
    }
    x += column.width;
  }
  row.remarkLines.forEach((words, index) => {
    for (const word of words) {
      page.text(x + CELL_PADDING + word.x, baseline + index * LINE_HEIGHT, word.text, {
        font: word.font,
        size: FONT_SIZE,
        color: word.color ?? [0, 0, 0]
      });
    }
  });
  if (row.sketch) {
    const { sketch } = row;
    const originX = x + CELL_PADDING;
    const originY = top + CELL_PADDING + row.remarkLines.length * LINE_HEIGHT + 2;
    for (const stroke of row.strokes) {
      page.polyline(
        (stroke.points ?? []).map((point) => [
          originX + (point.x - sketch.minX) * sketch.scale,
          originY + (point.y - sketch.minY) * sketch.scale
        ]),
        {
          color: stroke.color ? hexToRgb(stroke.color) : undefined,
          width: (stroke.width ?? DEFAULT_STROKE_WIDTH) * sketch.scale,
          alpha: stroke.tool === 'highlighter'
        }
      );
    }
  }
  page.line(PAGE.margin, top + row.height, PAGE.width - PAGE.margin, top + row.height, {
    color: RULE,
    width: 0.4
  });
}

// The weather block: a title naming the departure place, then a table of its
// own spanning the full width -- the same shape as the passage page's, drawn
// above the day's table rather than as one of its rows.
function drawWeatherRow(page, block, top, t) {
  page.text(PAGE.margin, top + 11, block.title, { font: 'bold', size: 9 });
  let y = top + WEATHER_TITLE_HEIGHT;
  page.rect(PAGE.margin, y, PAGE.width - 2 * PAGE.margin, TABLE_HEAD_HEIGHT, {
    fill: HEAD_FILL,
    stroke: RULE
  });
  for (const column of block.layout) {
    page.text(column.x + CELL_PADDING, y + 11, t(`weather.${column.key}`), {
      font: 'bold',
      size: 7.5
    });
  }
  y += TABLE_HEAD_HEIGHT;
  for (const dataRow of block.rows) {
    const baseline = y + CELL_PADDING + FONT_SIZE;
    for (const column of block.layout) {
      const value = column.key === 'time' ? dataRow.time : dataRow.cells[column.key];
      if (value?.main) {
        page.text(column.x + CELL_PADDING, baseline, value.main, { size: FONT_SIZE });
      }
      if (value?.sub) {
        page.text(column.x + CELL_PADDING, baseline + LINE_HEIGHT, value.sub, {
          size: FONT_SIZE,
          color: GREY
        });
      }
    }
    y += WEATHER_ROW_HEIGHT;
  }
  page.line(PAGE.margin, top + block.height, PAGE.width - PAGE.margin, top + block.height, {
    color: RULE,
    width: 0.4
  });
}

// One of the two info blocks: a title, then a line per tide extreme or per
// tank/battery -- plain text, unlike the weather block's table.
function drawInfoBlock(page, block, x, top) {
  if (!block) {
    return;
  }
  page.text(x, top + 11, block.title, { font: 'bold', size: 9 });
  const baseline = top + INFO_TITLE_HEIGHT + CELL_PADDING + FONT_SIZE;
  block.lines.forEach((text, index) => {
    page.text(x, baseline + index * LINE_HEIGHT, text, { size: FONT_SIZE });
  });
}

// The tide and boat-status blocks, side by side (SPEC §4.5.1, §4.5.2).
function drawInfoRow(page, row, top) {
  drawInfoBlock(page, row.left, PAGE.margin, top);
  drawInfoBlock(page, row.right, PAGE.margin + INFO_WIDTH + INFO_GAP, top);
  page.line(PAGE.margin, top + row.height, PAGE.width - PAGE.margin, top + row.height, {
    color: RULE,
    width: 0.4
  });
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function renderLogbookPdf(
  bundles,
  { language = 'en', timeZone, vesselName = null, now, version = '' }
) {
  const {
    i18n,
    format: formatModule,
    lines: lineModule,
    weather: weatherModule,
    tide: tideModule,
    landmarks: landmarkModule
  } = await loadShared();
  const t = i18n.createTranslator(language);
  const format = formatModule.createFormatter({
    locale: language,
    units: { knots: t('unit.knots'), nauticalMiles: t('unit.nauticalMiles') },
    timeZone
  });
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const context = {
    t,
    format,
    now,
    buildRows: lineModule.buildRows,
    describeEvent: lineModule.describeEvent,
    engineHours: lineModule.engineHours,
    engineName: lineModule.engineName,
    forecastSteps: weatherModule.forecastSteps,
    weatherColumns: weatherModule.weatherColumns,
    describeStepColumns: weatherModule.describeStepColumns,
    tideExtremes: tideModule.tideExtremes,
    tankName: lineModule.tankName,
    batteryName: lineModule.batteryName,
    landmarkLine: landmarkModule.landmarkLine,
    manoeuvreLabels: {}
  };

  const allLines = bundles
    .flatMap((bundle) => passageLines(bundle, context))
    .sort((a, b) => a.time.localeCompare(b.time) || a.order - b.order);

  // Days in order, each opened by the passages it continues from the day before.
  const totals = dayTotals(bundles, format, now);
  const days = [];
  for (const line of allLines) {
    const key = format.dayKey(line.time);
    if (days.at(-1)?.key !== key) {
      const continuing = bundles
        .filter(({ entry }) => {
          const end = entry.endTime ?? now;
          return format.dayKey(entry.startTime) < key && format.dayKey(end) >= key;
        })
        .map(({ entry }) => ({
          time: null,
          order: -1,
          kind: 'continues',
          remarks: [
            {
              text: t('pdf.passageContinues', {
                place: entry.startPlaceName ?? t('place.unknown')
              }),
              font: 'bold'
            }
          ]
        }));
      days.push({ key, date: line.time, lines: continuing });
    }
    days.at(-1).lines.push(line);
  }

  // Each passage's weather and info blocks belong on the day it departed,
  // above that day's table rather than mixed into it.
  for (const bundle of bundles) {
    const block = passageWeatherBlock(bundle, context);
    const day = block && days.find((candidate) => candidate.key === block.dayKey);
    if (day) {
      (day.weatherBlocks ??= []).push(block);
    }
    const info = passageInfoRow(bundle, context);
    const infoDay = info && days.find((candidate) => candidate.key === info.dayKey);
    if (infoDay) {
      (infoDay.infoRows ??= []).push(info);
    }
  }

  for (const day of days) {
    const total = totals.get(day.key) ?? { distance: 0, engine: 0, sail: 0 };
    day.lines.push({
      time: null,
      kind: 'total',
      remarks: [
        {
          text: t('pdf.dayTotal', {
            distance: format.distance(total.distance),
            engine: format.duration(total.engine),
            sail: format.duration(total.sail)
          }),
          font: 'bold'
        }
      ]
    });
  }

  const title = vesselName ? `${t('pdf.title')} — ${vesselName}` : t('pdf.title');
  const pdf = createPdf({
    title,
    author: vesselName ?? '',
    creator: `Chiplog ${version}`.trim(),
    creationDate: new Date(now)
  });
  const pages = days.length > 0 ? paginate(days, context) : [{ day: null, rows: [] }];
  const footer = (page, index) => {
    const bottom = PAGE.height - PAGE.margin;
    page.line(PAGE.margin, FOOTER_TOP - 4, PAGE.width - PAGE.margin, FOOTER_TOP - 4, {
      color: RULE
    });
    const reference = page.day?.date ?? now;
    page.text(
      PAGE.margin,
      bottom,
      t('pdf.timeZone', { zone, offset: format.utcOffset(reference) }),
      {
        size: 7,
        color: GREY
      }
    );
    const generated = t('pdf.generated', {
      date: `${format.shortDate(now)} ${format.time(now)}`,
      version
    });
    page.text((PAGE.width - textWidth(generated, 'regular', 7)) / 2, bottom, generated, {
      size: 7,
      color: GREY
    });
    const number = t('pdf.page', { page: index + 1, total: pages.length });
    page.text(PAGE.width - PAGE.margin - textWidth(number, 'regular', 7), bottom, number, {
      size: 7,
      color: GREY
    });
  };

  pages.forEach((layout, index) => {
    const page = pdf.addPage(PAGE.width, PAGE.height);
    page.text(PAGE.margin, PAGE.margin + 14, title, { font: 'bold', size: 15 });
    if (layout.day) {
      const heading = `${capitalise(format.day(new Date(layout.day.date)))}${layout.continued ? ` (${t('pdf.continued')})` : ''}`;
      page.text(
        PAGE.width - PAGE.margin - textWidth(heading, 'bold', 13),
        PAGE.margin + 14,
        heading,
        {
          font: 'bold',
          size: 13
        }
      );
      let top = HEADER_BOTTOM;
      if (!layout.continued) {
        for (const block of layout.day.weatherBlocks ?? []) {
          drawWeatherRow(page, block, top, t);
          top += block.height;
        }
        for (const row of layout.day.infoRows ?? []) {
          drawInfoRow(page, row, top);
          top += row.height;
        }
      }
      drawTableHead(page, t, top);
      top += TABLE_HEAD_HEIGHT;
      for (const row of layout.rows) {
        drawRow(page, row, top);
        top += row.height;
      }
    } else {
      page.text(PAGE.margin, PAGE.height / 2, t('pdf.empty'), { size: 12, color: GREY });
    }
    footer(page, index);
  });

  return pdf.finish();
}

function isTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

module.exports = { renderLogbookPdf, splitByDay, isTimeZone, PDF_LANGUAGES };
