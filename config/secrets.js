const fs = require("fs");
const path = require("path");
const { DEFAULT_VOICE_MEMO_FILE_EXTENSIONS_CSV } = require("../utils/voiceMemoExtensions");

let secrets = null;

/**
 * Merge Google Sheets settings from optional secrets.json section with process.env.
 * Environment variables win when set (non-empty after trim), matching Fly.io / README.
 * @param {Record<string, unknown>|undefined} fileSection
 */
function buildGoogleSheetsConfig(fileSection) {
  const f = fileSection && typeof fileSection === "object" ? fileSection : {};
  const envOr = (envKey, fileKey, fallback) => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv).trim();
    }
    const fromFile = f[fileKey];
    if (fromFile != null && String(fromFile).trim() !== "") {
      return String(fromFile).trim();
    }
    return fallback;
  };

  return {
    sheetId: envOr("GOOGLE_SHEET_ID", "sheetId", ""),
    sheetName: envOr("GOOGLE_SHEET_NAME", "sheetName", "People"),
    idColumn: envOr("GOOGLE_ID_COLUMN", "idColumn", "B"),
    nameColumn: envOr("GOOGLE_NAME_COLUMN", "nameColumn", "C"),
    emailColumn: envOr("GOOGLE_EMAIL_COLUMN", "emailColumn", "D"),
    phoneColumn: envOr("GOOGLE_PHONE_COLUMN", "phoneColumn", "F"),
    /** People sheet column for teacher/student type label (e.g. "Student: E-1 (24.5%)"). Blank or OFF disables. */
    peopleTypeColumn: envOr("GOOGLE_PEOPLE_TYPE_COLUMN", "peopleTypeColumn", "E"),
    /** Header label on People sheet for teacher/student type (used with loadHeaderRow). */
    peopleTypeHeader: envOr(
      "GOOGLE_PEOPLE_TYPE_COLUMN_HEADER",
      "peopleTypeHeader",
      "Type (teacher, student)",
    ),
    /** People sheet column for manual portal role (e.g. Admin). Blank or OFF disables. */
    peopleRoleColumn: envOr("GOOGLE_PEOPLE_ROLE_COLUMN", "peopleRoleColumn", "S"),
    /** Header label on People sheet for manual admin flag (used with loadHeaderRow). */
    peopleRoleHeader: envOr("GOOGLE_PEOPLE_ROLE_COLUMN_HEADER", "peopleRoleHeader", "Admins"),
    /** People sheet column for applicant/participant status (e.g. Applied). Blank or OFF disables. */
    peopleStatusColumn: envOr("GOOGLE_PEOPLE_STATUS_COLUMN", "peopleStatusColumn", "T"),
    /** Header label on People sheet for status (used with loadHeaderRow). */
    peopleStatusHeader: envOr("GOOGLE_PEOPLE_STATUS_COLUMN_HEADER", "peopleStatusHeader", "Status"),
    /** People sheet column for portal last-login timestamp. Blank or OFF disables. */
    peopleLastLoginColumn: envOr("GOOGLE_PEOPLE_LAST_LOGIN_COLUMN", "peopleLastLoginColumn", "U"),
    /** Header label on People sheet for last login (used with loadHeaderRow). */
    peopleLastLoginHeader: envOr("GOOGLE_PEOPLE_LAST_LOGIN_COLUMN_HEADER", "peopleLastLoginHeader", "Last Login"),
    dingChangesSheetName: envOr(
      "GOOGLE_DING_CHANGES_SHEET_NAME",
      "dingChangesSheetName",
      "Ding changes"
    ),
    dingIdColumn: envOr("GOOGLE_DING_ID_COLUMN", "dingIdColumn", "A"),
    dingTimestampColumn: envOr("GOOGLE_DING_TIMESTAMP_COLUMN", "dingTimestampColumn", "B"),
    dingNumberColumn: envOr("GOOGLE_DING_NUMBER_COLUMN", "dingNumberColumn", "C"),
    /** People sheet column for auto-filled unique Ding history from Ding changes (empty or OFF disables sync). */
    peoplePastDingColumn: envOr(
      "GOOGLE_PEOPLE_PAST_DING_COLUMN",
      "peoplePastDingColumn",
      "V"
    ),
    /** People sheet column for application reviewer flag. Blank or OFF disables. */
    peopleReviewerColumn: envOr("GOOGLE_PEOPLE_REVIEWER_COLUMN", "peopleReviewerColumn", "W"),
    /** Header label on People sheet for reviewer flag (used with loadHeaderRow). */
    peopleReviewerHeader: envOr(
      "GOOGLE_PEOPLE_REVIEWER_COLUMN_HEADER",
      "peopleReviewerHeader",
      "Reviewer",
    ),
    /** Applicant review assignments tab (AESOP ID, reviewers, levels, scores). */
    applicantReviewsSheetName: envOr(
      "GOOGLE_APPLICANT_REVIEWS_SHEET_NAME",
      "applicantReviewsSheetName",
      "ApplicantReviews",
    ),
    applicantReviewsApplicantIdColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_APPLICANT_ID_COLUMN",
      "applicantReviewsApplicantIdColumn",
      "A",
    ),
    applicantReviewsReviewerAColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_REVIEWER_A_COLUMN",
      "applicantReviewsReviewerAColumn",
      "B",
    ),
    applicantReviewsReviewerBColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_REVIEWER_B_COLUMN",
      "applicantReviewsReviewerBColumn",
      "C",
    ),
    applicantReviewsALevelColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_A_LEVEL_COLUMN",
      "applicantReviewsALevelColumn",
      "D",
    ),
    applicantReviewsASuspectedAiColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_A_SUSPECTED_AI_COLUMN",
      "applicantReviewsASuspectedAiColumn",
      "E",
    ),
    applicantReviewsAInstructionColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_A_INSTRUCTION_COLUMN",
      "applicantReviewsAInstructionColumn",
      "F",
    ),
    applicantReviewsAOriginalThinkingColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_A_ORIGINAL_THINKING_COLUMN",
      "applicantReviewsAOriginalThinkingColumn",
      "G",
    ),
    applicantReviewsACharacterColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_A_CHARACTER_COLUMN",
      "applicantReviewsACharacterColumn",
      "H",
    ),
    applicantReviewsBLevelColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_B_LEVEL_COLUMN",
      "applicantReviewsBLevelColumn",
      "I",
    ),
    applicantReviewsBSuspectedAiColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_B_SUSPECTED_AI_COLUMN",
      "applicantReviewsBSuspectedAiColumn",
      "J",
    ),
    applicantReviewsBInstructionColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_B_INSTRUCTION_COLUMN",
      "applicantReviewsBInstructionColumn",
      "K",
    ),
    applicantReviewsBOriginalThinkingColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_B_ORIGINAL_THINKING_COLUMN",
      "applicantReviewsBOriginalThinkingColumn",
      "L",
    ),
    applicantReviewsBCharacterColumn: envOr(
      "GOOGLE_APPLICANT_REVIEWS_B_CHARACTER_COLUMN",
      "applicantReviewsBCharacterColumn",
      "M",
    ),
    googleGradesSheetName: envOr(
      "GOOGLE_GRADES_SHEET_NAME",
      "googleGradesSheetName",
      "Import: Google Grades"
    ),
    googleGradesHeaderRow: envOr("GOOGLE_GRADES_HEADER_ROW", "googleGradesHeaderRow", "1"),
    googleGradesNameHeader: envOr("GOOGLE_GRADES_NAME_HEADER", "googleGradesNameHeader", "Name"),
    googleGradesSectionHeader: envOr(
      "GOOGLE_GRADES_SECTION_HEADER",
      "googleGradesSectionHeader",
      "Section"
    ),
    googleGradesGradeHeader: envOr(
      "GOOGLE_GRADES_GRADE_HEADER",
      "googleGradesGradeHeader",
      "Calculated Grade"
    ),
    teachersSheetName: envOr("GOOGLE_TEACHERS_SHEET_NAME", "teachersSheetName", "Teachers"),
    teachersIdColumn: envOr("GOOGLE_TEACHERS_ID_COLUMN", "teachersIdColumn", "A"),
    teachersClassesColumn: envOr("GOOGLE_TEACHERS_CLASSES_COLUMN", "teachersClassesColumn", "B"),
    admissionsSheetName: envOr("GOOGLE_ADMISSIONS_SHEET_NAME", "admissionsSheetName", "Applicants"),
    admissionsIdColumn: envOr("GOOGLE_ADMISSIONS_ID_COLUMN", "admissionsIdColumn", "A"),
    admissionsNameColumn: envOr("GOOGLE_ADMISSIONS_NAME_COLUMN", "admissionsNameColumn", "C"),
    admissionsEmailColumn: envOr("GOOGLE_ADMISSIONS_EMAIL_COLUMN", "admissionsEmailColumn", "D"),
    admissionsLevelColumn: envOr("GOOGLE_ADMISSIONS_LEVEL_COLUMN", "admissionsLevelColumn", "E"),
    admissionsEssayColumn: envOr("GOOGLE_ADMISSIONS_ESSAY_COLUMN", "admissionsEssayColumn", "K"),
    /** Alternate recipient email column on Applicants (e.g. parent/guardian addresses). */
    admissionsSpecialEmailColumn: envOr(
      "GOOGLE_ADMISSIONS_SPECIAL_EMAIL_COLUMN",
      "admissionsSpecialEmailColumn",
      "M",
    ),
    admissionsSpecialEmailHeader: envOr(
      "GOOGLE_ADMISSIONS_SPECIAL_EMAIL_HEADER",
      "admissionsSpecialEmailHeader",
      "Special emails",
    ),
    admissionsHeaderRow: envOr("GOOGLE_ADMISSIONS_HEADER_ROW", "admissionsHeaderRow", "1"),
    /** Comma-separated header labels used as recipient filters (Level, Round 1, Round 2, Special emails). */
    admissionsFilterColumns: envOr(
      "GOOGLE_ADMISSIONS_FILTER_COLUMNS",
      "admissionsFilterColumns",
      "Level,Round 1,Round 2,Special emails",
    ),
    calendarSheetName: envOr("GOOGLE_CALENDAR_SHEET_NAME", "calendarSheetName", "Calendar"),
    calendarHeaderRow: envOr("GOOGLE_CALENDAR_HEADER_ROW", "calendarHeaderRow", "1"),
    calendarProcessHeader: envOr(
      "GOOGLE_CALENDAR_PROCESS_HEADER",
      "calendarProcessHeader",
      "Application process",
    ),
    calendarDateHeader: envOr("GOOGLE_CALENDAR_DATE_HEADER", "calendarDateHeader", "Date"),
  };
}

/** Map legacy Applicants sheet / secrets header labels to current names. */
function normalizeVoiceMemoColumnHeader(value, legacyLabels, canonical, fallback) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return fallback;
  }
  const lower = trimmed.toLowerCase();
  if (legacyLabels.some((label) => String(label || "").trim().toLowerCase() === lower)) {
    return canonical;
  }
  return trimmed;
}

function buildVoiceMemoConfig(fileSection) {
  const f = fileSection && typeof fileSection === "object" ? fileSection : {};
  const envOr = (envKey, fileKey, fallback = "") => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv).trim();
    }
    const fromFile = f[fileKey];
    if (fromFile != null && String(fromFile).trim() !== "") {
      return String(fromFile).trim();
    }
    return fallback;
  };
  const envBool = (envKey, fileKey, fallback) => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return !/^(0|false|no|off)$/i.test(String(fromEnv).trim());
    }
    if (typeof f[fileKey] === "boolean") {
      return f[fileKey];
    }
    return fallback;
  };

  return {
    driveFolderId: envOr("VOICE_MEMO_DRIVE_FOLDER_ID", "driveFolderId", ""),
    fileExtension: envOr("VOICE_MEMO_FILE_EXTENSION", "fileExtension", "m4a"),
    fileExtensions: envOr(
      "VOICE_MEMO_FILE_EXTENSIONS",
      "fileExtensions",
      DEFAULT_VOICE_MEMO_FILE_EXTENSIONS_CSV,
    ),
    minDurationSeconds: envOr("VOICE_MEMO_MIN_DURATION_SECONDS", "minDurationSeconds", "30"),
    maxDurationSeconds: envOr("VOICE_MEMO_MAX_DURATION_SECONDS", "maxDurationSeconds", "120"),
    round2ColumnHeader: envOr("VOICE_MEMO_ROUND2_COLUMN_HEADER", "round2ColumnHeader", "Round 2"),
    linksColumnHeader: normalizeVoiceMemoColumnHeader(
      envOr("VOICE_MEMO_LINKS_COLUMN_HEADER", "linksColumnHeader", ""),
      ["Links"],
      "Voice note link",
      "Voice note link",
    ),
    dateOfSubmissionColumnHeader: normalizeVoiceMemoColumnHeader(
      envOr("VOICE_MEMO_DATE_COLUMN_HEADER", "dateOfSubmissionColumnHeader", ""),
      ["Date of Submission", "Date of submission"],
      "Voice note last updated",
      "Voice note last updated",
    ),
    round1ColumnHeader: envOr("VOICE_MEMO_ROUND1_COLUMN_HEADER", "round1ColumnHeader", "Round 1"),
    round1AcceptedValue: envOr("VOICE_MEMO_ROUND1_ACCEPTED_VALUE", "round1AcceptedValue", "Accepted"),
    round1RejectedValue: envOr("VOICE_MEMO_ROUND1_REJECTED_VALUE", "round1RejectedValue", "Rejected"),
    submittedValue: envOr("VOICE_MEMO_SUBMITTED_VALUE", "submittedValue", "Submitted"),
    submissionTimeSource: envOr(
      "VOICE_MEMO_SUBMISSION_TIME_SOURCE",
      "submissionTimeSource",
      "createdTime",
    ),
    onlyIfRound1Accepted: envBool("VOICE_MEMO_ONLY_IF_ROUND1_ACCEPTED", "onlyIfRound1Accepted", true),
    submissionInstructions: envOr(
      "VOICE_MEMO_SUBMISSION_INSTRUCTIONS",
      "submissionInstructions",
      "Submit your Round 2 voice memo using the instructions you received by email. Once it is received, this page will show Submitted and you can listen to your recording here.",
    ),
  };
}

function buildPostmarkConfig(fileSection) {
  const f = fileSection && typeof fileSection === "object" ? fileSection : {};
  const envOr = (envKey, fileKey, fallback = "") => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv).trim();
    }
    const fromFile = f[fileKey];
    if (fromFile != null && String(fromFile).trim() !== "") {
      return String(fromFile).trim();
    }
    return fallback;
  };
  return {
    serverToken: envOr("POSTMARK_SERVER_TOKEN", "serverToken", ""),
    webhookSecret: envOr("POSTMARK_WEBHOOK_SECRET", "webhookSecret", ""),
  };
}

/**
 * Use one Postmark token everywhere: promote legacy email.postmark.serverToken
 * to the top-level postmark block when needed.
 * @param {Record<string, unknown>} secrets
 */
function mergePostmarkSecrets(secrets) {
  secrets.postmark = buildPostmarkConfig(secrets.postmark);
  const nested =
    secrets.email &&
    typeof secrets.email === "object" &&
    secrets.email.postmark &&
    typeof secrets.email.postmark === "object" &&
    secrets.email.postmark.serverToken != null
      ? String(secrets.email.postmark.serverToken).trim()
      : "";
  const top = secrets.postmark.serverToken || "";
  const resolved = top || nested;
  if (resolved) {
    secrets.postmark.serverToken = resolved;
  }
}

/**
 * Build Google Classroom sync settings from an optional secrets.json `classroom`
 * section merged with process.env (env wins when set). The sync reuses the Gmail
 * service-account credentials, so only an impersonation email and the destination
 * tab/column layout are configured here.
 * @param {Record<string, unknown>|undefined} fileSection
 * @param {Record<string, unknown>|undefined} emailSection
 */
function buildClassroomConfig(fileSection, emailSection) {
  const f = fileSection && typeof fileSection === "object" ? fileSection : {};
  const envOr = (envKey, fileKey, fallback) => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv).trim();
    }
    const fromFile = f[fileKey];
    if (fromFile != null && String(fromFile).trim() !== "") {
      return String(fromFile).trim();
    }
    return fallback;
  };

  const boolOr = (envKey, fileKey, fallback) => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv).trim().toLowerCase() === "true";
    }
    const fromFile = f[fileKey];
    if (typeof fromFile === "boolean") {
      return fromFile;
    }
    if (fromFile != null && String(fromFile).trim() !== "") {
      return String(fromFile).trim().toLowerCase() === "true";
    }
    return fallback;
  };

  // Default the impersonated Workspace user to the Gmail delegated user when not set.
  const delegatedUser =
    emailSection && typeof emailSection === "object"
      ? emailSection.gmailServiceAccount?.delegatedUser
      : undefined;
  const impersonateFallback =
    delegatedUser != null && String(delegatedUser).trim() !== ""
      ? String(delegatedUser).trim()
      : "";

  return {
    enabled: boolOr("CLASSROOM_SYNC_ENABLED", "enabled", false),
    impersonateEmail: envOr("CLASSROOM_IMPERSONATE_EMAIL", "impersonateEmail", impersonateFallback),
    rolesSheetName: envOr("CLASSROOM_ROLES_SHEET_NAME", "rolesSheetName", "Classroom Roles"),
    rolesEmailColumn: envOr("CLASSROOM_ROLES_EMAIL_COLUMN", "rolesEmailColumn", "A"),
    rolesRoleColumn: envOr("CLASSROOM_ROLES_ROLE_COLUMN", "rolesRoleColumn", "B"),
    rolesClassesColumn: envOr("CLASSROOM_ROLES_CLASSES_COLUMN", "rolesClassesColumn", "C"),
    gradesSheetName: envOr("CLASSROOM_GRADES_SHEET_NAME", "gradesSheetName", "Classroom Grades"),
    gradesEmailColumn: envOr("CLASSROOM_GRADES_EMAIL_COLUMN", "gradesEmailColumn", "A"),
    gradesNameColumn: envOr("CLASSROOM_GRADES_NAME_COLUMN", "gradesNameColumn", "B"),
    gradesSectionColumn: envOr("CLASSROOM_GRADES_SECTION_COLUMN", "gradesSectionColumn", "C"),
    gradesGradeColumn: envOr("CLASSROOM_GRADES_GRADE_COLUMN", "gradesGradeColumn", "D"),
  };
}

function buildEmailFromEnv() {
  return {
    provider: process.env.EMAIL_PROVIDER || "smtp",
    from: process.env.EMAIL_FROM || "noreply@aesopafghanistan.org",
    smtp: {
      host: process.env.SMTP_HOST || "",
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      user: process.env.SMTP_USER || "",
      password: process.env.SMTP_PASSWORD || "",
    },
    sendgrid: {
      apiKey: process.env.SENDGRID_API_KEY || "",
    },
    postmark: {
      serverToken: process.env.POSTMARK_SERVER_TOKEN || "",
      messageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
      broadcastMessageStream: process.env.POSTMARK_BROADCAST_MESSAGE_STREAM || "broadcast",
    },
    gmail: {
      user: process.env.GMAIL_USER || "",
      appPassword: process.env.GMAIL_APP_PASSWORD || "",
    },
    gmailServiceAccount: {
      delegatedUser: process.env.GMAIL_SA_DELEGATED_USER || "",
      credentials: (() => {
        const raw = process.env.GMAIL_SA_CREDENTIALS_JSON || "";
        if (!raw) {
          return null;
        }

        try {
          return JSON.parse(raw);
        } catch (error) {
          console.error("Invalid GMAIL_SA_CREDENTIALS_JSON: must be valid JSON");
          return null;
        }
      })(),
    },
  };
}

/**
 * Portal admin allowlist and DingConnect+ bulk top-up defaults.
 * @param {Record<string, unknown>|undefined} fileSection
 */
function buildAdminConfig(fileSection) {
  const f = fileSection && typeof fileSection === "object" ? fileSection : {};
  const envOr = (envKey, fileKey, fallback) => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv).trim();
    }
    const fromFile = f[fileKey];
    if (fromFile != null && String(fromFile).trim() !== "") {
      return String(fromFile).trim();
    }
    return fallback;
  };

  const parseEmails = () => {
    const fromEnv = process.env.PORTAL_ADMIN_EMAILS;
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv)
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    }
    const fromFile = f.emails;
    if (Array.isArray(fromFile)) {
      return fromFile.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
    }
    if (typeof fromFile === "string" && fromFile.trim()) {
      return fromFile
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    }
    return [];
  };

  const thresholdRaw = envOr("PORTAL_ADMIN_GRADE_THRESHOLD", "gradeThreshold", "65");
  const gradeThreshold = Number.parseFloat(thresholdRaw);
  return {
    emails: parseEmails(),
    gradeThreshold: Number.isFinite(gradeThreshold) ? gradeThreshold : 65,
    dingConnectTopUpAmount: envOr("DINGCONNECT_TOPUP_AMOUNT", "dingConnectTopUpAmount", "500"),
    dingConnectTopUpSku: envOr("DINGCONNECT_TOPUP_SKU", "dingConnectTopUpSku", "DINGCONNECT_PLUS_AF"),
  };
}

function buildDatabaseConfig(fileSection) {
  const f = fileSection && typeof fileSection === "object" ? fileSection : {};
  const envOr = (envKey, fileKey, fallback = "") => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv).trim();
    }
    const fromFile = f[fileKey];
    if (fromFile != null && String(fromFile).trim() !== "") {
      return String(fromFile).trim();
    }
    return fallback;
  };
  return {
    url: envOr("DATABASE_URL", "url", ""),
  };
}

function buildBackupConfig(fileSection) {
  const f = fileSection && typeof fileSection === "object" ? fileSection : {};
  const envOr = (envKey, fileKey, fallback = "") => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv).trim();
    }
    const fromFile = f[fileKey];
    if (fromFile != null && String(fromFile).trim() !== "") {
      return String(fromFile).trim();
    }
    return fallback;
  };
  return {
    enabled: envOr("BACKUP_EXPORT_ENABLED", "enabled", "true"),
    provider: envOr("BACKUP_EXPORT_PROVIDER", "provider", "local"),
    bucket: envOr("BACKUP_S3_BUCKET", "bucket", ""),
    prefix: envOr("BACKUP_S3_PREFIX", "prefix", "classroom-sync"),
    region: envOr("BACKUP_S3_REGION", "region", "auto"),
    endpoint: envOr("BACKUP_S3_ENDPOINT", "endpoint", ""),
    accessKeyId: envOr("BACKUP_S3_ACCESS_KEY_ID", "accessKeyId", ""),
    secretAccessKey: envOr("BACKUP_S3_SECRET_ACCESS_KEY", "secretAccessKey", ""),
    localDir: envOr("BACKUP_LOCAL_DIR", "localDir", ""),
  };
}

/**
 * Optional inbox for portal “contact us” Ding help requests. `PORTAL_CONTACT_EMAIL` overrides file value.
 * @param {Record<string, unknown>} target
 */
function mergePortalContactEmail(target) {
  if (!target || typeof target !== "object") {
    return;
  }
  const fromEnv = process.env.PORTAL_CONTACT_EMAIL;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    target.portalContactEmail = String(fromEnv).trim();
    return;
  }
  const fromFile = target.portalContactEmail;
  target.portalContactEmail =
    fromFile != null && String(fromFile).trim() !== "" ? String(fromFile).trim() : "";
}

/**
 * Fly.io (and similar): entire secrets object as one JSON string.
 * Discrete env vars (e.g. GOOGLE_SHEET_ID) still override googleSheets via buildGoogleSheetsConfig.
 * @returns {Record<string, unknown>|null}
 */
function loadSecretsFromSecretsJsonEnv() {
  const raw = process.env.SECRETS_JSON;
  if (raw == null || String(raw).trim() === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("SECRETS_JSON must be a JSON object");
      return null;
    }
    parsed.googleSheets = buildGoogleSheetsConfig(parsed.googleSheets);
    parsed.voiceMemo = buildVoiceMemoConfig(parsed.voiceMemo);
    parsed.classroom = buildClassroomConfig(parsed.classroom, parsed.email);
    parsed.admin = buildAdminConfig(parsed.admin);
    parsed.database = buildDatabaseConfig(parsed.database);
    parsed.backup = buildBackupConfig(parsed.backup);
    parsed.postmark = buildPostmarkConfig(parsed.postmark);
    mergePostmarkSecrets(parsed);
    mergePortalContactEmail(parsed);
    return parsed;
  } catch (error) {
    console.error("Invalid SECRETS_JSON:", error);
    return null;
  }
}

/**
 * Load secrets: SECRETS_JSON (Fly.io) → config/secrets.json → discrete env vars only.
 */
function loadSecrets() {
  if (secrets) {
    return secrets;
  }

  const fromSecretsJsonEnv = loadSecretsFromSecretsJsonEnv();
  if (fromSecretsJsonEnv) {
    secrets = fromSecretsJsonEnv;
    return secrets;
  }

  const secretsPath = path.join(__dirname, "secrets.json");

  if (fs.existsSync(secretsPath)) {
    try {
      const fileContent = fs.readFileSync(secretsPath, "utf8");
      secrets = JSON.parse(fileContent);
      secrets.googleSheets = buildGoogleSheetsConfig(secrets.googleSheets);
      secrets.voiceMemo = buildVoiceMemoConfig(secrets.voiceMemo);
      secrets.classroom = buildClassroomConfig(secrets.classroom, secrets.email);
      secrets.admin = buildAdminConfig(secrets.admin);
      secrets.database = buildDatabaseConfig(secrets.database);
      secrets.backup = buildBackupConfig(secrets.backup);
      secrets.postmark = buildPostmarkConfig(secrets.postmark);
      mergePostmarkSecrets(secrets);
      mergePortalContactEmail(secrets);
      return secrets;
    } catch (error) {
      console.error("Error reading secrets.json:", error);
    }
  }

  const emailFromEnv = buildEmailFromEnv();
  secrets = {
    googleSheets: buildGoogleSheetsConfig(undefined),
    voiceMemo: buildVoiceMemoConfig(undefined),
    classroom: buildClassroomConfig(undefined, emailFromEnv),
    admin: buildAdminConfig(undefined),
    database: buildDatabaseConfig(undefined),
    backup: buildBackupConfig(undefined),
    postmark: buildPostmarkConfig(undefined),
    email: emailFromEnv,
    portalContactEmail: "",
  };
  mergePortalContactEmail(secrets);

  return secrets;
}

module.exports = loadSecrets();
