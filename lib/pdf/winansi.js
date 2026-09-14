// The standard PDF fonts only cover WinAnsiEncoding: Latin-1 plus a few
// typographic characters in 0x80–0x9F. Enough for English and French.

const HIGH_CODES = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f
};

// Characters the webapp uses that WinAnsi lacks, and their nearest stand-in.
const SUBSTITUTES = {
  '\u2032': "'", // prime, in coordinates
  '\u2033': '"', // double prime
  '\u2192': '->', // arrow
  '\u202f': '\u00a0', // narrow no-break space, the French thousands separator
  '\u2009': ' ', // thin space
  '\u2212': '-' // minus sign
};

function substitute(text) {
  return String(text).replace(
    /[\u2032\u2033\u2192\u202f\u2009\u2212]/g,
    (char) => SUBSTITUTES[char]
  );
}

// WinAnsi codes for a string, '?' for anything that cannot be shown.
function encodeWinAnsi(text) {
  const codes = [];
  for (const char of substitute(text)) {
    const point = char.codePointAt(0);
    if ((point >= 0x20 && point <= 0x7e) || (point >= 0xa0 && point <= 0xff)) {
      codes.push(point);
    } else {
      codes.push(HIGH_CODES[point] ?? 0x3f);
    }
  }
  return codes;
}

module.exports = { encodeWinAnsi };
