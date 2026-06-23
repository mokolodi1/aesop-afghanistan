#!/usr/bin/env node
/**
 * Populate People column X (Status) from Classroom Roles/Grades + 262 applicant IDs.
 * Teaching | Admitted | Applied
 */
const {
  loadClassroomRoleEmailSetsFromSheets,
  syncPeopleStatusOnPeopleSheet,
} = require("../services/googleSheets");

async function main() {
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
