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
      "Mirrors the People tab, current Ding numbers, Applicants, ApplicantReviews, and " +
      "Drive voice memo metadata from Google Sheets and Drive into the Postgres cache.",
    schedule: "Every hour 1:30–4:30 AM Afghanistan time",
    // Shares the cron VM with voice-memo-sync; both download Drive media.
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
      const result = await refreshPortalCaches({ includeClassroom });
      if (result.mirror) {
        console.log("[hourly-cache] mirror result:", result.mirror);
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
    schedule: "Daily at 2:00 AM Afghanistan time",
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

  /**
   * Google Drive voice memos → Applicants sheet (Round 2, link, date, length).
   */
  "voice-memo-sync": {
    label: "Voice memo sync",
    description:
      "Checks Google Drive for applicant voice notes and updates the Applicants sheet: " +
      "Round 2, voice note link, last updated, and memo length.",
    schedule: "Daily at 4:00 AM Afghanistan time",
    // Shares the cron VM with hourly-cache; both download Drive media.
    exclusiveGroup: "driveHeavy",
    async run() {
      const { syncVoiceMemoRound2Status } = require("./voiceMemoSync");
      const result = await syncVoiceMemoRound2Status();
      console.log(
        `[voice-memo-sync] updated=${result.updated} upToDate=${result.skippedUpToDate} ` +
          `noFile=${result.skippedNoFile} notAccepted=${result.skippedNotAccepted} ` +
          `noId=${result.skippedNoId} driveFiles=${result.driveFileCount}`,
      );
      return result;
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
 * Jobs that must not run concurrently with `jobName` on the same machine
 * (same job, or others in the same exclusiveGroup).
 * @param {string} jobName
 * @returns {string[]}
 */
function getConflictingJobNames(jobName) {
  const definition = getJobDefinition(jobName);
  if (!definition) {
    return [jobName].filter(Boolean);
  }
  const group = definition.exclusiveGroup;
  if (!group) {
    return [jobName];
  }
  return Object.entries(JOB_DEFINITIONS)
    .filter(([, def]) => def.exclusiveGroup === group)
    .map(([name]) => name);
}

module.exports = {
  listJobDefinitions,
  getJobDefinition,
  getConflictingJobNames,
};
