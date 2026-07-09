/**
 * @typedef {Object} PortalApplicationCalendarEntryDef
 * @property {string} processKey - i18n key for the process label
 * @property {string} process - English fallback label
 * @property {string} date - Human-readable date (English)
 * @property {string} [noteKey] - i18n key for a static "more info" note
 * @property {string} [note] - English fallback for the static note
 * @property {string} [dynamicNote] - Marker for a note computed at render time
 */

/** @type {PortalApplicationCalendarEntryDef[]} */
const PORTAL_APPLICATION_CALENDAR_ENTRY_DEFS = [
  {
    processKey: "calendar.event.round2VoiceDeadline",
    process: "Round 2 voice note submission deadline (11:59 pm)",
    date: "Wednesday, July 15, 2026",
    dynamicNote: "voiceCompleted",
  },
  {
    processKey: "calendar.event.round2Results",
    process: "Round 2 Results Shared by Email",
    date: "Friday, July 24, 2026",
    noteKey: "calendar.note.round2Results",
    note: "we will share more information about Round 3 Interviews if you are selected.",
  },
  {
    processKey: "calendar.event.round3InterviewsBegin",
    process: "Round 3 Interviews Begin",
    date: "Saturday, July 25, 2026",
  },
  {
    processKey: "calendar.event.round3InterviewsEnd",
    process: "Round 3 Interviews End",
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
