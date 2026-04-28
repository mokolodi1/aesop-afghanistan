/**
 * Format a wall-clock time for the Ding changes sheet (column B), e.g. "4/25/2026 12:01:00".
 * Uses DING_CHANGE_TIMEZONE when set (IANA), otherwise the process default timezone.
 * @param {Date} [date]
 * @returns {string}
 */
function formatDingChangeTimestamp(date = new Date()) {
  const options = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  };
  if (process.env.DING_CHANGE_TIMEZONE) {
    options.timeZone = process.env.DING_CHANGE_TIMEZONE;
  }
  const dtf = new Intl.DateTimeFormat('en-US', options);
  const parts = dtf.formatToParts(date);
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : '';
  };
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);
  const year = get('year');
  const hour = get('hour').padStart(2, '0');
  const minute = get('minute').padStart(2, '0');
  const second = get('second').padStart(2, '0');
  return `${month}/${day}/${year} ${hour}:${minute}:${second}`;
}

module.exports = { formatDingChangeTimestamp };
