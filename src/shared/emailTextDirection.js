/** Arabic, Persian/Dari, Hebrew, and related scripts */
const RTL_CHAR_RE =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const STRONG_LTR_CHAR_RE = /[A-Za-z0-9]/;

/**
 * Infer paragraph direction from the first strong character (Unicode bidi).
 * @param {string} text
 * @returns {'rtl' | 'ltr' | 'auto'}
 */
function paragraphDirection(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return 'auto';
  }
  for (const ch of trimmed) {
    if (RTL_CHAR_RE.test(ch)) {
      return 'rtl';
    }
    if (STRONG_LTR_CHAR_RE.test(ch)) {
      return 'ltr';
    }
  }
  return 'auto';
}

module.exports = {
  paragraphDirection,
};
