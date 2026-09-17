// Demo passages are placed on the local clock: fix it, as the days depend on it.
process.env.TZ = 'Europe/Paris';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const { openDatabase } = require('../lib/database');
const { renderExport, writeUsbExport } = require('../lib/export');
const { splitByDay, renderLogbookPdf } = require('../lib/logbook-pdf');
const { seedDemoLogbook } = require('../scripts/seed-demo');
const { readPdf } = require('./pdf-helpers');

const NOW = Date.parse('2026-09-13T16:00:00.000Z');

describe('facsimile PDF logbook', () => {
  let directory;
  let db;

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-pdf-'));
    ({ db } = openDatabase(directory));
    seedDemoLogbook(db, { now: NOW });
  });

  after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const render = async (pdf, range = {}) =>
    readPdf((await renderExport(db, 'pdf', range, new Date(NOW).toISOString(), pdf)).body);

  it('lays out a page per day in the chosen language, numbered', async () => {
    const french = await render({
      language: 'fr',
      timeZone: 'Europe/Paris',
      vesselName: 'Aldebaran',
      version: '9.9.9'
    });

    const total = french.pages.length;
    assert.ok(total >= 4, `${total} pages`);
    for (const heading of ['Heure', 'Position', 'Route', 'Vent', 'Moteur/voile', 'Remarques']) {
      assert.ok(french.pages[0].texts.includes(heading), heading);
    }
    assert.ok(french.pages[0].texts.includes('Journal de bord — Aldebaran'));
    assert.ok(french.pages[0].texts.includes(`Page 1 / ${total}`));
    assert.ok(french.pages.at(-1).texts.includes(`Page ${total} / ${total}`));
    assert.ok(french.text.includes('Départ de La Rochelle (Les Minimes)'));
    assert.ok(french.text.includes('Heure du bord : Europe/Paris (UTC+02:00)'));
    assert.match(french.text, /Généré le .+ par Chiplog 9\.9\.9/);

    const english = await render({ language: 'en', timeZone: 'Europe/Paris' });
    assert.ok(english.pages[0].texts.includes('Remarks'));
    assert.ok(english.text.includes('Departure from La Rochelle (Les Minimes)'));
  });

  it('keeps ship’s time: the night passage spans two days in some time zones only', async () => {
    const continues = 'Passage from Saint-Martin-de-Ré continues';
    const paris = await render({ language: 'en', timeZone: 'Europe/Paris' });
    assert.ok(paris.text.includes(continues));
    // Seven hours ahead, the same passage runs from 03:00 to 12:30.
    const tokyo = await render({ language: 'en', timeZone: 'Asia/Tokyo' });
    assert.ok(!tokyo.text.includes(continues));
    assert.ok(tokyo.text.includes('Ship’s time: Asia/Tokyo (UTC+09:00)'));
  });

  it('writes departures, arrivals with totals, readings, events and day totals', async () => {
    const { text, pages } = await render({ language: 'en', timeZone: 'Europe/Paris' });

    assert.match(
      text,
      /Arrival at Saint-Martin-de-Ré\n9\.4 nm in 3 h 20 — engine 40 min, sail 2 h 40/
    );
    assert.ok(text.includes('Sail change') && text.includes('(sail: Genoa)'));
    assert.ok(text.includes('Alarm: Engine temperature high'));
    assert.ok(!text.includes('— Engine temperature high'), 'no repeated alarm message');
    assert.ok(text.includes('<b>not bold</b>'), 'crew text as typed');
    assert.match(text, /Day: \d+\.\d nm sailed — engine/);
    assert.ok(text.includes('1,017 hPa'));
    assert.match(
      text,
      /Departure from La Rochelle \(Les Minimes\)\nEngine hours: port 812\.4 h, starboard 798\.1 h\n/
    );
    assert.match(
      text,
      /\nEngine hours: port 813\.1 h \(\+0\.7 h\), starboard 798\.8 h \(\+0\.7 h\)\n/,
      'at arrival, on a line of their own, with the hours run'
    );
    // The departure's own reading is on the departure line, not a line of its own.
    assert.ok(!pages.some((page) => page.texts.includes('Departure')));
    // Handwriting is drawn as strokes, each in its own colour...
    assert.ok(pages.some((page) => /1 J 1 j [\d.]+ [\d.]+ m [\d.]+ [\d.]+ l/.test(page.ops)));
    assert.ok(
      pages.some((page) => page.ops.includes('0.11 0.31 0.85 RG')),
      'blue pen stroke'
    );
    // ...and the highlighter through the shared translucency state, not opaque.
    assert.ok(
      pages.some((page) => page.ops.includes('/GS1 gs 0.85 0.47 0.02 RG')),
      'highlighter'
    );
  });

  it('notes the weather forecast at departure, a line every 3 hours', async () => {
    const french = await render({ language: 'fr', timeZone: 'Europe/Paris' });
    assert.ok(
      french.text.includes(
        'Départ de La Rochelle (Les Minimes)\nHeures moteur : bâbord 812,4 h, tribord 798,1 h\n' +
          'Prévisions météo :\n10:00 Couvert, vent SO 8,0 nd F3 (rafales 13,9 nd), vagues 0,9 m 6 s SO,'
      )
    );
    assert.ok(
      french.text.includes('13:00 Averses, vent SO 10,3 nd F3 (rafales 16,9 nd), pluie 1,6 mm')
    );
    assert.ok(french.text.includes('Orage, vent'));
    // Three passages with a forecast, eight lines each, dated once past the
    // departure's day.
    const steps = french.text.match(/^(\d+ sept\. )?\d\d:00 \p{L}/gmu);
    assert.equal(steps.length, 24);
    assert.ok(steps.some((step) => step.startsWith('11 sept. 01:00')));

    const english = await render({ language: 'en', timeZone: 'Europe/Paris' });
    assert.ok(english.text.includes('Weather forecast:\n10:00 Overcast, wind SW 8.0 kn F3'));
  });

  it('says when a period holds no passage', async () => {
    const { pages } = await render(
      { language: 'fr', timeZone: 'Europe/Paris' },
      { from: '2020-01-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z' }
    );
    assert.equal(pages.length, 1);
    assert.ok(pages[0].texts.includes('Aucune navigation sur cette période.'));
    assert.ok(pages[0].texts.includes('Page 1 / 1'));
  });

  it('continues a full day on another page', async () => {
    const start = Date.parse('2026-06-01T06:00:00.000Z');
    const minutes = (n) => new Date(start + n * 60 * 1000).toISOString();
    const bundle = {
      entry: {
        id: 1,
        startTime: minutes(0),
        endTime: minutes(600),
        startPlaceName: 'A',
        endPlaceName: 'B',
        startPosition: { lat: 46, lon: -1 },
        endPosition: { lat: 46.1, lon: -1 },
        distance: 1000,
        engineDuration: 0,
        sailDuration: 36000
      },
      trackPoints: [],
      propulsion: [{ type: 'sail', startTime: minutes(0), endTime: minutes(600) }],
      observations: [],
      events: Array.from({ length: 80 }, (_, index) => ({
        id: index + 1,
        time: minutes(index * 5 + 1),
        type: 'text_annotation',
        comment: `Note ${index + 1}`,
        position: null,
        payload: null
      }))
    };
    const { pages } = readPdf(
      await renderLogbookPdf([bundle], { language: 'en', timeZone: 'UTC', now: minutes(700) })
    );

    assert.ok(pages.length >= 2);
    assert.ok(pages[1].texts.some((text) => text.endsWith('(continued)')));
    assert.ok(pages[1].texts.includes('Time'), 'column heads repeated');
    assert.ok(pages.at(-1).texts.includes('Note 80'));
  });

  it('splits time by calendar day, daylight saving change included', async () => {
    const { createFormatter } = await import('../public/js/format.mjs');
    const format = createFormatter({ locale: 'en', units: {}, timeZone: 'Europe/Paris' });
    // Paris clocks go back on 25 October 2026: that day lasts 25 hours.
    const parts = splitByDay(
      Date.parse('2026-10-24T22:00:00.000Z'),
      Date.parse('2026-10-26T01:00:00.000Z'),
      format
    );
    assert.deepEqual(Object.fromEntries(parts), {
      '2026-10-25': 25 * 3600 * 1000,
      '2026-10-26': 2 * 3600 * 1000
    });
  });

  it('adds a PDF per passage to the USB copy, rewritten when its language changes', async () => {
    const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-usb-pdf-'));
    try {
      const now = new Date(NOW).toISOString();
      const first = await writeUsbExport(db, usb, now, { language: 'en', timeZone: 'UTC' });
      const pdfs = fs
        .readdirSync(path.join(usb, 'chiplog'))
        .filter((name) => name.endsWith('.pdf'));
      assert.equal(pdfs.length, first.entries);

      const same = await writeUsbExport(db, usb, now, {
        language: 'en',
        timeZone: 'UTC',
        version: '2.0.0'
      });
      assert.equal(same.written, 0, 'a new plugin version rewrites nothing');

      const french = await writeUsbExport(db, usb, now, { language: 'fr', timeZone: 'UTC' });
      assert.equal(french.written, first.entries);
      const { text } = readPdf(fs.readFileSync(path.join(usb, 'chiplog', pdfs[0])));
      assert.ok(text.includes('Journal de bord'));
    } finally {
      fs.rmSync(usb, { recursive: true, force: true });
    }
  });
});
