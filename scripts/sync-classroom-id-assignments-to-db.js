#!/usr/bin/env node
/**
 * Populate NULL people.aesop_id values from the "Classroom ID Assignments (Jul 2026)" sheet tab.
 * Matches rows by email and name (case-insensitive, trimmed).
 *
 * Usage:
 *   node scripts/sync-classroom-id-assignments-to-db.js
 *   node scripts/sync-classroom-id-assignments-to-db.js --dry-run
 */
require("../config/secrets");
const { getPool, closeDatabase, isDatabaseEnabled } = require("../db/index");
const { initGoogleSheets } = require("../services/googleSheets");

const STAGING_TAB = "Classroom ID Assignments (Jul 2026)";
const DRY_RUN = process.argv.includes("--dry-run");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Strip Google Sheets plain-text prefix/suffix quotes from IDs. */
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
  const typeIdx = resolveHeaderIndex(headerValues, [
    "Type",
    "Type (teacher, student)",
  ]);

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
      typeRaw,
      sheetRow: row.rowNumber,
    });
  }
  return assignments;
}

async function applyAssignments(assignments) {
  const pool = getPool();
  const client = await pool.connect();
  const stats = {
    updated: 0,
    alreadySet: 0,
    nameMismatch: 0,
    notFound: 0,
    idConflict: 0,
    skipped: 0,
  };

  try {
    if (!DRY_RUN) {
      await client.query("BEGIN");
    }

    for (const assignment of assignments) {
      const existing = await client.query(
        `SELECT id, aesop_id, name, email
         FROM people
         WHERE lower(trim(email)) = $1`,
        [assignment.email],
      );

      if (existing.rows.length === 0) {
        stats.notFound += 1;
        console.warn(
          `[sync-classroom-id-assignments] row ${assignment.sheetRow}: no people row for ${assignment.email}`,
        );
        continue;
      }

      const person = existing.rows[0];
      const dbName = normalizeName(person.name);
      const sheetName = normalizeName(assignment.name);
      if (dbName && sheetName && dbName !== sheetName) {
        stats.nameMismatch += 1;
        console.warn(
          `[sync-classroom-id-assignments] row ${assignment.sheetRow}: name mismatch for ${assignment.email} (db="${person.name}", sheet="${assignment.name}") — updating by email only`,
        );
      }

      if (person.aesop_id) {
        if (String(person.aesop_id).trim() === assignment.aesopId) {
          stats.alreadySet += 1;
        } else {
          stats.idConflict += 1;
          console.warn(
            `[sync-classroom-id-assignments] row ${assignment.sheetRow}: ${assignment.email} already has aesop_id=${person.aesop_id}, sheet has ${assignment.aesopId}`,
          );
        }
        continue;
      }

      if (DRY_RUN) {
        stats.updated += 1;
        continue;
      }

      const result = await client.query(
        `UPDATE people
         SET aesop_id = $1,
             name = COALESCE(NULLIF(trim($2), ''), name),
             people_type = COALESCE(NULLIF(trim($3), ''), people_type),
             synced_at = NOW()
         WHERE id = $4
           AND aesop_id IS NULL`,
        [assignment.aesopId, assignment.name, assignment.peopleType, person.id],
      );
      if (result.rowCount === 0) {
        stats.skipped += 1;
      } else {
        stats.updated += 1;
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
  console.log(`[sync-classroom-id-assignments] loaded ${assignments.length} row(s) from "${STAGING_TAB}".`);

  const stats = await applyAssignments(assignments);
  console.log("[sync-classroom-id-assignments] result:", { ...stats, dryRun: DRY_RUN });

  const pool = getPool();
  const remaining = await pool.query(
    `SELECT COUNT(*)::int AS c FROM people WHERE aesop_id IS NULL`,
  );
  console.log("[sync-classroom-id-assignments] remaining NULL aesop_id in people:", remaining.rows[0].c);
}

main()
  .catch((error) => {
    console.error("[sync-classroom-id-assignments] failed:", error.message);
    process.exit(1);
  })
  .finally(() => closeDatabase());
