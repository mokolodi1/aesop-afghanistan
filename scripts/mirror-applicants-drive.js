#!/usr/bin/env node
/**
 * Mirror People + Applicants sheet + Google Drive voice memo metadata into Postgres.
 * Does NOT run Classroom sync or Ding mirror — use this to test applicant portal DB reads.
 *
 * Usage: npm run mirror:applicants-drive
 */
require("../config/secrets");
const { runMigrations } = require("../db/migrate");
const { mirrorPeopleAndApplicantsFromSheets } = require("../services/peopleMirror");
const { getMirrorCacheMaxAgeMs } = require("../services/mirrorCache");
const { getPool, isDatabaseEnabled, closeDatabase } = require("../db/index");

async function printMirrorStats() {
  const pool = getPool();
  if (!pool) {
    return;
  }
  const maxAgeMs = getMirrorCacheMaxAgeMs();
  const stats = await pool.query(
    `SELECT
      COUNT(*)::int AS applicant_rows,
      COUNT(*) FILTER (WHERE drive_file_id IS NOT NULL AND trim(drive_file_id) <> '')::int AS with_drive_file,
      COUNT(*) FILTER (
        WHERE synced_at IS NOT NULL
          AND synced_at > NOW() - ($1::bigint * INTERVAL '1 millisecond')
      )::int AS applicant_rows_fresh
    FROM applicants`,
    [maxAgeMs],
  );
  const row = stats.rows[0] || {};
  console.log(
    `[mirror-applicants-drive] postgres snapshot: applicant_rows=${row.applicant_rows ?? 0}, with_drive_file=${row.with_drive_file ?? 0}, fresh_applicant_rows=${row.applicant_rows_fresh ?? 0}`,
  );
}

async function main() {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL is not set. Configure database.url or DATABASE_URL.");
    process.exit(1);
  }

  await runMigrations();
  const result = await mirrorPeopleAndApplicantsFromSheets();
  await printMirrorStats();
  console.log("[mirror-applicants-drive] done:", result);
}

main()
  .catch((error) => {
    console.error("[mirror-applicants-drive] failed:", error.message);
    process.exit(1);
  })
  .finally(() => closeDatabase());
