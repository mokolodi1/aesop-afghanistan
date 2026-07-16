/** Arabic, Persian/Dari, Hebrew, and related scripts plus bidi/format marks. */
const RTL_OR_MARK_RE =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u200C\u200D\uFEFF]|\p{M}/u;

/**
 * @param {string} line
 * @returns {number}
 */
function countLatinLetters(line) {
  let count = 0;
  for (const char of String(line || '')) {
    if (/\p{Script=Latin}/u.test(char)) {
      count += 1;
    }
  }
  return count;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function lineHasMeaningfulLatinText(line) {
  return countLatinLetters(line) >= 2;
}

/**
 * True when a letter uses a non-Latin script (Arabic/Persian/Dari, Cyrillic, etc.).
 * @param {string} char
 * @returns {boolean}
 */
function isNonLatinLetter(char) {
  return /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char);
}

/**
 * True when text includes Arabic/Persian/Dari/Hebrew script.
 * @param {string} text
 * @returns {boolean}
 */
function hasRtlScript(text) {
  return /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u.test(
    String(text || ''),
  );
}

/**
 * @param {string} char
 * @returns {'ltr'|'rtl'|null}
 */
function charStrongDirection(char) {
  if (/\p{Script=Latin}/u.test(char) || /[0-9]/.test(char)) {
    return 'ltr';
  }
  if (
    /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u.test(
      char,
    )
  ) {
    return 'rtl';
  }
  return null;
}

/**
 * True when a line mixes Latin and RTL script (e.g. English and Dari).
 * @param {string} text
 * @returns {boolean}
 */
function isMixedDirectionLine(text) {
  const line = String(text || '');
  return hasRtlScript(line) && /\p{Script=Latin}/u.test(line);
}

/**
 * Split inline text into isolated LTR/RTL runs for mixed-direction lines.
 * @param {string} text
 * @returns {Array<{ dir: 'ltr'|'rtl', text: string }>}
 */
function splitBidirectionalRuns(text) {
  const input = String(text || '');
  if (!input) {
    return [];
  }

  /** @type {Array<{ dir: 'ltr'|'rtl', text: string }>} */
  const runs = [];
  /** @type {'ltr'|'rtl'|null} */
  let runDir = null;
  let runText = '';

  for (const char of input) {
    const strongDir = charStrongDirection(char);
    if (!strongDir) {
      runText += char;
      continue;
    }
    if (runDir === null) {
      runDir = strongDir;
      runText += char;
      continue;
    }
    if (strongDir === runDir) {
      runText += char;
      continue;
    }
    if (runText) {
      runs.push({ dir: runDir, text: runText });
    }
    runDir = strongDir;
    runText = char;
  }

  if (runText) {
    runs.push({ dir: runDir || 'ltr', text: runText });
  }

  return runs;
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
    if (!lineHasMeaningfulLatinText(line)) {
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
  hasRtlScript,
  isMixedDirectionLine,
  splitBidirectionalRuns,
};
