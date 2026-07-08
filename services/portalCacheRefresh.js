const config = require("../config/secrets");
const { isDatabaseEnabled } = require("../db/index");
const { getMirrorCacheStatus } = require("./classroomDb");
const { mirrorPeopleAndDingFromSheets } = require("./peopleMirror");
const { runClassroomSync } = require("./classroomSync");

/**
 * Refresh Postgres mirror caches from Google Sheets, Drive, and optionally Classroom.
 *
 * When Classroom sync is enabled and included, it runs the full Classroom pull
 * (which also re-mirrors People/Ding at the end). Otherwise only the hourly
 * People/Ding/Applicants/Drive mirror runs.
 *
 * @param {{ includeClassroom?: boolean }} [options]
 * @returns {Promise<{
 *   mirror: { people: number, dingNumbers: number, dingHistory: number, applicants: number, driveFiles: number }|null,
 *   classroom: { courses: number, teachers: number, students: number, gradeRows: number }|null,
 *   mirrorCache: Awaited<ReturnType<typeof getMirrorCacheStatus>>,
 *   includeClassroom: boolean,
 * }>}
 */
async function refreshPortalCaches(options = {}) {
  if (!isDatabaseEnabled()) {
    const error = new Error("DATABASE_URL is not set. Portal cache requires Postgres.");
    error.statusCode = 503;
    throw error;
  }

  const includeClassroom =
    options.includeClassroom !== false && !!config.classroom?.enabled;

  let mirror = null;
  let classroom = null;

  if (includeClassroom) {
    classroom = await runClassroomSync();
  } else {
    mirror = await mirrorPeopleAndDingFromSheets();
  }

  const mirrorCache = await getMirrorCacheStatus();
  return { mirror, classroom, mirrorCache, includeClassroom };
}

module.exports = {
  refreshPortalCaches,
};
