const { GoogleSpreadsheet } = require("google-spreadsheet");
const { GoogleAuth, JWT } = require("google-auth-library");
const config = require("../config/secrets");
const { formatGoogleApiError } = require("../utils/errorLogging");

let doc = null;
let initPromise = null;
const SHEETS_READ_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

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
      scopes: [SHEETS_READ_SCOPE],
    });
  }

  const auth = new GoogleAuth({
    scopes: [SHEETS_READ_SCOPE],
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
 * Find user email by user ID in configured sheet/columns.
 * @param {string} userId - User ID to lookup (pre-sanitized)
 * @returns {Promise<string|null>} Email if found, otherwise null
 */
async function findEmailById(userId) {
  try {
    const sheet = await initGoogleSheets();
    const sheetName = config.googleSheets.sheetName || "People";
    const worksheet = sheet.sheetsByTitle[sheetName];
    if (!worksheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    // Load rows from configured sheet.
    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.idColumn || "B");
    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");
    const normalizedId = userId.trim().toLowerCase();

    for (const row of rows) {
      try {
        const rowData = Array.isArray(row._rawData) ? row._rawData : [];
        const rowId = String(rowData[idColumnIndex] || "").trim().toLowerCase();
        if (rowId !== normalizedId) {
          continue;
        }

        const rowEmail = String(rowData[emailColumnIndex] || "").trim().toLowerCase();
        return rowEmail || null;
      } catch (rowError) {
        // Skip malformed rows
        continue;
      }
    }

    return null;
  } catch (error) {
    const formattedError = formatGoogleApiError(error);
    console.error("Error finding email by ID in Google Sheet:", formattedError);
    throw new Error(formattedError, { cause: error });
  }
}

/**
 * Find user display name by email in configured sheet.
 * Defaults to People!C:C when no explicit config is set.
 * @param {string} email - Email to lookup (pre-sanitized)
 * @returns {Promise<string|null>} Name if found, otherwise null
 */
async function findNameByEmail(email) {
  try {
    const sheet = await initGoogleSheets();
    const sheetName = config.googleSheets.sheetName || "People";
    const worksheet = sheet.sheetsByTitle[sheetName];
    if (!worksheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const rows = await worksheet.getRows();
    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");
    const nameColumnIndex = resolveColumnIndex(config.googleSheets.nameColumn || "C");
    const emailLower = email.toLowerCase().trim();

    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const rowEmail = String(rowData[emailColumnIndex] || "").trim().toLowerCase();

      if (rowEmail === emailLower) {
        const rowName = String(rowData[nameColumnIndex] || "").trim();
        return rowName || null;
      }
    }

    return null;
  } catch (error) {
    const formattedError = formatGoogleApiError(error);
    console.error("Error finding name by email in Google Sheet:", formattedError);
    throw new Error(formattedError, { cause: error });
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
    const formattedError = formatGoogleApiError(error);
    console.error("Error getting user data from Google Sheet:", formattedError);
    throw new Error(formattedError, { cause: error });
  }
}

module.exports = {
  findEmailById,
  findNameByEmail,
  getUserData,
  initGoogleSheets,
};
