#!/usr/bin/env node
/**
 * Refresh the Postgres hourly cache from Google Sheets + Drive.
 *
 * Always mirrors:
 *   - People tab (roles, IDs, emails)
 *   - Ding numbers + ding change history
 *   - Applicants tab
 *   - Google Drive voice memo metadata (file id, name, duration)
 *
 * Optionally mirrors Google Classroom (heavy) when HOURLY_CACHE_INCLUDE_CLASSROOM=true.
 *
 * Schedule on Fly:
 *   bash scripts/schedule-hourly-cache.sh
 *
 * Local:
 *   npm run sync:hourly-cache
 */
require("../config/secrets");
const { runMigrations } = require("../db/migrate");
const { formatErrorForLog } = require("../utils/errorLogging");
const { isDatabaseEnabled, closeDatabase } = require("../db/index");
const { getMirrorCacheMaxAgeMs } = require("../services/mirrorCache");
const { refreshPortalCaches } = require("../services/portalCacheRefresh");
const { getPool } = require("../db/index");

function includeClassroomSync() {
  const raw = process.env.HOURLY_CACHE_INCLUDE_CLASSROOM;
  if (raw == null || String(raw).trim() === "") {
    return false;
  }
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function printApplicantsDriveStats() {
  const pool = getPool();
  if (!pool) {
    return;
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
  console.log(
    `[sync-hourly-cache] applicants/drive: rows=${row.applicant_rows ?? 0}, ` +
      `with_drive_file=${row.with_drive_file ?? 0}, fresh=${row.applicant_rows_fresh ?? 0}`,
  );
}

async function main() {
  const maxAgeMs = getMirrorCacheMaxAgeMs();
  const withClassroom = includeClassroomSync();
  console.log(
    `[sync-hourly-cache] TTL ${Math.round(maxAgeMs / 60000)} min; includeClassroom=${withClassroom}`,
  );

  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not set.");
  }

  await runMigrations();

  const result = await refreshPortalCaches({ includeClassroom: withClassroom });
  if (result.mirror) {
    console.log("[sync-hourly-cache] mirror result:", result.mirror);
  }
  if (result.classroom) {
    const s = result.classroom;
    console.log(
      `[sync-hourly-cache] classroom: ${s.courses} course(s), ${s.teachers} teacher(s), ` +
        `${s.students} student(s), ${s.gradeRows} grade row(s).`,
    );
  }
  await printApplicantsDriveStats();

  return result;
}

main()
  .then(() => {
    console.log("[sync-hourly-cache] done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[sync-hourly-cache] failed:", formatErrorForLog(err));
    process.exit(1);
  })
  .finally(() => closeDatabase());
