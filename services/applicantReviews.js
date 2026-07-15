const config = require("../config/secrets");
const {
  initGoogleSheets,
  getWorksheetByTitle,
  resolveColumnIndex,
} = require("./googleSheets");
const {
  isDatabaseEnabled,
  getApplicantsReviewFieldsMapFromDb,
  isReviewerAssignedToApplicantFromDb,
  isListedAsApplicantReviewerFromDb,
  getReviewAssignmentsForReviewerFromDb,
  getApplicantReviewRowFromDb,
  upsertApplicantReviewFromMirror,
} = require("./classroomDb");
const {
  mintReviewVoiceStreamToken,
} = require("./portalVoiceMemo");
const { classifyVoiceMemoDuration } = require("../utils/voiceMemoDuration");
const {
  getVoiceMemoDurationLimits,
} = require("./voiceMemoSync");
const { extractDriveFileIdFromLink } = require("./googleDrive");

const ENGLISH_LEVELS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const FITNESS_SCORES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
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
  if (Number.isFinite(asNumber) && asNumber >= 0 && asNumber <= 10) {
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
  if (Number.isFinite(asNumber) && asNumber >= 0 && asNumber <= 10) {
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
 *   ageColumnIndex: number,
 *   essayColumnIndex: number,
 * }}
 */
function getApplicantsReviewConfig() {
  const gs = config.googleSheets || {};
  return {
    sheetName: gs.admissionsSheetName || "Applicants",
    headerRowNum: Math.max(1, parseInt(String(gs.admissionsHeaderRow || "1"), 10) || 1),
    idColumnIndex: resolveColumnIndex(gs.admissionsIdColumn || "A"),
    ageColumnIndex: resolveColumnIndex(gs.admissionsAgeColumn || "L"),
    essayColumnIndex: resolveColumnIndex(gs.admissionsEssayColumn || "K"),
  };
}

/**
 * Reviewer player should appear whenever there is evidence of a voice memo,
 * not only when applicants.drive_file_id is already cached.
 * @param {{ driveFileId?: string|null, round2?: string|null, links?: string|null }} fields
 * @returns {boolean}
 */
function applicantHasReviewVoiceMemo(fields = {}) {
  if (String(fields.driveFileId || "").trim()) {
    return true;
  }
  if (extractDriveFileIdFromLink(fields.links)) {
    return true;
  }
  const submittedValue = String(
    config.voiceMemo?.submittedValue || "Submitted",
  )
    .trim()
    .toLowerCase();
  if (String(fields.round2 || "").trim().toLowerCase() === submittedValue) {
    return true;
  }
  return Boolean(String(fields.links || "").trim());
}

/**
 * @returns {Promise<Map<string, { age: string, essay: string, round2: string, round2Prompt: string, links: string, driveFileId: string, driveFileName: string, driveDurationSeconds: number|null }>>}
 */
async function loadApplicantsByIdMap() {
  if (isDatabaseEnabled()) {
    const fromDb = await getApplicantsReviewFieldsMapFromDb();
    if (fromDb) {
      return fromDb;
    }
  }

  const cfg = getApplicantsReviewConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, cfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${cfg.sheetName}" was not found.`);
  }

  await worksheet.loadHeaderRow(cfg.headerRowNum);
  const rows = await worksheet.getRows();
  /** @type {Map<string, { age: string, essay: string, round2: string, round2Prompt: string, links: string, driveFileId: string, driveFileName: string, driveDurationSeconds: number|null }>} */
  const byId = new Map();

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const aesopId = String(rowData[cfg.idColumnIndex] ?? "").trim();
    if (!aesopId) {
      continue;
    }
    byId.set(normalizeAesopIdKey(aesopId), {
      age: String(rowData[cfg.ageColumnIndex] ?? "").trim(),
      essay: String(rowData[cfg.essayColumnIndex] ?? "").trim(),
      round2: "",
      round2Prompt: "",
      links: "",
      driveFileId: "",
      driveFileName: "",
      driveDurationSeconds: null,
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
function readReviewFieldsFromDbRow(row, slot) {
  const prefix = slot === "A" ? "a_" : "b_";
  const levelRaw = String(row[`${prefix}english_level`] ?? "").trim();
  let englishLevel = normalizeEnglishLevel(levelRaw);
  let suspectedAi = normalizeSuspectedAi(row[`${prefix}suspected_ai`]);
  if (!englishLevel && normalizeSuspectedAi(levelRaw)) {
    suspectedAi = true;
  }
  return {
    englishLevel,
    suspectedAi,
    ...normalizeFitnessScores({
      instructionFollowing: row[`${prefix}instruction_following`],
      originalThinking: row[`${prefix}original_thinking`],
      character: row[`${prefix}character`],
    }),
  };
}

/**
 * @param {number|null|undefined} durationSeconds
 * @returns {'valid'|'too_short'|'too_long'|'unknown'}
 */
function classifyReviewVoiceDuration(durationSeconds) {
  return classifyVoiceMemoDuration(
    durationSeconds,
    getVoiceMemoDurationLimits(config.voiceMemo || {}),
  );
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} reviewerKey
 * @returns {Array<{ applicantId: string, age: string, essay: string, round2Prompt: string, driveFileName: string, slot: 'A'|'B', englishLevel: string, suspectedAi: boolean, instructionFollowing: string, originalThinking: string, character: string, hasVoiceMemo: boolean, durationStatus: 'valid'|'too_short'|'too_long'|'unknown' }>}
 */
function mapReviewAssignmentsFromDbRows(rows, reviewerKey) {
  /** @type {Array<{ applicantId: string, age: string, essay: string, round2Prompt: string, driveFileName: string, slot: 'A'|'B', englishLevel: string, suspectedAi: boolean, instructionFollowing: string, originalThinking: string, character: string, hasVoiceMemo: boolean, durationStatus: 'valid'|'too_short'|'too_long'|'unknown' }>} */
  const assignments = [];

  for (const row of rows) {
    const applicantId = String(row.aesop_id ?? "").trim();
    if (!applicantId) {
      continue;
    }

    const reviewerA = normalizeAesopIdKey(row.reviewer_a);
    const reviewerB = normalizeAesopIdKey(row.reviewer_b);
    let slot = null;
    if (reviewerA === reviewerKey) {
      slot = "A";
    } else if (reviewerB === reviewerKey) {
      slot = "B";
    } else {
      continue;
    }

    const reviewFields = readReviewFieldsFromDbRow(row, slot);
    const driveFileId = String(row.drive_file_id ?? "").trim();
    const round2 = String(row.round2 ?? "").trim();
    const links = String(row.applicant_links ?? "").trim();
    const durationRaw = Number(row.drive_duration_seconds);
    const durationSeconds = Number.isFinite(durationRaw) ? durationRaw : null;

    assignments.push({
      applicantId,
      age: String(row.age ?? "").trim(),
      essay: String(row.essay ?? "").trim(),
      round2Prompt: String(row.round2_prompt ?? "").trim(),
      driveFileName: String(row.drive_file_name ?? "").trim(),
      slot,
      ...reviewFields,
      hasVoiceMemo: applicantHasReviewVoiceMemo({ driveFileId, round2, links }),
      durationStatus: classifyReviewVoiceDuration(durationSeconds),
    });
  }

  assignments.sort((a, b) =>
    a.applicantId.localeCompare(b.applicantId, undefined, { sensitivity: "base" }),
  );

  return assignments;
}

async function loadReviewAssignmentsForReviewerFromSheets(reviewerKey) {
  const reviewsCfg = getApplicantReviewsConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, reviewsCfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${reviewsCfg.sheetName}" was not found.`);
  }

  await worksheet.loadHeaderRow(reviewsCfg.headerRowNum);
  const rows = await worksheet.getRows();
  const applicantsById = await loadApplicantsByIdMap();

  /** @type {Array<{ applicantId: string, age: string, essay: string, round2Prompt: string, driveFileName: string, slot: 'A'|'B', englishLevel: string, suspectedAi: boolean, instructionFollowing: string, originalThinking: string, character: string, hasVoiceMemo: boolean, durationStatus: 'valid'|'too_short'|'too_long'|'unknown' }>} */
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
    const slotCols = getSlotColumns(reviewsCfg, slot);
    const reviewFields = readReviewFieldsFromRow(rowData, slotCols);
    const hasVoiceMemo = applicantHasReviewVoiceMemo({
      driveFileId: applicant?.driveFileId,
      round2: applicant?.round2,
      links: applicant?.links,
    });

    assignments.push({
      applicantId,
      age: applicant?.age || "",
      essay: applicant?.essay || "",
      round2Prompt: applicant?.round2Prompt || "",
      driveFileName: applicant?.driveFileName || "",
      slot,
      ...reviewFields,
      hasVoiceMemo,
      durationStatus: classifyReviewVoiceDuration(applicant?.driveDurationSeconds),
    });
  }

  assignments.sort((a, b) =>
    a.applicantId.localeCompare(b.applicantId, undefined, { sensitivity: "base" }),
  );

  return assignments;
}

/**
 * @param {string} reviewerAesopId
 */
/**
 * @param {string} reviewerAesopId
 * @param {string} applicantAesopId
 * @returns {Promise<boolean>}
 */
async function isReviewerAssignedToApplicant(reviewerAesopId, applicantAesopId) {
  const reviewerKey = normalizeAesopIdKey(reviewerAesopId);
  const applicantKey = normalizeAesopIdKey(applicantAesopId);
  if (!reviewerKey || !applicantKey) {
    return false;
  }

  if (isDatabaseEnabled()) {
    const fromDb = await isReviewerAssignedToApplicantFromDb(reviewerAesopId, applicantAesopId);
    if (fromDb !== null) {
      return fromDb;
    }
  }

  const reviewsCfg = getApplicantReviewsConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, reviewsCfg.sheetName);
  if (!worksheet) {
    return false;
  }

  await worksheet.loadHeaderRow(reviewsCfg.headerRowNum);
  const rows = await worksheet.getRows();
  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const applicantId = normalizeAesopIdKey(rowData[reviewsCfg.applicantIdCol]);
    if (applicantId !== applicantKey) {
      continue;
    }
    const reviewerA = normalizeAesopIdKey(rowData[reviewsCfg.reviewerACol]);
    const reviewerB = normalizeAesopIdKey(rowData[reviewsCfg.reviewerBCol]);
    if (reviewerA === reviewerKey || reviewerB === reviewerKey) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string} reviewerAesopId
 * @param {Array<{ applicantId: string, hasVoiceMemo: boolean }>} assignments
 */
function attachReviewVoiceStreamTokens(reviewerAesopId, assignments) {
  return assignments.map((assignment) => ({
    ...assignment,
    streamToken:
      assignment.hasVoiceMemo && reviewerAesopId
        ? mintReviewVoiceStreamToken(reviewerAesopId, assignment.applicantId)
        : null,
  }));
}

async function loadReviewAssignmentsForReviewer(reviewerAesopId) {
  const reviewerKey = normalizeAesopIdKey(reviewerAesopId);
  if (!reviewerKey) {
    return [];
  }

  let assignments = [];

  if (isDatabaseEnabled()) {
    const rows = await getReviewAssignmentsForReviewerFromDb(reviewerAesopId);
    if (rows && rows.length > 0) {
      assignments = mapReviewAssignmentsFromDbRows(rows, reviewerKey);
    }
  }

  if (assignments.length === 0) {
    assignments = await loadReviewAssignmentsForReviewerFromSheets(reviewerKey);
  }

  return attachReviewVoiceStreamTokens(reviewerAesopId, assignments);
}

/**
 * @param {import('google-spreadsheet').GoogleSpreadsheetWorksheet} worksheet
 * @param {ReturnType<typeof getApplicantReviewsConfig>} reviewsCfg
 * @param {number} sheetRowNumber
 * @param {'A'|'B'} slot
 * @param {{ englishLevel: string, suspectedAi: boolean, instructionFollowing: string, originalThinking: string, character: string }} values
 */
async function writeReviewCellsToSheet(worksheet, reviewsCfg, sheetRowNumber, slot, values) {
  const slotCols = getSlotColumns(reviewsCfg, slot);
  const columnIndices = [
    slotCols.level,
    slotCols.suspectedAi,
    slotCols.instructionFollowing,
    slotCols.originalThinking,
    slotCols.character,
  ];
  const gridRowIdx = sheetRowNumber - 1;

  await worksheet.loadCells({
    startRowIndex: gridRowIdx,
    endRowIndex: gridRowIdx + 1,
    startColumnIndex: Math.min(...columnIndices),
    endColumnIndex: Math.max(...columnIndices) + 1,
  });

  worksheet.getCell(gridRowIdx, slotCols.level).value = values.englishLevel;
  worksheet.getCell(gridRowIdx, slotCols.suspectedAi).value = values.suspectedAi
    ? SUSPECTED_AI_SHEET_VALUE
    : "";
  worksheet.getCell(gridRowIdx, slotCols.instructionFollowing).value = values.instructionFollowing;
  worksheet.getCell(gridRowIdx, slotCols.originalThinking).value = values.originalThinking;
  worksheet.getCell(gridRowIdx, slotCols.character).value = values.character;
  await worksheet.saveUpdatedCells();
}

/**
 * @param {Record<string, unknown>} dbRow
 * @param {'A'|'B'} slot
 * @param {{ englishLevel: string, suspectedAi: boolean, instructionFollowing: string, originalThinking: string, character: string }} values
 */
async function writeThroughReviewToDb(dbRow, slot, values) {
  const syncedAt = new Date();
  const fields = {
    aesopId: String(dbRow.aesop_id ?? "").trim(),
    reviewerA: String(dbRow.reviewer_a ?? "").trim(),
    reviewerB: String(dbRow.reviewer_b ?? "").trim(),
    aEnglishLevel: String(dbRow.a_english_level ?? "").trim(),
    aSuspectedAi: String(dbRow.a_suspected_ai ?? "").trim(),
    aInstructionFollowing: String(dbRow.a_instruction_following ?? "").trim(),
    aOriginalThinking: String(dbRow.a_original_thinking ?? "").trim(),
    aCharacter: String(dbRow.a_character ?? "").trim(),
    bEnglishLevel: String(dbRow.b_english_level ?? "").trim(),
    bSuspectedAi: String(dbRow.b_suspected_ai ?? "").trim(),
    bInstructionFollowing: String(dbRow.b_instruction_following ?? "").trim(),
    bOriginalThinking: String(dbRow.b_original_thinking ?? "").trim(),
    bCharacter: String(dbRow.b_character ?? "").trim(),
    sheetRowNumber:
      dbRow.sheet_row_number != null && Number.isFinite(Number(dbRow.sheet_row_number))
        ? Number(dbRow.sheet_row_number)
        : null,
    syncedAt,
  };

  if (slot === "A") {
    fields.aEnglishLevel = values.englishLevel;
    fields.aSuspectedAi = values.suspectedAi ? SUSPECTED_AI_SHEET_VALUE : "";
    fields.aInstructionFollowing = values.instructionFollowing;
    fields.aOriginalThinking = values.originalThinking;
    fields.aCharacter = values.character;
  } else {
    fields.bEnglishLevel = values.englishLevel;
    fields.bSuspectedAi = values.suspectedAi ? SUSPECTED_AI_SHEET_VALUE : "";
    fields.bInstructionFollowing = values.instructionFollowing;
    fields.bOriginalThinking = values.originalThinking;
    fields.bCharacter = values.character;
  }

  await upsertApplicantReviewFromMirror(fields);
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

  const hasEnglishLevel = ENGLISH_LEVELS.includes(normalizedLevel);
  if (!hasEnglishLevel && !normalizedSuspectedAi) {
    const error = new Error("English level or Suspected AI is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!FITNESS_SCORES.includes(normalizedScores.instructionFollowing)) {
    const error = new Error("Instruction Following score is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!FITNESS_SCORES.includes(normalizedScores.originalThinking)) {
    const error = new Error("Independent/Original Thinking score is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!FITNESS_SCORES.includes(normalizedScores.character)) {
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

  const normalizedValues = {
    englishLevel: normalizedLevel,
    suspectedAi: normalizedSuspectedAi,
    instructionFollowing: normalizedScores.instructionFollowing,
    originalThinking: normalizedScores.originalThinking,
    character: normalizedScores.character,
  };

  /** @type {import('google-spreadsheet').GoogleSpreadsheetRow | null} */
  let matchedRow = null;
  /** @type {'A'|'B'|null} */
  let slot = null;
  /** @type {Record<string, unknown>|null} */
  let dbRow = null;

  if (isDatabaseEnabled()) {
    dbRow = await getApplicantReviewRowFromDb(applicantAesopId);
    if (dbRow) {
      const reviewerA = normalizeAesopIdKey(dbRow.reviewer_a);
      const reviewerB = normalizeAesopIdKey(dbRow.reviewer_b);
      if (reviewerA === reviewerKey) {
        slot = "A";
      } else if (reviewerB === reviewerKey) {
        slot = "B";
      }
    }
  }

  if (slot && dbRow?.sheet_row_number) {
    await writeReviewCellsToSheet(
      worksheet,
      reviewsCfg,
      Number(dbRow.sheet_row_number),
      slot,
      normalizedValues,
    );
    await writeThroughReviewToDb(dbRow, slot, normalizedValues);
    return {
      applicantId: applicantAesopId.trim(),
      englishLevel: normalizedLevel,
      suspectedAi: normalizedSuspectedAi,
      ...normalizedScores,
    };
  }

  await worksheet.loadHeaderRow(reviewsCfg.headerRowNum);
  const rows = await worksheet.getRows();

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

  await writeReviewCellsToSheet(worksheet, reviewsCfg, matchedRow.rowNumber, slot, normalizedValues);

  const rowData = Array.isArray(matchedRow._rawData) ? matchedRow._rawData : [];
  const cell = (index) => String(rowData[index] ?? "").trim();
  await upsertApplicantReviewFromMirror({
    aesopId: applicantAesopId.trim(),
    reviewerA: cell(reviewsCfg.reviewerACol),
    reviewerB: cell(reviewsCfg.reviewerBCol),
    aEnglishLevel: slot === "A" ? normalizedValues.englishLevel : cell(reviewsCfg.aLevelCol),
    aSuspectedAi:
      slot === "A"
        ? normalizedValues.suspectedAi
          ? SUSPECTED_AI_SHEET_VALUE
          : ""
        : cell(reviewsCfg.aSuspectedAiCol),
    aInstructionFollowing:
      slot === "A" ? normalizedValues.instructionFollowing : cell(reviewsCfg.aInstructionCol),
    aOriginalThinking:
      slot === "A" ? normalizedValues.originalThinking : cell(reviewsCfg.aOriginalThinkingCol),
    aCharacter: slot === "A" ? normalizedValues.character : cell(reviewsCfg.aCharacterCol),
    bEnglishLevel: slot === "B" ? normalizedValues.englishLevel : cell(reviewsCfg.bLevelCol),
    bSuspectedAi:
      slot === "B"
        ? normalizedValues.suspectedAi
          ? SUSPECTED_AI_SHEET_VALUE
          : ""
        : cell(reviewsCfg.bSuspectedAiCol),
    bInstructionFollowing:
      slot === "B" ? normalizedValues.instructionFollowing : cell(reviewsCfg.bInstructionCol),
    bOriginalThinking:
      slot === "B" ? normalizedValues.originalThinking : cell(reviewsCfg.bOriginalThinkingCol),
    bCharacter: slot === "B" ? normalizedValues.character : cell(reviewsCfg.bCharacterCol),
    sheetRowNumber: matchedRow.rowNumber,
    syncedAt: new Date(),
  });

  return {
    applicantId: applicantAesopId.trim(),
    englishLevel: normalizedLevel,
    suspectedAi: normalizedSuspectedAi,
    ...normalizedScores,
  };
}

/**
 * @param {string} reviewerAesopId
 * @returns {Promise<boolean>}
 */
async function isListedAsApplicantReviewer(reviewerAesopId) {
  const reviewerKey = normalizeAesopIdKey(reviewerAesopId);
  if (!reviewerKey) {
    return false;
  }

  if (isDatabaseEnabled()) {
    try {
      const fromDb = await isListedAsApplicantReviewerFromDb(reviewerAesopId);
      return fromDb === true;
    } catch (error) {
      console.warn("ApplicantReviews reviewer DB lookup failed:", error.message);
      return false;
    }
  }

  const reviewsCfg = getApplicantReviewsConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, reviewsCfg.sheetName);
  if (!worksheet) {
    return false;
  }

  await worksheet.loadHeaderRow(reviewsCfg.headerRowNum);
  const rows = await worksheet.getRows();

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const reviewerA = normalizeAesopIdKey(rowData[reviewsCfg.reviewerACol]);
    const reviewerB = normalizeAesopIdKey(rowData[reviewsCfg.reviewerBCol]);
    if (reviewerA === reviewerKey || reviewerB === reviewerKey) {
      return true;
    }
  }

  return false;
}

module.exports = {
  ENGLISH_LEVELS,
  FITNESS_SCORES,
  FITNESS_CRITERIA,
  getApplicantReviewsConfig,
  normalizeEnglishLevel,
  normalizeSuspectedAi,
  normalizeFitnessScore,
  loadReviewAssignmentsForReviewer,
  saveReviewAssessment,
  isListedAsApplicantReviewer,
  isReviewerAssignedToApplicant,
};
