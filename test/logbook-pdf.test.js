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
    // Each position is also read against the nearest amer (SPEC §4.13), on a
    // line of its own under the coordinates.
    assert.match(
      text,
      /\n46°\d\d\.\d\d'N 001°\d\d\.\d\d'W\n\d\.\d nm [NSEW]+ \(\d{3}°\) — Phare de Chauveau\n/
    );
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
    // A passage that set off again after a stopover departs from it once more.
    assert.ok(text.includes("Stopped at Château-d'Olonne (Cayola)"));
    assert.ok(text.includes("Departure from Château-d'Olonne (Cayola)"));
    assert.ok(
      pages.some((page) => page.texts.includes('Arrival')),
      'the stopover reading'
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

  it('gives the weather forecast its own block above the day, not mixed into its events', async () => {
    const french = await render({ language: 'fr', timeZone: 'Europe/Paris' });
    // A block per passage that has a forecast, named after the place it was
    // fetched near, one per day it departed on.
    assert.deepEqual(french.text.match(/Prévisions météo marine — [^\n]+/g), [
      'Prévisions météo marine — La Rochelle (Les Minimes)',
      'Prévisions météo marine — Saint-Martin-de-Ré',
      'Prévisions météo marine — Port Bourgenay'
    ]);
    // The block, and its own table, come before the day's table of events
    // and observations -- above it, not one of its rows.
    assert.ok(
      french.text.includes(
        'Prévisions météo marine — La Rochelle (Les Minimes)\n' +
          'Heure\nCiel\nVent\nVagues\nHoule\nPression\nVisibilité\nAir / eau\nCourant\n' +
          '10:00\n10 sept.\nCouvert\nForce 3 SO 8,0 nd\nrafales 13,9 nd\n0,9 m\n6 s SO'
      )
    );
    assert.ok(
      french.text.includes(
        'Heure\nPosition\nRoute\nVitesse\nVent\nBaro\nSonde\nMoteur/voile\nRemarques\n' +
          "10:00\n46°08.80'N 001°10.12'W\n0,7 M ENE (060°) — Tour Richelieu\n" +
          '250°\n2,5 nd\n10,7 nd 281°\n1 017 hPa\n14,2 m\n' +
          'Moteur\nDépart de La Rochelle (Les Minimes)'
      )
    );
    assert.ok(french.text.includes('Orage'));
    // Eight three-hourly steps per passage, each showing a Beaufort force.
    assert.equal((french.text.match(/Force \d/g) ?? []).length, 24);

    const english = await render({ language: 'en', timeZone: 'Europe/Paris' });
    assert.ok(
      english.text.includes(
        'Weather forecast — La Rochelle (Les Minimes)\n' +
          'Time\nSky\nWind\nWaves\nSwell\nPressure\nVisibility\nAir / sea\nCurrent\n' +
          '10:00\nSep 10\nOvercast\nForce 3 SW 8.0 kn\ngusts 13.9 kn'
      )
    );
  });

  it('shows the tanks and batteries noted at departure below the weather block', async () => {
    const { text } = await render({ language: 'en', timeZone: 'Europe/Paris' });
    // Drawn after the weather block and before the day's table, one per
    // departure that has a boat state recorded.
    assert.ok(
      text.includes(
        '1.1 kn\nSW\n' +
          'Boat status\n' +
          'Fuel: 90% · 162 L\nFresh water: 93% · 280 L\nBlack water: 10%\n' +
          'House: 95% · 13.0 V · -4.5 A\nStarter: 12.7 V\n' +
          'Time\nPosition\nCourse\nSOG\nWind\nBaro\nDepth\nEngine/sail\nRemarks'
      )
    );

    const french = await render({ language: 'fr', timeZone: 'Europe/Paris' });
    assert.ok(french.text.includes('État du bord\nCarburant: 90 % · 162 L'));
  });

  it('draws the tide and boat-status blocks side by side, either optional', async () => {
    const start = Date.parse('2026-06-01T06:00:00.000Z');
    const minutes = (n) => new Date(start + n * 60 * 1000).toISOString();
    const points = Array.from({ length: 24 }, (_, i) => ({
      time: new Date(start + i * 60 * 60 * 1000).toISOString(),
      height: 2 + 2 * Math.sin((i / 12) * Math.PI)
    }));
    const bundleOf = (id, boatState, tide) => ({
      entry: {
        id,
        startTime: minutes(id * 120),
        endTime: minutes(id * 120 + 60),
        startPlaceName: `Place ${id}`,
        endPlaceName: 'B',
        startPosition: { lat: 46, lon: -1 },
        endPosition: { lat: 46.1, lon: -1 },
        distance: 1000,
        engineDuration: 0,
        sailDuration: 3600,
        ...boatState
      },
      trackPoints: [],
      propulsion: [{ type: 'sail', startTime: minutes(id * 120), endTime: minutes(id * 120 + 60) }],
      observations: [],
      events: [],
      tide
    });
    const both = bundleOf(
      1,
      {
        startTanks: [{ type: 'fuel', id: '0', level: 0.8, volume: 0.12 }],
        startBatteries: [{ id: '0', stateOfCharge: 0.9, voltage: 12.6, current: -3.2 }]
      },
      { points }
    );
    const tideOnly = bundleOf(2, {}, { points });
    const statusOnly = bundleOf(
      3,
      { startTanks: [{ type: 'fuel', id: '0', level: 0.5, volume: 0.09 }] },
      null
    );

    const { text: both1 } = readPdf(
      await renderLogbookPdf([both], { language: 'en', timeZone: 'UTC', now: minutes(200) })
    );
    // Drawn as two separate blocks -- all of the tide's lines, then all of
    // the boat status's, not interleaved row by row like the weather table.
    assert.ok(
      both1.includes(
        'Tide\n' +
          'High tide Jun 1 12:00 — 4.0 m\nLow tide Jun 2 00:00 — 0.0 m\n' +
          'Boat status\n' +
          'Fuel: 80% · 120 L\nBattery 0: 90% · 12.6 V · -3.2 A'
      )
    );

    const { text: tideText } = readPdf(
      await renderLogbookPdf([tideOnly], { language: 'en', timeZone: 'UTC', now: minutes(320) })
    );
    assert.ok(tideText.includes('Tide\nHigh tide'));
    assert.ok(!tideText.includes('Boat status'));

    const { text: statusText } = readPdf(
      await renderLogbookPdf([statusOnly], { language: 'en', timeZone: 'UTC', now: minutes(440) })
    );
    assert.ok(statusText.includes('Boat status\nFuel: 50% · 90 L'));
    assert.ok(!statusText.includes('Tide\n'));
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

  it('names the crew on the departure line, once, not on a stopover departure', async () => {
    const start = Date.parse('2026-06-01T06:00:00.000Z');
    const minutes = (n) => new Date(start + n * 60 * 1000).toISOString();
    const bundle = {
      entry: {
        id: 1,
        startTime: minutes(0),
        endTime: minutes(60),
        startPlaceName: 'A',
        endPlaceName: 'B',
        startPosition: { lat: 46, lon: -1 },
        endPosition: { lat: 46.1, lon: -1 },
        distance: 1000,
        engineDuration: 0,
        sailDuration: 3600
      },
      trackPoints: [],
      propulsion: [{ type: 'sail', startTime: minutes(0), endTime: minutes(60) }],
      observations: [],
      events: [],
      crew: [
        { id: 1, crewMemberId: 1, name: 'Alex', role: 'skipper' },
        { id: 2, crewMemberId: null, name: 'Jo', role: null }
      ]
    };
    const { text } = readPdf(
      await renderLogbookPdf([bundle], { language: 'en', timeZone: 'UTC', now: minutes(120) })
    );

    assert.match(text, /Departure from A\nCrew: Alex \(skipper\), Jo\n/);
  });

  it('omits the crew remark when none is recorded', async () => {
    const start = Date.parse('2026-06-01T06:00:00.000Z');
    const minutes = (n) => new Date(start + n * 60 * 1000).toISOString();
    const bundle = {
      entry: {
        id: 1,
        startTime: minutes(0),
        endTime: minutes(60),
        startPlaceName: 'A',
        endPlaceName: 'B',
        startPosition: { lat: 46, lon: -1 },
        endPosition: { lat: 46.1, lon: -1 },
        distance: 1000,
        engineDuration: 0,
        sailDuration: 3600
      },
      trackPoints: [],
      propulsion: [{ type: 'sail', startTime: minutes(0), endTime: minutes(60) }],
      observations: [],
      events: [],
      crew: []
    };
    const { text } = readPdf(
      await renderLogbookPdf([bundle], { language: 'en', timeZone: 'UTC', now: minutes(120) })
    );

    assert.ok(!text.includes('Crew:'));
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
