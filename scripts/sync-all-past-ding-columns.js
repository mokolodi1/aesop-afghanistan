#!/usr/bin/env node
/**
 * One-shot: for each People row whose ID matches Ding changes (People column B vs Ding changes column A by default),
 * set column V (by default) to every Ding number from Ding changes, ordered by that sheet’s timestamp column.
 *
 * Requires local config/secrets.json or SECRETS_JSON / env matching production.
 *
 * Usage: npm run sync:past-ding-columns
 */

require("../config/secrets");
const { syncAllPeoplePastDingColumns } = require("../services/googleSheets");

syncAllPeoplePastDingColumns()
  .then((result) => {
    console.log(
      `Updated ${result.updated} People row(s) where ID appears on both sheets; ${result.skippedNoPeople} Ding-change id(s) had no People row; ${result.idCount} distinct id(s) with Ding history on Ding changes.`,
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
