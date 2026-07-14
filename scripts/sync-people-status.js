#!/usr/bin/env node
/**
 * Legacy no-op: People Status column is no longer used.
 *
 * Status is derived from Classroom Roles/Grades, the Applicants sheet, and
 * 262-prefix AESOP IDs during people mirror / portal role resolution.
 * Re-enable sheet writes only by setting GOOGLE_PEOPLE_STATUS_COLUMN to a
 * column letter, then use syncPeopleStatusOnPeopleSheet.
 */
const { isPeopleStatusSyncEnabled, syncPeopleStatusOnPeopleSheet, loadClassroomRoleEmailSetsFromSheets } = require("../services/googleSheets");

async function main() {
  if (!isPeopleStatusSyncEnabled()) {
    console.log(
      "[sync-people-status] People Status column is OFF — status is derived from Classroom + Applicants. Nothing to write.",
    );
    return;
  }
  const { teacherEmails, studentEmails } = await loadClassroomRoleEmailSetsFromSheets();
  console.log(
    `[sync-people-status] teachers=${teacherEmails.size} students=${studentEmails.size}`,
  );
  const result = await syncPeopleStatusOnPeopleSheet({ teacherEmails, studentEmails });
  console.log(`[sync-people-status] updated=${result.updated} skipped=${result.skipped}`);
}

main().catch((error) => {
  console.error("[sync-people-status] failed:", error.message);
  process.exit(1);
});
