const fs = require("fs");
const path = require("path");

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
    phoneColumn: envOr("GOOGLE_PHONE_COLUMN", "phoneColumn", "E"),
    dingChangesSheetName: envOr(
      "GOOGLE_DING_CHANGES_SHEET_NAME",
      "dingChangesSheetName",
      "Ding changes"
    ),
    dingIdColumn: envOr("GOOGLE_DING_ID_COLUMN", "dingIdColumn", "A"),
    dingTimestampColumn: envOr("GOOGLE_DING_TIMESTAMP_COLUMN", "dingTimestampColumn", "B"),
    dingNumberColumn: envOr("GOOGLE_DING_NUMBER_COLUMN", "dingNumberColumn", "C"),
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
      return secrets;
    } catch (error) {
      console.error("Error reading secrets.json:", error);
    }
  }

  secrets = {
    googleSheets: buildGoogleSheetsConfig(undefined),
    email: buildEmailFromEnv(),
  };

  return secrets;
}

module.exports = loadSecrets();
