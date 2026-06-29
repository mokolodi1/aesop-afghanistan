const config = require("../config/secrets");
const { formatEasternSheetTimestamp } = require("../utils/dingSheetTime");
const { scanVoiceMemoFolder } = require("./googleDrive");
const {
  initGoogleSheets,
  getWorksheetByTitle,
  resolveColumnIndex,
} = require("./googleSheets");

const VOICE_NOTE_LINK_HEADERS = ["Voice note link", "Links"];
const VOICE_NOTE_DATE_HEADERS = [
  "Voice note last updated",
  "Date of Submission",
  "Date of submission",
];

/**
 * @param {string[]} headerValues
 * @param {string|string[]} labels
 * @returns {number}
 */
function resolveHeaderColumnIndex(headerValues, labels) {
  const candidates = (Array.isArray(labels) ? labels : [labels])
    .map((label) => String(label || "").trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    throw new Error("A column header label is required.");
  }
  for (const label of candidates) {
    const want = label.toLowerCase();
    const idx = headerValues.findIndex(
      (header) => String(header || "").trim().toLowerCase() === want,
    );
    if (idx >= 0) {
      return idx;
    }
  }
  throw new Error(
    `Column "${candidates[0]}" was not found on the Applicants sheet. Expected one of: ${candidates.join(", ")}.`,
  );
}

/**
 * @param {string} configuredHeader
 * @param {string[]} knownHeaders
 * @returns {string[]}
 */
function voiceMemoHeaderCandidates(configuredHeader, knownHeaders) {
  const configured = String(configuredHeader || "").trim();
  const merged = configured ? [configured, ...knownHeaders] : knownHeaders;
  return [...new Set(merged.map((label) => String(label || "").trim()).filter(Boolean))];
}

/**
 * @returns {{
 *   voiceMemo: Record<string, unknown>,
 *   sheetName: string,
 *   headerRowNum: number,
 *   idColumnIndex: number,
 *   emailColumnIndex: number,
 *   round1Header: string,
 *   round2Header: string,
 *   linksHeader: string,
 *   dateHeader: string,
 *   submittedValue: string,
 *   acceptedValue: string,
 *   onlyIfRound1Accepted: boolean,
 * }}
 */
function getVoiceMemoSheetConfig() {
  const voiceMemo = config.voiceMemo || {};
  const gs = config.googleSheets || {};
  return {
    voiceMemo,
    sheetName: gs.admissionsSheetName || "Applicants",
    headerRowNum: Math.max(1, parseInt(String(gs.admissionsHeaderRow || "1"), 10) || 1),
    idColumnIndex: resolveColumnIndex(gs.admissionsIdColumn || "A"),
    emailColumnIndex: resolveColumnIndex(gs.admissionsEmailColumn || "D"),
    round1Header: voiceMemo.round1ColumnHeader || "Round 1",
    round2Header: voiceMemo.round2ColumnHeader || "Round 2",
    linksHeader: voiceMemo.linksColumnHeader || "Voice note link",
    dateHeader: voiceMemo.dateOfSubmissionColumnHeader || "Voice note last updated",
    submittedValue: voiceMemo.submittedValue || "Submitted",
    acceptedValue: String(voiceMemo.round1AcceptedValue || "Accepted").trim(),
    onlyIfRound1Accepted: voiceMemo.onlyIfRound1Accepted !== false,
  };
}

/**
 * @returns {Promise<{
 *   worksheet: import('google-spreadsheet').GoogleSpreadsheetWorksheet,
 *   headerValues: string[],
 *   columns: { round1: number, round2: number, links: number, date: number },
 *   cfg: ReturnType<typeof getVoiceMemoSheetConfig>,
 * }>}
 */
async function loadApplicantsWorksheet() {
  const cfg = getVoiceMemoSheetConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, cfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${cfg.sheetName}" was not found.`);
  }

  await worksheet.loadHeaderRow(cfg.headerRowNum);
  const headerValues = Array.isArray(worksheet.headerValues) ? worksheet.headerValues : [];
  const columns = {
    round1: resolveHeaderColumnIndex(headerValues, cfg.round1Header),
    round2: resolveHeaderColumnIndex(headerValues, cfg.round2Header),
    links: resolveHeaderColumnIndex(
      headerValues,
      voiceMemoHeaderCandidates(cfg.linksHeader, VOICE_NOTE_LINK_HEADERS),
    ),
    date: resolveHeaderColumnIndex(
      headerValues,
      voiceMemoHeaderCandidates(cfg.dateHeader, VOICE_NOTE_DATE_HEADERS),
    ),
  };

  return { worksheet, headerValues, columns, cfg };
}

/**
 * @param {string} aesopId
 * @returns {Promise<{ aesopId: string, round1: string, round2: string, links: string, submittedAt: string, email: string }|null>}
 */
async function getApplicantRowByAesopId(aesopId) {
  const idKey = String(aesopId || "").trim();
  if (!idKey) {
    return null;
  }
  const idKeyLower = idKey.toLowerCase();

  const { worksheet, columns, cfg } = await loadApplicantsWorksheet();
  const rows = await worksheet.getRows();

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const rowId = String(rowData[cfg.idColumnIndex] ?? "").trim();
    if (rowId.toLowerCase() !== idKeyLower) {
      continue;
    }
    return {
      aesopId: rowId,
      round1: String(rowData[columns.round1] ?? "").trim(),
      round2: String(rowData[columns.round2] ?? "").trim(),
      links: String(rowData[columns.links] ?? "").trim(),
      submittedAt: String(rowData[columns.date] ?? "").trim(),
      email: String(rowData[cfg.emailColumnIndex] ?? "").trim(),
    };
  }

  return null;
}

/**
 * Build Drive audit warnings against Applicants AESOP IDs.
 * @param {Set<string>} applicantIds
 * @param {Awaited<ReturnType<typeof scanVoiceMemoFolder>>} scan
 */
function buildVoiceMemoDriveWarnings(applicantIds, scan) {
  const unmatchedFiles = scan.parsedFiles
    .filter((file) => !applicantIds.has(file.aesopId))
    .map((file) => ({ aesopId: file.aesopId, fileName: file.fileName }))
    .sort((a, b) => a.aesopId.localeCompare(b.aesopId) || a.fileName.localeCompare(b.fileName));

  const warnings = [];
  if (scan.duplicateAesopIds.length > 0) {
    warnings.push(
      `${scan.duplicateAesopIds.length} AESOP ID${scan.duplicateAesopIds.length === 1 ? "" : "s"} have more than one voice note in Drive. The newest file is used for sync and playback.`,
    );
  }
  if (unmatchedFiles.length > 0) {
    warnings.push(
      `${unmatchedFiles.length} voice note file${unmatchedFiles.length === 1 ? "" : "s"} in Drive do not match any AESOP ID on the Applicants sheet.`,
    );
  }
  if (scan.invalidFileNames.length > 0) {
    warnings.push(
      `${scan.invalidFileNames.length} file${scan.invalidFileNames.length === 1 ? "" : "s"} in the Drive folder are not named like {AESOP_ID}.m4a and were ignored.`,
    );
  }

  return {
    warnings,
    duplicateAesopIds: scan.duplicateAesopIds,
    unmatchedFiles,
    invalidFileNames: scan.invalidFileNames,
  };
}

/**
 * Sync Round 2, Voice note link, and Voice note last updated from Google Drive voice memos.
 * @returns {Promise<{ updated: number, skippedUpToDate: number, skippedNoFile: number, skippedNotAccepted: number, skippedNoId: number, driveFileCount: number, warnings: string[], duplicateAesopIds: Array, unmatchedFiles: Array, invalidFileNames: string[] }>}
 */
async function syncVoiceMemoRound2Status() {
  const cfg = getVoiceMemoSheetConfig();
  const folderId = String(cfg.voiceMemo.driveFolderId || "").trim();
  if (!folderId) {
    throw new Error("voiceMemo.driveFolderId is not configured.");
  }

  const scan = await scanVoiceMemoFolder(folderId, {
    extension: cfg.voiceMemo.fileExtension || "m4a",
    submissionTimeSource: cfg.voiceMemo.submissionTimeSource || "createdTime",
  });
  const memoById = scan.memosById;

  const { worksheet, columns, cfg: sheetCfg } = await loadApplicantsWorksheet();
  const round2ColIdx = columns.round2;
  const linksColIdx = columns.links;
  const dateColIdx = columns.date;
  const round1ColIdx = sheetCfg.onlyIfRound1Accepted ? columns.round1 : null;
  const acceptedValue = sheetCfg.acceptedValue.toLowerCase();
  const submittedValue = sheetCfg.submittedValue;

  const rows = await worksheet.getRows();
  const applicantIds = new Set();
  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const aesopId = String(rowData[sheetCfg.idColumnIndex] ?? "").trim();
    if (aesopId) {
      applicantIds.add(aesopId);
    }
  }

  const driveWarnings = buildVoiceMemoDriveWarnings(applicantIds, scan);
  /** @type {Array<{ gridRowIdx: number, round2: string, links: string, submittedAt: string }>} */
  const pending = [];
  let skippedUpToDate = 0;
  let skippedNoFile = 0;
  let skippedNotAccepted = 0;
  let skippedNoId = 0;

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const aesopId = String(rowData[sheetCfg.idColumnIndex] ?? "").trim();
    if (!aesopId) {
      skippedNoId += 1;
      continue;
    }

    const memo = memoById.get(aesopId);
    if (!memo) {
      skippedNoFile += 1;
      continue;
    }

    if (sheetCfg.onlyIfRound1Accepted && round1ColIdx != null) {
      const round1Value = String(rowData[round1ColIdx] ?? "")
        .trim()
        .toLowerCase();
      if (round1Value !== acceptedValue) {
        skippedNotAccepted += 1;
        continue;
      }
    }

    const desiredRound2 = submittedValue;
    const desiredLinks = memo.webViewLink;
    const desiredDate = formatEasternSheetTimestamp(memo.submittedAt);
    const currentRound2 = String(rowData[round2ColIdx] ?? "").trim();
    const currentLinks = String(rowData[linksColIdx] ?? "").trim();
    const currentDate = String(rowData[dateColIdx] ?? "").trim();

    if (
      currentRound2 === desiredRound2 &&
      currentLinks === desiredLinks &&
      currentDate === desiredDate
    ) {
      skippedUpToDate += 1;
      continue;
    }

    pending.push({
      gridRowIdx: row.rowNumber - 1,
      round2: desiredRound2,
      links: desiredLinks,
      submittedAt: desiredDate,
    });
  }

  if (pending.length === 0) {
    return {
      updated: 0,
      skippedUpToDate,
      skippedNoFile,
      skippedNotAccepted,
      skippedNoId,
      driveFileCount: memoById.size,
      ...driveWarnings,
    };
  }

  const columnIndices = [round2ColIdx, linksColIdx, dateColIdx];
  const minRow = Math.min(...pending.map((entry) => entry.gridRowIdx));
  const maxRow = Math.max(...pending.map((entry) => entry.gridRowIdx)) + 1;
  const minCol = Math.min(...columnIndices);
  const maxCol = Math.max(...columnIndices) + 1;

  await worksheet.loadCells({
    startRowIndex: minRow,
    endRowIndex: maxRow,
    startColumnIndex: minCol,
    endColumnIndex: maxCol,
  });

  for (const entry of pending) {
    worksheet.getCell(entry.gridRowIdx, round2ColIdx).value = entry.round2;
    worksheet.getCell(entry.gridRowIdx, linksColIdx).value = entry.links;
    worksheet.getCell(entry.gridRowIdx, dateColIdx).value = entry.submittedAt;
  }

  await worksheet.saveUpdatedCells();

  return {
    updated: pending.length,
    skippedUpToDate,
    skippedNoFile,
    skippedNotAccepted,
    skippedNoId,
    driveFileCount: memoById.size,
    ...driveWarnings,
  };
}

module.exports = {
  syncVoiceMemoRound2Status,
  loadApplicantsWorksheet,
  getApplicantRowByAesopId,
  getVoiceMemoSheetConfig,
  buildVoiceMemoDriveWarnings,
};
