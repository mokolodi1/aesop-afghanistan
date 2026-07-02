const { translatePortalText } = require('./portalI18n.js');

/** @typedef {{ processKey: string, date: string }} PortalCalendarEntryDef */

/** @type {PortalCalendarEntryDef[]} */
const PORTAL_APPLICATION_CALENDAR_ENTRIES = [
  { processKey: 'calendar.event.signalVoice', date: 'Saturday, June 27, 2026' },
  { processKey: 'calendar.event.manualReview', date: 'Saturday, July 11, 2026' },
  { processKey: 'calendar.event.interviews', date: 'Saturday, July 18, 2026' },
  { processKey: 'calendar.event.decisions', date: 'Saturday, August 8, 2026' },
  { processKey: 'calendar.event.studentsAdmitted', date: 'Saturday, August 15, 2026' },
  { processKey: 'calendar.event.openingCeremony', date: 'Tuesday, September 8, 2026' },
  { processKey: 'calendar.event.classesStart', date: 'Wednesday, September 9, 2026' },
  { processKey: 'calendar.event.classesEnd', date: 'Wednesday, December 16, 2026' },
];

/**
 * @param {'en'|'fa'} locale
 * @returns {Array<{ process: string, date: string }>}
 */
function getPortalApplicationCalendarEntries(locale) {
  return PORTAL_APPLICATION_CALENDAR_ENTRIES.map(({ processKey, date }) => ({
    process: translatePortalText(locale, processKey),
    date,
  }));
}

module.exports = {
  getPortalApplicationCalendarEntries,
};
