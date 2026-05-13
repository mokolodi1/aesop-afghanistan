const { GoogleSpreadsheet } = require("google-spreadsheet");
const { GoogleAuth, JWT } = require("google-auth-library");
const config = require("../config/secrets");
const { formatGoogleSheetsOperationError } = require("../utils/errorLogging");
const { dateToGoogleSheetsSerial, formatDingChangeTimestamp } = require("../utils/dingSheetTime");

let doc = null;
let initPromise = null;
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

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

/** Display serial datetimes like `4/27/2026 20:39:12` (still stored as a number). */
const DING_TIMESTAMP_NUMBER_FORMAT = {
  type: "DATE_TIME",
  pattern: "m/d/yyyy HH:mm:ss",
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
 * @returns {Promise<{ displayedAt: string, dingNumber: string }[]>}
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

    const tsParsed = parseSheetTimestamp(rowData[tsColumnIndex]);
    const tsMs = tsParsed === -Infinity ? null : tsParsed;
    collected.push({ tsMs, order: sheetOrder++, dingNumber: dingStr });
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

  return collected.slice(0, maxRows).map((e) => ({
    displayedAt:
      e.tsMs != null && Number.isFinite(e.tsMs)
        ? formatDingChangeTimestamp(new Date(e.tsMs))
        : "—",
    dingNumber: e.dingNumber,
  }));
}

/**
 * Append a row to the Ding changes tab: A=id, B=datetime serial, C=ding#, D=name or source label, E=note, F=phone.
 * Column D may be a fixed label (e.g. "Student portal") for self-service updates rather than a person's name.
 * Column B is a Sheets date/time serial (numeric); we apply number format `m/d/yyyy HH:mm:ss` so it
 * displays like `4/27/2026 20:39:12`. Other columns use text literals (leading ') where needed.
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

module.exports = {
  appendDingChangeRow,
  buildPastDingSummaryFromChanges,
  findEmailById,
  findLatestDingNumberById,
  findNameByEmail,
  findProfileByEmail,
  findProfileById,
  getPortalDingChangeHistory,
  getUserData,
  initGoogleSheets,
  syncAllPeoplePastDingColumns,
  syncPastDingNumbersToPeople,
};
