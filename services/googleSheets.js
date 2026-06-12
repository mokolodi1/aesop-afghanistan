const { GoogleSpreadsheet } = require("google-spreadsheet");
const { GoogleAuth, JWT } = require("google-auth-library");
const config = require("../config/secrets");
const { formatGoogleSheetsOperationError } = require("../utils/errorLogging");
const { dateToGoogleSheetsSerial, sheetDatetimeCellTextToUtcMillis } = require("../utils/dingSheetTime");

let doc = null;
let initPromise = null;
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// #region agent log
function agentDebugLog(location, message, data, hypothesisId) {
  fetch("http://127.0.0.1:7639/ingest/1051cd26-72b6-4ce7-82ae-d3b10c65d4b2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "c2ebdd" },
    body: JSON.stringify({
      sessionId: "c2ebdd",
      location,
      message,
      data,
      timestamp: Date.now(),
      hypothesisId,
    }),
  }).catch(() => {});
}
// #endregion

/**
 * Build an auth client for Google Sheets.
 * Prefers the configured Gmail service account credentials so one service
 * account can handle both Gmail API and Google Sheets access.
 * Falls back to Application Default Credentials when not configured.
 * @returns {Promise<import('google-auth-library').OAuth2Client>}
 */
async function buildSheetsAuthClient() {
  const serviceAccountCredentials = config.email?.gmailServiceAccount?.credentials;

  if (serviceAccountCredentials?.client_email && serviceAccountCredentials?.private_key) {
    return new JWT({
      email: serviceAccountCredentials.client_email,
      key: serviceAccountCredentials.private_key,
      scopes: [SHEETS_SCOPE],
    });
  }

  const auth = new GoogleAuth({
    scopes: [SHEETS_SCOPE],
  });

  return auth.getClient();
}

/**
 * Initialize Google Sheets connection
 */
async function initGoogleSheets() {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (!doc) {
      if (!config.googleSheets.sheetId) {
        throw new Error("Google Sheets sheet ID is missing.");
      }

      const authClient = await buildSheetsAuthClient();
      doc = new GoogleSpreadsheet(config.googleSheets.sheetId, authClient);
    }

    // Required before using sheetsByTitle or other sheet metadata.
    await doc.loadInfo();
    return doc;
  })().catch((error) => {
    // Allow retries if initialization fails.
    initPromise = null;
    doc = null;
    throw error;
  });

  return initPromise;
}

/**
 * Convert column reference to zero-based index.
 * Supports numeric indices or A1-style letters (A, B, ..., AA).
 * @param {string|number} columnRef
 * @returns {number}
 */
function resolveColumnIndex(columnRef) {
  if (typeof columnRef === "number" && Number.isInteger(columnRef) && columnRef >= 0) {
    return columnRef;
  }

  if (typeof columnRef !== "string") {
    throw new Error("Invalid column reference type.");
  }

  const normalized = columnRef.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error("Invalid column reference format.");
  }

  let index = 0;
  for (const char of normalized) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }

  return index - 1;
}

/** Match portal Ding history: 12-hour + comma after date (stored value is still a serial number). */
const DING_TIMESTAMP_NUMBER_FORMAT = {
  type: "DATE_TIME",
  pattern: "m/d/yyyy, h:mm:ss AM/PM",
};

/**
 * Value for USER_ENTERED so Google Sheets stores the cell as plain text (matches manual 'text entries).
 * @param {unknown} value
 * @returns {string}
 */
function googleSheetPlainText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const s = String(value).replace(/\r?\n/g, " ").trim();
  if (s === "") {
    return "";
  }
  const escaped = s.replace(/'/g, "''");
  return `'${escaped}`;
}

/**
 * Find name and email for the row where the id column matches userId.
 * @param {string} userId - User ID to lookup (pre-sanitized)
 * @returns {Promise<{ name: string, email: string, id: string, phone: string }|null>}
 */
async function findProfileById(userId) {
  try {
    const sheet = await initGoogleSheets();
    const sheetName = config.googleSheets.sheetName || "People";
    const worksheet = sheet.sheetsByTitle[sheetName];
    if (!worksheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.idColumn || "B");
    const nameColumnIndex = resolveColumnIndex(config.googleSheets.nameColumn || "C");
    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");
    let phoneColumnIndex = null;
    const pc = config.googleSheets.phoneColumn;
    if (pc === "") {
      phoneColumnIndex = null;
    } else {
      try {
        phoneColumnIndex = resolveColumnIndex(pc != null ? String(pc).trim() : "E");
      } catch {
        phoneColumnIndex = null;
      }
    }
    const normalizedId = userId.trim().toLowerCase();

    for (const row of rows) {
      try {
        const rowData = Array.isArray(row._rawData) ? row._rawData : [];
        const rowId = String(rowData[idColumnIndex] || "").trim().toLowerCase();
        if (rowId !== normalizedId) {
          continue;
        }

        const phoneRaw =
          phoneColumnIndex !== null ? String(rowData[phoneColumnIndex] ?? "").trim() : "";

        return {
          name: String(rowData[nameColumnIndex] || "").trim(),
          email: String(rowData[emailColumnIndex] || "").trim(),
          id: String(rowData[idColumnIndex] || "").trim(),
          phone: phoneRaw,
        };
      } catch (rowError) {
        continue;
      }
    }

    return null;
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.error("Error finding profile by ID in Google Sheet:", formattedError);
    throw new Error(formattedError, { cause: error });
  }
}

/**
 * Find user email by user ID in configured sheet/columns.
 * @param {string} userId - User ID to lookup (pre-sanitized)
 * @returns {Promise<string|null>} Email if found, otherwise null
 */
async function findEmailById(userId) {
  const profile = await findProfileById(userId);
  if (!profile?.email) {
    return null;
  }
  return profile.email.toLowerCase().trim() || null;
}

/**
 * Find name and email (per configured columns) for a user row matching email.
 * @param {string} email - Email to lookup (pre-sanitized)
 * @returns {Promise<{ name: string, email: string, id: string, phone: string }|null>}
 */
async function findProfileByEmail(email) {
  try {
    const sheet = await initGoogleSheets();
    const sheetName = config.googleSheets.sheetName || "People";
    const worksheet = sheet.sheetsByTitle[sheetName];
    if (!worksheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.idColumn || "B");
    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");
    const nameColumnIndex = resolveColumnIndex(config.googleSheets.nameColumn || "C");
    let phoneColumnIndex = null;
    const pc = config.googleSheets.phoneColumn;
    if (pc === "") {
      phoneColumnIndex = null;
    } else {
      try {
        phoneColumnIndex = resolveColumnIndex(pc != null ? String(pc).trim() : "E");
      } catch {
        phoneColumnIndex = null;
      }
    }
    const emailLower = email.toLowerCase().trim();

    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const rowEmail = String(rowData[emailColumnIndex] || "").trim().toLowerCase();

      if (rowEmail === emailLower) {
        const phoneRaw =
          phoneColumnIndex !== null ? String(rowData[phoneColumnIndex] ?? "").trim() : "";
        return {
          name: String(rowData[nameColumnIndex] || "").trim(),
          email: String(rowData[emailColumnIndex] || "").trim(),
          id: String(rowData[idColumnIndex] || "").trim(),
          phone: phoneRaw,
        };
      }
    }

    return null;
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.error("Error finding profile by email in Google Sheet:", formattedError);
    throw new Error(formattedError, { cause: error });
  }
}

/**
 * Find user display name by email in configured sheet.
 * @param {string} email - Email to lookup (pre-sanitized)
 * @returns {Promise<string|null>} Name if found, otherwise null
 */
async function findNameByEmail(email) {
  const profile = await findProfileByEmail(email);
  if (!profile) {
    return null;
  }
  return profile.name || null;
}

/**
 * Parse a cell value as a time for "most recent" comparison (ms since epoch).
 * @param {unknown} raw
 * @returns {number}
 */
function parseSheetTimestamp(raw) {
  if (raw == null || raw === "") {
    return -Infinity;
  }
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isNaN(t) ? -Infinity : t;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const utcCellMs = sheetDatetimeCellTextToUtcMillis(trimmed);
    if (utcCellMs != null) {
      return utcCellMs;
    }
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) {
        return parseSheetTimestamp(n);
      }
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1e12) {
      return raw;
    }
    // Google Sheets / Excel serial (fractional day = time of day)
    if (raw > 20000 && raw < 600000) {
      return (raw - 25569) * 86400000;
    }
  }
  const parsed = Date.parse(String(raw).trim());
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  return -Infinity;
}

/**
 * In the "Ding changes" tab, find rows for userId in the id column, pick the row
 * with the latest timestamp, and return the ding number from that row.
 * @param {string} userId - Student ID (pre-sanitized, same as People lookup)
 * @returns {Promise<string|null>}
 */
async function findLatestDingNumberById(userId) {
  try {
    const sheet = await initGoogleSheets();
    const dingSheetName = config.googleSheets.dingChangesSheetName || "Ding changes";
    const worksheet = sheet.sheetsByTitle[dingSheetName];
    if (!worksheet) {
      return null;
    }

    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.dingIdColumn || "A");
    const tsColumnIndex = resolveColumnIndex(config.googleSheets.dingTimestampColumn || "B");
    const dingColumnIndex = resolveColumnIndex(config.googleSheets.dingNumberColumn || "C");
    const normalizedId = userId.trim().toLowerCase();

    let bestTs = -Infinity;
    let bestDing = null;
    let fallbackDing = null;

    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const rowId = String(rowData[idColumnIndex] || "").trim().toLowerCase();
      if (rowId !== normalizedId) {
        continue;
      }

      const rawDing = rowData[dingColumnIndex];
      const dingStr = rawDing == null ? "" : String(rawDing).trim();
      if (dingStr) {
        fallbackDing = dingStr;
      }

      const ts = parseSheetTimestamp(rowData[tsColumnIndex]);
      if (ts === -Infinity) {
        continue;
      }
      if (ts >= bestTs) {
        bestTs = ts;
        bestDing = dingStr || null;
      }
    }

    if (bestTs > -Infinity) {
      return bestDing || null;
    }
    return fallbackDing || null;
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.error("Error looking up latest ding number:", formattedError);
    return null;
  }
}

/**
 * Portal: Ding change rows for one student from Ding changes (newest first).
 * @param {string} userId
 * @param {{ maxRows?: number }} [options]
 * @returns {Promise<{ atMs: number | null, dingNumber: string }[]>}
 */
async function getPortalDingChangeHistory(userId, options = {}) {
  const maxRows = Math.min(Math.max(Number(options.maxRows) || 500, 1), 1000);
  const sheet = await initGoogleSheets();
  const dingSheetName = config.googleSheets.dingChangesSheetName || "Ding changes";
  const worksheet = sheet.sheetsByTitle[dingSheetName];
  if (!worksheet) {
    return [];
  }

  worksheet.resetLocalCache(true);
  const rows = await worksheet.getRows();
  const idColumnIndex = resolveColumnIndex(config.googleSheets.dingIdColumn || "A");
  const tsColumnIndex = resolveColumnIndex(config.googleSheets.dingTimestampColumn || "B");
  const dingColumnIndex = resolveColumnIndex(config.googleSheets.dingNumberColumn || "C");
  const normalizedId = userId.trim().toLowerCase();

  /** @type {{ tsMs: number | null, order: number, dingNumber: string }[]} */
  const collected = [];
  let sheetOrder = 0;

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const rowId = String(rowData[idColumnIndex] || "").trim().toLowerCase();
    if (rowId !== normalizedId) {
      continue;
    }

    const dingStr = rowData[dingColumnIndex] == null ? "" : String(rowData[dingColumnIndex]).trim();
    if (!dingStr) {
      continue;
    }

    const rawTsCell = rowData[tsColumnIndex];
    const tsParsed = parseSheetTimestamp(rawTsCell);
    const tsMs = tsParsed === -Infinity ? null : tsParsed;
    let rawTsSnippet = null;
    if (rawTsCell != null && rawTsCell !== "") {
      if (typeof rawTsCell === "number") rawTsSnippet = rawTsCell;
      else if (typeof rawTsCell === "string") rawTsSnippet = rawTsCell.slice(0, 120);
      else if (rawTsCell instanceof Date) rawTsSnippet = rawTsCell.toISOString();
      else rawTsSnippet = String(rawTsCell).slice(0, 120);
    }

    collected.push({
      tsMs,
      order: sheetOrder++,
      dingNumber: dingStr,
      _dbgRawTsType: typeof rawTsCell,
      _dbgRawTsSnippet: rawTsSnippet,
      _dbgParsedIso: tsMs != null && Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null,
    });
  }

  collected.sort((a, b) => {
    if (a.tsMs != null && b.tsMs != null && a.tsMs !== b.tsMs) {
      return b.tsMs - a.tsMs;
    }
    if (a.tsMs != null && b.tsMs == null) {
      return -1;
    }
    if (a.tsMs == null && b.tsMs != null) {
      return 1;
    }
    return b.order - a.order;
  });

  const sheetFmt = DING_TIMESTAMP_NUMBER_FORMAT.pattern;
  for (let i = 0; i < Math.min(3, collected.length); i++) {
    const e = collected[i];
    agentDebugLog(
      "googleSheets.js:getPortalDingChangeHistory",
      "history_row_sample",
      {
        rowIdxNewestFirst: i,
        tsColumnRef: config.googleSheets.dingTimestampColumn || "B",
        rawTsType: e._dbgRawTsType,
        rawTsSnippet: e._dbgRawTsSnippet,
        atMs: e.tsMs,
        parsedUtcIso: e._dbgParsedIso,
        dingMaskedSuffix:
          typeof e.dingNumber === "string" && e.dingNumber.length >= 4 ? e.dingNumber.slice(-4) : "",
        sheetsAppliedPattern: sheetFmt,
        runId: "post-HD-fix",
      },
      "H-A,B,C,D,E",
    );
  }
  agentDebugLog(
    "googleSheets.js:getPortalDingChangeHistory",
    "history_summary",
    {
      matchedRows: collected.length,
      newestUtcIso: collected[0]?._dbgParsedIso ?? null,
      runId: "post-HD-fix",
    },
    "H-D",
  );

  return collected.slice(0, maxRows).map((e) => ({
    atMs: e.tsMs != null && Number.isFinite(e.tsMs) ? e.tsMs : null,
    dingNumber: e.dingNumber,
  }));
}

/**
 * Append a row to the Ding changes tab: A=id, B=datetime serial, C=ding#, D=name or source label, E=note, F=phone.
 * Column D may be a fixed label (e.g. "Student portal") for self-service updates rather than a person's name.
 * Column B is a Sheets date/time serial (numeric); we apply `m/d/yyyy, h:mm:ss AM/PM` so it
 * matches the portal’s 12-hour style (comma after date). Other columns use text literals (leading ') where needed.
 * Requires a header row on that sheet and spreadsheet scope for writes.
 * @param {{ userId: string, timestampAt: Date, newDingNumber: string, displayName: string, portalNote: string, phone: string }} row
 * @returns {Promise<void>}
 */
async function appendDingChangeRow(row) {
  const sheet = await initGoogleSheets();
  const dingSheetName = config.googleSheets.dingChangesSheetName || "Ding changes";
  const worksheet = sheet.sheetsByTitle[dingSheetName];
  if (!worksheet) {
    throw new Error(`Sheet "${dingSheetName}" not found.`);
  }

  const phone = typeof row.phone === "string" ? row.phone : "";

  const tsSerial = dateToGoogleSheetsSerial(row.timestampAt);
  if (!Number.isFinite(tsSerial)) {
    throw new Error("Invalid timestampAt for ding change row.");
  }

  // #region agent log
  agentDebugLog(
    "googleSheets.js:appendDingChangeRow",
    "write_ts_serial",
    {
      timestampAtIso: row.timestampAt instanceof Date ? row.timestampAt.toISOString() : null,
      tsSerial,
      sheetsAppliedPattern: DING_TIMESTAMP_NUMBER_FORMAT.pattern,
      runId: "post-HD-fix",
    },
    "H-B,D",
  );
  // #endregion

  const values = [
    googleSheetPlainText(row.userId),
    tsSerial,
    googleSheetPlainText(row.newDingNumber),
    googleSheetPlainText(row.displayName),
    googleSheetPlainText(row.portalNote),
    googleSheetPlainText(phone),
  ];
  const newRow = await worksheet.addRow(values, { insert: true, raw: false });
  const tsColIndex = resolveColumnIndex(config.googleSheets.dingTimestampColumn || "B");
  const rowNum = newRow.rowNumber;

  // Apply display format via batchUpdate. Using saveCells() on a loaded cell often yields
  // "At least one cell must have something to update" when Sheets already treats the format as unchanged.
  await worksheet._makeSingleUpdateRequest("repeatCell", {
    range: {
      sheetId: worksheet.sheetId,
      startRowIndex: rowNum - 1,
      endRowIndex: rowNum,
      startColumnIndex: tsColIndex,
      endColumnIndex: tsColIndex + 1,
    },
    cell: {
      userEnteredFormat: {
        numberFormat: DING_TIMESTAMP_NUMBER_FORMAT,
      },
    },
    fields: "userEnteredFormat.numberFormat",
  });
}

function isPeoplePastDingSyncEnabled() {
  const c = config.googleSheets.peoplePastDingColumn;
  if (c == null) {
    return false;
  }
  const s = String(c).trim();
  if (s === "" || s.toUpperCase() === "OFF") {
    return false;
  }
  return true;
}

/**
 * Order Ding change rows by timestamp column (B), then sheet order for ties / missing times.
 * @param {{ ts: number | null, order: number, ding: string }[]} matches
 */
function sortDingChangeEntries(matches) {
  matches.sort((a, b) => {
    if (a.ts != null && b.ts != null && a.ts !== b.ts) {
      return a.ts - b.ts;
    }
    if (a.ts != null && b.ts == null) {
      return -1;
    }
    if (a.ts == null && b.ts != null) {
      return 1;
    }
    return a.order - b.order;
  });
}

/**
 * Comma-separated Ding values for every change row (duplicates allowed), chronological by column B.
 * @param {{ ts: number | null, order: number, ding: string }[]} matches
 */
function pastDingSummaryFromEntries(matches) {
  sortDingChangeEntries(matches);
  return matches.map((m) => m.ding).join(", ");
}

/**
 * Every Ding change from Ding changes for this user, ordered by timestamp column B (all rows, including repeats).
 * IDs are matched case-insensitively: People `idColumn` (default B) vs Ding changes `dingIdColumn` (default A).
 * Rows without a usable timestamp come after dated rows, in sheet order.
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function buildPastDingSummaryFromChanges(userId) {
  const sheet = await initGoogleSheets();
  const dingSheetName = config.googleSheets.dingChangesSheetName || "Ding changes";
  const worksheet = sheet.sheetsByTitle[dingSheetName];
  if (!worksheet) {
    return "";
  }

  worksheet.resetLocalCache(true);

  const rows = await worksheet.getRows();
  const idColumnIndex = resolveColumnIndex(config.googleSheets.dingIdColumn || "A");
  const tsColumnIndex = resolveColumnIndex(config.googleSheets.dingTimestampColumn || "B");
  const dingColumnIndex = resolveColumnIndex(config.googleSheets.dingNumberColumn || "C");
  const normalizedId = userId.trim().toLowerCase();

  /** @type {{ ts: number | null, order: number, ding: string }[]} */
  const matches = [];
  let order = 0;

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const rowId = String(rowData[idColumnIndex] || "").trim().toLowerCase();
    if (rowId !== normalizedId) {
      continue;
    }

    const dingStr = rowData[dingColumnIndex] == null ? "" : String(rowData[dingColumnIndex]).trim();
    if (!dingStr) {
      continue;
    }

    const tsRaw = parseSheetTimestamp(rowData[tsColumnIndex]);
    const ts = tsRaw === -Infinity ? null : tsRaw;
    matches.push({ ts, order: order++, ding: dingStr });
  }

  return pastDingSummaryFromEntries(matches);
}

/**
 * Write aggregated past Ding numbers to People when the student exists on People (`idColumn`, default B).
 * History is read from Ding changes (`dingIdColumn`, default A).
 * @param {string} userId - Same ID as stored on Ding changes column A / People id column
 * @returns {Promise<boolean>} True if a matching People row was updated
 */
async function syncPastDingNumbersToPeople(userId) {
  if (!isPeoplePastDingSyncEnabled()) {
    return false;
  }

  let pastColRef;
  try {
    pastColRef = String(config.googleSheets.peoplePastDingColumn).trim();
    resolveColumnIndex(pastColRef);
  } catch {
    console.error(
      "syncPastDingNumbersToPeople: invalid googleSheets.peoplePastDingColumn:",
      config.googleSheets.peoplePastDingColumn
    );
    return false;
  }

  const summary = await buildPastDingSummaryFromChanges(userId);

  const doc = await initGoogleSheets();
  const peopleName = config.googleSheets.sheetName || "People";
  const peopleSheet = doc.sheetsByTitle[peopleName];
  if (!peopleSheet) {
    throw new Error(`Sheet "${peopleName}" not found.`);
  }

  const pastColIdx = resolveColumnIndex(pastColRef);
  const idColIdx = resolveColumnIndex(config.googleSheets.idColumn || "B");

  const rows = await peopleSheet.getRows();
  const nid = userId.trim().toLowerCase();
  let targetRowNum = null;

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const rowId = String(rowData[idColIdx] || "").trim().toLowerCase();
    if (rowId !== nid) {
      continue;
    }
    targetRowNum = row.rowNumber;
    break;
  }

  if (targetRowNum == null) {
    console.warn("syncPastDingNumbersToPeople: no People row matched id", userId);
    return false;
  }

  const gridRowIdx = targetRowNum - 1;
  await peopleSheet.loadCells({
    startRowIndex: gridRowIdx,
    endRowIndex: gridRowIdx + 1,
    startColumnIndex: pastColIdx,
    endColumnIndex: pastColIdx + 1,
  });

  const cell = peopleSheet.getCell(gridRowIdx, pastColIdx);
  cell.value = summary;
  await peopleSheet.saveUpdatedCells();
  return true;
}

/**
 * Populate People past-Ding column when an ID appears on both sheets:
 * - People ID column `googleSheets.idColumn` (default **B**)
 * - Ding changes ID column `googleSheets.dingIdColumn` (default **A**)
 *
 * For each matching People row, column `googleSheets.peoplePastDingColumn` (default **V**) is set to
 * every Ding value from `dingNumberColumn` (default **C**), ordered by `dingTimestampColumn` (default **B**).
 * Rows are walked on People so duplicate IDs each get the same history list.
 *
 * Ding-change IDs with no People row are counted and warned. Ignores peoplePastDingColumn OFF (defaults to V).
 * @returns {Promise<{ updated: number, skippedNoPeople: number, idCount: number }>}
 */
async function syncAllPeoplePastDingColumns() {
  let pastColRef = String(config.googleSheets.peoplePastDingColumn ?? "V").trim();
  if (!pastColRef || pastColRef.toUpperCase() === "OFF") {
    pastColRef = "V";
    console.warn(
      'syncAllPeoplePastDingColumns: googleSheets.peoplePastDingColumn is blank/OFF; writing column V.',
    );
  }
  resolveColumnIndex(pastColRef);

  const doc = await initGoogleSheets();
  const dingSheetName = config.googleSheets.dingChangesSheetName || "Ding changes";
  const dingWorksheet = doc.sheetsByTitle[dingSheetName];
  if (!dingWorksheet) {
    throw new Error(`Sheet "${dingSheetName}" not found.`);
  }

  dingWorksheet.resetLocalCache(true);
  const dingRows = await dingWorksheet.getRows();

  const dingIdColumnIndex = resolveColumnIndex(config.googleSheets.dingIdColumn || "A");
  const tsColumnIndex = resolveColumnIndex(config.googleSheets.dingTimestampColumn || "B");
  const dingColumnIndex = resolveColumnIndex(config.googleSheets.dingNumberColumn || "C");

  /** @type {Map<string, { ts: number | null, order: number, ding: string }[]>} */
  const byNormalizedId = new Map();
  let globalOrder = 0;

  for (const row of dingRows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const rawId = String(rowData[dingIdColumnIndex] || "").trim();
    if (!rawId) {
      continue;
    }

    const dingStr = rowData[dingColumnIndex] == null ? "" : String(rowData[dingColumnIndex]).trim();
    if (!dingStr) {
      continue;
    }

    const nid = rawId.toLowerCase();
    const tsRaw = parseSheetTimestamp(rowData[tsColumnIndex]);
    const ts = tsRaw === -Infinity ? null : tsRaw;
    const entry = { ts, order: globalOrder++, ding: dingStr };

    if (!byNormalizedId.has(nid)) {
      byNormalizedId.set(nid, []);
    }
    byNormalizedId.get(nid).push(entry);
  }

  const peopleName = config.googleSheets.sheetName || "People";
  const peopleSheet = doc.sheetsByTitle[peopleName];
  if (!peopleSheet) {
    throw new Error(`Sheet "${peopleName}" not found.`);
  }

  peopleSheet.resetLocalCache(true);
  const peopleRows = await peopleSheet.getRows();

  const peopleIdColumnRef = config.googleSheets.idColumn || "B";
  const idColIdx = resolveColumnIndex(peopleIdColumnRef);
  const pastColIdx = resolveColumnIndex(pastColRef);

  /** @type {Set<string>} */
  const peopleIdsNormalized = new Set();
  for (const row of peopleRows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const rid = String(rowData[idColIdx] || "").trim().toLowerCase();
    if (rid) {
      peopleIdsNormalized.add(rid);
    }
  }

  let skippedNoPeople = 0;
  for (const nid of byNormalizedId.keys()) {
    if (!peopleIdsNormalized.has(nid)) {
      skippedNoPeople += 1;
      console.warn(
        `syncAllPeoplePastDingColumns: Ding changes id "${nid}" has no matching People row (column ${peopleIdColumnRef}).`,
      );
    }
  }

  /** @type {{ gridRowIdx: number, summary: string }[]} */
  const pending = [];

  for (const row of peopleRows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const rawId = String(rowData[idColIdx] || "").trim();
    if (!rawId) {
      continue;
    }
    const nid = rawId.toLowerCase();
    const matches = byNormalizedId.get(nid);
    if (!matches || matches.length === 0) {
      continue;
    }
    pending.push({
      gridRowIdx: row.rowNumber - 1,
      summary: pastDingSummaryFromEntries(matches),
    });
  }

  if (pending.length === 0) {
    return { updated: 0, skippedNoPeople, idCount: byNormalizedId.size };
  }

  pending.sort((a, b) => a.gridRowIdx - b.gridRowIdx);
  const minIdx = pending[0].gridRowIdx;
  const maxIdx = pending[pending.length - 1].gridRowIdx;

  await peopleSheet.loadCells({
    startRowIndex: minIdx,
    endRowIndex: maxIdx + 1,
    startColumnIndex: pastColIdx,
    endColumnIndex: pastColIdx + 1,
  });

  for (const p of pending) {
    peopleSheet.getCell(p.gridRowIdx, pastColIdx).value = p.summary;
  }

  await peopleSheet.saveUpdatedCells();

  return {
    updated: pending.length,
    skippedNoPeople,
    idCount: byNormalizedId.size,
  };
}

/**
 * @param {string} s
 * @returns {string}
 */
function normalizePortalPersonName(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * @param {string} s
 * @returns {string}
 */
function normalizeGradeSheetHeaderLabel(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * @param {string|undefined|null} primary
 * @param {string} fallbackCsv
 * @returns {string[]}
 */
function splitGradeHeaderCandidates(primary, fallbackCsv) {
  const raw =
    primary != null && String(primary).trim() !== "" ? String(primary).trim() : fallbackCsv;
  return String(raw)
    .split(/[|,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} headerValues
 * @param {string[]} candidates
 * @returns {number}
 */
function findGradeSheetColumnIndex(headerValues, candidates) {
  if (!headerValues.length || !candidates.length) {
    return -1;
  }
  const wanted = new Set(candidates.map(normalizeGradeSheetHeaderLabel));
  for (let i = 0; i < headerValues.length; i++) {
    if (wanted.has(normalizeGradeSheetHeaderLabel(headerValues[i]))) {
      return i;
    }
  }
  return -1;
}

/**
 * Class (section) + calculated grade: match People display name to **Import: Google Grades** `Name` column.
 * @param {string} studentName
 * @returns {Promise<{ classSection: string, calculatedGrade: string }>}
 */
async function getPortalClassGradeByStudentName(studentName) {
  const plain = typeof studentName === "string" ? studentName.trim() : "";
  const want = normalizePortalPersonName(plain);
  if (!want) {
    return { classSection: "", calculatedGrade: "" };
  }

  try {
    const sheet = await initGoogleSheets();
    const gs = config.googleSheets;
    const gradesTitle = gs.googleGradesSheetName || "Import: Google Grades";
    const worksheet = sheet.sheetsByTitle[gradesTitle];
    if (!worksheet) {
      console.warn(`getPortalClassGradeByStudentName: sheet "${gradesTitle}" not found.`);
      return { classSection: "", calculatedGrade: "" };
    }

    const headerRowNum = Math.max(1, parseInt(String(gs.googleGradesHeaderRow || "1"), 10) || 1);
    await worksheet.loadHeaderRow(headerRowNum);
    const headerValues = worksheet.headerValues;
    if (!Array.isArray(headerValues) || headerValues.length === 0) {
      console.warn("getPortalClassGradeByStudentName: empty header row.");
      return { classSection: "", calculatedGrade: "" };
    }

    const nameCandidates = splitGradeHeaderCandidates(gs.googleGradesNameHeader, "Name");
    const sectionCandidates = splitGradeHeaderCandidates(gs.googleGradesSectionHeader, "Section");
    const gradeCandidates = splitGradeHeaderCandidates(
      gs.googleGradesGradeHeader,
      "Calculated Grade"
    );

    const nameIdx = findGradeSheetColumnIndex(headerValues, nameCandidates);
    const sectionIdx = findGradeSheetColumnIndex(headerValues, sectionCandidates);
    const gradeIdx = findGradeSheetColumnIndex(headerValues, gradeCandidates);

    if (nameIdx === -1 || sectionIdx === -1 || gradeIdx === -1) {
      console.warn("getPortalClassGradeByStudentName: could not map columns.", {
        nameIdx,
        sectionIdx,
        gradeIdx,
        headersPreview: headerValues.slice(0, 24),
      });
      return { classSection: "", calculatedGrade: "" };
    }

    const rows = await worksheet.getRows();
    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const cellName = normalizePortalPersonName(rowData[nameIdx]);
      if (cellName !== want) {
        continue;
      }
      return {
        classSection: String(rowData[sectionIdx] ?? "").trim(),
        calculatedGrade: String(rowData[gradeIdx] ?? "").trim(),
      };
    }

    return { classSection: "", calculatedGrade: "" };
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.warn("getPortalClassGradeByStudentName:", formattedError);
    return { classSection: "", calculatedGrade: "" };
  }
}

/**
 * **Teachers** tab: ID in column A (default), classes currently teaching in column B (default).
 * Match ID case-insensitively to signed-in AESOP ID.
 * @param {string} userId
 * @returns {Promise<{ isTeacher: boolean, teacherClasses: string }>}
 */
async function getPortalTeacherByUserId(userId) {
  const normalized = typeof userId === "string" ? userId.trim().toLowerCase() : "";
  if (!normalized) {
    return { isTeacher: false, teacherClasses: "" };
  }

  try {
    const sheet = await initGoogleSheets();
    const gs = config.googleSheets;
    const tabTitle = gs.teachersSheetName || "Teachers";
    const worksheet = sheet.sheetsByTitle[tabTitle];
    if (!worksheet) {
      return { isTeacher: false, teacherClasses: "" };
    }

    const idIdx = resolveColumnIndex(gs.teachersIdColumn || "A");
    const classesIdx = resolveColumnIndex(gs.teachersClassesColumn || "B");

    const rows = await worksheet.getRows();
    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const rowId = String(rowData[idIdx] ?? "")
        .trim()
        .toLowerCase();
      if (rowId !== normalized) {
        continue;
      }
      return {
        isTeacher: true,
        teacherClasses: String(rowData[classesIdx] ?? "").trim(),
      };
    }

    return { isTeacher: false, teacherClasses: "" };
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.warn("getPortalTeacherByUserId:", formattedError);
    return { isTeacher: false, teacherClasses: "" };
  }
}

/**
 * Build a row array placing values at specific zero-based column indices.
 * Gaps are filled with empty strings so values land in the configured columns.
 * @param {Record<number, string>} indexed
 * @returns {string[]}
 */
function buildIndexedRow(indexed) {
  const indices = Object.keys(indexed).map((k) => Number(k));
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

/**
 * Get (or create) a worksheet by title and ensure its header row matches headerByIndex.
 * @param {import('google-spreadsheet').GoogleSpreadsheet} doc
 * @param {string} title
 * @param {Record<number, string>} headerByIndex
 * @returns {Promise<import('google-spreadsheet').GoogleSpreadsheetWorksheet>}
 */
async function ensureWorksheetWithHeader(doc, title, headerByIndex) {
  const headerArray = buildIndexedRow(headerByIndex).map((h, i) => (h === "" ? `col${i}` : h));
  let worksheet = doc.sheetsByTitle[title];
  if (!worksheet) {
    worksheet = await doc.addSheet({ title, headerValues: headerArray });
    return worksheet;
  }
  await worksheet.setHeaderRow(headerArray);
  return worksheet;
}

/**
 * Replace all data rows in a tab (header preserved) with the provided indexed rows.
 * Used by the Classroom sync to rewrite the Classroom Roles / Classroom Grades tabs.
 * @param {string} title
 * @param {Record<number, string>} headerByIndex
 * @param {Record<number, string>[]} indexedRows
 * @returns {Promise<number>} Number of data rows written
 */
async function replaceTabData(title, headerByIndex, indexedRows) {
  const doc = await initGoogleSheets();
  const worksheet = await ensureWorksheetWithHeader(doc, title, headerByIndex);

  const existing = await worksheet.getRows();
  if (existing.length > 0) {
    await worksheet.clearRows();
  }

  const rows = indexedRows.map((indexed) => buildIndexedRow(indexed));
  if (rows.length > 0) {
    await worksheet.addRows(rows, { raw: false, insert: false });
  }
  return rows.length;
}

/**
 * Classroom Roles tab lookup by email. Mirrors the Teachers-tab role logic but
 * keyed on the signed-in email (populated by the Classroom sync). Returns the
 * stored role plus a convenience `isTeacher` flag and the classes they teach.
 * @param {string} email
 * @returns {Promise<{ found: boolean, role: string, isTeacher: boolean, teacherClasses: string }>}
 */
async function getRoleByEmail(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  const empty = { found: false, role: "", isTeacher: false, teacherClasses: "" };
  if (!normalized) {
    return empty;
  }

  try {
    const sheet = await initGoogleSheets();
    const cr = config.classroom || {};
    const tabTitle = cr.rolesSheetName || "Classroom Roles";
    const worksheet = sheet.sheetsByTitle[tabTitle];
    if (!worksheet) {
      return empty;
    }

    const emailIdx = resolveColumnIndex(cr.rolesEmailColumn || "A");
    const roleIdx = resolveColumnIndex(cr.rolesRoleColumn || "B");
    const classesIdx = resolveColumnIndex(cr.rolesClassesColumn || "C");

    const rows = await worksheet.getRows();
    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const rowEmail = String(rowData[emailIdx] ?? "").trim().toLowerCase();
      if (rowEmail !== normalized) {
        continue;
      }
      const role = String(rowData[roleIdx] ?? "").trim();
      const isTeacher = role.toLowerCase() === "teacher";
      return {
        found: true,
        role,
        isTeacher,
        teacherClasses: isTeacher ? String(rowData[classesIdx] ?? "").trim() : "",
      };
    }

    return empty;
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.warn("getRoleByEmail:", formattedError);
    return empty;
  }
}

/**
 * Classroom Grades tab lookup by email (populated by the Classroom sync).
 * @param {string} email
 * @returns {Promise<{ found: boolean, classSection: string, calculatedGrade: string }>}
 */
async function getClassGradeByEmail(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  const empty = { found: false, classSection: "", calculatedGrade: "" };
  if (!normalized) {
    return empty;
  }

  try {
    const sheet = await initGoogleSheets();
    const cr = config.classroom || {};
    const tabTitle = cr.gradesSheetName || "Classroom Grades";
    const worksheet = sheet.sheetsByTitle[tabTitle];
    if (!worksheet) {
      return empty;
    }

    const emailIdx = resolveColumnIndex(cr.gradesEmailColumn || "A");
    const sectionIdx = resolveColumnIndex(cr.gradesSectionColumn || "C");
    const gradeIdx = resolveColumnIndex(cr.gradesGradeColumn || "D");

    const rows = await worksheet.getRows();
    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const rowEmail = String(rowData[emailIdx] ?? "").trim().toLowerCase();
      if (rowEmail !== normalized) {
        continue;
      }
      return {
        found: true,
        classSection: String(rowData[sectionIdx] ?? "").trim(),
        calculatedGrade: String(rowData[gradeIdx] ?? "").trim(),
      };
    }

    return empty;
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.warn("getClassGradeByEmail:", formattedError);
    return empty;
  }
}

/**
 * Get user data from Google Sheet by email
 * @param {string} email - Email address
 * @returns {Promise<Object|null>} User data or null if not found
 */
async function getUserData(email) {
  try {
    const sheet = await initGoogleSheets();
    const sheetName = config.googleSheets.sheetName || "People";
    const worksheet = sheet.sheetsByTitle[sheetName];
    if (!worksheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const rows = await worksheet.getRows();

    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");
    const emailLower = email.toLowerCase().trim();

    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const rowEmail = String(rowData[emailColumnIndex] || "").trim().toLowerCase();

      if (rowEmail && rowEmail.toLowerCase().trim() === emailLower) {
        // Return all row data as object
        return row.toObject();
      }
    }

    return null;
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.error("Error getting user data from Google Sheet:", formattedError);
    throw new Error(formattedError, { cause: error });
  }
}

/**
 * Build a lookup map from normalized People-tab email to AESOP ID and display name.
 * Used to enrich Classroom rosters with student IDs for portal search.
 * @returns {Promise<Map<string, { id: string, name: string }>>}
 */
async function loadEmailToPeopleProfileMap() {
  const map = new Map();
  try {
    const sheet = await initGoogleSheets();
    const sheetName = config.googleSheets.sheetName || "People";
    const worksheet = sheet.sheetsByTitle[sheetName];
    if (!worksheet) {
      return map;
    }

    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.idColumn || "B");
    const nameColumnIndex = resolveColumnIndex(config.googleSheets.nameColumn || "C");
    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");

    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const email = String(rowData[emailColumnIndex] ?? "")
        .trim()
        .toLowerCase();
      if (!email) {
        continue;
      }
      map.set(email, {
        id: String(rowData[idColumnIndex] ?? "").trim(),
        name: String(rowData[nameColumnIndex] ?? "").trim(),
      });
    }
  } catch (error) {
    console.warn("loadEmailToPeopleProfileMap:", formatGoogleSheetsOperationError(error));
  }
  return map;
}

/**
 * Latest Ding number per AESOP ID from the Ding changes tab (one sheet pass).
 * @returns {Promise<Map<string, string>>} normalized userId -> ding number
 */
async function buildLatestDingNumberByUserIdMap() {
  const map = new Map();
  try {
    const sheet = await initGoogleSheets();
    const dingSheetName = config.googleSheets.dingChangesSheetName || "Ding changes";
    const worksheet = sheet.sheetsByTitle[dingSheetName];
    if (!worksheet) {
      return map;
    }

    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.dingIdColumn || "A");
    const tsColumnIndex = resolveColumnIndex(config.googleSheets.dingTimestampColumn || "B");
    const dingColumnIndex = resolveColumnIndex(config.googleSheets.dingNumberColumn || "C");

    /** userId -> { bestTs, ding, fallbackDing } */
    const acc = new Map();

    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const userId = String(rowData[idColumnIndex] ?? "").trim().toLowerCase();
      if (!userId) {
        continue;
      }
      const dingStr = String(rowData[dingColumnIndex] ?? "").trim();
      let entry = acc.get(userId);
      if (!entry) {
        entry = { bestTs: -Infinity, ding: "", fallbackDing: "" };
        acc.set(userId, entry);
      }
      if (dingStr) {
        entry.fallbackDing = dingStr;
      }
      const ts = parseSheetTimestamp(rowData[tsColumnIndex]);
      if (ts !== -Infinity && ts >= entry.bestTs) {
        entry.bestTs = ts;
        entry.ding = dingStr;
      }
    }

    for (const [userId, entry] of acc.entries()) {
      const ding = entry.bestTs > -Infinity ? entry.ding : entry.fallbackDing;
      if (ding) {
        map.set(userId, ding);
      }
    }
  } catch (error) {
    console.warn("buildLatestDingNumberByUserIdMap:", formatGoogleSheetsOperationError(error));
  }
  return map;
}

/**
 * All rows from the Classroom Grades tab (sync output).
 * @returns {Promise<Array<{ email: string, name: string, classSection: string, calculatedGrade: string }>>}
 */
async function listAllClassroomGradeRows() {
  try {
    const sheet = await initGoogleSheets();
    const cr = config.classroom || {};
    const tabTitle = cr.gradesSheetName || "Classroom Grades";
    const worksheet = sheet.sheetsByTitle[tabTitle];
    if (!worksheet) {
      return [];
    }

    const emailIdx = resolveColumnIndex(cr.gradesEmailColumn || "A");
    const nameIdx = resolveColumnIndex(cr.gradesNameColumn || "B");
    const sectionIdx = resolveColumnIndex(cr.gradesSectionColumn || "C");
    const gradeIdx = resolveColumnIndex(cr.gradesGradeColumn || "D");

    const rows = await worksheet.getRows();
    const out = [];
    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const email = String(rowData[emailIdx] ?? "").trim().toLowerCase();
      if (!email) {
        continue;
      }
      out.push({
        email,
        name: String(rowData[nameIdx] ?? "").trim(),
        classSection: String(rowData[sectionIdx] ?? "").trim(),
        calculatedGrade: String(rowData[gradeIdx] ?? "").trim(),
      });
    }
    return out;
  } catch (error) {
    console.warn("listAllClassroomGradeRows:", formatGoogleSheetsOperationError(error));
    return [];
  }
}

/**
 * Search People tab by partial AESOP ID, name, or email (admin lookup).
 * @param {string} query
 * @param {number} [limit]
 */
async function searchPeopleProfiles(query, limit = 25) {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q || q.length < 2) {
    return [];
  }

  try {
    const sheet = await initGoogleSheets();
    const sheetName = config.googleSheets.sheetName || "People";
    const worksheet = sheet.sheetsByTitle[sheetName];
    if (!worksheet) {
      return [];
    }

    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.idColumn || "B");
    const nameColumnIndex = resolveColumnIndex(config.googleSheets.nameColumn || "C");
    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");
    let phoneColumnIndex = null;
    const pc = config.googleSheets.phoneColumn;
    if (pc !== "") {
      try {
        phoneColumnIndex = resolveColumnIndex(pc != null ? String(pc).trim() : "E");
      } catch {
        phoneColumnIndex = null;
      }
    }

    const matches = [];
    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const id = String(rowData[idColumnIndex] ?? "").trim();
      const name = String(rowData[nameColumnIndex] ?? "").trim();
      const email = String(rowData[emailColumnIndex] ?? "").trim();
      const phone =
        phoneColumnIndex !== null ? String(rowData[phoneColumnIndex] ?? "").trim() : "";
      const haystack = `${id} ${name} ${email}`.toLowerCase();
      if (!haystack.includes(q)) {
        continue;
      }
      matches.push({ id, name, email, phone });
      if (matches.length >= limit) {
        break;
      }
    }
    return matches;
  } catch (error) {
    console.warn("searchPeopleProfiles:", formatGoogleSheetsOperationError(error));
    return [];
  }
}

/**
 * Count data rows in Classroom Roles / Grades tabs (admin dashboard).
 */
async function getClassroomTabStats() {
  try {
    const sheet = await initGoogleSheets();
    const cr = config.classroom || {};
    const rolesTitle = cr.rolesSheetName || "Classroom Roles";
    const gradesTitle = cr.gradesSheetName || "Classroom Grades";
    const rolesSheet = sheet.sheetsByTitle[rolesTitle];
    const gradesSheet = sheet.sheetsByTitle[gradesTitle];
    const rolesRows = rolesSheet ? (await rolesSheet.getRows()).length : 0;
    const gradesRows = gradesSheet ? (await gradesSheet.getRows()).length : 0;
    return { rolesRows, gradesRows, rolesTitle, gradesTitle };
  } catch (error) {
    console.warn("getClassroomTabStats:", formatGoogleSheetsOperationError(error));
    return { rolesRows: 0, gradesRows: 0, rolesTitle: "", gradesTitle: "" };
  }
}

module.exports = {
  appendDingChangeRow,
  buildPastDingSummaryFromChanges,
  buildLatestDingNumberByUserIdMap,
  findEmailById,
  findLatestDingNumberById,
  findNameByEmail,
  findProfileByEmail,
  findProfileById,
  getClassroomTabStats,
  loadEmailToPeopleProfileMap,
  listAllClassroomGradeRows,
  searchPeopleProfiles,
  getPortalDingChangeHistory,
  getPortalClassGradeByStudentName,
  getPortalTeacherByUserId,
  getRoleByEmail,
  getClassGradeByEmail,
  getUserData,
  initGoogleSheets,
  replaceTabData,
  resolveColumnIndex,
  syncAllPeoplePastDingColumns,
  syncPastDingNumbersToPeople,
};
