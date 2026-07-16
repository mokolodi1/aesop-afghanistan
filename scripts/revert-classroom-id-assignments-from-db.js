#!/usr/bin/env node
/**
 * Undo people.aesop_id values applied from "Classroom ID Assignments (Jul 2026)".
 * Clears aesop_id (by email + matching ID) — does not delete people rows.
 *
 * Usage:
 *   node scripts/revert-classroom-id-assignments-from-db.js --dry-run
 *   node scripts/revert-classroom-id-assignments-from-db.js
 */
require("../config/secrets");
const { getPool, closeDatabase, isDatabaseEnabled } = require("../db/index");
const { initGoogleSheets } = require("../services/googleSheets");

const STAGING_TAB = "Classroom ID Assignments (Jul 2026)";
const DRY_RUN = process.argv.includes("--dry-run");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAesopId(value) {
  let s = String(value ?? "").trim();
  if (s.startsWith("'")) {
    s = s.slice(1);
  }
  if (s.endsWith("'")) {
    s = s.slice(0, -1);
  }
  return s.trim();
}

function resolveHeaderIndex(headerValues, candidates) {
  const headers = Array.isArray(headerValues) ? headerValues : [];
  for (const candidate of candidates) {
    const idx = headers.findIndex(
      (header) => String(header || "").trim().toLowerCase() === candidate.toLowerCase(),
    );
    if (idx >= 0) {
      return idx;
    }
  }
  return -1;
}

async function loadStagingAssignments() {
  const doc = await initGoogleSheets();
  const worksheet = doc.sheetsByTitle[STAGING_TAB];
  if (!worksheet) {
    throw new Error(`Sheet tab "${STAGING_TAB}" not found.`);
  }

  await worksheet.loadHeaderRow(1);
  const headerValues = worksheet.headerValues || [];
  const idIdx = resolveHeaderIndex(headerValues, ["AESOP ID", "ID"]);
  const nameIdx = resolveHeaderIndex(headerValues, ["Name"]);
  const emailIdx = resolveHeaderIndex(headerValues, ["Email", "Current Email (past see right)"]);
  const typeIdx = resolveHeaderIndex(headerValues, ["Type", "Type (teacher, student)"]);

  if (idIdx < 0 || nameIdx < 0 || emailIdx < 0) {
    throw new Error(
      `Missing required columns on "${STAGING_TAB}". Found headers: ${headerValues.join(", ")}`,
    );
  }

  const rows = await worksheet.getRows();
  const assignments = [];
  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const aesopId = normalizeAesopId(rowData[idIdx]);
    const email = normalizeEmail(rowData[emailIdx]);
    const name = String(rowData[nameIdx] ?? "").trim();
    const typeRaw = typeIdx >= 0 ? String(rowData[typeIdx] ?? "").trim() : "";
    if (!aesopId || !email) {
      continue;
    }
    assignments.push({
      aesopId,
      email,
      name,
      peopleType: typeRaw || null,
      sheetRow: row.rowNumber,
    });
  }
  return assignments;
}

async function revertAssignments(assignments) {
  const pool = getPool();
  const client = await pool.connect();
  const stats = {
    reverted: 0,
    notFound: 0,
    idMismatch: 0,
    alreadyNull: 0,
    skipped: 0,
  };

  try {
    if (!DRY_RUN) {
      await client.query("BEGIN");
    }

    for (const assignment of assignments) {
      const existing = await client.query(
        `SELECT id, aesop_id, email, name
         FROM people
         WHERE lower(trim(email)) = $1`,
        [assignment.email],
      );

      if (existing.rows.length === 0) {
        stats.notFound += 1;
        continue;
      }

      const person = existing.rows[0];
      const currentId = String(person.aesop_id || "").trim();

      if (!currentId) {
        stats.alreadyNull += 1;
        continue;
      }

      if (currentId !== assignment.aesopId) {
        stats.idMismatch += 1;
        console.warn(
          `[revert-classroom-id-assignments] row ${assignment.sheetRow}: ${assignment.email} has aesop_id=${currentId}, staging has ${assignment.aesopId} — skipped`,
        );
        continue;
      }

      if (DRY_RUN) {
        stats.reverted += 1;
        continue;
      }

      const result = await client.query(
        `UPDATE people
         SET aesop_id = NULL,
             synced_at = NOW()
         WHERE id = $1
           AND aesop_id = $2`,
        [person.id, assignment.aesopId],
      );
      if (result.rowCount === 0) {
        stats.skipped += 1;
      } else {
        stats.reverted += 1;
      }
    }

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

  return stats;
}

async function main() {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not set.");
  }

  const assignments = await loadStagingAssignments();
  console.log(
    `[revert-classroom-id-assignments] loaded ${assignments.length} row(s) from "${STAGING_TAB}".`,
  );

  const stats = await revertAssignments(assignments);
  console.log("[revert-classroom-id-assignments] result:", { ...stats, dryRun: DRY_RUN });

  const pool = getPool();
  const remaining = await pool.query(
    `SELECT COUNT(*)::int AS c FROM people WHERE aesop_id IS NULL`,
  );
  console.log("[revert-classroom-id-assignments] NULL aesop_id in people:", remaining.rows[0].c);
}

main()
  .catch((error) => {
    console.error("[revert-classroom-id-assignments] failed:", error.message);
    process.exit(1);
  })
  .finally(() => closeDatabase());
