/**
 * Shared TTL for Postgres mirror reads (People, Applicants, Classroom).
 *
 * Env (first match wins for max age):
 *   MIRROR_CACHE_TTL_HOURS=1
 *   MIRROR_CACHE_MAX_AGE_MS=3600000
 *   PORTAL_MIRROR_MAX_AGE_MS=3600000  (legacy alias)
 */
const DEFAULT_MIRROR_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

function getMirrorCacheMaxAgeMs() {
  const hoursRaw = process.env.MIRROR_CACHE_TTL_HOURS;
  if (hoursRaw != null && String(hoursRaw).trim() !== "") {
    const hours = Number.parseFloat(String(hoursRaw).trim());
    if (Number.isFinite(hours) && hours > 0) {
      return Math.round(hours * 60 * 60 * 1000);
    }
  }

  const msRaw = process.env.MIRROR_CACHE_MAX_AGE_MS ?? process.env.PORTAL_MIRROR_MAX_AGE_MS;
  if (msRaw != null && String(msRaw).trim() !== "") {
    const parsed = Number.parseInt(String(msRaw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_MIRROR_CACHE_MAX_AGE_MS;
}

/**
 * @param {Date|string|null|undefined} syncedAt
 * @returns {number|null} age in ms, or null when timestamp missing/invalid
 */
function getMirrorCacheAgeMs(syncedAt) {
  if (!syncedAt) {
    return null;
  }
  const at = syncedAt instanceof Date ? syncedAt : new Date(syncedAt);
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  return Date.now() - at.getTime();
}

/**
 * @param {Date|string|null|undefined} syncedAt
 * @param {number} [maxAgeMs]
 * @returns {boolean}
 */
function isMirrorTimestampFresh(syncedAt, maxAgeMs = getMirrorCacheMaxAgeMs()) {
  const ageMs = getMirrorCacheAgeMs(syncedAt);
  if (ageMs == null) {
    return false;
  }
  return ageMs <= maxAgeMs;
}

/**
 * @param {Date|string|null|undefined} syncedAt
 * @returns {{ fresh: boolean, ageMs: number|null, maxAgeMs: number }}
 */
function describeMirrorTimestamp(syncedAt) {
  const maxAgeMs = getMirrorCacheMaxAgeMs();
  const ageMs = getMirrorCacheAgeMs(syncedAt);
  return {
    fresh: ageMs != null && ageMs <= maxAgeMs,
    ageMs,
    maxAgeMs,
  };
}

module.exports = {
  DEFAULT_MIRROR_CACHE_MAX_AGE_MS,
  getMirrorCacheMaxAgeMs,
  getMirrorCacheAgeMs,
  isMirrorTimestampFresh,
  describeMirrorTimestamp,
};
