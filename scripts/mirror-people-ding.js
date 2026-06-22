#!/usr/bin/env node
require("../config/secrets");
const { runMigrations } = require("../db/migrate");
const { mirrorPeopleAndDingFromSheets } = require("../services/peopleMirror");
const { isDatabaseEnabled } = require("../db/index");

async function main() {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  await runMigrations();
  const result = await mirrorPeopleAndDingFromSheets();
  console.log("[mirror-people-ding] done:", result);
}

main().catch((error) => {
  console.error("[mirror-people-ding] failed:", error.message);
  process.exit(1);
});
