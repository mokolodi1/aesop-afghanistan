/**
 * Format wall-clock time for portal notes / logs: exactly "M/D/YYYY HH:mm:ss"
 * (e.g. "5/1/2026 23:53:16"). Uses DING_CHANGE_TIMEZONE when set (IANA), else default TZ.
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
  const val = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : '';
  };
  const month = parseInt(val('month'), 10);
  const day = parseInt(val('day'), 10);
  const year = val('year').trim();
  const hour = parseInt(val('hour'), 10);
  const minute = parseInt(val('minute'), 10);
  const second = parseInt(val('second'), 10);
  if (
    !year ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return dtf.format(date).replace(/,\s*/, ' ');
  }
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(second).padStart(2, '0');
  return `${month}/${day}/${year} ${hh}:${mm}:${ss}`;
}

/**
 * Google Sheets date/time serial (Excel-compatible): whole + fractional days since 1899-12-30 UTC.
 * Store this in column B so the cell is a datetime value (apply Date time format in the sheet).
 * @param {Date} date
 * @returns {number}
 */
function dateToGoogleSheetsSerial(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return NaN;
  }
  return date.getTime() / 86400000 + 25569;
}

module.exports = { formatDingChangeTimestamp, dateToGoogleSheetsSerial };
