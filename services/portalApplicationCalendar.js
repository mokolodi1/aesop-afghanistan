/** @typedef {{ processKey: string, process: string, date: string }} PortalApplicationCalendarEntryDef */

/** @type {PortalApplicationCalendarEntryDef[]} */
const PORTAL_APPLICATION_CALENDAR_ENTRY_DEFS = [
  {
    processKey: "calendar.event.signalVoice",
    process: "Signal voice messages (students send in)",
    date: "Saturday, June 27, 2026",
  },
  {
    processKey: "calendar.event.manualReview",
    process: "Manual review (of signal + essay)",
    date: "Saturday, July 11, 2026",
  },
  {
    processKey: "calendar.event.interviews",
    process: "Interviews",
    date: "Saturday, July 18, 2026",
  },
  {
    processKey: "calendar.event.decisions",
    process: "Decisions",
    date: "Saturday, August 8, 2026",
  },
  {
    processKey: "calendar.event.studentsAdmitted",
    process: "Students admitted",
    date: "Saturday, August 15, 2026",
  },
  {
    processKey: "calendar.event.openingCeremony",
    process: "Opening Ceremony",
    date: "Tuesday, September 8, 2026",
  },
  {
    processKey: "calendar.event.classesStart",
    process: "Classes start",
    date: "Wednesday, September 9, 2026",
  },
  {
    processKey: "calendar.event.classesEnd",
    process: "Classes end",
    date: "Wednesday, December 16, 2026",
  },
];

/**
 * Hard-coded application calendar shown to Round 1 accepted applicants.
 * @returns {{ sheetName: string, entries: Array<{ process: string, date: string }> }}
 */
function getPortalApplicationCalendar() {
  return {
    sheetName: "Application Calendar",
    entries: PORTAL_APPLICATION_CALENDAR_ENTRY_DEFS.map(({ process, date }) => ({ process, date })),
  };
}

module.exports = {
  PORTAL_APPLICATION_CALENDAR_ENTRY_DEFS,
  getPortalApplicationCalendar,
};
