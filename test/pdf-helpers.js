const zlib = require('node:zlib');

// Reads back what a PDF from lib/pdf/writer.js shows, for assertions: the
// decoded text of each page and its raw drawing operators.

const HIGH = {
  0x80: '€',
  0x85: '…',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x96: '–',
  0x97: '—',
  0x9c: 'œ'
};

function decodeWinAnsi(hex) {
  let text = '';
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    text += HIGH[code] ?? String.fromCharCode(code);
  }
  return text;
}

function readPdf(buffer) {
  const source = buffer.toString('latin1');
  const pages = [];
  const stream = />>\nstream\n/g;
  let match;
  while ((match = stream.exec(source)) !== null) {
    const start = match.index + match[0].length;
    const header = source.slice(source.lastIndexOf('<<', match.index), match.index);
    const length = Number(header.match(/\/Length (\d+)/)[1]);
    const ops = zlib.inflateSync(buffer.subarray(start, start + length)).toString('latin1');
    const texts = [...ops.matchAll(/<([0-9a-f]*)> Tj/g)].map((m) => decodeWinAnsi(m[1]));
    pages.push({ ops, texts, text: texts.join('\n') });
    stream.lastIndex = start + length;
  }
  return { source, pages, text: pages.map((page) => page.text).join('\n') };
}

module.exports = { readPdf };
