const fs = require("fs");
const path = require("path");

let secrets = null;

/**
 * Load secrets from secrets.json file
 * Falls back to environment variables if file doesn't exist
 */
function loadSecrets() {
  if (secrets) {
    return secrets;
  }

  const secretsPath = path.join(__dirname, "secrets.json");

  // Try to load from file first
  if (fs.existsSync(secretsPath)) {
    try {
      const fileContent = fs.readFileSync(secretsPath, "utf8");
      secrets = JSON.parse(fileContent);
      return secrets;
    } catch (error) {
      console.error("Error reading secrets.json:", error);
    }
  }

  // Fall back to environment variables
  secrets = {
    googleSheets: {
      sheetId: process.env.GOOGLE_SHEET_ID || "",
      sheetName: process.env.GOOGLE_SHEET_NAME || "People",
      idColumn: process.env.GOOGLE_ID_COLUMN || "B",
      nameColumn: process.env.GOOGLE_NAME_COLUMN || "C",
      emailColumn: process.env.GOOGLE_EMAIL_COLUMN || "D",
    },
    email: {
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
    },
  };

  return secrets;
}

module.exports = loadSecrets();
