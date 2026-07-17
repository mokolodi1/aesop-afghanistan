#!/usr/bin/env node
/**
 * Shift ApplicantReviews scores written with the legacy column map into the
 * current Unable/Technical + fitness layout, then remirror into Postgres.
 *
 * Usage:
 *   node scripts/fix-applicant-reviews-columns.js           # dry-run
 *   node scripts/fix-applicant-reviews-columns.js --apply  # write sheet + mirror
 */
require("../config/secrets");
const { getApplicantReviewsConfig } = require("../services/applicantReviews");
const {
  initGoogleSheets,
  getWorksheetByTitle,
  sheetsApiCall,
} = require("../services/googleSheets");
const { repairApplicantReviewRow } = require("../utils/applicantReviewsColumnRepair");
const { mirrorApplicantReviewsFromSheets } = require("../services/peopleMirror");
const { formatErrorForLog } = require("../utils/errorLogging");
const { isDatabaseEnabled, closeDatabase } = require("../db/index");
const { getServiceAccountCredentials } = require("../services/googleAuth");
const { runMigrations } = require("../db/migrate");

const APPLY = process.argv.includes("--apply");

/**
 * @param {ReturnType<typeof getApplicantReviewsConfig>} cfg
 * @param {string[]} rowData
 */
function readLogicalRow(cfg, rowData) {
  const at = (index) => String(rowData[index] ?? "").trim();
  return {
    aLevel: at(cfg.aLevelCol),
    aSuspectedAi: at(cfg.aSuspectedAiCol),
    aUnable: at(cfg.aUnableToGradeCol),
    aTechnical: at(cfg.aTechnicalFlagCol),
    aInstruction: at(cfg.aInstructionCol),
    aOriginal: at(cfg.aOriginalThinkingCol),
    aCharacter: at(cfg.aCharacterCol),
    bLevel: at(cfg.bLevelCol),
    bSuspectedAi: at(cfg.bSuspectedAiCol),
    bUnable: at(cfg.bUnableToGradeCol),
    bTechnical: at(cfg.bTechnicalFlagCol),
    bInstruction: at(cfg.bInstructionCol),
    bOriginal: at(cfg.bOriginalThinkingCol),
    bCharacter: at(cfg.bCharacterCol),
  };
}

async function main() {
  const credentials = getServiceAccountCredentials();
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error(
      "Google service account credentials are missing. Configure SECRETS_JSON or GMAIL_SA_CREDENTIALS_JSON.",
    );
  }

  const cfg = getApplicantReviewsConfig();
  console.log(
    `[fix-applicant-reviews-columns] sheet=${cfg.sheetName} mode=${APPLY ? "APPLY" : "dry-run"}`,
  );
  console.log(
    `[fix-applicant-reviews-columns] A map: level=${cfg.aLevelCol} ai=${cfg.aSuspectedAiCol} ` +
      `unable=${cfg.aUnableToGradeCol} tech=${cfg.aTechnicalFlagCol} ` +
      `instr=${cfg.aInstructionCol} orig=${cfg.aOriginalThinkingCol} char=${cfg.aCharacterCol}`,
  );
  console.log(
    `[fix-applicant-reviews-columns] B map: level=${cfg.bLevelCol} ai=${cfg.bSuspectedAiCol} ` +
      `unable=${cfg.bUnableToGradeCol} tech=${cfg.bTechnicalFlagCol} ` +
      `instr=${cfg.bInstructionCol} orig=${cfg.bOriginalThinkingCol} char=${cfg.bCharacterCol}`,
  );

  // Guard: refuse to run if config still points A instruction at F.
  if (cfg.aInstructionCol === cfg.aUnableToGradeCol) {
    throw new Error(
      "ApplicantReviews column config still collides (instruction == unable). " +
        "Update secrets so A fitness is H–J before repairing.",
    );
  }

  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, cfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${cfg.sheetName}" was not found.`);
  }

  await sheetsApiCall("loadHeaderRow(applicant reviews repair)", () =>
    worksheet.loadHeaderRow(cfg.headerRowNum),
  );
  const rows = await sheetsApiCall("getRows(applicant reviews repair)", () =>
    worksheet.getRows(),
  );

  /** @type {Array<{ aesopId: string, rowNumber: number, shifts: string[], before: object, after: object }>} */
  const planned = [];

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const aesopId = String(rowData[cfg.applicantIdCol] ?? "").trim();
    if (!aesopId) {
      continue;
    }
    const before = readLogicalRow(cfg, rowData);
    const { changed, row: after, shifts } = repairApplicantReviewRow(before);
    if (!changed) {
      continue;
    }
    planned.push({
      aesopId,
      rowNumber: row.rowNumber,
      shifts,
      before,
      after,
      sheetRow: row,
    });
  }

  console.log(`[fix-applicant-reviews-columns] rows to repair: ${planned.length}`);
  for (const entry of planned.slice(0, 30)) {
    console.log(
      `  ${entry.aesopId} row=${entry.rowNumber} shifts=${entry.shifts.join(",")} ` +
        `A:${entry.before.aUnable}/${entry.before.aTechnical}/${entry.before.aInstruction}→` +
        `${entry.after.aInstruction}/${entry.after.aOriginal}/${entry.after.aCharacter} ` +
        `B:${entry.before.aOriginal}/${entry.before.bLevel}/${entry.before.bSuspectedAi}/${entry.before.bUnable}→` +
        `${entry.after.bLevel}/${entry.after.bInstruction}/${entry.after.bOriginal}/${entry.after.bCharacter}`,
    );
  }
  if (planned.length > 30) {
    console.log(`  … ${planned.length - 30} more`);
  }

  if (!APPLY) {
    console.log("[fix-applicant-reviews-columns] dry-run only. Re-run with --apply to write.");
    return { repaired: 0, planned: planned.length };
  }

  let repaired = 0;
  for (const entry of planned) {
    const { sheetRow, after } = entry;
    const gridRowIdx = sheetRow.rowNumber - 1;
    const columnIndices = [
      cfg.aUnableToGradeCol,
      cfg.aTechnicalFlagCol,
      cfg.aInstructionCol,
      cfg.aOriginalThinkingCol,
      cfg.aCharacterCol,
      cfg.bLevelCol,
      cfg.bSuspectedAiCol,
      cfg.bUnableToGradeCol,
      cfg.bTechnicalFlagCol,
      cfg.bInstructionCol,
      cfg.bOriginalThinkingCol,
      cfg.bCharacterCol,
    ];
    await sheetsApiCall(`loadCells(repair ${entry.aesopId})`, () =>
      worksheet.loadCells({
        startRowIndex: gridRowIdx,
        endRowIndex: gridRowIdx + 1,
        startColumnIndex: Math.min(...columnIndices),
        endColumnIndex: Math.max(...columnIndices) + 1,
      }),
    );

    worksheet.getCell(gridRowIdx, cfg.aUnableToGradeCol).value = after.aUnable;
    worksheet.getCell(gridRowIdx, cfg.aTechnicalFlagCol).value = after.aTechnical;
    worksheet.getCell(gridRowIdx, cfg.aInstructionCol).value = after.aInstruction;
    worksheet.getCell(gridRowIdx, cfg.aOriginalThinkingCol).value = after.aOriginal;
    worksheet.getCell(gridRowIdx, cfg.aCharacterCol).value = after.aCharacter;
    worksheet.getCell(gridRowIdx, cfg.bLevelCol).value = after.bLevel;
    worksheet.getCell(gridRowIdx, cfg.bSuspectedAiCol).value = after.bSuspectedAi;
    worksheet.getCell(gridRowIdx, cfg.bUnableToGradeCol).value = after.bUnable;
    worksheet.getCell(gridRowIdx, cfg.bTechnicalFlagCol).value = after.bTechnical;
    worksheet.getCell(gridRowIdx, cfg.bInstructionCol).value = after.bInstruction;
    worksheet.getCell(gridRowIdx, cfg.bOriginalThinkingCol).value = after.bOriginal;
    worksheet.getCell(gridRowIdx, cfg.bCharacterCol).value = after.bCharacter;

    await sheetsApiCall(`saveUpdatedCells(repair ${entry.aesopId})`, () =>
      worksheet.saveUpdatedCells(),
    );
    repaired += 1;
  }

  console.log(`[fix-applicant-reviews-columns] wrote ${repaired} sheet row(s)`);

  if (isDatabaseEnabled()) {
    await runMigrations();
    const mirror = await mirrorApplicantReviewsFromSheets();
    console.log("[fix-applicant-reviews-columns] mirrored into Postgres:", mirror.mirrored);
  } else {
    console.warn(
      "[fix-applicant-reviews-columns] DATABASE_URL not set; skipped Postgres remirror.",
    );
  }

  return { repaired, planned: planned.length };
}

main()
  .then((result) => {
    console.log("[fix-applicant-reviews-columns] done:", result);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[fix-applicant-reviews-columns] failed:", formatErrorForLog(err));
    process.exit(1);
  })
  .finally(() => closeDatabase());
