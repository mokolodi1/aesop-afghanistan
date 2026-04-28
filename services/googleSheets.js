const { GoogleSpreadsheet } = require("google-spreadsheet");
const { GoogleAuth, JWT } = require("google-auth-library");
const config = require("../config/secrets");
const { formatGoogleApiError } = require("../utils/errorLogging");

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
    const formattedError = formatGoogleApiError(error);
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
    const formattedError = formatGoogleApiError(error);
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
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1e12) {
      return raw;
    }
    if (raw > 20000 && raw < 120000) {
      return (raw - 25569) * 86400 * 1000;
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
    const formattedError = formatGoogleApiError(error);
    console.error("Error looking up latest ding number:", formattedError);
    return null;
  }
}

/**
 * Append a row to the Ding changes tab: A=id, B=timestamp, C=ding#, D=name, E=note, F=phone.
 * ID, ding number, name, note, phone use Sheets text literals (leading ') so numbers stay text.
 * Requires a header row on that sheet and spreadsheet scope for writes.
 * @param {{ userId: string, timestamp: string, newDingNumber: string, displayName: string, portalNote: string, phone: string }} row
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

  const values = [
    googleSheetPlainText(row.userId),
    row.timestamp,
    googleSheetPlainText(row.newDingNumber),
    googleSheetPlainText(row.displayName),
    googleSheetPlainText(row.portalNote),
    googleSheetPlainText(phone),
  ];
  await worksheet.addRow(values, { insert: true, raw: false });
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
    const formattedError = formatGoogleApiError(error);
    console.error("Error getting user data from Google Sheet:", formattedError);
    throw new Error(formattedError, { cause: error });
  }
}

module.exports = {
  appendDingChangeRow,
  findEmailById,
  findLatestDingNumberById,
  findNameByEmail,
  findProfileByEmail,
  findProfileById,
  getUserData,
  initGoogleSheets,
};
