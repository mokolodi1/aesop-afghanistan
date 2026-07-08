#!/usr/bin/env node
/**
 * Rebuild Postgres people table from the People Google Sheet tab (full column mirror).
 *
 * Usage:
 *   node scripts/rebuild-people-from-sheets.js --dry-run
 *   node scripts/rebuild-people-from-sheets.js
 *
 * WARNING: default mode TRUNCATEs people (CASCADE deletes ding/enrollment FKs).
 * Run npm run sync:hourly-cache afterward to repopulate Ding mirror tables.
 */
require("../config/secrets");
const { runMigrations } = require("../db/migrate");
const { rebuildPeopleTableFromSheets } = require("../services/peopleMirror");
const { isDatabaseEnabled, closeDatabase } = require("../db/index");

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not set.");
  }

  await runMigrations();

  if (DRY_RUN) {
    const preview = await rebuildPeopleTableFromSheets({ dryRun: true });
    console.log("[rebuild-people-from-sheets] dry-run:", preview);
    return;
  }

  console.warn(
    "[rebuild-people-from-sheets] TRUNCATE people CASCADE — ding/enrollment links will be cleared.",
  );
  const result = await rebuildPeopleTableFromSheets();
  console.log("[rebuild-people-from-sheets] done:", result);
}

main()
  .catch((error) => {
    console.error("[rebuild-people-from-sheets] failed:", error.message);
    process.exit(1);
  })
  .finally(() => closeDatabase());
