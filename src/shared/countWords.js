/**
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).filter(Boolean).length;
}

module.exports = {
  countWords,
};
