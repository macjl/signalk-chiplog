const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { textWidth, wrapText } = require('../lib/pdf/helvetica');
const { encodeWinAnsi } = require('../lib/pdf/winansi');
const { createPdf } = require('../lib/pdf/writer');
const { readPdf } = require('./pdf-helpers');

describe('PDF writer', () => {
  function sample() {
    const pdf = createPdf({ title: 'Journal de bord — Île d’Yeu', creator: 'Chiplog test' });
    const page = pdf.addPage(842, 595);
    page.text(28, 40, 'Génois – 25 kn (reef) \\ ok', { font: 'bold', size: 12 });
    page.rect(28, 50, 100, 20, { fill: [0.9, 0.9, 0.9], stroke: [0, 0, 0] });
    page.polyline([
      [10, 10],
      [20, 20]
    ]);
    pdf.addPage(842, 595).text(28, 40, 'Page two');
    return pdf.finish();
  }

  it('writes a well-formed file whose cross-reference table points at every object', () => {
    const buffer = sample();
    const source = buffer.toString('latin1');

    assert.ok(source.startsWith('%PDF-1.4\n'));
    assert.ok(source.endsWith('%%EOF\n'));
    const startxref = Number(source.match(/startxref\n(\d+)\n%%EOF/)[1]);
    assert.ok(source.startsWith('xref\n', startxref));
    const offsets = [...source.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1])
    );
    assert.equal(offsets.length, 5 + 2 * 2);
    offsets.forEach((offset, index) => {
      assert.ok(source.startsWith(`${index + 1} 0 obj\n`, offset), `object ${index + 1}`);
    });
    assert.match(source, /\/Count 2/);
  });

  it('draws text in WinAnsi, accents and typography included, and shapes as paths', () => {
    const { pages, source } = readPdf(sample());

    assert.equal(pages.length, 2);
    assert.deepEqual(pages[0].texts, ['Génois – 25 kn (reef) \\ ok']);
    assert.match(pages[0].ops, /\/F2 12 Tf/);
    assert.match(pages[0].ops, / re B Q/);
    assert.match(pages[0].ops, /1 J 1 j 10 585 m 20 575 l S/);
    assert.deepEqual(pages[1].texts, ['Page two']);
    // The title, in UTF-16 with a byte order mark.
    const title = Buffer.from('﻿Journal de bord — Île d’Yeu', 'utf16le').swap16().toString('hex');
    assert.ok(source.includes(`/Title <${title}>`));
  });

  it('stands in for characters the standard fonts lack', () => {
    assert.deepEqual(encodeWinAnsi('46°08′N → 1 013 😀'), [
      ...Buffer.from("46\xb008'N -> 1\xa0013 ?", 'latin1')
    ]);
  });

  it('measures and wraps text with the font metrics', () => {
    assert.equal(textWidth('W', 'regular', 1000), 944);
    assert.equal(textWidth('i', 'regular', 1000), 222);
    assert.equal(textWidth('i', 'bold', 1000), 278);
    assert.equal(textWidth('é', 'regular', 10), textWidth('e', 'regular', 10));

    const lines = wrapText('Pris un ris dans la grand-voile après le grain', 'regular', 10, 80);
    assert.ok(lines.length > 1);
    lines.forEach((line) => assert.ok(textWidth(line, 'regular', 10) <= 80, line));
    assert.equal(lines.join(' '), 'Pris un ris dans la grand-voile après le grain');
    assert.deepEqual(wrapText('', 'regular', 10, 80), ['']);
    const cut = wrapText('x'.repeat(40), 'regular', 10, 50);
    assert.ok(cut.length > 1 && cut.every((line) => textWidth(line, 'regular', 10) <= 50));
  });
});
