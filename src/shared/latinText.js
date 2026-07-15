/** Arabic, Persian/Dari, Hebrew, and related scripts plus bidi/format marks. */
const RTL_OR_MARK_RE =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u200C\u200D\uFEFF]|\p{M}/u;

const HAS_LATIN_LETTER_RE = /\p{Script=Latin}/u;

/**
 * True when a letter uses a non-Latin script (Arabic/Persian/Dari, Cyrillic, etc.).
 * @param {string} char
 * @returns {boolean}
 */
function isNonLatinLetter(char) {
  return /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char);
}

/**
 * Remove non-Latin script and keep English/Latin prompt lines only.
 * Drops Dari/Arabic lines and leftover punctuation or diacritic fragments.
 * @param {string} text
 * @returns {string}
 */
function stripNonLatinLetters(text) {
  const keptLines = [];

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = '';
    for (const char of rawLine) {
      if (isNonLatinLetter(char) || RTL_OR_MARK_RE.test(char)) {
        continue;
      }
      line += char;
    }

    line = line.replace(/[ \t]+/g, ' ').trim();
    if (!HAS_LATIN_LETTER_RE.test(line)) {
      continue;
    }
    keptLines.push(line);
  }

  return keptLines.join('\n').trim();
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasNonLatinLetters(text) {
  for (const char of String(text || '')) {
    if (isNonLatinLetter(char)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  stripNonLatinLetters,
  hasNonLatinLetters,
};
