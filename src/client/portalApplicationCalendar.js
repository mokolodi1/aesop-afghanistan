const { translatePortalText } = require('./portalI18n.js');
const {
  PORTAL_APPLICATION_CALENDAR_ENTRY_DEFS,
} = require('../../services/portalApplicationCalendar.js');

/**
 * @param {'en'|'fa'} locale
 * @returns {Array<{ process: string, date: string, note: string, dynamicNote: string }>}
 */
function getPortalApplicationCalendarEntries(locale) {
  return PORTAL_APPLICATION_CALENDAR_ENTRY_DEFS.map(({ processKey, process, date, noteKey, note, dynamicNote }) => ({
    process: translatePortalText(locale, processKey) || process,
    date,
    note: noteKey ? translatePortalText(locale, noteKey) || note || '' : note || '',
    dynamicNote: dynamicNote || '',
  }));
}

module.exports = {
  getPortalApplicationCalendarEntries,
};
