/**
 * @param {unknown} error
 * @returns {number|null}
 */
function driveErrorStatus(error) {
  const status = Number(error?.response?.status ?? error?.code);
  return Number.isFinite(status) ? status : null;
}

/**
 * Google signals throttling as HTTP 429, or as HTTP 403 with a rate-limit reason.
 * @param {unknown} error
 * @returns {boolean}
 */
function isDriveThrottleError(error) {
  const status = driveErrorStatus(error);
  if (status === 429) {
    return true;
  }
  if (status === 403) {
    const reasons = error?.errors || error?.response?.data?.error?.errors || [];
    return (Array.isArray(reasons) ? reasons : []).some((entry) =>
      String(entry?.reason || "").toLowerCase().includes("ratelimit"),
    );
  }
  return false;
}

module.exports = {
  driveErrorStatus,
  isDriveThrottleError,
};
