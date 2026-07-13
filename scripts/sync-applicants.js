#!/usr/bin/env node
/**
 * Mirror Applicants sheet + Drive voice memo metadata into Postgres.
 *
 * Usage: npm run sync:applicants
 */
require("../config/secrets");
const { runMigrations } = require("../db/migrate");
const { setDriveScriptRateLimit } = require("../services/googleDrive");
const { mirrorApplicantsAndDriveFromSheets } = require("../services/peopleMirror");
const { formatErrorForLog } = require("../utils/errorLogging");
const { isDatabaseEnabled, closeDatabase } = require("../db/index");
const { getServiceAccountCredentials } = require("../services/googleAuth");

async function main() {
  setDriveScriptRateLimit(true);
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not set.");
  }

  const credentials = getServiceAccountCredentials();
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error(
      "Google service account credentials are missing. Configure SECRETS_JSON or GMAIL_SA_CREDENTIALS_JSON.",
    );
  }

  await runMigrations();
  const result = await mirrorApplicantsAndDriveFromSheets();
  console.log("[sync-applicants] mirrored:", result.mirrored, "driveFiles:", result.driveFiles);
  return result;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[sync-applicants] failed:", formatErrorForLog(err));
    process.exit(1);
  })
  .finally(() => closeDatabase());
