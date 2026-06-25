const { DateTime } = require('luxon');

/** US Eastern — portal + Ding notes use this zone (handles EST/EDT). Bundled TZ data avoids Alpine `Intl` gaps. */
const DING_CHANGE_DISPLAY_TIMEZONE = 'America/New_York';

/**
 * Ding timestamp cells sometimes arrive as plain text `M/D/YYYY H:mm:ss` with **no timezone**.
 * Those strings match the **UTC civil clock** implied by Excel/Google serial math (`dateToGoogleSheetsSerial`).
 * Never parse them as America/New_York — that shifts EDT rows by ~4 hours (e.g. “17:41” becomes 5:41 PM EDT instead of 1:41 PM EDT).
 *
 * @param {string} raw
 * @returns {number | null}
 */
function sheetSlashDatetimeAsUtcMillis(raw) {
  const trimmed = String(raw).trim();
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const da = Number(m[2]);
  const yr = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = Number(m[6]);
  if (![mo, da, yr, hh, mi, ss].every((n) => Number.isFinite(n))) return null;
  const t = Date.UTC(yr, mo - 1, da, hh, mi, ss);
  return Number.isFinite(t) ? t : null;
}

/**
 * Parse formatted Ding timestamp strings from Sheets into UTC milliseconds.
 *
 * Both shapes below follow **UTC civil clock** — same convention as numeric serial (`dateToGoogleSheetsSerial`).
 * Many spreadsheets use **display timezone UTC**, so column B reads like `… 6:38 PM` meaning **18:38 UTC**, which is **~2:38 PM EDT** for students.
 * Parsing AM/PM text as `America/New_York` would wrongly treat “6:38 PM” as Eastern wall-clock (~4h skew vs portal).
 *
 * - **`M/D/YYYY H:mm:ss`** (24-hour): UTC civil.
 * - **`M/D/YYYY h:mm:ss AM/PM`** (12-hour): UTC civil (`Luxon` `zone: 'utc'`).
 *
 * **Sheet UI vs portal:** To show **Eastern wall-clock** in Google Sheets (e.g. `2:38 PM` instead of `6:38 PM` for the same instant), set the spreadsheet **File → Settings → Time zone** to **`(GMT-05:00) Eastern Time`** — not fixable purely in parsing here.
 *
 * @param {string} raw
 * @returns {number | null}
 */
function sheetDatetimeCellTextToUtcMillis(raw) {
  const normalized = String(raw)
    .trim()
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const slashMs = sheetSlashDatetimeAsUtcMillis(normalized);
  if (slashMs != null) return slashMs;

  const twelveHourFormats = ['M/d/yyyy h:mm:ss a', 'M/d/yyyy h:mm:ssa', 'MM/dd/yyyy h:mm:ss a'];
  for (const fmt of twelveHourFormats) {
    const dt = DateTime.fromFormat(normalized, fmt, { zone: 'utc', locale: 'en-US' });
    if (dt.isValid) {
      return dt.toMillis();
    }
  }

  return null;
}

/**
 * Ding timestamps for portal UI + spreadsheet notes:
 * US Eastern civil time with **12-hour clock + zone** (e.g. `5/19/2026 4:16:48 PM EDT`).
 * Same instant as column B date cells; Luxon avoids Alpine `Intl` gaps.
 */
function formatDingChangeTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return '—';
  }
  return DateTime.fromMillis(d.getTime())
    .setZone(DING_CHANGE_DISPLAY_TIMEZONE)
    .toFormat('M/d/yyyy h:mm:ss a ZZZZ');
}

/** People Last Login column: Eastern wall-clock text (e.g. `6/23/2026, 2:15:30 PM EDT`). */
function formatEasternSheetTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return DateTime.fromMillis(d.getTime())
    .setZone(DING_CHANGE_DISPLAY_TIMEZONE)
    .toFormat('M/d/yyyy, h:mm:ss a ZZZZ');
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

module.exports = {
  formatDingChangeTimestamp,
  formatEasternSheetTimestamp,
  dateToGoogleSheetsSerial,
  sheetDatetimeCellTextToUtcMillis,
  sheetSlashDatetimeAsUtcMillis,
  DING_CHANGE_DISPLAY_TIMEZONE,
};
