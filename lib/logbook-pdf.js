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
const LINE_HEIGHT = 10;
const CELL_PADDING = 3;
const SKETCH_MAX_HEIGHT = 48;

const GREY = [0.45, 0.45, 0.45];
const RULE = [0.75, 0.75, 0.75];
const HEAD_FILL = [0.9, 0.92, 0.94];
const PASSAGE_FILL = [0.95, 0.96, 0.97];
const ALARM = [0.72, 0.1, 0.1];

const COLUMNS = [
  { key: 'time', width: 36 },
  { key: 'position', width: 112 },
  { key: 'course', width: 42 },
  { key: 'speed', width: 42 },
  { key: 'wind', width: 80 },
  { key: 'pressure', width: 48 },
  { key: 'depth', width: 40 },
  { key: 'propulsion', width: 54 }
];
const REMARKS_WIDTH =
  PAGE.width - 2 * PAGE.margin - COLUMNS.reduce((sum, column) => sum + column.width, 0);

const HOUR_MS = 60 * 60 * 1000;

// The languages of public/js/i18n.mjs, known synchronously for validation.
const PDF_LANGUAGES = ['en', 'fr'];

let sharedModules = null;

// The webapp's modules are ES modules; loaded once, on first use.
function loadShared() {
  const load = (file) =>
    import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);
  sharedModules ??= Promise.all([load('i18n.mjs'), load('format.mjs'), load('log-lines.mjs')]).then(
    ([i18n, format, lines]) => ({ i18n, format, lines })
  );
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

function passageLines(bundle, context) {
  const { t, format, buildRows, describeEvent, manoeuvreLabels } = context;
  const { entry, events, observations, propulsion } = bundle;
  const place = (name) => name ?? t('place.unknown');
  // Readings taken at departure and arrival belong on those lines.
  const startReadings = observations.find((observation) => observation.reason === 'entry_start');
  const endReadings = observations.find((observation) => observation.reason === 'entry_end');
  const otherReadings = observations.filter(
    (observation) => observation !== startReadings && observation !== endReadings
  );
  const lines = [
    {
      time: entry.startTime,
      order: 0,
      entry,
      kind: 'departure',
      readings: startReadings ?? null,
      propulsion: startReadings ? propulsionAt(propulsion, startReadings.time) : null,
      position: entry.startPosition,
      remarks: [{ text: t('pdf.departure', { place: place(entry.startPlaceName) }), font: 'bold' }]
    }
  ];

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
        }
      ]
    });
  }
  return lines;
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

// Words with their font, laid out greedily over lines of `width`.
function layoutRemarks(parts, width) {
  const lines = [[]];
  let x = 0;
  for (const part of parts) {
    const font = part.font ?? 'regular';
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

function measure(line, context) {
  const remarkLines = layoutRemarks(line.remarks, REMARKS_WIDTH - 2 * CELL_PADDING);
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
    Math.max(1, shown.length) * LINE_HEIGHT +
    (sketch ? sketch.drawnHeight + (shown.length > 0 ? 2 : 0) : 0);
  return { ...line, cells: readingCells(line, context), remarkLines: shown, sketch, height };
}

// Pages as lists of measured rows; nothing is drawn yet, so the page count is
// known for the footers.
function paginate(days, context) {
  const pages = [];
  const available = BODY_BOTTOM - HEADER_BOTTOM - TABLE_HEAD_HEIGHT;
  for (const day of days) {
    let page = { day, continued: false, rows: [], used: 0 };
    pages.push(page);
    for (const line of day.lines) {
      const row = measure(line, context);
      if (page.used + row.height > available && page.rows.length > 0) {
        page = { day, continued: true, rows: [], used: 0 };
        pages.push(page);
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
        { width: 0.8 }
      );
    }
  }
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
  const { i18n, format: formatModule, lines: lineModule } = await loadShared();
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
      drawTableHead(page, t, HEADER_BOTTOM);
      let top = HEADER_BOTTOM + TABLE_HEAD_HEIGHT;
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
