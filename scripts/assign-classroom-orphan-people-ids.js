#!/usr/bin/env node
/**
 * Add classroom-only people (NULL aesop_id in Postgres) to the People sheet with new AESOP IDs.
 *
 * Usage:
 *   node scripts/assign-classroom-orphan-people-ids.js           # apply changes
 *   node scripts/assign-classroom-orphan-people-ids.js --dry-run # preview only
 */
require("../config/secrets");
const fs = require("fs");
const path = require("path");
const config = require("../config/secrets");
const { getPool, closeDatabase, isDatabaseEnabled } = require("../db/index");
const {
  initGoogleSheets,
  resolveColumnIndex,
} = require("../services/googleSheets");
const { mirrorAllPeopleFromSheets } = require("../services/peopleMirror");

const DRY_RUN = process.argv.includes("--dry-run");
const ID_START = 2629999465n;
const BATCH_SIZE = 50;

function googleSheetPlainText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const s = String(value).replace(/\r?\n/g, " ").trim();
  if (s === "") {
    return "";
  }
  return `'${s.replace(/'/g, "''")}'`;
}

function buildIndexedRow(indexed) {
  const indices = Object.keys(indexed).map(Number);
  if (indices.length === 0) {
    return [];
  }
  const maxIdx = Math.max(...indices);
  const arr = new Array(maxIdx + 1).fill("");
  for (const [idx, value] of Object.entries(indexed)) {
    arr[Number(idx)] = value == null ? "" : String(value);
  }
  return arr;
}

function buildPeopleAppendRow({ aesopId, name, email, portalRole }) {
  const idIdx = resolveColumnIndex(config.googleSheets.idColumn || "B");
  const nameIdx = resolveColumnIndex(config.googleSheets.nameColumn || "C");
  const emailIdx = resolveColumnIndex(config.googleSheets.emailColumn || "D");
  const typeIdx = resolveColumnIndex(config.googleSheets.peopleTypeColumn || "E");
  const statusIdx = resolveColumnIndex(config.googleSheets.peopleStatusColumn || "T");
  const typeValue = portalRole === "Teacher" ? "Teacher: Classroom" : "Student: Classroom";
  const statusValue = portalRole === "Teacher" ? "Teaching" : "Admitted";
  return buildIndexedRow({
    [idIdx]: googleSheetPlainText(aesopId),
    [nameIdx]: name || "",
    [emailIdx]: email || "",
    [typeIdx]: typeValue,
    [statusIdx]: statusValue,
  });
}

async function loadOrphanPeople() {
  const pool = getPool();
  const result = await pool.query(
    `SELECT
       lower(trim(p.email)) AS email,
       p.name,
       p.portal_role,
       (SELECT COUNT(*)::int FROM course_enrollments ce WHERE ce.person_id = p.id) AS course_count
     FROM people p
     WHERE p.aesop_id IS NULL
       AND EXISTS (SELECT 1 FROM course_enrollments ce WHERE ce.person_id = p.id)
     ORDER BY
       CASE WHEN p.portal_role = 'Teacher' THEN 0 WHEN p.portal_role = 'Student' THEN 1 ELSE 2 END,
       lower(trim(p.email))`,
  );
  return result.rows;
}

async function loadExistingIdSet() {
  const pool = getPool();
  const result = await pool.query(
    `SELECT lower(trim(aesop_id)) AS id
     FROM people
     WHERE aesop_id IS NOT NULL
     UNION
     SELECT lower(trim(aesop_id)) AS id
     FROM applicants
     WHERE aesop_id IS NOT NULL`,
  );
  return new Set(result.rows.map((row) => row.id).filter(Boolean));
}

function assignIds(orphans, existingIds) {
  let nextId = ID_START;
  const assigned = [];
  for (const person of orphans) {
    while (existingIds.has(String(nextId))) {
      nextId += 1n;
    }
    const aesopId = String(nextId);
    existingIds.add(aesopId.toLowerCase());
    assigned.push({ ...person, aesop_id: aesopId });
    nextId += 1n;
  }
  return assigned;
}

function writeAssignmentCsv(assigned) {
  const docsDir = path.join(__dirname, "..", "docs");
  const esc = (value) => {
    const s = String(value ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["aesop_id", "email", "name", "portal_role", "course_count"];
  const toCsv = (rows) => [header.join(","), ...rows.map((row) => header.map((key) => esc(row[key])).join(","))].join("\n") + "\n";

  const teachers = assigned.filter((row) => row.portal_role === "Teacher");
  const students = assigned.filter((row) => row.portal_role === "Student");
  const staffTeachers = teachers.filter((row) => row.email.endsWith("@aesopafghanistan.org"));

  fs.writeFileSync(path.join(docsDir, "assigned-classroom-orphan-ids.csv"), toCsv(assigned));
  fs.writeFileSync(path.join(docsDir, "assigned-classroom-orphan-ids-teachers.csv"), toCsv(teachers));
  fs.writeFileSync(path.join(docsDir, "assigned-classroom-orphan-ids-students.csv"), toCsv(students));
  fs.writeFileSync(path.join(docsDir, "assigned-classroom-orphan-ids-staff-teachers.csv"), toCsv(staffTeachers));

  return { teachers: teachers.length, students: students.length, staffTeachers: staffTeachers.length };
}

async function ensureStagingWorksheet(doc) {
  const title = "Classroom ID Assignments (Jul 2026)";
  let worksheet = doc.sheetsByTitle[title];
  if (!worksheet) {
    worksheet = await doc.addSheet({
      title,
      headerValues: ["AESOP ID", "Name", "Email", "Type (teacher, student)", "Status", "portal_role", "course_count"],
    });
    return worksheet;
  }

  await worksheet.loadHeaderRow(1);
  const rows = await worksheet.getRows();
  if (rows.length > 0) {
    await worksheet.clearRows();
  }
  return worksheet;
}

async function appendStagingRows(assigned) {
  const sheet = await initGoogleSheets();
  const worksheet = await ensureStagingWorksheet(sheet);
  const rows = assigned.map((person) => [
    googleSheetPlainText(person.aesop_id),
    person.name || "",
    person.email || "",
    person.portal_role === "Teacher" ? "Teacher: Classroom" : "Student: Classroom",
    person.portal_role === "Teacher" ? "Teaching" : "Admitted",
    person.portal_role || "",
    String(person.course_count ?? ""),
  ]);

  let appended = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    await worksheet.addRows(batch, { raw: false, insert: false });
    appended += batch.length;
    console.log(`[assign-classroom-orphan-people-ids] staging tab: ${appended}/${rows.length}`);
  }
  return appended;
}

async function updateDatabaseIds(assigned) {
  const pool = getPool();
  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query("BEGIN");
    for (const person of assigned) {
      const result = await client.query(
        `UPDATE people
         SET aesop_id = $1,
             portal_role = COALESCE(NULLIF(portal_role, ''), $2),
             synced_at = NOW()
         WHERE lower(trim(email)) = lower(trim($3))
           AND aesop_id IS NULL`,
        [person.aesop_id, person.portal_role, person.email],
      );
      updated += result.rowCount;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return updated;
}

async function appendPeopleRows(assigned) {
  const sheet = await initGoogleSheets();
  const sheetName = config.googleSheets.sheetName || "People";
  const worksheet = sheet.sheetsByTitle[sheetName];
  if (!worksheet) {
    throw new Error(`Sheet "${sheetName}" not found.`);
  }

  await worksheet.loadHeaderRow(1);
  worksheet.resetLocalCache(true);

  const rows = assigned.map((person) =>
    buildPeopleAppendRow({
      aesopId: person.aesop_id,
      name: person.name,
      email: person.email,
      portalRole: person.portal_role,
    }),
  );

  let appended = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    await worksheet.addRows(batch, { raw: false, insert: false });
    appended += batch.length;
    console.log(`[assign-classroom-orphan-people-ids] People tab: ${appended}/${rows.length}`);
  }
  return appended;
}

async function syncPeopleSheetOrStaging(assigned) {
  try {
    const appended = await appendPeopleRows(assigned);
    return { target: "People", appended };
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error);
    if (!message.includes("protected cell")) {
      throw error;
    }
    console.warn(
      "[assign-classroom-orphan-people-ids] People tab is protected for API edits; writing staging tab instead.",
    );
    const appended = await appendStagingRows(assigned);
    return { target: "Classroom ID Assignments (Jul 2026)", appended };
  }
}

async function main() {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not set.");
  }

  const orphans = await loadOrphanPeople();
  if (orphans.length === 0) {
    console.log("[assign-classroom-orphan-people-ids] no orphan people with classroom enrollments.");
    return;
  }

  const existingIds = await loadExistingIdSet();
  const assigned = assignIds(orphans, existingIds);
  const csvStats = writeAssignmentCsv(assigned);

  console.log("[assign-classroom-orphan-people-ids] prepared assignments:", {
    total: assigned.length,
    teachers: csvStats.teachers,
    students: csvStats.students,
    staffTeachers: csvStats.staffTeachers,
    idRange: `${assigned[0].aesop_id} .. ${assigned[assigned.length - 1].aesop_id}`,
    dryRun: DRY_RUN,
  });
  console.log("[assign-classroom-orphan-people-ids] CSV files written under docs/assigned-classroom-orphan-ids*.csv");

  if (DRY_RUN) {
    console.log("[assign-classroom-orphan-people-ids] dry run — no sheet changes.");
    return;
  }

  const syncResult = await syncPeopleSheetOrStaging(assigned);
  console.log(
    `[assign-classroom-orphan-people-ids] wrote ${syncResult.appended} row(s) to "${syncResult.target}".`,
  );

  const dbUpdated = await updateDatabaseIds(assigned);
  console.log(`[assign-classroom-orphan-people-ids] updated ${dbUpdated} people row(s) in Postgres.`);

  if (syncResult.target === "People") {
    const mirrorResult = await mirrorAllPeopleFromSheets();
    console.log("[assign-classroom-orphan-people-ids] mirrored people from sheets:", mirrorResult);
  }

  const pool = getPool();
  const remaining = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM people p
     WHERE p.aesop_id IS NULL
       AND EXISTS (SELECT 1 FROM course_enrollments ce WHERE ce.person_id = p.id)`,
  );
  console.log("[assign-classroom-orphan-people-ids] remaining null-id classroom people:", remaining.rows[0].c);
}

main()
  .catch((error) => {
    console.error("[assign-classroom-orphan-people-ids] failed:", error.message);
    process.exit(1);
  })
  .finally(() => closeDatabase());
