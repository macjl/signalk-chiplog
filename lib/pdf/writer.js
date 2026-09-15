const zlib = require('node:zlib');
const { encodeWinAnsi } = require('./winansi');

// A minimal PDF 1.4 writer: the two standard Helvetica fonts, text, lines,
// rectangles and polylines — what a logbook page needs, with no dependency.
// Drawing coordinates are in points from the top-left corner of the page.

const FONTS = { regular: 'F1', bold: 'F2' };

const number = (value) => {
  const text = Number(value).toFixed(2);
  return text.replace(/\.?0+$/, '') || '0';
};

const colour = ([r, g, b]) => `${number(r)} ${number(g)} ${number(b)}`;

function hexString(codes) {
  return `<${codes.map((code) => code.toString(16).padStart(2, '0')).join('')}>`;
}

// Text in the Info dictionary is UTF-16BE with a byte order mark, which any
// reader understands, rather than WinAnsi.
function infoString(text) {
  const buffer = Buffer.from(`\ufeff${text}`, 'utf16le').swap16();
  return `<${buffer.toString('hex')}>`;
}

function pdfDate(date) {
  return `(D:${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z)`;
}

function createPage(width, height) {
  const ops = [];
  const y = (top) => height - top;

  return {
    width,
    height,
    ops,

    // `top` is the baseline, measured from the top of the page.
    text(x, top, text, { font = 'regular', size = 10, color = [0, 0, 0] } = {}) {
      ops.push(
        `BT /${FONTS[font]} ${number(size)} Tf ${colour(color)} rg ${number(x)} ${number(y(top))} Td ${hexString(encodeWinAnsi(text))} Tj ET`
      );
    },

    line(x1, top1, x2, top2, { color = [0, 0, 0], width: lineWidth = 0.5 } = {}) {
      ops.push(
        `q ${colour(color)} RG ${number(lineWidth)} w ${number(x1)} ${number(y(top1))} m ${number(x2)} ${number(y(top2))} l S Q`
      );
    },

    rect(
      x,
      top,
      rectWidth,
      rectHeight,
      { fill = null, stroke = null, width: lineWidth = 0.5 } = {}
    ) {
      const path = `${number(x)} ${number(y(top + rectHeight))} ${number(rectWidth)} ${number(rectHeight)} re`;
      const paint = fill && stroke ? 'B' : fill ? 'f' : 'S';
      ops.push(
        `q ${fill ? `${colour(fill)} rg ` : ''}${stroke ? `${colour(stroke)} RG ` : ''}${number(lineWidth)} w ${path} ${paint} Q`
      );
    },

    // Round caps and joins, so a single point still shows as a dot. `alpha`
    // draws through the document's one translucency state (a highlighter),
    // rather than at full opacity.
    polyline(points, { color = [0, 0, 0], width: lineWidth = 1, alpha = false } = {}) {
      if (points.length === 0) {
        return;
      }
      const path = points
        .map(([px, top], index) => `${number(px)} ${number(y(top))} ${index === 0 ? 'm' : 'l'}`)
        .join(' ');
      const dot =
        points.length === 1 ? ` ${number(points[0][0])} ${number(y(points[0][1]))} l` : '';
      const gs = alpha ? '/GS1 gs ' : '';
      ops.push(`q ${gs}${colour(color)} RG ${number(lineWidth)} w 1 J 1 j ${path}${dot} S Q`);
    }
  };
}

// The one translucency level the writer knows: a highlighter over ink, over
// the paper. Only allocated once, referenced from any page that needs it.
const HIGHLIGHTER_ALPHA = 0.35;

function createPdf({ title = '', author = '', creator = '', creationDate = new Date() } = {}) {
  const pages = [];

  return {
    addPage(width, height) {
      const page = createPage(width, height);
      pages.push(page);
      return page;
    },

    finish() {
      // Object numbers: 1 catalog, 2 page tree, 3–4 fonts, 5 the highlighter's
      // ExtGState, 6 info, then a page and its content stream for each page.
      const pageRef = (index) => 7 + index * 2;
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageRef(index)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
        `<< /Type /ExtGState /ca ${number(HIGHLIGHTER_ALPHA)} /CA ${number(HIGHLIGHTER_ALPHA)} >>`,
        `<< /Title ${infoString(title)} /Author ${infoString(author)} /Creator ${infoString(creator)} /Producer ${infoString(creator)} /CreationDate ${pdfDate(creationDate)} >>`
      ];
      pages.forEach((page, index) => {
        objects.push(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(page.width)} ${number(page.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /GS1 5 0 R >> >> /Contents ${pageRef(index) + 1} 0 R >>`
        );
        const content = zlib.deflateSync(Buffer.from(page.ops.join('\n'), 'latin1'));
        objects.push({
          dictionary: `<< /Length ${content.length} /Filter /FlateDecode >>`,
          content
        });
      });

      const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
      let length = chunks[0].length;
      const offsets = [];
      const push = (buffer) => {
        chunks.push(buffer);
        length += buffer.length;
      };
      objects.forEach((object, index) => {
        offsets.push(length);
        if (typeof object === 'string') {
          push(Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'latin1'));
        } else {
          push(Buffer.from(`${index + 1} 0 obj\n${object.dictionary}\nstream\n`, 'latin1'));
          push(object.content);
          push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
        }
      });

      const xrefOffset = length;
      const xref = [
        'xref',
        `0 ${objects.length + 1}`,
        '0000000000 65535 f ',
        ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
        'trailer',
        `<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>`,
        'startxref',
        String(xrefOffset),
        '%%EOF',
        ''
      ].join('\n');
      push(Buffer.from(xref, 'latin1'));
      return Buffer.concat(chunks);
    }
  };
}

module.exports = { createPdf, HIGHLIGHTER_ALPHA };
