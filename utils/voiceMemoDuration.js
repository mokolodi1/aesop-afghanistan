const VOICE_MEMO_MIN_DURATION_SEC = 30;
const VOICE_MEMO_MAX_DURATION_SEC = 120;

/**
 * @param {number|null|undefined} seconds
 * @param {{ minSeconds?: number, maxSeconds?: number }} [limits]
 * @returns {'valid'|'too_short'|'too_long'|'unknown'}
 */
function classifyVoiceMemoDuration(seconds, limits = {}) {
  const minSeconds = limits.minSeconds ?? VOICE_MEMO_MIN_DURATION_SEC;
  const maxSeconds = limits.maxSeconds ?? VOICE_MEMO_MAX_DURATION_SEC;
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return "unknown";
  }
  if (seconds < minSeconds) {
    return "too_short";
  }
  if (seconds > maxSeconds) {
    return "too_long";
  }
  return "valid";
}

/**
 * @param {'valid'|'too_short'|'too_long'|'unknown'} status
 * @param {{ minSeconds?: number, maxSeconds?: number }} [limits]
 * @returns {string|null}
 */
function voiceMemoDurationWarning(status, limits = {}) {
  const minSeconds = limits.minSeconds ?? VOICE_MEMO_MIN_DURATION_SEC;
  const maxSeconds = limits.maxSeconds ?? VOICE_MEMO_MAX_DURATION_SEC;
  if (status === "too_short") {
    return `Your voice memo is shorter than ${minSeconds} seconds. Please record again and resubmit a memo between ${minSeconds} seconds and ${Math.floor(maxSeconds / 60)} minutes. Applications with voice memos shorter than ${minSeconds} seconds will be rejected immediately.`;
  }
  if (status === "too_long") {
    return `Your voice memo is longer than ${Math.floor(maxSeconds / 60)} minutes. Please record again and resubmit a memo between ${minSeconds} seconds and ${Math.floor(maxSeconds / 60)} minutes.`;
  }
  return null;
}

/**
 * @param {number|null|undefined} seconds
 * @returns {string|null}
 */
function formatVoiceMemoDurationLabel(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes > 0) {
    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }
  return `${secs} sec`;
}

module.exports = {
  VOICE_MEMO_MIN_DURATION_SEC,
  VOICE_MEMO_MAX_DURATION_SEC,
  classifyVoiceMemoDuration,
  voiceMemoDurationWarning,
  formatVoiceMemoDurationLabel,
};
