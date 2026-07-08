#!/usr/bin/env node
/**
 * Pull roles and grades from Google Classroom and rewrite the email-keyed
 * "Classroom Roles" and "Classroom Grades" tabs in the configured Google Sheet.
 *
 * Uses the Gmail service-account credentials with domain-wide delegation,
 * impersonating classroom.impersonateEmail (CLASSROOM_IMPERSONATE_EMAIL).
 * Requires classroom.enabled (CLASSROOM_SYNC_ENABLED=true).
 *
 * Requires local config/secrets.json or SECRETS_JSON / env matching production.
 *
 * People tab data is mirrored separately (npm run sync:hourly-cache). Classroom sync
 * only attaches rosters/grades to people rows that already exist from that mirror.
 * Ding change history is mirrored here once daily (not in the hourly cache job).
 *
 * Usage: npm run sync:classroom
 */

require("../config/secrets");
const { runMigrations } = require("../db/migrate");
const { runClassroomSync } = require("../services/classroomSync");
const { mirrorDingHistoryFromSheets } = require("../services/peopleMirror");
const { loadApplicantAesopIdSetFromSheets } = require("../services/voiceMemoSync");
const { formatErrorForLog } = require("../utils/errorLogging");
const { isDatabaseEnabled, closeDatabase } = require("../db/index");

async function main() {
  if (isDatabaseEnabled()) {
    await runMigrations();
  } else {
    console.warn("[sync:classroom] DATABASE_URL not set; skipping DB migrate/persist.");
  }

  const classroomSummary = await runClassroomSync();

  let dingHistory = { mirrored: 0 };
  if (isDatabaseEnabled()) {
    try {
      const applicantIdSet = await loadApplicantAesopIdSetFromSheets();
      dingHistory = await mirrorDingHistoryFromSheets({}, applicantIdSet);
      console.log(`[sync:classroom] ding change history mirrored: ${dingHistory.mirrored} row(s).`);
    } catch (error) {
      console.warn("[sync:classroom] ding change history mirror failed:", error.message);
    }
  }

  return { classroom: classroomSummary, dingHistory };
}

main()
  .then(({ classroom: summary }) => {
    console.log(
      `Classroom sync complete: ${summary.courses} course(s), ${summary.teachers} teacher(s), ` +
        `${summary.students} student(s), ${summary.gradeRows} grade row(s) written.`,
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error("Classroom sync failed:", formatErrorForLog(err));
    process.exit(1);
  })
  .finally(() => closeDatabase());
