const config = require("../config/secrets");
const { getVoiceMemoFileForAesopId } = require("./googleDrive");
const {
  initGoogleSheets,
  getWorksheetByTitle,
  resolveColumnIndex,
} = require("./googleSheets");
const { getVoiceMemoDriveScanOptions, findVoiceMemoInScan } = require("./voiceMemoSync");
const { scanVoiceMemoFolder } = require("./googleDrive");

const ENGLISH_LEVELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const FITNESS_SCORES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const FITNESS_CRITERIA = ["instructionFollowing", "originalThinking", "character"];
const SUSPECTED_AI_SHEET_VALUE = "Suspected AI";
const LEGACY_FLAGGED_AI_LEVEL = "Flagged for AI";

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeEnglishLevel(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (
    trimmed.toLowerCase() === LEGACY_FLAGGED_AI_LEVEL.toLowerCase() ||
    trimmed.toLowerCase() === SUSPECTED_AI_SHEET_VALUE.toLowerCase()
  ) {
    return "";
  }
  const asNumber = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= 10) {
    return String(asNumber);
  }
  return ENGLISH_LEVELS.find((level) => level === trimmed) || "";
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function normalizeSuspectedAi(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  return (
    trimmed === "yes" ||
    trimmed === "y" ||
    trimmed === "true" ||
    trimmed === "1" ||
    trimmed === SUSPECTED_AI_SHEET_VALUE.toLowerCase() ||
    trimmed === LEGACY_FLAGGED_AI_LEVEL.toLowerCase()
  );
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeFitnessScore(value) {
  const trimmed = String(value ?? "").trim();
  if (FITNESS_SCORES.includes(trimmed)) {
    return trimmed;
  }
  const asNumber = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= 10) {
    return String(asNumber);
  }
  return "";
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeAesopIdKey(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * @param {Record<string, string>} scores
 * @returns {Record<string, string>}
 */
function normalizeFitnessScores(scores) {
  return {
    instructionFollowing: normalizeFitnessScore(scores?.instructionFollowing),
    originalThinking: normalizeFitnessScore(scores?.originalThinking),
    character: normalizeFitnessScore(scores?.character),
  };
}

/**
 * @returns {{
 *   sheetName: string,
 *   headerRowNum: number,
 *   applicantIdCol: number,
 *   reviewerACol: number,
 *   aLevelCol: number,
 *   aSuspectedAiCol: number,
 *   aInstructionCol: number,
 *   aOriginalThinkingCol: number,
 *   aCharacterCol: number,
 *   reviewerBCol: number,
 *   bLevelCol: number,
 *   bSuspectedAiCol: number,
 *   bInstructionCol: number,
 *   bOriginalThinkingCol: number,
 *   bCharacterCol: number,
 * }}
 */
function getApplicantReviewsConfig() {
  const gs = config.googleSheets || {};
  const col = (key, fallback) => resolveColumnIndex(gs[key] || fallback);
  return {
    sheetName: gs.applicantReviewsSheetName || "ApplicantReviews",
    headerRowNum: 1,
    applicantIdCol: col("applicantReviewsApplicantIdColumn", "A"),
    reviewerACol: col("applicantReviewsReviewerAColumn", "B"),
    reviewerBCol: col("applicantReviewsReviewerBColumn", "C"),
    aLevelCol: col("applicantReviewsALevelColumn", "D"),
    aSuspectedAiCol: col("applicantReviewsASuspectedAiColumn", "E"),
    aInstructionCol: col("applicantReviewsAInstructionColumn", "F"),
    aOriginalThinkingCol: col("applicantReviewsAOriginalThinkingColumn", "G"),
    aCharacterCol: col("applicantReviewsACharacterColumn", "H"),
    bLevelCol: col("applicantReviewsBLevelColumn", "I"),
    bSuspectedAiCol: col("applicantReviewsBSuspectedAiColumn", "J"),
    bInstructionCol: col("applicantReviewsBInstructionColumn", "K"),
    bOriginalThinkingCol: col("applicantReviewsBOriginalThinkingColumn", "L"),
    bCharacterCol: col("applicantReviewsBCharacterColumn", "M"),
  };
}

/**
 * @param {ReturnType<typeof getApplicantReviewsConfig>} cfg
 * @param {'A'|'B'} slot
 */
function getSlotColumns(cfg, slot) {
  if (slot === "A") {
    return {
      level: cfg.aLevelCol,
      suspectedAi: cfg.aSuspectedAiCol,
      instructionFollowing: cfg.aInstructionCol,
      originalThinking: cfg.aOriginalThinkingCol,
      character: cfg.aCharacterCol,
    };
  }
  return {
    level: cfg.bLevelCol,
    suspectedAi: cfg.bSuspectedAiCol,
    instructionFollowing: cfg.bInstructionCol,
    originalThinking: cfg.bOriginalThinkingCol,
    character: cfg.bCharacterCol,
  };
}

/**
 * @returns {{
 *   sheetName: string,
 *   headerRowNum: number,
 *   idColumnIndex: number,
 *   nameColumnIndex: number,
 *   levelColumnIndex: number,
 *   essayColumnIndex: number,
 * }}
 */
function getApplicantsReviewConfig() {
  const gs = config.googleSheets || {};
  return {
    sheetName: gs.admissionsSheetName || "Applicants",
    headerRowNum: Math.max(1, parseInt(String(gs.admissionsHeaderRow || "1"), 10) || 1),
    idColumnIndex: resolveColumnIndex(gs.admissionsIdColumn || "A"),
    nameColumnIndex: resolveColumnIndex(gs.admissionsNameColumn || "C"),
    levelColumnIndex: resolveColumnIndex(gs.admissionsLevelColumn || "E"),
    essayColumnIndex: resolveColumnIndex(gs.admissionsEssayColumn || "K"),
  };
}

/**
 * @returns {Promise<Map<string, { name: string, appliedLevel: string, essay: string }>>}
 */
async function loadApplicantsByIdMap() {
  const cfg = getApplicantsReviewConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, cfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${cfg.sheetName}" was not found.`);
  }

  await worksheet.loadHeaderRow(cfg.headerRowNum);
  const rows = await worksheet.getRows();
  /** @type {Map<string, { name: string, appliedLevel: string, essay: string }>} */
  const byId = new Map();

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const aesopId = String(rowData[cfg.idColumnIndex] ?? "").trim();
    if (!aesopId) {
      continue;
    }
    byId.set(normalizeAesopIdKey(aesopId), {
      name: String(rowData[cfg.nameColumnIndex] ?? "").trim(),
      appliedLevel: String(rowData[cfg.levelColumnIndex] ?? "").trim(),
      essay: String(rowData[cfg.essayColumnIndex] ?? "").trim(),
    });
  }

  return byId;
}

/**
 * @param {string[]} rowData
 * @param {ReturnType<typeof getSlotColumns>} cols
 */
function readReviewFieldsFromRow(rowData, cols) {
  const levelRaw = String(rowData[cols.level] ?? "").trim();
  let englishLevel = normalizeEnglishLevel(levelRaw);
  let suspectedAi = normalizeSuspectedAi(rowData[cols.suspectedAi]);
  if (!englishLevel && normalizeSuspectedAi(levelRaw)) {
    suspectedAi = true;
  }
  return {
    englishLevel,
    suspectedAi,
    ...normalizeFitnessScores({
      instructionFollowing: rowData[cols.instructionFollowing],
      originalThinking: rowData[cols.originalThinking],
      character: rowData[cols.character],
    }),
  };
}

/**
 * @param {string} reviewerAesopId
 */
async function loadReviewAssignmentsForReviewer(reviewerAesopId) {
  const reviewerKey = normalizeAesopIdKey(reviewerAesopId);
  if (!reviewerKey) {
    return [];
  }

  const reviewsCfg = getApplicantReviewsConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, reviewsCfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${reviewsCfg.sheetName}" was not found.`);
  }

  await worksheet.loadHeaderRow(reviewsCfg.headerRowNum);
  const rows = await worksheet.getRows();
  const applicantsById = await loadApplicantsByIdMap();

  const voiceMemo = config.voiceMemo || {};
  const folderId = String(voiceMemo.driveFolderId || "").trim();
  const scanOptions = getVoiceMemoDriveScanOptions(voiceMemo);

  let memoById = null;
  if (folderId) {
    try {
      const scan = await scanVoiceMemoFolder(folderId, scanOptions);
      memoById = scan.memosById;
    } catch {
      memoById = null;
    }
  }

  /** @type {Array<{ applicantId: string, name: string, appliedLevel: string, essay: string, slot: 'A'|'B', englishLevel: string, suspectedAi: boolean, instructionFollowing: string, originalThinking: string, character: string, hasVoiceMemo: boolean }>} */
  const assignments = [];

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const applicantId = String(rowData[reviewsCfg.applicantIdCol] ?? "").trim();
    if (!applicantId) {
      continue;
    }

    const reviewerA = normalizeAesopIdKey(rowData[reviewsCfg.reviewerACol]);
    const reviewerB = normalizeAesopIdKey(rowData[reviewsCfg.reviewerBCol]);
    let slot = null;
    if (reviewerA === reviewerKey) {
      slot = "A";
    } else if (reviewerB === reviewerKey) {
      slot = "B";
    } else {
      continue;
    }

    const applicant = applicantsById.get(normalizeAesopIdKey(applicantId));
    const appliedLevel = applicant?.appliedLevel || "";
    const slotCols = getSlotColumns(reviewsCfg, slot);
    const reviewFields = readReviewFieldsFromRow(rowData, slotCols);

    let hasVoiceMemo = false;
    if (memoById) {
      hasVoiceMemo = Boolean(findVoiceMemoInScan(memoById, applicantId));
    } else if (folderId) {
      try {
        const driveFile = await getVoiceMemoFileForAesopId(folderId, applicantId, scanOptions);
        hasVoiceMemo = Boolean(driveFile);
      } catch {
        hasVoiceMemo = false;
      }
    }

    assignments.push({
      applicantId,
      name: applicant?.name || applicantId,
      appliedLevel,
      essay: applicant?.essay || "",
      slot,
      ...reviewFields,
      hasVoiceMemo,
    });
  }

  assignments.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.applicantId.localeCompare(b.applicantId, undefined, { sensitivity: "base" }),
  );

  return assignments;
}

/**
 * @param {{
 *   reviewerAesopId: string,
 *   applicantAesopId: string,
 *   englishLevel: string,
 *   suspectedAi: boolean,
 *   instructionFollowing: string,
 *   originalThinking: string,
 *   character: string,
 * }} params
 */
async function saveReviewAssessment({
  reviewerAesopId,
  applicantAesopId,
  englishLevel,
  suspectedAi,
  instructionFollowing,
  originalThinking,
  character,
}) {
  const reviewerKey = normalizeAesopIdKey(reviewerAesopId);
  const applicantKey = normalizeAesopIdKey(applicantAesopId);
  if (!reviewerKey || !applicantKey) {
    const error = new Error("Reviewer ID and applicant ID are required.");
    error.statusCode = 400;
    throw error;
  }

  const normalizedLevel = normalizeEnglishLevel(englishLevel);
  const normalizedSuspectedAi = suspectedAi === true;
  const normalizedScores = normalizeFitnessScores({
    instructionFollowing,
    originalThinking,
    character,
  });

  if (!normalizedLevel && !normalizedSuspectedAi) {
    const error = new Error("English level or Suspected AI is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!normalizedScores.instructionFollowing) {
    const error = new Error("Instruction Following score is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!normalizedScores.originalThinking) {
    const error = new Error("Independent/Original Thinking score is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!normalizedScores.character) {
    const error = new Error("Demonstration of Character score is required.");
    error.statusCode = 400;
    throw error;
  }

  const reviewsCfg = getApplicantReviewsConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, reviewsCfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${reviewsCfg.sheetName}" was not found.`);
  }

  await worksheet.loadHeaderRow(reviewsCfg.headerRowNum);
  const rows = await worksheet.getRows();

  /** @type {import('google-spreadsheet').GoogleSpreadsheetRow | null} */
  let matchedRow = null;
  /** @type {'A'|'B'|null} */
  let slot = null;

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const rowApplicantId = normalizeAesopIdKey(rowData[reviewsCfg.applicantIdCol]);
    if (rowApplicantId !== applicantKey) {
      continue;
    }

    const reviewerA = normalizeAesopIdKey(rowData[reviewsCfg.reviewerACol]);
    const reviewerB = normalizeAesopIdKey(rowData[reviewsCfg.reviewerBCol]);
    if (reviewerA === reviewerKey) {
      matchedRow = row;
      slot = "A";
      break;
    }
    if (reviewerB === reviewerKey) {
      matchedRow = row;
      slot = "B";
      break;
    }
  }

  if (!matchedRow || !slot) {
    const error = new Error("You are not assigned to review this applicant.");
    error.statusCode = 403;
    throw error;
  }

  const slotCols = getSlotColumns(reviewsCfg, slot);
  const columnIndices = [
    slotCols.level,
    slotCols.suspectedAi,
    slotCols.instructionFollowing,
    slotCols.originalThinking,
    slotCols.character,
  ];
  const gridRowIdx = matchedRow.rowNumber - 1;

  await worksheet.loadCells({
    startRowIndex: gridRowIdx,
    endRowIndex: gridRowIdx + 1,
    startColumnIndex: Math.min(...columnIndices),
    endColumnIndex: Math.max(...columnIndices) + 1,
  });

  worksheet.getCell(gridRowIdx, slotCols.level).value = normalizedLevel;
  worksheet.getCell(gridRowIdx, slotCols.suspectedAi).value = normalizedSuspectedAi
    ? SUSPECTED_AI_SHEET_VALUE
    : "";
  worksheet.getCell(gridRowIdx, slotCols.instructionFollowing).value =
    normalizedScores.instructionFollowing;
  worksheet.getCell(gridRowIdx, slotCols.originalThinking).value =
    normalizedScores.originalThinking;
  worksheet.getCell(gridRowIdx, slotCols.character).value = normalizedScores.character;
  await worksheet.saveUpdatedCells();

  return {
    applicantId: applicantAesopId.trim(),
    englishLevel: normalizedLevel,
    suspectedAi: normalizedSuspectedAi,
    ...normalizedScores,
  };
}

module.exports = {
  ENGLISH_LEVELS,
  FITNESS_SCORES,
  FITNESS_CRITERIA,
  normalizeEnglishLevel,
  normalizeFitnessScore,
  loadReviewAssignmentsForReviewer,
  saveReviewAssessment,
};
