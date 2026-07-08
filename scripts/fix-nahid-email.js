#!/usr/bin/env node
/**
 * Fix malformed People email "nahidqaderi78@gmail.com 07" and assign AESOP ID to nahidqaderi78@gmail.com.
 *
 * Usage: node scripts/fix-nahid-email.js
 */
require("../config/secrets");
const config = require("../config/secrets");
const { getPool, closeDatabase, isDatabaseEnabled } = require("../db/index");
const {
  initGoogleSheets,
  resolveColumnIndex,
} = require("../services/googleSheets");

const GOOD_EMAIL = "nahidqaderi78@gmail.com";
const BAD_EMAIL = "nahidqaderi78@gmail.com 07";
const AESOP_ID = "2613449311";

async function fixDatabase() {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not set.");
  }

  const pool = getPool();
  const existing = await pool.query(
    `SELECT id, aesop_id, email, portal_role
     FROM people
     WHERE lower(email) IN (lower($1), lower($2)) OR aesop_id = $3
     ORDER BY id`,
    [GOOD_EMAIL, BAD_EMAIL, AESOP_ID],
  );
  console.log("[fix-nahid-email] before:", existing.rows);

  const goodRow = existing.rows.find((row) => row.email?.toLowerCase() === GOOD_EMAIL);
  const badRow = existing.rows.find((row) => row.email?.toLowerCase() === BAD_EMAIL.toLowerCase());
  const idRow = existing.rows.find((row) => row.aesop_id === AESOP_ID);

  const keepId = goodRow?.id || idRow?.id;
  if (!keepId) {
    throw new Error("Could not find target people row for nahidqaderi78@gmail.com.");
  }

  const deleteIds = existing.rows
    .map((row) => row.id)
    .filter((id) => id !== keepId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const deleteId of deleteIds) {
      await client.query("DELETE FROM ding_numbers WHERE person_id = $1", [deleteId]);
      await client.query("DELETE FROM people WHERE id = $1", [deleteId]);
    }
    await client.query(
      `UPDATE people
       SET aesop_id = $1,
           email = $2,
           portal_role = COALESCE(NULLIF(portal_role, ''), 'Student'),
           synced_at = NOW()
       WHERE id = $3`,
      [AESOP_ID, GOOD_EMAIL, keepId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const after = await pool.query(
    `SELECT id, aesop_id, email, portal_role
     FROM people
     WHERE lower(email) = lower($1) OR aesop_id = $2`,
    [GOOD_EMAIL, AESOP_ID],
  );
  console.log("[fix-nahid-email] after:", after.rows);
}

async function fixPeopleSheet() {
  const sheet = await initGoogleSheets();
  const sheetName = config.googleSheets.sheetName || "People";
  const worksheet = sheet.sheetsByTitle[sheetName];
  if (!worksheet) {
    throw new Error(`Sheet "${sheetName}" not found.`);
  }

  await worksheet.loadHeaderRow(1);
  const rows = await worksheet.getRows();
  const emailColIdx = resolveColumnIndex(config.googleSheets.emailColumn || "D");
  const idColIdx = resolveColumnIndex(config.googleSheets.idColumn || "B");

  /** @type {import('google-spreadsheet').GoogleSpreadsheetRow[]} */
  const matches = [];
  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const email = String(rowData[emailColIdx] ?? "").trim();
    const id = String(rowData[idColIdx] ?? "").trim();
    if (
      email.toLowerCase() === GOOD_EMAIL.toLowerCase() ||
      email.toLowerCase() === BAD_EMAIL.toLowerCase() ||
      id === AESOP_ID
    ) {
      matches.push(row);
    }
  }

  if (matches.length === 0) {
    console.warn("[fix-nahid-email] no matching People sheet rows found.");
    return;
  }

  let keeper = matches.find((row) => {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    return String(rowData[idColIdx] ?? "").trim() === AESOP_ID;
  });
  if (!keeper) {
    keeper = matches[0];
  }

  const keeperData = Array.isArray(keeper._rawData) ? keeper._rawData : [];
  const keeperRowIdx = keeper.rowNumber - 1;
  await worksheet.loadCells({
    startRowIndex: keeperRowIdx,
    endRowIndex: keeperRowIdx + 1,
    startColumnIndex: Math.min(emailColIdx, idColIdx),
    endColumnIndex: Math.max(emailColIdx, idColIdx) + 1,
  });
  worksheet.getCell(keeperRowIdx, emailColIdx).value = GOOD_EMAIL;
  worksheet.getCell(keeperRowIdx, idColIdx).value = AESOP_ID;
  await worksheet.saveUpdatedCells();
  console.log(
    "[fix-nahid-email] updated keeper row",
    keeper.rowNumber,
    "from",
    String(keeperData[emailColIdx] ?? "").trim(),
  );

  for (const row of matches) {
    if (row.rowNumber === keeper.rowNumber) {
      continue;
    }
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    console.log(
      "[fix-nahid-email] duplicate sheet row remains at",
      row.rowNumber,
      "email=",
      String(rowData[emailColIdx] ?? "").trim(),
      "id=",
      String(rowData[idColIdx] ?? "").trim(),
      "(clear manually if needed)",
    );
  }
}

async function main() {
  await fixDatabase();
  await fixPeopleSheet();
}

main()
  .catch((error) => {
    console.error("[fix-nahid-email] failed:", error.message);
    process.exit(1);
  })
  .finally(() => closeDatabase());
