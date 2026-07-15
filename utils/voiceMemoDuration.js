const VOICE_MEMO_MIN_DURATION_SEC = 30;
const VOICE_MEMO_MAX_DURATION_SEC = 120;
/** Sheet / stats value written for recordings longer than the allowed max. */
const VOICE_MEMO_OVERACHIEVE_SHEET_SECONDS = 300;

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
 * Value to store in the Applicants sheet (and matching Postgres cache) for a
 * measured duration. Over-max recordings are written as 300 so length checks
 * do not expose the true length.
 * @param {number|null|undefined} seconds
 * @param {{ minSeconds?: number, maxSeconds?: number }} [limits]
 * @returns {number|null}
 */
function sheetVoiceMemoLengthSeconds(seconds, limits = {}) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const rounded = Math.round(seconds);
  // Sub-second probes round to 0; never persist that as a real length.
  if (rounded <= 0) {
    return null;
  }
  if (classifyVoiceMemoDuration(rounded, limits) === "too_long") {
    return VOICE_MEMO_OVERACHIEVE_SHEET_SECONDS;
  }
  return rounded;
}

/**
 * Cached Drive/sheet lengths of 0 came from bad mislabeled-file probes and should
 * be recomputed instead of reused.
 * @param {number|null|undefined} seconds
 * @returns {boolean}
 */
function isTrustedVoiceMemoCachedDurationSeconds(seconds) {
  return seconds != null && Number.isFinite(seconds) && seconds > 0;
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
    return `Your voice memo is shorter than ${minSeconds} seconds. Please record again and resubmit a memo between ${minSeconds} seconds and ${Math.floor(maxSeconds / 60)} minutes. Applications with voice memos shorter than ${minSeconds} seconds will be rejected automatically.`;
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

/**
 * Browser-measured durations can differ slightly from server probes; only treat
 * larger gaps as a cache mismatch worth correcting.
 */
const VOICE_MEMO_DURATION_MISMATCH_SECONDS = 2;

/**
 * @param {number|null|undefined} cachedSeconds
 * @param {number|null|undefined} measuredSeconds
 * @returns {boolean}
 */
function voiceMemoDurationsDiffer(cachedSeconds, measuredSeconds) {
  if (cachedSeconds == null || measuredSeconds == null) {
    return false;
  }
  if (!Number.isFinite(cachedSeconds) || !Number.isFinite(measuredSeconds)) {
    return false;
  }
  return Math.abs(cachedSeconds - measuredSeconds) >= VOICE_MEMO_DURATION_MISMATCH_SECONDS;
}

module.exports = {
  VOICE_MEMO_MIN_DURATION_SEC,
  VOICE_MEMO_MAX_DURATION_SEC,
  VOICE_MEMO_OVERACHIEVE_SHEET_SECONDS,
  VOICE_MEMO_DURATION_MISMATCH_SECONDS,
  classifyVoiceMemoDuration,
  sheetVoiceMemoLengthSeconds,
  voiceMemoDurationWarning,
  formatVoiceMemoDurationLabel,
  voiceMemoDurationsDiffer,
  isTrustedVoiceMemoCachedDurationSeconds,
};
