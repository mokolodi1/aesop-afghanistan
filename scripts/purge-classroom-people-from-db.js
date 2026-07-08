#!/usr/bin/env node
/**
 * Remove Google Classroom cache from Postgres and keep only People tab rows.
 *
 * - Deletes courses, enrollments, grades, assignments, sync_runs
 * - Deletes people rows whose email is not on the People sheet
 * - Clears teacher_classes on remaining people
 * - Re-mirrors people from the People sheet (unless --skip-remirror)
 *
 * Usage:
 *   node scripts/purge-classroom-people-from-db.js --dry-run
 *   node scripts/purge-classroom-people-from-db.js
 */
require("../config/secrets");
const { getPool, closeDatabase, isDatabaseEnabled } = require("../db/index");
const { loadEmailToPeopleProfileMap } = require("../services/googleSheets");
const { mirrorAllPeopleFromSheets } = require("../services/peopleMirror");

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_REMIRROR = process.argv.includes("--skip-remirror");

async function loadPeopleSheetEmails() {
  const profileMap = await loadEmailToPeopleProfileMap();
  const emails = new Set();
  for (const email of profileMap.keys()) {
    const key = String(email || "").trim().toLowerCase();
    if (key) {
      emails.add(key);
    }
  }
  return emails;
}

async function countTable(client, table) {
  const result = await client.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
  return result.rows[0].c;
}

async function purgeClassroomData(client, peopleSheetEmails) {
  const stats = {
    assignmentGrades: 0,
    assignments: 0,
    courseGrades: 0,
    courseEnrollments: 0,
    courses: 0,
    syncRuns: 0,
    peopleRemoved: 0,
    peopleKept: 0,
    teacherClassesCleared: 0,
  };

  const emailList = [...peopleSheetEmails];
  if (emailList.length === 0) {
    throw new Error("People sheet returned zero emails — aborting to avoid deleting all people.");
  }

  const peopleToRemove = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM people
     WHERE lower(trim(email)) NOT IN (SELECT unnest($1::text[]))`,
    [emailList],
  );
  stats.peopleRemoved = peopleToRemove.rows[0].c;

  const peopleToKeep = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM people
     WHERE lower(trim(email)) IN (SELECT unnest($1::text[]))`,
    [emailList],
  );
  stats.peopleKept = peopleToKeep.rows[0].c;

  const teacherClasses = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM people
     WHERE teacher_classes IS NOT NULL AND trim(teacher_classes) <> ''`,
  );
  stats.teacherClassesCleared = teacherClasses.rows[0].c;

  if (DRY_RUN) {
    stats.assignmentGrades = await countTable(client, "assignment_grades");
    stats.assignments = await countTable(client, "assignments");
    stats.courseGrades = await countTable(client, "course_grades");
    stats.courseEnrollments = await countTable(client, "course_enrollments");
    stats.courses = await countTable(client, "courses");
    stats.syncRuns = await countTable(client, "sync_runs");
    return stats;
  }

  await client.query(`DELETE FROM assignment_grades`);
  stats.assignmentGrades = (await client.query(`SELECT COUNT(*)::int AS c FROM assignment_grades`)).rows[0].c;

  await client.query(`DELETE FROM assignments`);
  stats.assignments = (await countTable(client, "assignments"));

  await client.query(`DELETE FROM course_grades`);
  stats.courseGrades = await countTable(client, "course_grades");

  await client.query(`DELETE FROM course_enrollments`);
  stats.courseEnrollments = await countTable(client, "course_enrollments");

  await client.query(`DELETE FROM courses`);
  stats.courses = await countTable(client, "courses");

  await client.query(`UPDATE ding_topups SET sync_run_id = NULL WHERE sync_run_id IS NOT NULL`);
  await client.query(`DELETE FROM sync_runs`);
  stats.syncRuns = await countTable(client, "sync_runs");

  await client.query(
    `DELETE FROM people
     WHERE lower(trim(email)) NOT IN (SELECT unnest($1::text[]))`,
    [emailList],
  );

  const cleared = await client.query(
    `UPDATE people
     SET teacher_classes = NULL
     WHERE teacher_classes IS NOT NULL AND trim(teacher_classes) <> ''`,
  );
  stats.teacherClassesCleared = cleared.rowCount;

  return stats;
}

async function main() {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not set.");
  }

  const peopleSheetEmails = await loadPeopleSheetEmails();
  console.log(`[purge-classroom-people] People sheet emails: ${peopleSheetEmails.size}`);

  const pool = getPool();
  const client = await pool.connect();

  try {
    if (!DRY_RUN) {
      await client.query("BEGIN");
    }

    const stats = await purgeClassroomData(client, peopleSheetEmails);
    console.log("[purge-classroom-people] result:", { ...stats, dryRun: DRY_RUN });

    if (!DRY_RUN) {
      await client.query("COMMIT");
    }
  } catch (error) {
    if (!DRY_RUN) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }

  if (!DRY_RUN && !SKIP_REMIRROR) {
    const mirrored = await mirrorAllPeopleFromSheets();
    console.log("[purge-classroom-people] re-mirrored from People sheet:", mirrored);
  }

  const pool2 = getPool();
  const summary = await pool2.query(
    `SELECT
       (SELECT COUNT(*)::int FROM people) AS people,
       (SELECT COUNT(*)::int FROM courses) AS courses,
       (SELECT COUNT(*)::int FROM course_enrollments) AS enrollments,
       (SELECT COUNT(*)::int FROM sync_runs) AS sync_runs`,
  );
  console.log("[purge-classroom-people] final counts:", summary.rows[0]);
}

main()
  .catch((error) => {
    console.error("[purge-classroom-people] failed:", error.message);
    process.exit(1);
  })
  .finally(() => closeDatabase());
