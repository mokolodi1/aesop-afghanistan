const config = require("../config/secrets");
const { google } = require("googleapis");
const { formatEasternSheetTimestamp } = require("../utils/dingSheetTime");
const {
  VOICE_MEMO_MIN_DURATION_SEC,
  VOICE_MEMO_MAX_DURATION_SEC,
  VOICE_MEMO_OVERACHIEVE_SHEET_SECONDS,
  classifyVoiceMemoDuration,
  formatVoiceMemoDurationLabel,
  sheetVoiceMemoLengthSeconds,
  isTrustedVoiceMemoCachedDurationSeconds,
} = require("../utils/voiceMemoDuration");
const {
  DEFAULT_VOICE_MEMO_FILE_EXTENSIONS,
  parseVoiceMemoFileExtensions,
} = require("../utils/voiceMemoExtensions");
const { buildServiceAccountJwt } = require("./googleAuth");
const {
  scanVoiceMemoFolder,
  resolveVoiceMemoDurationsMap,
  extractDriveFileIdFromLink,
} = require("./googleDrive");
const {
  initGoogleSheets,
  getWorksheetByTitle,
  resolveColumnIndex,
  sheetsApiCall,
  chunkSheetRowWrites,
  SHEETS_BATCH_WRITE_MAX_ITEMS,
  SHEETS_BATCH_WRITE_MAX_ROW_SPAN,
} = require("./googleSheets");
const { recordSheetsApiCall, recordSheetsApiError, recordSheetsApiThrottle } = require("./portalMetrics");
const { isSheetsScriptRateLimitEnabled, isSheetsThrottleError } = require("./googleSheets");
const { isDatabaseEnabled } = require("../db/index");
const {
  getApplicantRowByAesopIdFromDb,
  getApplicantVoiceMemoDurationsMapFromDb,
} = require("./classroomDb");
const { logVoiceMemoAudioTranscodeFailures } = require("./voiceMemoAudio");
const { JOB_MAX_RUNTIME_MS } = require("./jobRuns");

const VOICE_NOTE_LINK_HEADERS = ["Voice note link", "Links"];
const VOICE_NOTE_DATE_HEADERS = [
  "Voice note last updated",
  "Date of Submission",
  "Date of submission",
];
/** Probe/cache Drive durations in chunks so progress survives OOM and GC can reclaim. */
const VOICE_MEMO_DURATION_PROBE_CHUNK_SIZE = 25;

const VOICE_NOTE_LENGTH_HEADERS = [
  "Voice memo length (secs)",
  "Voice memo length (sec)",
  "Voice memo length",
];
const ROUND2_PROMPT_HEADERS = ["Round 2 Prompt"];

/** Drive/Sheets throttling can stretch the voice memo sync; allow up to 6 hours. */
const SYNC_VOICE_MEMO_TIME_BUDGET_MS = JOB_MAX_RUNTIME_MS;

/**
 * Parse a `Voice memo length (secs)` sheet cell into whole seconds.
 * @param {unknown} rawValue
 * @returns {number|null}
 */
function parseVoiceMemoSheetLengthSeconds(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.round(parsed);
}

/**
 * @param {string[]} headerValues
 * @param {string|string[]} labels
 * @returns {number}
 */
function resolveOptionalHeaderColumnIndex(headerValues, labels) {
  const candidates = (Array.isArray(labels) ? labels : [labels])
    .map((label) => String(label || "").trim())
    .filter(Boolean);
  for (const label of candidates) {
    const want = label.toLowerCase();
    const idx = headerValues.findIndex(
      (header) => String(header || "").trim().toLowerCase() === want,
    );
    if (idx >= 0) {
      return idx;
    }
  }
  return -1;
}

/**
 * @param {string[]} rowData
 * @param {{ round2Prompt?: number }} columns
 * @returns {string}
 */
function readApplicantRound2Prompt(rowData, columns) {
  const columnIndex = columns.round2Prompt;
  if (columnIndex == null || columnIndex < 0) {
    return "";
  }
  return String(rowData[columnIndex] ?? "").trim();
}

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
 * @param {string} sheetName
 * @returns {string}
 */
function escapeSheetRangeName(sheetName) {
  return `'${String(sheetName || "").replace(/'/g, "''")}'`;
}

/**
 * Load Applicants rows with one Sheets values API call (much faster than getRows() on large tabs).
 * @param {{ deadlineAt?: number }} [options]
 * @returns {Promise<{
 *   headerValues: string[],
 *   dataRows: string[][],
 *   columns: { round1: number, round2: number, links: number, date: number, length: number },
 *   cfg: ReturnType<typeof getVoiceMemoSheetConfig>,
 * }>}
 */
async function loadApplicantsDataForStats(options = {}) {
  const cfg = getVoiceMemoSheetConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, cfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${cfg.sheetName}" was not found.`);
  }

  await sheetsApiCall(
    "loadHeaderRow(applicants stats)",
    () => worksheet.loadHeaderRow(cfg.headerRowNum),
    { deadlineAt: options.deadlineAt },
  );
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
    length: resolveOptionalHeaderColumnIndex(
      headerValues,
      voiceMemoHeaderCandidates(cfg.lengthHeader, VOICE_NOTE_LENGTH_HEADERS),
    ),
    round2Prompt: resolveOptionalHeaderColumnIndex(headerValues, ROUND2_PROMPT_HEADERS),
  };

  const sheetId = String(config.googleSheets?.sheetId || "").trim();
  if (!sheetId) {
    throw new Error("googleSheets.sheetId is not configured.");
  }

  const auth = await buildServiceAccountJwt(["https://www.googleapis.com/auth/spreadsheets.readonly"]);
  const sheets = google.sheets({ version: "v4", auth });
  const startRow = cfg.headerRowNum + 1;
  const range = `${escapeSheetRangeName(cfg.sheetName)}!A${startRow}:ZZ`;
  const response = await sheetsApiCall(
    "spreadsheets.values.get(applicants)",
    async () => {
      try {
        const result = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range,
          majorDimension: "ROWS",
        });
        recordSheetsApiCall(1);
        return result;
      } catch (error) {
        recordSheetsApiCall(1);
        if (isSheetsScriptRateLimitEnabled() && isSheetsThrottleError(error)) {
          recordSheetsApiThrottle(1);
        } else {
          recordSheetsApiError(1);
        }
        throw error;
      }
    },
    { deadlineAt: options.deadlineAt },
  );

  return {
    headerValues,
    dataRows: Array.isArray(response.data.values) ? response.data.values : [],
    columns,
    cfg,
  };
}

/**
 * @param {Record<string, unknown>} [voiceMemo]
 * @returns {{ extensions: string[], submissionTimeSource: 'createdTime'|'modifiedTime' }}
 */
function getVoiceMemoDriveScanOptions(voiceMemo = {}) {
  const vm = voiceMemo && typeof voiceMemo === "object" ? voiceMemo : {};
  const extensions = parseVoiceMemoFileExtensions(
    vm.fileExtensions ?? vm.fileExtension,
    DEFAULT_VOICE_MEMO_FILE_EXTENSIONS,
  );
  const submissionTimeSource =
    vm.submissionTimeSource === "modifiedTime" ? "modifiedTime" : "createdTime";
  return { extensions, submissionTimeSource };
}

/**
 * @param {Record<string, unknown>} [voiceMemo]
 * @returns {{ minSeconds: number, maxSeconds: number }}
 */
function getVoiceMemoDurationLimits(voiceMemo = {}) {
  const vm = voiceMemo && typeof voiceMemo === "object" ? voiceMemo : {};
  const minRaw = Number.parseInt(String(vm.minDurationSeconds ?? VOICE_MEMO_MIN_DURATION_SEC), 10);
  const maxRaw = Number.parseInt(String(vm.maxDurationSeconds ?? VOICE_MEMO_MAX_DURATION_SEC), 10);
  const minSeconds = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : VOICE_MEMO_MIN_DURATION_SEC;
  const maxSeconds =
    Number.isFinite(maxRaw) && maxRaw > minSeconds ? maxRaw : VOICE_MEMO_MAX_DURATION_SEC;
  return { minSeconds, maxSeconds };
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
 *   lengthHeader: string,
 *   submittedValue: string,
 *   acceptedValue: string,
 *   rejectedValue: string,
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
    nameColumnIndex: resolveColumnIndex(gs.admissionsNameColumn || "C"),
    emailColumnIndex: resolveColumnIndex(gs.admissionsEmailColumn || "D"),
    round1Header: voiceMemo.round1ColumnHeader || "Round 1",
    round2Header: voiceMemo.round2ColumnHeader || "Round 2",
    linksHeader: voiceMemo.linksColumnHeader || "Voice note link",
    dateHeader: voiceMemo.dateOfSubmissionColumnHeader || "Voice note last updated",
    lengthHeader: voiceMemo.lengthColumnHeader || "Voice memo length (secs)",
    submittedValue: voiceMemo.submittedValue || "Submitted",
    acceptedValue: String(voiceMemo.round1AcceptedValue || "Accepted").trim(),
    rejectedValue: String(voiceMemo.round1RejectedValue || "Rejected").trim(),
    onlyIfRound1Accepted: voiceMemo.onlyIfRound1Accepted !== false,
  };
}

/**
 * @param {string} rawValue
 * @param {ReturnType<typeof getVoiceMemoSheetConfig>} [cfg]
 * @returns {'Accepted' | 'Rejected' | 'Pending'}
 */
function classifyRound1ApplicationStatus(rawValue, cfg) {
  const resolved = cfg || getVoiceMemoSheetConfig();
  const value = String(rawValue ?? "").trim();
  if (!value) {
    return "Pending";
  }
  if (value.toLowerCase() === resolved.acceptedValue.toLowerCase()) {
    return "Accepted";
  }
  if (value.toLowerCase() === resolved.rejectedValue.toLowerCase()) {
    return "Rejected";
  }
  return "Pending";
}

/**
 * @typedef {{ name: string, aesopId: string, email: string, durationSeconds?: number|null, durationLabel?: string|null, fileName?: string|null }} ApplicationStatPerson
 */

/**
 * Count Round 1 outcomes and Round 2 voice memo submission durations.
 * @returns {Promise<{
 *   sheetName: string,
 *   round1Column: string,
 *   accepted: number,
 *   rejected: number,
 *   pending: number,
 *   total: number,
 *   voiceMemo: {
 *     submitted: number,
 *     validDuration: number,
 *     tooShort: number,
 *     tooLong: number,
 *     unknownDuration: number,
 *     minDurationSeconds: number,
 *     maxDurationSeconds: number,
 *     fileExtensions: string[],
 *   },
 *   lists: Record<string, ApplicationStatPerson[]>,
 * }>}
 */
async function getRound1ApplicationStats() {
  const startedAt = Date.now();
  const { dataRows, columns, cfg } = await loadApplicantsDataForStats();
  console.info(
    `[application-stats] loaded ${dataRows.length} Applicants row(s) in ${Date.now() - startedAt}ms`,
  );
  const durationLimits = getVoiceMemoDurationLimits(cfg.voiceMemo);
  const scanOptions = getVoiceMemoDriveScanOptions(cfg.voiceMemo);
  const submittedValue = String(cfg.submittedValue || "Submitted").trim().toLowerCase();
  const acceptedValue = cfg.acceptedValue.toLowerCase();

  /** @type {Record<string, ApplicationStatPerson[]>} */
  const lists = {
    round1Accepted: [],
    round1Rejected: [],
    round1Pending: [],
    voiceMemoSubmitted: [],
    voiceMemoValidDuration: [],
    voiceMemoTooShort: [],
    voiceMemoTooLong: [],
    voiceMemoUnknownDuration: [],
  };

  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  let total = 0;

  /** @type {Array<{ person: ApplicationStatPerson, memo: { fileId: string, fileName: string }|null, round2Submitted: boolean, round1Accepted: boolean, round1Status: 'Accepted'|'Rejected'|'Pending', sheetLengthSeconds: number|null, sheetLinkFileId: string|null }>} */
  const applicantRows = [];

  for (const rowData of dataRows) {
    const rowId = String(rowData[cfg.idColumnIndex] ?? "").trim();
    if (!rowId) {
      continue;
    }
    total += 1;
    const round1Status = classifyRound1ApplicationStatus(rowData[columns.round1], cfg);
    const round1Accepted =
      String(rowData[columns.round1] ?? "")
        .trim()
        .toLowerCase() === acceptedValue;
    const person = {
      name: String(rowData[cfg.nameColumnIndex] ?? "").trim(),
      aesopId: rowId,
      email: String(rowData[cfg.emailColumnIndex] ?? "").trim(),
    };
    if (round1Status === "Accepted") {
      accepted += 1;
      lists.round1Accepted.push(person);
    } else if (round1Status === "Rejected") {
      rejected += 1;
      lists.round1Rejected.push(person);
    } else {
      pending += 1;
      lists.round1Pending.push(person);
    }
    applicantRows.push({
      person,
      memo: null,
      round2Submitted:
        String(rowData[columns.round2] ?? "")
          .trim()
          .toLowerCase() === submittedValue,
      round1Accepted,
      round1Status,
      sheetLengthSeconds:
        columns.length >= 0 ? parseVoiceMemoSheetLengthSeconds(rowData[columns.length]) : null,
      sheetLinkFileId: extractDriveFileIdFromLink(rowData[columns.links]),
    });
  }

  const folderId = String(cfg.voiceMemo.driveFolderId || "").trim();
  /** @type {Map<string, { aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }>} */
  let memosById = new Map();
  if (folderId) {
    const driveStartedAt = Date.now();
    const scan = await scanVoiceMemoFolder(folderId, scanOptions);
    memosById = scan.memosById;
    console.info(
      `[application-stats] scanned Drive folder (${memosById.size} memo(s)) in ${Date.now() - driveStartedAt}ms`,
    );
  }

  for (const entry of applicantRows) {
    const memo = findVoiceMemoInScan(memosById, entry.person.aesopId);
    entry.memo = memo
      ? { fileId: memo.fileId, fileName: memo.fileName }
      : null;
  }

  let submitted = 0;
  let validDuration = 0;
  let tooShort = 0;
  let tooLong = 0;
  let unknownDuration = 0;
  /** @type {Set<string>} */
  const memoFileIdsNeedingProbe = new Set();
  /** Sheet Voice note link matches this Drive file id — safe to parse Postgres audio cache. */
  /** @type {Set<string>} */
  const postgresCacheFileIds = new Set();
  /** @type {Array<{ person: ApplicationStatPerson, memo: { fileId: string, fileName: string }, cachedDurationSeconds: number|null }>} */
  const memoEntries = [];

  /** @type {Map<string, number>} */
  let cachedDurationByFileId = new Map();
  /** @type {Map<string, { fileId: string|null, durationSeconds: number }>} */
  let cachedDurationByAesopId = new Map();
  if (isDatabaseEnabled()) {
    try {
      const cached = await getApplicantVoiceMemoDurationsMapFromDb();
      if (cached) {
        cachedDurationByFileId = cached.byFileId;
        cachedDurationByAesopId = cached.byAesopId;
        console.info(
          `[application-stats] loaded ${cachedDurationByFileId.size} cached Drive duration(s) from DB`,
        );
      }
    } catch (error) {
      console.warn(
        "[application-stats] could not load cached voice memo durations:",
        error.message || error,
      );
    }
  }

  for (const entry of applicantRows) {
    if (!entry.round1Accepted) {
      continue;
    }
    const hasSubmission = entry.round2Submitted || Boolean(entry.memo);
    if (!hasSubmission) {
      continue;
    }
    submitted += 1;
    lists.voiceMemoSubmitted.push({ ...entry.person });

    if (!entry.memo) {
      unknownDuration += 1;
      lists.voiceMemoUnknownDuration.push({ ...entry.person });
      continue;
    }

    const aesopKey = String(entry.person.aesopId || "").trim().toLowerCase();
    const cachedByFile = cachedDurationByFileId.get(entry.memo.fileId);
    const cachedByApplicant = cachedDurationByAesopId.get(aesopKey);
    // The sheet's "Voice memo length (secs)" column is authoritative when its
    // Voice note link still points at the scanned Drive file.
    let cachedDurationSeconds =
      entry.sheetLengthSeconds != null && entry.sheetLinkFileId === entry.memo.fileId
        ? entry.sheetLengthSeconds
        : null;
    // Otherwise fall back to the DB cache when it matches this Drive file id
    // (includes browser-corrected lengths).
    if (cachedDurationSeconds == null && isTrustedVoiceMemoCachedDurationSeconds(cachedByFile)) {
      cachedDurationSeconds = cachedByFile;
    }
    if (
      cachedDurationSeconds == null &&
      cachedByApplicant &&
      cachedByApplicant.fileId &&
      cachedByApplicant.fileId === entry.memo.fileId &&
      isTrustedVoiceMemoCachedDurationSeconds(cachedByApplicant.durationSeconds)
    ) {
      cachedDurationSeconds = cachedByApplicant.durationSeconds;
    }

    memoEntries.push({
      person: entry.person,
      memo: entry.memo,
      cachedDurationSeconds,
    });
    if (cachedDurationSeconds == null) {
      memoFileIdsNeedingProbe.add(entry.memo.fileId);
      if (entry.sheetLinkFileId === entry.memo.fileId) {
        postgresCacheFileIds.add(entry.memo.fileId);
      }
    }
  }

  const durationStartedAt = Date.now();
  const durationByFileId = await resolveVoiceMemoDurationsMap([...memoFileIdsNeedingProbe], {
    postgresCacheFileIds,
  });
  console.info(
    `[application-stats] probed ${memoFileIdsNeedingProbe.size} missing duration(s) in ${Date.now() - durationStartedAt}ms`,
  );

  for (const entry of memoEntries) {
    const probedDuration = durationByFileId.has(entry.memo.fileId)
      ? durationByFileId.get(entry.memo.fileId)
      : null;
    const durationSeconds =
      entry.cachedDurationSeconds != null
        ? sheetVoiceMemoLengthSeconds(entry.cachedDurationSeconds, durationLimits)
        : probedDuration != null && Number.isFinite(probedDuration)
          ? sheetVoiceMemoLengthSeconds(probedDuration, durationLimits)
          : null;
    const durationStatus = classifyVoiceMemoDuration(durationSeconds, durationLimits);
    const personWithDuration = {
      ...entry.person,
      durationSeconds: durationSeconds ?? null,
      durationLabel:
        durationStatus === "too_long"
          ? String(durationSeconds)
          : formatVoiceMemoDurationLabel(durationSeconds),
      fileName: entry.memo.fileName,
    };
    if (durationStatus === "valid") {
      validDuration += 1;
      lists.voiceMemoValidDuration.push(personWithDuration);
    } else if (durationStatus === "too_short") {
      tooShort += 1;
      lists.voiceMemoTooShort.push(personWithDuration);
    } else if (durationStatus === "too_long") {
      tooLong += 1;
      lists.voiceMemoTooLong.push(personWithDuration);
    } else {
      unknownDuration += 1;
      lists.voiceMemoUnknownDuration.push(personWithDuration);
    }
  }

  for (const key of Object.keys(lists)) {
    lists[key].sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.aesopId.localeCompare(b.aesopId, undefined, { sensitivity: "base" }),
    );
  }

  console.info(`[application-stats] completed in ${Date.now() - startedAt}ms`);
  logAesopIdsInLots(
    "[application-stats]",
    "voice memo too short",
    lists.voiceMemoTooShort,
  );
  logAesopIdsInLots(
    "[application-stats]",
    "voice memo too long",
    lists.voiceMemoTooLong,
  );
  logAesopIdsInLots(
    "[application-stats]",
    "voice memo duration unknown",
    lists.voiceMemoUnknownDuration,
  );

  return {
    sheetName: cfg.sheetName,
    round1Column: cfg.round1Header,
    accepted,
    rejected,
    pending,
    total,
    voiceMemo: {
      submitted,
      validDuration,
      tooShort,
      tooLong,
      unknownDuration,
      minDurationSeconds: durationLimits.minSeconds,
      maxDurationSeconds: durationLimits.maxSeconds,
      fileExtensions: scanOptions.extensions,
    },
    lists,
  };
}

/**
 * @returns {Promise<{
 *   worksheet: import('google-spreadsheet').GoogleSpreadsheetWorksheet,
 *   headerValues: string[],
 *   columns: { round1: number, round2: number, links: number, date: number, length: number },
 *   cfg: ReturnType<typeof getVoiceMemoSheetConfig>,
 * }>}
 */
/**
 * @param {{ deadlineAt?: number }} [options]
 * @returns {Promise<{
 *   worksheet: import('google-spreadsheet').GoogleSpreadsheetWorksheet,
 *   headerValues: string[],
 *   columns: { round1: number, round2: number, links: number, date: number, length: number },
 *   cfg: ReturnType<typeof getVoiceMemoSheetConfig>,
 * }>}
 */
async function loadApplicantsWorksheet(options = {}) {
  const cfg = getVoiceMemoSheetConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, cfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${cfg.sheetName}" was not found.`);
  }

  await sheetsApiCall(
    "loadHeaderRow(applicants)",
    () => worksheet.loadHeaderRow(cfg.headerRowNum),
    { deadlineAt: options.deadlineAt },
  );
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
    length: resolveOptionalHeaderColumnIndex(
      headerValues,
      voiceMemoHeaderCandidates(cfg.lengthHeader, VOICE_NOTE_LENGTH_HEADERS),
    ),
    round2Prompt: resolveOptionalHeaderColumnIndex(headerValues, ROUND2_PROMPT_HEADERS),
  };

  return { worksheet, headerValues, columns, cfg };
}

/**
 * @param {string} aesopId
 * @returns {Promise<{
 *   aesopId: string,
 *   round1: string,
 *   round2: string,
 *   links: string,
 *   submittedAt: string,
 *   email: string,
 *   round2Prompt: string,
 *   driveFileId: string|null,
 *   driveFileName: string|null,
 *   driveDurationSeconds: number|null,
 * }|null>}
 */
async function getApplicantRowFromSheet(aesopId) {
  const idKeyLower = String(aesopId || "").trim().toLowerCase();
  if (!idKeyLower) {
    return null;
  }

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
      round2Prompt: readApplicantRound2Prompt(rowData, columns),
      driveFileId: null,
      driveFileName: null,
      driveDurationSeconds: null,
    };
  }

  return null;
}

/**
 * @param {string} aesopId
 * @returns {Promise<{ aesopId: string, round1: string, round2: string, links: string, submittedAt: string, email: string, round2Prompt: string }|null>}
 */
async function getApplicantRowByAesopId(aesopId) {
  const idKey = String(aesopId || "").trim();
  if (!idKey) {
    return null;
  }

  if (isDatabaseEnabled()) {
    try {
      const { isHourlyMirrorFresh } = require("./mirrorPromote");
      if (await isHourlyMirrorFresh()) {
        const row = await getApplicantRowByAesopIdFromDb(idKey);
        if (row) {
          return row;
        }
      }
    } catch (error) {
      console.warn("Applicants DB lookup failed:", error.message);
    }
  }

  return getApplicantRowFromSheet(idKey);
}

/**
 * @param {Map<string, { aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }>} memoById
 * @param {string} aesopId
 */
function findVoiceMemoInScan(memoById, aesopId) {
  const direct = memoById.get(aesopId);
  if (direct) {
    return direct;
  }
  const normalizedLower = String(aesopId || "").trim().toLowerCase();
  if (!normalizedLower) {
    return null;
  }
  for (const [candidateId, memo] of memoById.entries()) {
    if (candidateId.toLowerCase() === normalizedLower) {
      return memo;
    }
  }
  return null;
}

/**
 * Print AESOP IDs to server logs in fixed-size lots for grep-friendly tracing.
 * @param {string} prefix
 * @param {string} label
 * @param {Array<{ aesopId?: string }|string>} entries
 * @param {{ lotSize?: number }} [options]
 */
function logAesopIdsInLots(prefix, label, entries, options = {}) {
  const lotSize = options.lotSize ?? 40;
  const ids = entries
    .map((entry) => (typeof entry === "string" ? entry : String(entry?.aesopId || "").trim()))
    .filter(Boolean);
  if (ids.length === 0) {
    return;
  }
  const totalLots = Math.ceil(ids.length / lotSize);
  for (let lotIndex = 0; lotIndex < totalLots; lotIndex += 1) {
    const lot = ids.slice(lotIndex * lotSize, (lotIndex + 1) * lotSize);
    const lotLabel = totalLots > 1 ? ` (lot ${lotIndex + 1}/${totalLots})` : "";
    console.warn(`${prefix} ${label}${lotLabel}: ${lot.join(", ")}`);
  }
}

/**
 * @param {{
 *   warnings?: string[],
 *   duplicateAesopIds?: Array<{ aesopId: string, files?: Array<{ fileName: string }> }>,
 *   unmatchedFiles?: Array<{ aesopId: string, fileName: string }>,
 *   lengthsUnknownEntries?: Array<{ aesopId: string, fileName: string, fileId: string }>,
 * }} result
 */
function logVoiceMemoSyncAudit(result) {
  for (const warning of result.warnings || []) {
    console.warn(`[sync-voice-memos] warning: ${warning}`);
  }
  for (const entry of result.duplicateAesopIds || []) {
    const names = (entry.files || []).map((file) => file.fileName).join(", ");
    console.warn(`[sync-voice-memos] duplicate AESOP ID ${entry.aesopId}: ${names}`);
  }
  logAesopIdsInLots(
    "[sync-voice-memos]",
    "unmatched voice note AESOP IDs (not on Applicants sheet)",
    (result.unmatchedFiles || []).map((entry) => entry.aesopId),
  );
  logAesopIdsInLots(
    "[sync-voice-memos]",
    "voice memo length unknown after Drive probe",
    (result.lengthsUnknownEntries || []).map((entry) => entry.aesopId),
  );
  logVoiceMemoAudioTranscodeFailures(result.audioTranscodeFailures, { label: "[sync-voice-memos]" });
}

/**
 * Build Drive audit warnings against Applicants AESOP IDs.
 * @param {Set<string>} applicantIds
 * @param {Awaited<ReturnType<typeof scanVoiceMemoFolder>>} scan
 * @param {string[]} [extensions]
 */
function buildVoiceMemoDriveWarnings(applicantIds, scan, extensions = DEFAULT_VOICE_MEMO_FILE_EXTENSIONS) {
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
    const extLabel = extensions.map((ext) => `{AESOP_ID}.${ext}`).join(" or ");
    warnings.push(
      `${scan.invalidFileNames.length} file${scan.invalidFileNames.length === 1 ? "" : "s"} in the Drive folder are not named like ${extLabel} and were ignored.`,
    );
  }

  return {
    warnings,
    duplicateAesopIds: scan.duplicateAesopIds,
    unmatchedFiles,
    invalidFileNames: scan.invalidFileNames,
  };
}

let voiceMemoSyncInFlight = false;

/**
 * Sync Round 2, Voice note link, Voice note last updated, and Voice memo length (secs)
 * from Google Drive voice memos into the Applicants sheet only (no Postgres writes).
 *
 * Lengths are only computed for rows whose sheet length is blank/invalid or whose
 * Drive file changed since the last sync (detected via the Voice note link file id).
 * When a fresh length is needed, Drive metadata is used when available; otherwise
 * cached Postgres audio is parsed when the sheet Voice note link already points at
 * that Drive file, then Drive is downloaded as a fallback.
 * Postgres mirror and audio playback cache are owned by the hourly-cache job.
 * Drive/Sheets throttling (429s) is retried with backoff, so a run may take up to 6 hours.
 *
 * @param {{ timeBudgetMs?: number }} [options]
 * @returns {Promise<{ updated: number, skippedUpToDate: number, skippedNoFile: number, skippedNotAccepted: number, skippedNoId: number, driveFileCount: number, lengthsWritten: number, lengthsCleared: number, lengthsUnknown: number, lengthsUnknownEntries: Array<{ aesopId: string, fileName: string, fileId: string }>, lengthProbes: number, warnings: string[], duplicateAesopIds: Array, unmatchedFiles: Array, invalidFileNames: string[] }>}
 */
async function syncVoiceMemoRound2Status(options = {}) {
  if (voiceMemoSyncInFlight) {
    const error = new Error(
      "A voice memo sync is already running. Please wait for it to finish and try again.",
    );
    error.statusCode = 409;
    throw error;
  }
  voiceMemoSyncInFlight = true;
  try {
    return await runVoiceMemoRound2Sync(options);
  } finally {
    voiceMemoSyncInFlight = false;
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(items, size) {
  const chunkSize = Math.max(1, Math.floor(size) || 1);
  /** @type {T[][]} */
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * @param {Array<{ aesopId: string, memo: { fileId: string, fileName: string }, lengthFromProbe: boolean, lengthSeconds: number|null }>} candidates
 * @param {Map<string, number|null>} durationByFileId
 * @param {Set<string>} fileIdsInChunk
 */
function applyProbedDurationsToCandidates(candidates, durationByFileId, fileIdsInChunk) {
  for (const candidate of candidates) {
    if (!candidate.lengthFromProbe || !fileIdsInChunk.has(candidate.memo.fileId)) {
      continue;
    }
    if (candidate.lengthSeconds != null) {
      continue;
    }
    const probed = durationByFileId.get(candidate.memo.fileId);
    if (probed == null || !Number.isFinite(probed)) {
      continue;
    }
    candidate.lengthSeconds = sheetVoiceMemoLengthSeconds(probed, getVoiceMemoDurationLimits());
    candidate.lengthFromProbe = false;
  }
}

/**
 * @param {{ timeBudgetMs?: number }} [options]
 */
async function runVoiceMemoRound2Sync(options = {}) {
  const timeBudgetMs = Number.isFinite(options.timeBudgetMs)
    ? Number(options.timeBudgetMs)
    : SYNC_VOICE_MEMO_TIME_BUDGET_MS;
  const deadlineAt = Date.now() + timeBudgetMs;

  const cfg = getVoiceMemoSheetConfig();
  const durationLimits = getVoiceMemoDurationLimits(cfg.voiceMemo);
  const folderId = String(cfg.voiceMemo.driveFolderId || "").trim();
  if (!folderId) {
    throw new Error("voiceMemo.driveFolderId is not configured.");
  }

  const scanOptions = getVoiceMemoDriveScanOptions(cfg.voiceMemo);
  console.info("[sync-voice-memos] scanning Drive voice memo folder...");
  const scanStartedAt = Date.now();
  const scan = await scanVoiceMemoFolder(folderId, { ...scanOptions, deadlineAt });
  const memoById = scan.memosById;
  console.info(
    `[sync-voice-memos] Drive scan complete: ${memoById.size} memo(s) in ${Date.now() - scanStartedAt}ms`,
  );

  // One values.get is much lighter than worksheet.getRows() on large Applicants tabs.
  console.info("[sync-voice-memos] loading Applicants sheet...");
  const sheetStartedAt = Date.now();
  let {
    dataRows,
    columns,
    cfg: sheetCfg,
  } = await loadApplicantsDataForStats({ deadlineAt });
  console.info(
    `[sync-voice-memos] Applicants sheet loaded: ${dataRows.length} row(s) in ${Date.now() - sheetStartedAt}ms`,
  );
  const round2ColIdx = columns.round2;
  const linksColIdx = columns.links;
  const dateColIdx = columns.date;
  const lengthColIdx = columns.length;
  const lengthEnabled = lengthColIdx != null && lengthColIdx >= 0;
  const round1ColIdx = sheetCfg.onlyIfRound1Accepted ? columns.round1 : null;
  const acceptedValue = sheetCfg.acceptedValue.toLowerCase();
  const submittedValue = sheetCfg.submittedValue;

  const applicantIds = new Set();
  for (const rowData of dataRows) {
    const aesopId = String(rowData[sheetCfg.idColumnIndex] ?? "").trim();
    if (aesopId) {
      applicantIds.add(aesopId);
    }
  }

  const driveWarnings = buildVoiceMemoDriveWarnings(applicantIds, scan, scanOptions.extensions);
  if (!lengthEnabled) {
    driveWarnings.warnings.push(
      `The "${sheetCfg.lengthHeader}" column was not found on the Applicants sheet, so voice memo lengths were not written.`,
    );
  }

  /** @type {Array<{ gridRowIdx: number, aesopId: string, memo: { fileId: string, fileName: string }, round2: string, links: string, submittedAt: string, baseChanged: boolean, needsLength: boolean, currentLengthRaw: string, lengthSeconds: number|null, lengthFromProbe: boolean }>} */
  const candidates = [];
  /** @type {Set<string>} */
  const probeFileIds = new Set();
  /** Sheet Voice note link matches this Drive file id — safe to parse Postgres audio cache. */
  /** @type {Set<string>} */
  const postgresCacheFileIds = new Set();
  let skippedUpToDate = 0;
  let skippedNoFile = 0;
  let skippedNotAccepted = 0;
  let skippedNoId = 0;

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
    const rowData = dataRows[rowIndex] || [];
    // values.get starts at headerRowNum + 1; grid row index is 0-based sheet row.
    const gridRowIdx = sheetCfg.headerRowNum + rowIndex;
    const aesopId = String(rowData[sheetCfg.idColumnIndex] ?? "").trim();
    if (!aesopId) {
      skippedNoId += 1;
      continue;
    }

    const memo = findVoiceMemoInScan(memoById, aesopId);
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
    const baseChanged =
      currentRound2 !== desiredRound2 ||
      currentLinks !== desiredLinks ||
      currentDate !== desiredDate;

    // Keep the sheet length only while its Voice note link still points at the same
    // Drive file; a changed file id means the recording was replaced, so recompute.
    let needsLength = false;
    let lengthSeconds = null;
    let lengthFromProbe = false;
    let currentLengthRaw = "";
    if (lengthEnabled) {
      currentLengthRaw = String(rowData[lengthColIdx] ?? "").trim();
      const sheetLengthSeconds = parseVoiceMemoSheetLengthSeconds(currentLengthRaw);
      const sheetLinkFileId = extractDriveFileIdFromLink(currentLinks);
      const sheetLengthIsCurrent =
        sheetLengthSeconds != null && sheetLinkFileId === memo.fileId;
      if (!sheetLengthIsCurrent) {
        needsLength = true;
        probeFileIds.add(memo.fileId);
        lengthFromProbe = true;
        if (sheetLinkFileId === memo.fileId) {
          postgresCacheFileIds.add(memo.fileId);
        }
      } else if (
        classifyVoiceMemoDuration(sheetLengthSeconds, durationLimits) === "too_long" &&
        sheetLengthSeconds !== VOICE_MEMO_OVERACHIEVE_SHEET_SECONDS
      ) {
        // Normalize legacy over-max lengths to the fixed sheet sentinel (300).
        needsLength = true;
        lengthSeconds = VOICE_MEMO_OVERACHIEVE_SHEET_SECONDS;
      }
    }

    if (!baseChanged && !needsLength) {
      skippedUpToDate += 1;
      continue;
    }

    candidates.push({
      gridRowIdx,
      aesopId,
      memo: { fileId: memo.fileId, fileName: memo.fileName },
      round2: desiredRound2,
      links: desiredLinks,
      submittedAt: desiredDate,
      baseChanged,
      needsLength,
      currentLengthRaw,
      lengthSeconds,
      lengthFromProbe,
    });
  }

  // Release the full sheet values payload before Drive downloads / Sheets writes.
  dataRows = [];
  applicantIds.clear();

  /** @type {Map<string, number|null>} */
  const durationByFileId = new Map();
  const probeIdList = [...probeFileIds];
  console.info(
    `[sync-voice-memos] candidates=${candidates.length}, lengthProbes=${probeIdList.length}, ` +
      `skippedUpToDate=${skippedUpToDate}, skippedNoFile=${skippedNoFile}`,
  );
  if (probeIdList.length > 0) {
    const probeStartedAt = Date.now();
    const chunks = chunkArray(probeIdList, VOICE_MEMO_DURATION_PROBE_CHUNK_SIZE);
    let probedCount = 0;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const chunkMap = await resolveVoiceMemoDurationsMap(chunk, {
        concurrency: 4,
        deadlineAt,
        postgresCacheFileIds,
      });
      for (const [fileId, duration] of chunkMap) {
        durationByFileId.set(fileId, duration);
      }
      applyProbedDurationsToCandidates(candidates, durationByFileId, new Set(chunk));
      probedCount += chunk.length;
      console.info(
        `[sync-voice-memos] probed Drive lengths chunk ${chunkIndex + 1}/${chunks.length} ` +
          `(${probedCount}/${probeIdList.length})`,
      );
    }
    console.info(
      `[sync-voice-memos] probed ${probeIdList.length} voice memo length(s) from Drive in ${Date.now() - probeStartedAt}ms`,
    );
  }

  /** @type {Array<{ gridRowIdx: number, round2: string, links: string, submittedAt: string, baseChanged: boolean, writeLength: boolean, lengthCellValue: number|'' }>} */
  const pending = [];
  let lengthsWritten = 0;
  let lengthsCleared = 0;
  let lengthsUnknown = 0;
  /** @type {Array<{ aesopId: string, fileName: string, fileId: string }>} */
  const lengthsUnknownEntries = [];

  for (const candidate of candidates) {
    let writeLength = false;
    /** @type {number|''} */
    let lengthCellValue = "";

    if (candidate.needsLength) {
      let seconds = candidate.lengthSeconds;
      if (seconds == null && candidate.lengthFromProbe) {
        const probed = durationByFileId.get(candidate.memo.fileId);
        if (probed != null && Number.isFinite(probed)) {
          seconds = Math.round(probed);
        }
      }

      if (seconds != null) {
        const sheetSeconds = sheetVoiceMemoLengthSeconds(seconds, durationLimits);
        if (sheetSeconds != null && String(sheetSeconds) !== candidate.currentLengthRaw) {
          writeLength = true;
          lengthCellValue = sheetSeconds;
          lengthsWritten += 1;
        }
      } else {
        lengthsUnknown += 1;
        lengthsUnknownEntries.push({
          aesopId: candidate.aesopId,
          fileName: candidate.memo.fileName,
          fileId: candidate.memo.fileId,
        });
        if (candidate.currentLengthRaw !== "") {
          // The Drive file changed and the new length is unknown: clear the stale value.
          writeLength = true;
          lengthCellValue = "";
          lengthsCleared += 1;
        }
      }
    }

    if (!candidate.baseChanged && !writeLength) {
      skippedUpToDate += 1;
      continue;
    }

    pending.push({
      gridRowIdx: candidate.gridRowIdx,
      round2: candidate.round2,
      links: candidate.links,
      submittedAt: candidate.submittedAt,
      baseChanged: candidate.baseChanged,
      writeLength,
      lengthCellValue,
    });
  }

  candidates.length = 0;
  durationByFileId.clear();

  const updated = pending.filter((entry) => entry.baseChanged).length;
  const driveFileCount = memoById.size;

  if (pending.length > 0) {
    pending.sort((a, b) => a.gridRowIdx - b.gridRowIdx);
    const { worksheet } = await loadApplicantsWorksheet({ deadlineAt });
    const columnIndices = [round2ColIdx, linksColIdx, dateColIdx];
    if (lengthEnabled) {
      columnIndices.push(lengthColIdx);
    }
    const minCol = Math.min(...columnIndices);
    const maxCol = Math.max(...columnIndices) + 1;
    const writeChunks = chunkSheetRowWrites(pending, {
      maxItems: SHEETS_BATCH_WRITE_MAX_ITEMS,
      maxRowSpan: SHEETS_BATCH_WRITE_MAX_ROW_SPAN,
    });
    console.info(
      `[sync-voice-memos] writing ${pending.length} Applicants row update(s) in ${writeChunks.length} chunk(s)...`,
    );

    for (let chunkIndex = 0; chunkIndex < writeChunks.length; chunkIndex += 1) {
      const chunk = writeChunks[chunkIndex];
      const minRow = chunk[0].gridRowIdx;
      const maxRow = chunk[chunk.length - 1].gridRowIdx + 1;

      await sheetsApiCall(
        `loadCells(applicants voice memo ${chunkIndex + 1}/${writeChunks.length})`,
        () =>
          worksheet.loadCells({
            startRowIndex: minRow,
            endRowIndex: maxRow,
            startColumnIndex: minCol,
            endColumnIndex: maxCol,
          }),
        { deadlineAt },
      );

      for (const entry of chunk) {
        if (entry.baseChanged) {
          worksheet.getCell(entry.gridRowIdx, round2ColIdx).value = entry.round2;
          worksheet.getCell(entry.gridRowIdx, linksColIdx).value = entry.links;
          worksheet.getCell(entry.gridRowIdx, dateColIdx).value = entry.submittedAt;
        }
        if (lengthEnabled && entry.writeLength) {
          worksheet.getCell(entry.gridRowIdx, lengthColIdx).value = entry.lengthCellValue;
        }
      }

      await sheetsApiCall(
        `saveUpdatedCells(applicants voice memo ${chunkIndex + 1}/${writeChunks.length})`,
        () => worksheet.saveUpdatedCells(),
        { deadlineAt },
      );
      console.info(
        `[sync-voice-memos] wrote Applicants chunk ${chunkIndex + 1}/${writeChunks.length} ` +
          `(rows ${minRow + 1}-${maxRow})`,
      );
    }
    console.info(
      `[sync-voice-memos] sheet sync complete: updated=${updated}, lengthsWritten=${lengthsWritten}, ` +
        `lengthsUnknown=${lengthsUnknown}, lengthProbes=${probeFileIds.size} ` +
        `(Postgres mirror is hourly-cache only)`,
    );
  }

  const result = {
    updated,
    skippedUpToDate,
    skippedNoFile,
    skippedNotAccepted,
    skippedNoId,
    driveFileCount,
    lengthsWritten,
    lengthsCleared,
    lengthsUnknown,
    lengthsUnknownEntries: lengthsUnknownEntries.sort(
      (a, b) =>
        a.aesopId.localeCompare(b.aesopId) || a.fileName.localeCompare(b.fileName),
    ),
    lengthProbes: probeFileIds.size,
    audioTranscodeFailures: [],
    ...driveWarnings,
  };
  logVoiceMemoSyncAudit(result);
  return result;
}

/**
 * @param {{ deadlineAt?: number }} [options]
 * @returns {Promise<Set<string>>} normalized lowercase AESOP IDs from the Applicants sheet
 */
async function loadApplicantAesopIdSetFromSheets(options = {}) {
  const { dataRows, cfg } = await loadApplicantsDataForStats(options);
  const ids = new Set();
  for (const rowData of dataRows) {
    const id = String(rowData[cfg.idColumnIndex] ?? "").trim().toLowerCase();
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

module.exports = {
  syncVoiceMemoRound2Status,
  loadApplicantsWorksheet,
  loadApplicantsDataForStats,
  getApplicantRowByAesopId,
  getApplicantRowFromSheet,
  loadApplicantAesopIdSetFromSheets,
  getVoiceMemoSheetConfig,
  getVoiceMemoDriveScanOptions,
  getVoiceMemoDurationLimits,
  classifyRound1ApplicationStatus,
  getRound1ApplicationStats,
  buildVoiceMemoDriveWarnings,
  logAesopIdsInLots,
  logVoiceMemoSyncAudit,
  findVoiceMemoInScan,
  readApplicantRound2Prompt,
  parseVoiceMemoSheetLengthSeconds,
};
