/** Supported voice memo filename extensions (without dots). */
const DEFAULT_VOICE_MEMO_FILE_EXTENSIONS = ["m4a", "aac", "mp3", "ogg", "opus"];

const DEFAULT_VOICE_MEMO_FILE_EXTENSIONS_CSV = DEFAULT_VOICE_MEMO_FILE_EXTENSIONS.join(",");

/**
 * @param {unknown} value
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
function parseVoiceMemoFileExtensions(value, fallback = DEFAULT_VOICE_MEMO_FILE_EXTENSIONS) {
  if (Array.isArray(value) && value.length > 0) {
    const parsed = value
      .map((extension) =>
        String(extension || "")
          .trim()
          .replace(/^\./, "")
          .toLowerCase(),
      )
      .filter(Boolean);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  const raw = String(value ?? "").trim();
  if (raw) {
    const parsed = raw
      .split(/[,|\s]+/)
      .map((part) => part.trim().replace(/^\./, "").toLowerCase())
      .filter(Boolean);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [...fallback];
}

/**
 * @param {string[]} extensions
 * @returns {string}
 */
function formatVoiceMemoExtensionHint(extensions) {
  const list = parseVoiceMemoFileExtensions(extensions);
  if (list.length === 0) {
    return "{AESOP ID}.m4a";
  }
  if (list.length === 1) {
    return `{AESOP ID}.${list[0]}`;
  }
  if (list.length === 2) {
    return `{AESOP ID}.${list[0]} or {AESOP ID}.${list[1]}`;
  }
  const head = list.slice(0, -1).map((ext) => `{AESOP ID}.${ext}`).join(", ");
  return `${head}, or {AESOP ID}.${list[list.length - 1]}`;
}

module.exports = {
  DEFAULT_VOICE_MEMO_FILE_EXTENSIONS,
  DEFAULT_VOICE_MEMO_FILE_EXTENSIONS_CSV,
  parseVoiceMemoFileExtensions,
  formatVoiceMemoExtensionHint,
};
