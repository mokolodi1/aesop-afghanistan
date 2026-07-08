#!/usr/bin/env node
/**
 * Mirror only the ApplicantReviews tab into Postgres (fast path after sheet edits).
 *
 * Usage: npm run sync:applicant-reviews
 */
require("../config/secrets");
const { runMigrations } = require("../db/migrate");
const { mirrorApplicantReviewsFromSheets } = require("../services/peopleMirror");
const { formatErrorForLog } = require("../utils/errorLogging");
const { isDatabaseEnabled, closeDatabase } = require("../db/index");
const { getServiceAccountCredentials } = require("../services/googleAuth");

async function main() {
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
  const result = await mirrorApplicantReviewsFromSheets();
  console.log("[sync-applicant-reviews] mirrored:", result.mirrored);
  return result;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[sync-applicant-reviews] failed:", formatErrorForLog(err));
    process.exit(1);
  })
  .finally(() => closeDatabase());
