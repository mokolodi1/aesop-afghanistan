/** @typedef {{ processKey: string, process: string, date: string }} PortalApplicationCalendarEntryDef */

/** @type {PortalApplicationCalendarEntryDef[]} */
const PORTAL_APPLICATION_CALENDAR_ENTRY_DEFS = [
  {
    processKey: "calendar.event.voiceNoteDeadline",
    process: "Round 2 voice note submission deadline (11:59 pm)",
    date: "Wednesday, July 15, 2026",
  },
  {
    processKey: "calendar.event.round2Results",
    process: "Round 2 Results Shared",
    date: "Friday, July 24, 2026",
  },
  {
    processKey: "calendar.event.interviewStart",
    process: "Interview start",
    date: "Saturday, July 25, 2026",
  },
  {
    processKey: "calendar.event.interviewEnd",
    process: "Interview end",
    date: "Monday, August 10, 2026",
  },
  {
    processKey: "calendar.event.round3Decision",
    process: "Final Round 3 Admission Decision Shared",
    date: "Monday, August 17, 2026",
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
