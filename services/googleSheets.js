const { GoogleSpreadsheet } = require("google-spreadsheet");
const config = require("../config/secrets");
const { buildServiceAccountJwt } = require("./googleAuth");
const { formatGoogleSheetsOperationError } = require("../utils/errorLogging");
const { dateToGoogleSheetsSerial, formatEasternSheetTimestamp, sheetDatetimeCellTextToUtcMillis } = require("../utils/dingSheetTime");
const { isDatabaseEnabled } = require("../db/index");
const { getPersonByAesopId, isPeopleIdentityFresh, personRowToProfile } = require("./classroomDb");

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
  return buildServiceAccountJwt([SHEETS_SCOPE]);
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
 * Resolve a worksheet by tab title, reloading spreadsheet metadata once if missing
 * (handles tabs added after the server started).
 * @param {import('google-spreadsheet').GoogleSpreadsheet} doc
 * @param {string} title
 * @returns {Promise<import('google-spreadsheet').GoogleSpreadsheetWorksheet|null>}
 */
async function getWorksheetByTitle(doc, title) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) {
    return null;
  }
  let worksheet = doc.sheetsByTitle[normalizedTitle];
  if (worksheet) {
    return worksheet;
  }
  await doc.loadInfo();
  return doc.sheetsByTitle[normalizedTitle] || null;
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

function resolvePeopleRoleColumnIndex() {
  const columnRef = config.googleSheets.peopleRoleColumn;
  if (columnRef == null || String(columnRef).trim() === "" || String(columnRef).trim().toUpperCase() === "OFF") {
    return null;
  }
  try {
    return resolveColumnIndex(String(columnRef).trim());
  } catch {
    return null;
  }
}

function resolvePeopleTypeColumnIndex() {
  const columnRef = config.googleSheets.peopleTypeColumn;
  if (columnRef == null || String(columnRef).trim() === "" || String(columnRef).trim().toUpperCase() === "OFF") {
    return null;
  }
  try {
    return resolveColumnIndex(String(columnRef).trim());
  } catch {
    return null;
  }
}

function resolvePeoplePhoneColumnIndex() {
  const columnRef = config.googleSheets.phoneColumn;
  if (columnRef === "") {
    return null;
  }
  try {
    const ref =
      columnRef != null && String(columnRef).trim() !== "" ? String(columnRef).trim() : "F";
    return resolveColumnIndex(ref);
  } catch {
    return null;
  }
}

function peopleTypeHeaderCandidates() {
  const configured = config.googleSheets.peopleTypeHeader;
  const fromConfig = configured != null && String(configured).trim() !== "" ? [String(configured).trim()] : [];
  return [...fromConfig, "Type (teacher, student)", "Type", "Teacher/Student"];
}

function readPeopleType(rowData, typeColumnIndex) {
  if (typeColumnIndex === null) {
    return "";
  }
  return String(rowData[typeColumnIndex] ?? "").trim();
}

/**
 * @param {import("google-spreadsheet").GoogleSpreadsheetRow | null | undefined} row
 * @param {string[]} rowData
 * @param {number | null} typeColumnIndex
 */
function readPeopleTypeFromRow(row, rowData, typeColumnIndex) {
  if (row && typeof row.get === "function") {
    for (const header of peopleTypeHeaderCandidates()) {
      try {
        const value = row.get(header);
        if (value != null && String(value).trim() !== "") {
          return String(value).trim();
        }
      } catch {
        // Header not registered on this worksheet.
      }
    }
  }
  return readPeopleType(rowData, typeColumnIndex);
}

/**
 * Parse People column E values like:
 * - "Student: E-1 (24.5%)" or "Teacher: I-1"
 * - "Stud. A-1 (18.0%) / Teach I-3" (student in one class, teacher in another)
 * When both student and teacher markers appear, Teacher wins (matches status priority).
 * @param {unknown} rawType
 * @returns {"Teacher"|"Student"|null}
 */
function parsePortalRoleFromPeopleType(rawType) {
  const text = String(rawType || "").trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();

  const hasTeacher =
    lower.startsWith("teacher:") ||
    /^teacher\b/.test(lower) ||
    /^teach\b/.test(lower) ||
    /\/\s*teach\b/.test(lower);

  const hasStudent =
    lower.startsWith("student:") ||
    /^student\b/.test(lower) ||
    /^stud\./.test(lower) ||
    /\bstud\./.test(lower);

  if (hasTeacher && hasStudent) {
    return "Teacher";
  }
  if (hasTeacher) {
    return "Teacher";
  }
  if (hasStudent) {
    return "Student";
  }
  return null;
}

/**
 * Resolve portal_role from People tab type column, Admins column, and Applicants tab membership.
 * @param {{ id?: string, peopleType?: string, portalRole?: string }} profile
 * @param {Set<string>|null|undefined} applicantIdSet lowercase AESOP IDs from Applicants sheet
 * @returns {"Admin"|"Teacher"|"Student"|"Applied"|null}
 */
function resolvePortalRoleFromPeopleSheet(profile, applicantIdSet) {
  const adminRaw = profile?.portalRole || "";
  if (isPeopleSheetAdminRole(adminRaw)) {
    return "Admin";
  }

  const fromType = parsePortalRoleFromPeopleType(profile?.peopleType);
  if (fromType) {
    return fromType;
  }

  const typeText = String(profile?.peopleType || "").trim();
  if (!typeText) {
    const idKey = String(profile?.id || "").trim().toLowerCase();
    if (idKey && applicantIdSet && applicantIdSet.has(idKey)) {
      return "Applied";
    }
  }

  return null;
}

function resolvePeopleReviewerColumnIndex() {
  const columnRef = config.googleSheets.peopleReviewerColumn;
  if (columnRef == null || String(columnRef).trim() === "" || String(columnRef).trim().toUpperCase() === "OFF") {
    return null;
  }
  try {
    return resolveColumnIndex(String(columnRef).trim());
  } catch {
    return null;
  }
}

function readPeoplePortalRole(rowData, roleColumnIndex) {
  if (roleColumnIndex === null) {
    return "";
  }
  return String(rowData[roleColumnIndex] ?? "").trim();
}

function resolvePeopleStatusColumnIndex() {
  const columnRef = config.googleSheets.peopleStatusColumn;
  if (columnRef == null || String(columnRef).trim() === "" || String(columnRef).trim().toUpperCase() === "OFF") {
    return null;
  }
  try {
    return resolveColumnIndex(String(columnRef).trim());
  } catch {
    return null;
  }
}

function peopleStatusHeaderCandidates() {
  const configured = config.googleSheets.peopleStatusHeader;
  const fromConfig = configured != null && String(configured).trim() !== "" ? [String(configured).trim()] : [];
  return [...fromConfig, "Status"];
}

function readPeopleStatus(rowData, statusColumnIndex) {
  if (statusColumnIndex === null) {
    return "";
  }
  return String(rowData[statusColumnIndex] ?? "").trim();
}

/**
 * Read applicant/participant status from People Status column (default T).
 * @param {import("google-spreadsheet").GoogleSpreadsheetRow | null | undefined} row
 * @param {string[]} rowData
 * @param {number | null} statusColumnIndex
 */
function readPeopleStatusFromRow(row, rowData, statusColumnIndex) {
  if (row && typeof row.get === "function") {
    for (const header of peopleStatusHeaderCandidates()) {
      try {
        const value = row.get(header);
        if (value != null && String(value).trim() !== "") {
          return String(value).trim();
        }
      } catch {
        // Header not registered on this worksheet.
      }
    }
  }
  return readPeopleStatus(rowData, statusColumnIndex);
}

/** AESOP applicant IDs use the 262 prefix; empty Status defaults to Applied. */
function isAppliedAesopId(aesopId) {
  return String(aesopId || "").trim().startsWith("262");
}

const PEOPLE_STATUS_APPLIED = "Applied";
const PEOPLE_STATUS_ADMITTED = "Admitted";
const PEOPLE_STATUS_TEACHING = "Teaching";

function normalizePeopleStatusValue(status) {
  return String(status || "").trim().toLowerCase();
}

function resolvePeopleStatus(aesopId, rawStatus) {
  const trimmed = String(rawStatus || "").trim();
  if (trimmed) {
    return trimmed;
  }
  if (isAppliedAesopId(aesopId)) {
    return PEOPLE_STATUS_APPLIED;
  }
  return "";
}

function isAppliedPeopleStatus(status) {
  return normalizePeopleStatusValue(status) === "applied";
}

function isAdmittedPeopleStatus(status) {
  return normalizePeopleStatusValue(status) === "admitted";
}

function isTeachingPeopleStatus(status) {
  return normalizePeopleStatusValue(status) === "teaching";
}

/**
 * Derive People sheet Status column value from Classroom role + AESOP ID.
 * Priority: Teaching > Admitted > Applied (262 applicants not yet in Classroom).
 * @param {{ aesopId?: string, isTeacher?: boolean, isStudent?: boolean }} params
 * @returns {string}
 */
function derivePeopleSheetStatus({ aesopId = "", isTeacher = false, isStudent = false }) {
  if (isTeacher) {
    return PEOPLE_STATUS_TEACHING;
  }
  if (isStudent) {
    return PEOPLE_STATUS_ADMITTED;
  }
  if (isAppliedAesopId(aesopId)) {
    return PEOPLE_STATUS_APPLIED;
  }
  return "";
}

function isPeopleStatusSyncEnabled() {
  return resolvePeopleStatusColumnIndex() !== null;
}

function resolvePeopleLastLoginColumnIndex() {
  const columnRef = config.googleSheets.peopleLastLoginColumn;
  if (columnRef == null || String(columnRef).trim() === "" || String(columnRef).trim().toUpperCase() === "OFF") {
    return null;
  }
  try {
    return resolveColumnIndex(String(columnRef).trim());
  } catch {
    return null;
  }
}

function peopleLastLoginHeaderCandidates() {
  const configured = config.googleSheets.peopleLastLoginHeader;
  const fromConfig = configured != null && String(configured).trim() !== "" ? [String(configured).trim()] : [];
  return [...fromConfig, "Last Login", "Last Login "];
}

function isPeopleLastLoginSyncEnabled() {
  return resolvePeopleLastLoginColumnIndex() !== null;
}

function peopleRoleHeaderCandidates() {
  const configured = config.googleSheets.peopleRoleHeader;
  const fromConfig = configured != null && String(configured).trim() !== "" ? [String(configured).trim()] : [];
  return [...fromConfig, "Admins", "Admin", "Role", "Portal Role", "PortalRole"];
}

function peopleReviewerHeaderCandidates() {
  const configured = config.googleSheets.peopleReviewerHeader;
  const fromConfig = configured != null && String(configured).trim() !== "" ? [String(configured).trim()] : [];
  return [...fromConfig, "Reviewer", "Reviewers"];
}

function readPeopleReviewerRole(rowData, reviewerColumnIndex) {
  if (reviewerColumnIndex === null) {
    return "";
  }
  return String(rowData[reviewerColumnIndex] ?? "").trim();
}

/**
 * Read application reviewer flag from a People row.
 * @param {import("google-spreadsheet").GoogleSpreadsheetRow | null | undefined} row
 * @param {string[]} rowData
 * @param {number | null} reviewerColumnIndex
 */
function readPeopleReviewerRoleFromRow(row, rowData, reviewerColumnIndex) {
  if (row && typeof row.get === "function") {
    for (const header of peopleReviewerHeaderCandidates()) {
      try {
        const value = row.get(header);
        if (value != null && String(value).trim() !== "") {
          return String(value).trim();
        }
      } catch {
        // Header not registered on this worksheet.
      }
    }
  }
  return readPeopleReviewerRole(rowData, reviewerColumnIndex);
}

/**
 * Read portal admin flag from a People row. Prefer header-based lookup (Admins column may
 * extend past the trailing edge of row._rawData when earlier columns end at E).
 * @param {import("google-spreadsheet").GoogleSpreadsheetRow | null | undefined} row
 * @param {string[]} rowData
 * @param {number | null} roleColumnIndex
 */
function readPeoplePortalRoleFromRow(row, rowData, roleColumnIndex) {
  if (row && typeof row.get === "function") {
    for (const header of peopleRoleHeaderCandidates()) {
      try {
        const value = row.get(header);
        if (value != null && String(value).trim() !== "") {
          return String(value).trim();
        }
      } catch {
        // Header not registered on this worksheet.
      }
    }
  }
  return readPeoplePortalRole(rowData, roleColumnIndex);
}

const peopleHeaderLoaded = new Set();

/** @param {import("google-spreadsheet").GoogleSpreadsheetWorksheet} worksheet */
async function preparePeopleWorksheet(worksheet) {
  const key = worksheet.title || "People";
  if (peopleHeaderLoaded.has(key)) {
    return;
  }
  try {
    await worksheet.loadHeaderRow(1);
  } catch (error) {
    const msg = error?.message ? String(error.message) : String(error);
    if (msg.includes("Duplicate header")) {
      console.warn(
        `People sheet has duplicate headers; continuing with configured column letters: ${msg}`,
      );
    } else {
      throw error;
    }
  }
  peopleHeaderLoaded.add(key);
}

async function findProfileByIdFromDb(userId) {
  if (!isDatabaseEnabled()) {
    return null;
  }
  try {
    const person = await getPersonByAesopId(userId);
    if (!person?.email) {
      return null;
    }
    const profile = personRowToProfile(person);
    profile.peopleStatus = resolvePeopleStatus(profile.id, profile.peopleStatus);
    return profile;
  } catch (error) {
    console.warn("Profile DB lookup failed:", error.message);
    return null;
  }
}

/** @param {string} role */
function isPeopleSheetReviewerRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized === "reviewer" ||
    normalized === "reviewers" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "true" ||
    normalized === "1"
  );
}

/** @param {string} role */
function isPeopleSheetAdminRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized === "admin" ||
    normalized === "admins" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "true" ||
    normalized === "1"
  );
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
 * @returns {Promise<{ name: string, email: string, id: string, phone: string, portalRole: string }|null>}
 */
async function findProfileById(userId) {
  const idKey = String(userId || "").trim();
  if (!idKey) {
    return null;
  }

  if (isDatabaseEnabled()) {
    try {
      const person = await getPersonByAesopId(idKey);
      if (person?.email && isPeopleIdentityFresh(person)) {
        const profile = personRowToProfile(person);
        profile.peopleStatus = resolvePeopleStatus(profile.id, profile.peopleStatus);
        return profile;
      }
    } catch (error) {
      console.warn("Profile DB lookup failed:", error.message);
    }
  }

  try {
    const sheet = await initGoogleSheets();
    const sheetName = config.googleSheets.sheetName || "People";
    const worksheet = sheet.sheetsByTitle[sheetName];
    if (!worksheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    await preparePeopleWorksheet(worksheet);
    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.idColumn || "B");
    const nameColumnIndex = resolveColumnIndex(config.googleSheets.nameColumn || "C");
    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");
    const phoneColumnIndex = resolvePeoplePhoneColumnIndex();
    const roleColumnIndex = resolvePeopleRoleColumnIndex();
    const typeColumnIndex = resolvePeopleTypeColumnIndex();
    const reviewerColumnIndex = resolvePeopleReviewerColumnIndex();
    const statusColumnIndex = resolvePeopleStatusColumnIndex();
    const normalizedId = idKey.trim().toLowerCase();
    const applicantIdSet = await require("./voiceMemoSync").loadApplicantAesopIdSetFromSheets();

    for (const row of rows) {
      try {
        const rowData = Array.isArray(row._rawData) ? row._rawData : [];
        const rowId = String(rowData[idColumnIndex] || "").trim().toLowerCase();
        if (rowId !== normalizedId) {
          continue;
        }

        const phoneRaw =
          phoneColumnIndex !== null ? String(rowData[phoneColumnIndex] ?? "").trim() : "";

        const aesopId = String(rowData[idColumnIndex] || "").trim();
        const adminRole = readPeoplePortalRoleFromRow(row, rowData, roleColumnIndex);
        const peopleType = readPeopleTypeFromRow(row, rowData, typeColumnIndex);
        return {
          name: String(rowData[nameColumnIndex] || "").trim(),
          email: String(rowData[emailColumnIndex] || "").trim(),
          id: aesopId,
          phone: phoneRaw,
          portalRole: resolvePortalRoleFromPeopleSheet(
            { id: aesopId, peopleType, portalRole: adminRole },
            applicantIdSet,
          ) || "",
          reviewerRole: readPeopleReviewerRoleFromRow(row, rowData, reviewerColumnIndex),
          peopleStatus: resolvePeopleStatus(
            aesopId,
            readPeopleStatusFromRow(row, rowData, statusColumnIndex),
          ),
        };
      } catch (rowError) {
        continue;
      }
    }

    return null;
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.error("Error finding profile by ID in Google Sheet:", formattedError);
    const fromDb = await findProfileByIdFromDb(userId);
    if (fromDb) {
      return fromDb;
    }
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
 * @returns {Promise<{ name: string, email: string, id: string, phone: string, portalRole: string }|null>}
 */
async function findProfileByEmail(email) {
  try {
    const sheet = await initGoogleSheets();
    const sheetName = config.googleSheets.sheetName || "People";
    const worksheet = sheet.sheetsByTitle[sheetName];
    if (!worksheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    await preparePeopleWorksheet(worksheet);
    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.idColumn || "B");
    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");
    const nameColumnIndex = resolveColumnIndex(config.googleSheets.nameColumn || "C");
    const phoneColumnIndex = resolvePeoplePhoneColumnIndex();
    const roleColumnIndex = resolvePeopleRoleColumnIndex();
    const typeColumnIndex = resolvePeopleTypeColumnIndex();
    const reviewerColumnIndex = resolvePeopleReviewerColumnIndex();
    const statusColumnIndex = resolvePeopleStatusColumnIndex();
    const emailLower = email.toLowerCase().trim();
    const applicantIdSet = await require("./voiceMemoSync").loadApplicantAesopIdSetFromSheets();

    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const rowEmail = String(rowData[emailColumnIndex] || "").trim().toLowerCase();

      if (rowEmail === emailLower) {
        const phoneRaw =
          phoneColumnIndex !== null ? String(rowData[phoneColumnIndex] ?? "").trim() : "";
        const aesopId = String(rowData[idColumnIndex] || "").trim();
        const adminRole = readPeoplePortalRoleFromRow(row, rowData, roleColumnIndex);
        const peopleType = readPeopleTypeFromRow(row, rowData, typeColumnIndex);
        return {
          name: String(rowData[nameColumnIndex] || "").trim(),
          email: String(rowData[emailColumnIndex] || "").trim(),
          id: aesopId,
          phone: phoneRaw,
          portalRole:
            resolvePortalRoleFromPeopleSheet(
              { id: aesopId, peopleType, portalRole: adminRole },
              applicantIdSet,
            ) || "",
          reviewerRole: readPeopleReviewerRoleFromRow(row, rowData, reviewerColumnIndex),
          peopleStatus: resolvePeopleStatus(
            aesopId,
            readPeopleStatusFromRow(row, rowData, statusColumnIndex),
          ),
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
  // Non-fatal: row data is already saved; Google occasionally returns 500 on repeatCell for new sheets.
  try {
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
  } catch (formatError) {
    console.warn(
      "Ding change row saved but timestamp cell format failed:",
      formatGoogleSheetsOperationError(formatError),
    );
  }
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
 * Record a successful portal sign-in on the People sheet (column U by default).
 * Stores Eastern (America/New_York) date/time text, e.g. `6/23/2026, 2:15:30 PM EDT`.
 * @param {string} userId - AESOP ID (People id column)
 * @param {Date} [loginAt]
 * @returns {Promise<boolean>}
 */
async function recordPeopleLastLogin(userId, loginAt = new Date()) {
  if (!isPeopleLastLoginSyncEnabled()) {
    return false;
  }

  const idKey = typeof userId === "string" ? userId.trim() : "";
  if (!idKey) {
    return false;
  }

  let lastLoginColIdx;
  try {
    lastLoginColIdx = resolvePeopleLastLoginColumnIndex();
    if (lastLoginColIdx === null) {
      return false;
    }
  } catch (error) {
    console.warn("recordPeopleLastLogin: invalid column config:", error.message);
    return false;
  }

  const when = loginAt instanceof Date ? loginAt : new Date(loginAt);
  const displayValue = formatEasternSheetTimestamp(when);
  if (!displayValue) {
    return false;
  }

  const doc = await initGoogleSheets();
  const peopleName = config.googleSheets.sheetName || "People";
  const peopleSheet = doc.sheetsByTitle[peopleName];
  if (!peopleSheet) {
    throw new Error(`Sheet "${peopleName}" not found.`);
  }

  await preparePeopleWorksheet(peopleSheet);
  const idColIdx = resolveColumnIndex(config.googleSheets.idColumn || "B");
  const rows = await peopleSheet.getRows();
  const nid = idKey.toLowerCase();
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
    console.warn("recordPeopleLastLogin: no People row matched id", idKey);
    return false;
  }

  const gridRowIdx = targetRowNum - 1;
  await peopleSheet.loadCells({
    startRowIndex: gridRowIdx,
    endRowIndex: gridRowIdx + 1,
    startColumnIndex: lastLoginColIdx,
    endColumnIndex: lastLoginColIdx + 1,
  });

  const cell = peopleSheet.getCell(gridRowIdx, lastLoginColIdx);
  cell.value = displayValue;
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
 * All rows from the Classroom Roles tab (sync output).
 * @returns {Promise<Array<{ email: string, role: string, teacherClasses: string }>>}
 */
async function listAllClassroomRoleRows() {
  try {
    const sheet = await initGoogleSheets();
    const cr = config.classroom || {};
    const tabTitle = cr.rolesSheetName || "Classroom Roles";
    const worksheet = sheet.sheetsByTitle[tabTitle];
    if (!worksheet) {
      return [];
    }

    const emailIdx = resolveColumnIndex(cr.rolesEmailColumn || "A");
    const roleIdx = resolveColumnIndex(cr.rolesRoleColumn || "B");
    const classesIdx = resolveColumnIndex(cr.rolesClassesColumn || "C");

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
        role: String(rowData[roleIdx] ?? "").trim(),
        teacherClasses: String(rowData[classesIdx] ?? "").trim(),
      });
    }
    return out;
  } catch (error) {
    console.warn("listAllClassroomRoleRows:", formatGoogleSheetsOperationError(error));
    return [];
  }
}

/**
 * Expand a grade row into per-course entries (handles legacy combined rows).
 * @param {{ classSection: string, calculatedGrade: string }} row
 * @returns {Array<{ classSection: string, calculatedGrade: string }>}
 */
function expandClassGradeRow(row) {
  const section = row?.classSection ? String(row.classSection).trim() : "";
  const calculatedGrade = row?.calculatedGrade ? String(row.calculatedGrade).trim() : "";
  if (!section) {
    return calculatedGrade ? [{ classSection: "", calculatedGrade }] : [];
  }
  const sections = section
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (sections.length <= 1) {
    return [{ classSection: section, calculatedGrade }];
  }
  return sections.map((classSection) => ({ classSection, calculatedGrade }));
}

/**
 * All Classroom Grades rows for one student email (one entry per course).
 * @param {string} email
 * @returns {Promise<Array<{ classSection: string, calculatedGrade: string }>>}
 */
async function getAllClassGradesByEmail(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized) {
    return [];
  }

  try {
    const sheet = await initGoogleSheets();
    const cr = config.classroom || {};
    const tabTitle = cr.gradesSheetName || "Classroom Grades";
    const worksheet = sheet.sheetsByTitle[tabTitle];
    if (!worksheet) {
      return [];
    }

    const emailIdx = resolveColumnIndex(cr.gradesEmailColumn || "A");
    const sectionIdx = resolveColumnIndex(cr.gradesSectionColumn || "C");
    const gradeIdx = resolveColumnIndex(cr.gradesGradeColumn || "D");

    const rows = await worksheet.getRows();
    const out = [];
    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const rowEmail = String(rowData[emailIdx] ?? "").trim().toLowerCase();
      if (rowEmail !== normalized) {
        continue;
      }
      out.push(
        ...expandClassGradeRow({
          classSection: String(rowData[sectionIdx] ?? "").trim(),
          calculatedGrade: String(rowData[gradeIdx] ?? "").trim(),
        }),
      );
    }

    out.sort((a, b) => a.classSection.localeCompare(b.classSection));
    return out;
  } catch (error) {
    const formattedError = formatGoogleSheetsOperationError(error);
    console.warn("getAllClassGradesByEmail:", formattedError);
    return [];
  }
}

/**
 * Classroom Grades tab lookup by email (populated by the Classroom sync).
 * @param {string} email
 * @returns {Promise<{ found: boolean, classSection: string, calculatedGrade: string, classGrades: Array<{ classSection: string, calculatedGrade: string }> }>}
 */
async function getClassGradeByEmail(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  const empty = { found: false, classSection: "", calculatedGrade: "", classGrades: [] };
  if (!normalized) {
    return empty;
  }

  const classGrades = await getAllClassGradesByEmail(normalized);
  if (classGrades.length === 0) {
    return empty;
  }

  const classSection = classGrades
    .map((row) => row.classSection)
    .filter(Boolean)
    .join(", ");
  const calculatedGrade =
    classGrades.length === 1 ? classGrades[0].calculatedGrade : "";

  return {
    found: true,
    classSection,
    calculatedGrade,
    classGrades,
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

    await preparePeopleWorksheet(worksheet);
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

    await preparePeopleWorksheet(worksheet);
    const rows = await worksheet.getRows();
    const idColumnIndex = resolveColumnIndex(config.googleSheets.idColumn || "B");
    const nameColumnIndex = resolveColumnIndex(config.googleSheets.nameColumn || "C");
    const emailColumnIndex = resolveColumnIndex(config.googleSheets.emailColumn || "D");
    const roleColumnIndex = resolvePeopleRoleColumnIndex();
    const typeColumnIndex = resolvePeopleTypeColumnIndex();
    const reviewerColumnIndex = resolvePeopleReviewerColumnIndex();
    const statusColumnIndex = resolvePeopleStatusColumnIndex();

    for (const row of rows) {
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const email = String(rowData[emailColumnIndex] ?? "")
        .trim()
        .toLowerCase();
      if (!email) {
        continue;
      }
      const aesopId = String(rowData[idColumnIndex] ?? "").trim();
      map.set(email, {
        id: aesopId,
        name: String(rowData[nameColumnIndex] ?? "").trim(),
        peopleType: readPeopleTypeFromRow(row, rowData, typeColumnIndex),
        portalRole: readPeoplePortalRoleFromRow(row, rowData, roleColumnIndex),
        peopleStatus: resolvePeopleStatus(
          aesopId,
          readPeopleStatusFromRow(row, rowData, statusColumnIndex),
        ),
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
    const phoneColumnIndex = resolvePeoplePhoneColumnIndex();

    const matches = [];
    const statusColumnIndex = resolvePeopleStatusColumnIndex();
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
      matches.push({
        id,
        name,
        email,
        phone,
        peopleStatus: resolvePeopleStatus(id, readPeopleStatusFromRow(row, rowData, statusColumnIndex)),
      });
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
 * Populate People Status (column T by default): Teaching, Admitted, or Applied (262 applicants).
 * @param {{ teacherEmails?: Set<string>|string[], studentEmails?: Set<string>|string[] }} roleContext
 * @returns {Promise<{ updated: number, skipped: number }>}
 */
async function syncPeopleStatusOnPeopleSheet(roleContext = {}) {
  if (!isPeopleStatusSyncEnabled()) {
    return { updated: 0, skipped: 0 };
  }

  const statusColIdx = resolvePeopleStatusColumnIndex();
  if (statusColIdx === null) {
    return { updated: 0, skipped: 0 };
  }

  const teacherEmails = new Set(
    [...(roleContext.teacherEmails || [])].map((email) => String(email).trim().toLowerCase()).filter(Boolean),
  );
  const studentEmails = new Set(
    [...(roleContext.studentEmails || [])].map((email) => String(email).trim().toLowerCase()).filter(Boolean),
  );

  const doc = await initGoogleSheets();
  const peopleName = config.googleSheets.sheetName || "People";
  const peopleSheet = doc.sheetsByTitle[peopleName];
  if (!peopleSheet) {
    throw new Error(`Sheet "${peopleName}" not found.`);
  }

  await preparePeopleWorksheet(peopleSheet);
  peopleSheet.resetLocalCache(true);
  const rows = await peopleSheet.getRows();
  const idColIdx = resolveColumnIndex(config.googleSheets.idColumn || "B");
  const emailColIdx = resolveColumnIndex(config.googleSheets.emailColumn || "D");

  /** @type {{ gridRowIdx: number, value: string }[]} */
  const pending = [];
  let skipped = 0;

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const aesopId = String(rowData[idColIdx] ?? "").trim();
    const email = String(rowData[emailColIdx] ?? "")
      .trim()
      .toLowerCase();
    if (!aesopId && !email) {
      skipped += 1;
      continue;
    }

    const isTeacher = email ? teacherEmails.has(email) : false;
    const isStudent = email ? studentEmails.has(email) && !isTeacher : false;
    const nextStatus = derivePeopleSheetStatus({ aesopId, isTeacher, isStudent });
    if (!nextStatus) {
      skipped += 1;
      continue;
    }

    const currentStatus = readPeopleStatusFromRow(row, rowData, statusColIdx);
    if (normalizePeopleStatusValue(currentStatus) === normalizePeopleStatusValue(nextStatus)) {
      skipped += 1;
      continue;
    }

    pending.push({ gridRowIdx: row.rowNumber - 1, value: nextStatus });
  }

  if (pending.length === 0) {
    return { updated: 0, skipped };
  }

  const minRow = Math.min(...pending.map((entry) => entry.gridRowIdx));
  const maxRow = Math.max(...pending.map((entry) => entry.gridRowIdx)) + 1;
  await peopleSheet.loadCells({
    startRowIndex: minRow,
    endRowIndex: maxRow,
    startColumnIndex: statusColIdx,
    endColumnIndex: statusColIdx + 1,
  });

  for (const entry of pending) {
    const cell = peopleSheet.getCell(entry.gridRowIdx, statusColIdx);
    cell.value = entry.value;
  }

  await peopleSheet.saveUpdatedCells();
  return { updated: pending.length, skipped };
}

/** @deprecated Use syncPeopleStatusOnPeopleSheet */
async function backfillAppliedStatusOnPeopleSheet() {
  return syncPeopleStatusOnPeopleSheet({ teacherEmails: [], studentEmails: [] });
}

/**
 * Build teacher/student email sets from synced Classroom Roles + Grades tabs.
 * @returns {Promise<{ teacherEmails: Set<string>, studentEmails: Set<string> }>}
 */
async function loadClassroomRoleEmailSetsFromSheets() {
  const teacherEmails = new Set();
  const studentEmails = new Set();

  const roleRows = await listAllClassroomRoleRows();
  for (const row of roleRows) {
    if (!row.email) {
      continue;
    }
    if (String(row.role || "").trim().toLowerCase() === "teacher") {
      teacherEmails.add(row.email);
    } else {
      studentEmails.add(row.email);
    }
  }

  const gradeRows = await listAllClassroomGradeRows();
  for (const row of gradeRows) {
    const email = row.email ? String(row.email).trim().toLowerCase() : "";
    if (email) {
      studentEmails.add(email);
    }
  }

  for (const email of teacherEmails) {
    studentEmails.delete(email);
  }

  return { teacherEmails, studentEmails };
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

/**
 * Convert zero-based column index to A1 letter(s).
 * @param {number} index
 * @returns {string}
 */
function columnIndexToLetter(index) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function parseAdmissionsFilterColumnLabels(gs) {
  const raw = gs?.admissionsFilterColumns ?? "Level,Round 1,Round 2";
  if (Array.isArray(raw)) {
    return raw.map((label) => String(label).trim()).filter(Boolean);
  }
  return String(raw)
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function headerLabelMatchesConfigured(label, configuredLabels) {
  const normalized = String(label || "").trim().toLowerCase();
  return configuredLabels.some((configured) => configured.toLowerCase() === normalized);
}

function getAdmissionsSpecialEmailHeaderLabel(gs = config.googleSheets || {}) {
  return String(gs.admissionsSpecialEmailHeader || "Special emails").trim() || "Special emails";
}

function readApplicantSpecialEmail(row, gs = config.googleSheets || {}) {
  const header = getAdmissionsSpecialEmailHeaderLabel(gs);
  if (row?.fields && Object.prototype.hasOwnProperty.call(row.fields, header)) {
    return String(row.fields[header] ?? "").trim();
  }
  if (row?.fields) {
    const lower = header.toLowerCase();
    for (const [key, value] of Object.entries(row.fields)) {
      if (key.toLowerCase() === lower) {
        return String(value ?? "").trim();
      }
    }
  }
  return "";
}

function isSpecialEmailRecipientFilter(filter, gs = config.googleSheets || {}) {
  if (!filter?.column) {
    return false;
  }
  const special = getAdmissionsSpecialEmailHeaderLabel(gs).toLowerCase();
  return String(filter.column).trim().toLowerCase() === special;
}

function resolveApplicantRecipientEmail(row, filter, gs = config.googleSheets || {}) {
  if (isSpecialEmailRecipientFilter(filter, gs)) {
    return readApplicantSpecialEmail(row, gs);
  }
  return String(row.email || "").trim();
}

function withApplicantRecipientEmails(rows, filter, gs = config.googleSheets || {}) {
  return rows.map((row) => {
    const sendEmail = resolveApplicantRecipientEmail(row, filter, gs);
    return { ...row, email: sendEmail };
  });
}

/**
 * @param {Array<{ id: string, name: string, email: string, fields: Record<string, string> }>} rows
 */
function analyzeDuplicateApplicantEmails(rows) {
  const byEmail = new Map();
  for (const row of rows) {
    const emailKey = String(row.email || "")
      .trim()
      .toLowerCase();
    if (!emailKey) {
      continue;
    }
    if (!byEmail.has(emailKey)) {
      byEmail.set(emailKey, []);
    }
    byEmail.get(emailKey).push({
      id: row.id || "",
      name: row.name || "",
      email: row.email || "",
      fields: row.fields || {},
    });
  }

  const duplicateEmailGroups = [];
  const duplicateEmailSkips = [];
  for (const [email, groupRows] of byEmail) {
    if (groupRows.length <= 1) {
      continue;
    }
    duplicateEmailGroups.push({ email, rows: groupRows });
    const [kept, ...skippedRows] = groupRows;
    for (const skipped of skippedRows) {
      duplicateEmailSkips.push({
        reason: "duplicate-email",
        id: skipped.id,
        name: skipped.name,
        email: skipped.email,
        fields: skipped.fields,
        sharedWith: {
          id: kept.id,
          name: kept.name,
          email: kept.email,
        },
      });
    }
  }
  duplicateEmailGroups.sort((a, b) => a.email.localeCompare(b.email));
  return { duplicateEmailGroups, duplicateEmailSkips };
}

/**
 * Load all rows from the Applicants sheet tab with header-based field map.
 * @returns {Promise<{ headers: Array<{ letter: string, label: string, index: number }>, rows: Array<{ id: string, name: string, email: string, fields: Record<string, string> }>, identityColumnIndices: Set<number> }>}
 */
async function loadAdmissionsSheet() {
  const empty = { headers: [], rows: [], identityColumnIndices: new Set(), stats: null };
  try {
    const gs = config.googleSheets || {};
    const sheetName = gs.admissionsSheetName || "Applicants";
    const headerRowNum = Math.max(1, parseInt(String(gs.admissionsHeaderRow || "1"), 10) || 1);
    const idColumnIndex = resolveColumnIndex(gs.admissionsIdColumn || "A");
    const nameColumnIndex = resolveColumnIndex(gs.admissionsNameColumn || "C");
    const emailColumnIndex = resolveColumnIndex(gs.admissionsEmailColumn || "D");
    const specialEmailColumnIndex = resolveColumnIndex(gs.admissionsSpecialEmailColumn || "M");
    const identityColumnIndices = new Set([idColumnIndex, nameColumnIndex, emailColumnIndex]);
    const columnMapping = {
      id: columnIndexToLetter(idColumnIndex),
      name: columnIndexToLetter(nameColumnIndex),
      email: columnIndexToLetter(emailColumnIndex),
      specialEmail: columnIndexToLetter(specialEmailColumnIndex),
    };

    const sheet = await initGoogleSheets();
    const availableTabs = Object.keys(sheet.sheetsByTitle || {}).sort((a, b) => a.localeCompare(b));
    const worksheet = await getWorksheetByTitle(sheet, sheetName);
    if (!worksheet) {
      const similarTabs = availableTabs.filter((title) => /admit|applic/i.test(title));
      const stats = {
        configuredSheetName: sheetName,
        sheetFound: false,
        availableTabs,
        similarTabs,
        headerRowNum,
        columnMapping,
      };
      const hint = similarTabs.length ? ` Similar tabs: ${similarTabs.join(", ")}.` : "";
      console.warn(
        `[admissions-email] tab "${sheetName}" not found (${availableTabs.length} tabs in spreadsheet).${hint}`,
      );
      return { ...empty, stats };
    }

    await worksheet.loadHeaderRow(headerRowNum);
    const headerValues = Array.isArray(worksheet.headerValues) ? worksheet.headerValues : [];
    const headers = headerValues.map((label, index) => ({
      letter: columnIndexToLetter(index),
      label: String(label || "").trim() || columnIndexToLetter(index),
      index,
    }));

    const rows = [];
    let dataRowsRead = 0;
    let rowsSkippedNoEmail = 0;
    let rowsWithPrimaryEmail = 0;
    let rowsWithSpecialEmailOnly = 0;
    const dataRows = await worksheet.getRows();
    for (const row of dataRows) {
      dataRowsRead += 1;
      const rowData = Array.isArray(row._rawData) ? row._rawData : [];
      const email = String(rowData[emailColumnIndex] ?? "").trim();
      const specialEmail = String(rowData[specialEmailColumnIndex] ?? "").trim();
      if (!email && !specialEmail) {
        rowsSkippedNoEmail += 1;
        continue;
      }
      if (email) {
        rowsWithPrimaryEmail += 1;
      } else {
        rowsWithSpecialEmailOnly += 1;
      }
      const fields = {};
      for (const header of headers) {
        if (identityColumnIndices.has(header.index)) {
          continue;
        }
        fields[header.label] = String(rowData[header.index] ?? "").trim();
      }
      rows.push({
        id: String(rowData[idColumnIndex] ?? "").trim(),
        name: String(rowData[nameColumnIndex] ?? "").trim(),
        email,
        fields,
      });
    }

    const duplicateAnalysis = analyzeDuplicateApplicantEmails(rows);
    const stats = {
      configuredSheetName: sheetName,
      sheetFound: true,
      headerRowNum,
      dataRowsRead,
      rowsWithEmail: rows.length,
      rowsWithPrimaryEmail,
      rowsWithSpecialEmailOnly,
      rowsSkippedNoEmail,
      columnMapping,
      specialEmailHeader: getAdmissionsSpecialEmailHeaderLabel(gs),
      headerLabels: headers.map((header) => header.label),
      duplicateEmailGroupCount: duplicateAnalysis.duplicateEmailGroups.length,
      duplicateEmailSkips: duplicateAnalysis.duplicateEmailSkips,
      duplicateEmailGroups: duplicateAnalysis.duplicateEmailGroups,
    };
    console.info(
      `[admissions-email] tab "${sheetName}": ${dataRowsRead} data row(s), ${rows.length} with email in column ${columnMapping.email} and/or ${columnMapping.specialEmail}, ${rowsSkippedNoEmail} skipped (no primary or special email)`,
    );

    return { headers, rows, identityColumnIndices, stats };
  } catch (error) {
    console.warn("loadAdmissionsSheet:", formatGoogleSheetsOperationError(error));
    return empty;
  }
}

/**
 * @param {Array<{ id: string, name: string, email: string, fields: Record<string, string> }>} rows
 * @param {{ column?: string, values?: string[], aesopIds?: string[] }|null|undefined} filter
 */
function filterAdmissionsRows(rows, filter) {
  if (!Array.isArray(rows)) {
    return [];
  }
  if (!filter || typeof filter !== "object") {
    return rows;
  }
  if (Array.isArray(filter.aesopIds) && filter.aesopIds.length > 0) {
    const want = new Set(
      filter.aesopIds.map((id) => String(id ?? "").trim().toLowerCase()).filter(Boolean),
    );
    if (want.size === 0) {
      return rows;
    }
    return rows.filter((row) => want.has(String(row.id || "").trim().toLowerCase()));
  }
  if (!filter.column || !Array.isArray(filter.values) || filter.values.length === 0) {
    return rows;
  }
  const column = String(filter.column).trim();
  const want = new Set(filter.values.map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean));
  if (!column || want.size === 0) {
    return rows;
  }
  return rows.filter((row) => {
    const cell = row.fields[column];
    if (cell == null) {
      return false;
    }
    return want.has(String(cell).trim().toLowerCase());
  });
}

/**
 * Filter and template-variable options for the Applicants sheet.
 * Level, Round 1, and Round 2 are filters; other non-identity columns are template variables.
 * @param {{ headers: Array<{ letter: string, label: string, index: number }>, rows: Array<{ fields: Record<string, string> }>, identityColumnIndices: Set<number> }} sheetData
 */
function getAdmissionsFilterOptions(sheetData) {
  const headers = Array.isArray(sheetData?.headers) ? sheetData.headers : [];
  const rows = Array.isArray(sheetData?.rows) ? sheetData.rows : [];
  const identityColumnIndices =
    sheetData?.identityColumnIndices instanceof Set ? sheetData.identityColumnIndices : new Set();
  const configuredFilterLabels = parseAdmissionsFilterColumnLabels(config.googleSheets || {});

  const filterHeaders = headers.filter(
    (header) =>
      !identityColumnIndices.has(header.index) &&
      headerLabelMatchesConfigured(header.label, configuredFilterLabels),
  );
  const variableHeaders = headers.filter(
    (header) =>
      !identityColumnIndices.has(header.index) &&
      !headerLabelMatchesConfigured(header.label, configuredFilterLabels),
  );

  const valuesByColumn = {};
  for (const header of filterHeaders) {
    const values = new Set();
    for (const row of rows) {
      const cell = row.fields?.[header.label];
      if (cell != null && String(cell).trim() !== "") {
        values.add(String(cell).trim());
      }
    }
    valuesByColumn[header.label] = Array.from(values).sort((a, b) => a.localeCompare(b));
  }

  const filterColumnLabels = filterHeaders.map((header) => header.label);
  const variableColumnLabels = variableHeaders.map((header) => header.label);

  return {
    filterColumns: filterColumnLabels,
    variableColumns: variableColumnLabels,
    columns: filterColumnLabels,
    valuesByColumn,
    headers: filterHeaders.map((header) => ({ letter: header.letter, label: header.label })),
  };
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
  recordPeopleLastLogin,
  getClassroomTabStats,
  loadEmailToPeopleProfileMap,
  listAllClassroomGradeRows,
  listAllClassroomRoleRows,
  searchPeopleProfiles,
  getPortalDingChangeHistory,
  getPortalClassGradeByStudentName,
  getPortalTeacherByUserId,
  getRoleByEmail,
  isPeopleSheetAdminRole,
  isPeopleSheetReviewerRole,
  parsePortalRoleFromPeopleType,
  resolvePortalRoleFromPeopleSheet,
  readPeopleTypeFromRow,
  resolvePeopleTypeColumnIndex,
  isAppliedPeopleStatus,
  isAdmittedPeopleStatus,
  isTeachingPeopleStatus,
  isAppliedAesopId,
  derivePeopleSheetStatus,
  resolvePeopleStatus,
  getClassGradeByEmail,
  getAllClassGradesByEmail,
  expandClassGradeRow,
  getUserData,
  initGoogleSheets,
  getWorksheetByTitle,
  replaceTabData,
  resolveColumnIndex,
  syncAllPeoplePastDingColumns,
  syncPastDingNumbersToPeople,
  syncPeopleStatusOnPeopleSheet,
  loadClassroomRoleEmailSetsFromSheets,
  backfillAppliedStatusOnPeopleSheet,
  loadAdmissionsSheet,
  filterAdmissionsRows,
  getAdmissionsFilterOptions,
  analyzeDuplicateApplicantEmails,
  getAdmissionsSpecialEmailHeaderLabel,
  isSpecialEmailRecipientFilter,
  resolveApplicantRecipientEmail,
  withApplicantRecipientEmails,
};
