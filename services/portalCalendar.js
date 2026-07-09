const {
  findProfileById,
  isAppliedPeopleStatus,
  resolvePeopleStatus,
} = require("./googleSheets");
const { getPortalApplicationCalendar } = require("./portalApplicationCalendar");
const { getApplicantRowByAesopId } = require("./voiceMemoSync");

/**
 * @param {string} email
 * @returns {string}
 */
function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/**
 * @param {{ userId: string, email: string }} params
 * @returns {Promise<{ id: string, email: string, name: string, peopleStatus?: string }|null>}
 */
async function verifyPortalCalendarSession({ userId, email }) {
  const idKey = String(userId || "").trim();
  const emailKey = normalizeEmail(email);
  if (!idKey || !emailKey) {
    return null;
  }

  const profile = await findProfileById(idKey);
  if (!profile) {
    return null;
  }

  if (normalizeEmail(profile.email) !== emailKey) {
    return null;
  }

  return profile;
}

/**
 * @param {{ userId: string, email: string }} params
 * @returns {Promise<{ eligible: false }|{ eligible: true, sheetName: string, entries: Array<{ process: string, date: string }> }>}
 */
async function getPortalCalendarForApplicant({ userId, email }) {
  const profile = await verifyPortalCalendarSession({ userId, email });
  if (!profile) {
    const error = new Error("Unable to load calendar. Please sign in again from the login link.");
    error.statusCode = 403;
    throw error;
  }

  const applicant = await getApplicantRowByAesopId(profile.id || userId);
  const peopleStatus = resolvePeopleStatus(profile.id || userId, profile.peopleStatus || "");
  const isApplicant = Boolean(applicant);
  const isApplied = isApplicant || isAppliedPeopleStatus(peopleStatus);

  if (!isApplied) {
    return { eligible: false };
  }

  const calendar = getPortalApplicationCalendar();
  return {
    eligible: true,
    sheetName: calendar.sheetName,
    entries: calendar.entries,
  };
}

module.exports = {
  getPortalCalendarForApplicant,
};
