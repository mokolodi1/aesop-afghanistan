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
 * Usage: npm run sync:classroom
 */

require("../config/secrets");
const { runMigrations } = require("../db/migrate");
const { runClassroomSync } = require("../services/classroomSync");
const { formatErrorForLog } = require("../utils/errorLogging");
const { isDatabaseEnabled } = require("../db/index");

async function main() {
  if (isDatabaseEnabled()) {
    await runMigrations();
  } else {
    console.warn("[sync:classroom] DATABASE_URL not set; skipping DB migrate/persist.");
  }
  return runClassroomSync();
}

main()
  .then((summary) => {
    console.log(
      `Classroom sync complete: ${summary.courses} course(s), ${summary.teachers} teacher(s), ` +
        `${summary.students} student(s), ${summary.gradeRows} grade row(s) written.`,
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error("Classroom sync failed:", formatErrorForLog(err));
    process.exit(1);
  });
