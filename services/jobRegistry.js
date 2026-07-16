/**
 * Registry of the sync jobs that run on the cron Machine.
 *
 * Single source of truth for job identity: the crontab schedules them
 * (via scripts/run-job.js), the admin portal's Jobs tab lists and triggers
 * them, and job_runs rows reference them by name.
 */
const { runMigrations } = require("../db/migrate");
const { isDatabaseEnabled, getPool } = require("../db/index");
const { getMirrorCacheMaxAgeMs } = require("./mirrorCache");

function envFlag(raw) {
  if (raw == null || String(raw).trim() === "") {
    return false;
  }
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function queryApplicantsDriveStats() {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const maxAgeMs = getMirrorCacheMaxAgeMs();
  const stats = await pool.query(
    `SELECT
       COUNT(*)::int AS applicant_rows,
       COUNT(*) FILTER (
         WHERE drive_file_id IS NOT NULL AND trim(drive_file_id) <> ''
       )::int AS with_drive_file,
       COUNT(*) FILTER (
         WHERE synced_at IS NOT NULL
           AND synced_at > NOW() - ($1::bigint * INTERVAL '1 millisecond')
       )::int AS applicant_rows_fresh
     FROM applicants`,
    [maxAgeMs],
  );
  const row = stats.rows[0] || {};
  return {
    rows: row.applicant_rows ?? 0,
    withDriveFile: row.with_drive_file ?? 0,
    fresh: row.applicant_rows_fresh ?? 0,
  };
}

async function queryApplicantReviewsStats() {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const maxAgeMs = getMirrorCacheMaxAgeMs();
  const stats = await pool.query(
    `SELECT
       COUNT(*)::int AS review_rows,
       COUNT(*) FILTER (
         WHERE synced_at IS NOT NULL
           AND synced_at > NOW() - ($1::bigint * INTERVAL '1 millisecond')
       )::int AS review_rows_fresh
     FROM applicant_reviews`,
    [maxAgeMs],
  );
  const row = stats.rows[0] || {};
  return { rows: row.review_rows ?? 0, fresh: row.review_rows_fresh ?? 0 };
}

const JOB_DEFINITIONS = {
  /**
   * Mirror People, current Ding numbers, Applicants, ApplicantReviews, and
   * Google Drive voice memo metadata into Postgres. Classroom is excluded
   * unless HOURLY_CACHE_INCLUDE_CLASSROOM=true (or payload.includeClassroom).
   */
  "hourly-cache": {
    label: "Hourly cache refresh",
    description:
      "Mirrors People, Ding numbers, Applicants, ApplicantReviews, and Drive metadata into Postgres, " +
      "then caches voice memo audio (Drive → Postgres only).",
    schedule: "Hourly on the hour (AFT), except 4:00 AM when classroom-sync runs",
    exclusiveGroup: "driveHeavy",
    async run(payload = {}) {
      const { refreshPortalCaches } = require("./portalCacheRefresh");

      if (!isDatabaseEnabled()) {
        throw new Error("DATABASE_URL is not set.");
      }
      const includeClassroom =
        payload.includeClassroom != null
          ? payload.includeClassroom === true
          : envFlag(process.env.HOURLY_CACHE_INCLUDE_CLASSROOM);
      const maxAgeMs = getMirrorCacheMaxAgeMs();
      console.log(
        `[hourly-cache] TTL ${Math.round(maxAgeMs / 60000)} min; includeClassroom=${includeClassroom}`,
      );

      await runMigrations();
      const result = await refreshPortalCaches({ includeClassroom, jobRunId: payload.jobRunId ?? null });
      if (result.mirror) {
        console.log("[hourly-cache] mirror result:", result.mirror);
        if (Array.isArray(result.mirror.partialFailures) && result.mirror.partialFailures.length > 0) {
          console.warn(
            `[hourly-cache] mirror left unchanged in Postgres: ${result.mirror.partialFailures.join(", ")}`,
          );
        }
      }
      if (result.classroom) {
        const s = result.classroom;
        console.log(
          `[hourly-cache] classroom: ${s.courses} course(s), ${s.teachers} teacher(s), ` +
            `${s.students} student(s), ${s.gradeRows} grade row(s).`,
        );
      }

      const applicantsDrive = await queryApplicantsDriveStats();
      if (applicantsDrive) {
        console.log(
          `[hourly-cache] applicants/drive: rows=${applicantsDrive.rows}, ` +
            `with_drive_file=${applicantsDrive.withDriveFile}, fresh=${applicantsDrive.fresh}`,
        );
      }
      const applicantReviews = await queryApplicantReviewsStats();
      if (applicantReviews) {
        console.log(
          `[hourly-cache] applicant_reviews: rows=${applicantReviews.rows}, fresh=${applicantReviews.fresh}`,
        );
      }

      return {
        mirror: result.mirror,
        classroom: result.classroom,
        includeClassroom: result.includeClassroom,
        applicantsDrive,
        applicantReviews,
      };
    },
  },

  /**
   * Full Google Classroom pull (rosters, grades, sheet dual-write, backup
   * export) plus the daily Ding change history mirror.
   */
  "classroom-sync": {
    label: "Classroom sync",
    description:
      "Pulls rosters and grades from Google Classroom, rewrites the Classroom Roles and " +
      "Classroom Grades tabs, and mirrors Ding change history. Requires Classroom sync " +
      "to be enabled.",
    schedule: "Daily at 4:00 AM Afghanistan time",
    async run() {
      const { runClassroomSync } = require("./classroomSync");
      const { mirrorDingHistoryFromSheets } = require("./peopleMirror");
      const { loadApplicantAesopIdSetFromSheets } = require("./voiceMemoSync");

      if (isDatabaseEnabled()) {
        await runMigrations();
      } else {
        console.warn("[classroom-sync] DATABASE_URL not set; skipping DB migrate/persist.");
      }

      const classroom = await runClassroomSync();
      console.log(
        `[classroom-sync] ${classroom.courses} course(s), ${classroom.teachers} teacher(s), ` +
          `${classroom.students} student(s), ${classroom.gradeRows} grade row(s) written.`,
      );

      let dingHistory = { mirrored: 0 };
      if (isDatabaseEnabled()) {
        try {
          const applicantIdSet = await loadApplicantAesopIdSetFromSheets();
          dingHistory = await mirrorDingHistoryFromSheets({}, applicantIdSet);
          console.log(`[classroom-sync] ding change history mirrored: ${dingHistory.mirrored} row(s).`);
        } catch (error) {
          console.warn("[classroom-sync] ding change history mirror failed:", error.message);
        }
      }

      return { classroom, dingHistory };
    },
  },
};

/** @returns {{ name: string, label: string, description: string, schedule: string, exclusiveGroup: string|null }[]} */
function listJobDefinitions() {
  return Object.entries(JOB_DEFINITIONS).map(([name, def]) => ({
    name,
    label: def.label,
    description: def.description,
    schedule: def.schedule,
    exclusiveGroup: def.exclusiveGroup || null,
  }));
}

/** @param {string} name */
function getJobDefinition(name) {
  return JOB_DEFINITIONS[name] || null;
}

/**
 * Job names to scan for an active run before starting `jobName`. The cron
 * machine runs one job at a time — any running job blocks every other job.
 * @param {string} jobName
 * @returns {string[]}
 */
function getConflictingJobNames(jobName) {
  void jobName;
  return Object.keys(JOB_DEFINITIONS);
}

module.exports = {
  listJobDefinitions,
  getJobDefinition,
  getConflictingJobNames,
};
