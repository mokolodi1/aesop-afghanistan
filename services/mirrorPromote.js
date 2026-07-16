const { getPool } = require("../db/index");
const { isMirrorTimestampFresh, describeMirrorTimestamp } = require("./mirrorCache");

const STAGING_TABLES = [
  "applicant_reviews_staging",
  "applicants_staging",
  "ding_numbers_staging",
  "people_staging",
];

function envFlag(raw) {
  if (raw == null || String(raw).trim() === "") {
    return false;
  }
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** @returns {boolean} */
function useMirrorStaging() {
  return envFlag(process.env.MIRROR_USE_STAGING);
}

/**
 * @param {import("pg").Pool | import("pg").PoolClient} runner
 */
async function truncateMirrorStagingTables(runner) {
  for (const table of STAGING_TABLES) {
    await runner.query(`TRUNCATE TABLE ${table}`);
  }
}

/**
 * Clear one mirror staging table (e.g. after a failed sub-step so promote skips it).
 * @param {import("pg").Pool | import("pg").PoolClient} runner
 * @param {string} tableName
 */
async function truncateMirrorStagingTable(runner, tableName) {
  if (!STAGING_TABLES.includes(tableName)) {
    throw new Error(`Unknown mirror staging table: ${tableName}`);
  }
  await runner.query(`TRUNCATE TABLE ${tableName}`);
}

/**
 * @param {number|null|undefined} jobRunId
 * @returns {Promise<number>}
 */
async function createMirrorSyncRun(jobRunId = null) {
  const pool = getPool();
  if (!pool) {
    throw new Error("Database is not configured.");
  }
  const startedAt = new Date();
  const result = await pool.query(
    `INSERT INTO mirror_sync_runs (job_run_id, started_at, status)
     VALUES ($1, $2, 'running')
     RETURNING id`,
    [jobRunId ?? null, startedAt],
  );
  return result.rows[0].id;
}

/**
 * @param {number} mirrorSyncRunId
 * @param {'succeeded'|'failed'} status
 * @param {{
 *   peopleCount?: number,
 *   dingCount?: number,
 *   applicantsCount?: number,
 *   applicantReviewsCount?: number,
 *   error?: string|null,
 * }} [stats]
 */
async function finalizeMirrorSyncRun(mirrorSyncRunId, status, stats = {}) {
  const pool = getPool();
  if (!pool) {
    return;
  }
  await pool.query(
    `UPDATE mirror_sync_runs SET
       finished_at = NOW(),
       status = $2,
       people_count = $3,
       ding_count = $4,
       applicants_count = $5,
       applicant_reviews_count = $6,
       error = $7
     WHERE id = $1`,
    [
      mirrorSyncRunId,
      status,
      stats.peopleCount ?? null,
      stats.dingCount ?? null,
      stats.applicantsCount ?? null,
      stats.applicantReviewsCount ?? null,
      stats.error ?? null,
    ],
  );
}

/** @returns {Promise<{ id: number, startedAt: Date, finishedAt: Date|null, status: string }|null>} */
async function getLastSuccessfulMirrorSyncRun() {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const result = await pool.query(
    `SELECT id, started_at, finished_at, status
     FROM mirror_sync_runs
     WHERE status = 'succeeded'
     ORDER BY finished_at DESC NULLS LAST
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
  };
}

/** @returns {Promise<boolean>} */
async function isHourlyMirrorFresh() {
  const lastRun = await getLastSuccessfulMirrorSyncRun();
  if (lastRun?.finishedAt) {
    return isMirrorTimestampFresh(lastRun.finishedAt);
  }
  return legacyTableMirrorFresh("people");
}

/** @returns {Promise<boolean>} */
async function isApplicantsMirrorTableFresh() {
  const lastRun = await getLastSuccessfulMirrorSyncRun();
  if (lastRun?.finishedAt) {
    return isMirrorTimestampFresh(lastRun.finishedAt);
  }
  return legacyTableMirrorFresh("applicants");
}

/** @returns {Promise<boolean>} */
async function isApplicantReviewsMirrorTableFresh() {
  const lastRun = await getLastSuccessfulMirrorSyncRun();
  if (lastRun?.finishedAt) {
    return isMirrorTimestampFresh(lastRun.finishedAt);
  }
  return legacyTableMirrorFresh("applicant_reviews");
}

/**
 * @param {'people'|'applicants'|'applicant_reviews'} table
 * @returns {Promise<boolean>}
 */
async function legacyTableMirrorFresh(table) {
  const pool = getPool();
  if (!pool) {
    return false;
  }
  const result = await pool.query(
    `SELECT MAX(synced_at) AS latest FROM ${table} WHERE synced_at IS NOT NULL`,
  );
  return isMirrorTimestampFresh(result.rows[0]?.latest);
}

/** @returns {Promise<Date|string|null>} */
async function getHourlyMirrorLastSyncedAt() {
  const lastRun = await getLastSuccessfulMirrorSyncRun();
  if (lastRun?.finishedAt) {
    return lastRun.finishedAt;
  }
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const result = await pool.query(
    `SELECT MAX(synced_at) AS latest FROM people WHERE synced_at IS NOT NULL`,
  );
  return result.rows[0]?.latest || null;
}

/**
 * @returns {Promise<{ fresh: boolean, ageMs: number|null, maxAgeMs: number, lastSyncedAt: Date|string|null }>}
 */
async function describeHourlyMirrorFreshness() {
  const lastSyncedAt = await getHourlyMirrorLastSyncedAt();
  return { ...describeMirrorTimestamp(lastSyncedAt), lastSyncedAt };
}

/**
 * Convert a people_staging row into a sheet profile for merge helpers.
 * @param {Record<string, unknown>} row
 */
function stagingRowToProfile(row) {
  const sheetRow =
    row.sheet_row && typeof row.sheet_row === "object" ? row.sheet_row : {};
  const sheetRowNumber = sheetRow.__rowNumber;
  return {
    id: row.aesop_id ? String(row.aesop_id).trim() : "",
    email: String(row.email || "").trim(),
    name: row.name ? String(row.name) : "",
    phone: row.phone ? String(row.phone) : "",
    portalRole: row.portal_role ? String(row.portal_role) : "",
    reviewerRole: row.reviewer_role ? String(row.reviewer_role) : "",
    peopleType: row.people_type ? String(row.people_type) : "",
    adminRole: row.admin_role ? String(row.admin_role) : "",
    peopleStatus: row.people_status ? String(row.people_status) : "",
    lastLogin: row.last_login ? String(row.last_login) : "",
    pastDing: row.past_ding ? String(row.past_ding) : "",
    sheetRow,
    sheetRowNumber:
      sheetRowNumber != null && Number.isFinite(Number(sheetRowNumber))
        ? Number(sheetRowNumber)
        : undefined,
  };
}

/**
 * Atomically promote staging tables into production.
 * @param {number} mirrorSyncRunId
 * @param {Set<string>} applicantIdSet
 * @returns {Promise<{ people: number, peoplePruned: number, dingNumbers: number, applicants: number, applicantReviews: number }>}
 */
async function promoteStagingMirror(mirrorSyncRunId, applicantIdSet) {
  const {
    personSheetIdentityKey,
    findExistingPersonId,
    buildPersonInsertParams,
    INSERT_PERSON_FROM_SHEET_SQL,
    UPDATE_PERSON_FROM_SHEET_SQL,
  } = require("./peopleMirror");

  const pool = getPool();
  if (!pool) {
    throw new Error("Database is not configured.");
  }

  const runResult = await pool.query(
    `SELECT started_at FROM mirror_sync_runs WHERE id = $1`,
    [mirrorSyncRunId],
  );
  const syncedAt = runResult.rows[0]?.started_at
    ? new Date(runResult.rows[0].started_at)
    : new Date();

  const client = await pool.connect();
  let peopleMerged = 0;
  let peoplePruned = 0;
  let dingMerged = 0;
  let applicantsMerged = 0;
  let reviewsMerged = 0;

  try {
    await client.query("BEGIN");

    const stagingPeople = await client.query(`SELECT * FROM people_staging`);
    if (stagingPeople.rows.length === 0) {
      throw new Error("people_staging is empty — refusing to promote.");
    }

    /** @type {Map<string, number>} */
    const personIdByIdentityKey = new Map();
    const stagingIdentityKeys = new Set();

    for (const row of stagingPeople.rows) {
      const profile = stagingRowToProfile(row);
      const identityKey = String(row.identity_key || personSheetIdentityKey(profile));
      stagingIdentityKeys.add(identityKey);

      const params = buildPersonInsertParams(profile, syncedAt, applicantIdSet);
      const existingId = await findExistingPersonId(client, profile);
      let personRow;
      if (existingId) {
        const updated = await client.query(UPDATE_PERSON_FROM_SHEET_SQL, [...params, existingId]);
        personRow = updated.rows[0];
      } else {
        const inserted = await client.query(INSERT_PERSON_FROM_SHEET_SQL, params);
        personRow = inserted.rows[0];
      }
      if (personRow?.id) {
        personIdByIdentityKey.set(identityKey, personRow.id);
        peopleMerged += 1;
      }
    }

    const stagingDing = await client.query(`SELECT * FROM ding_numbers_staging`);
    for (const row of stagingDing.rows) {
      const identityKey = String(row.identity_key || "");
      const personId = personIdByIdentityKey.get(identityKey);
      if (!personId) {
        continue;
      }
      const nextNumber = String(row.number || "").trim();
      if (!nextNumber) {
        continue;
      }

      const current = await client.query(
        `SELECT number FROM ding_numbers
         WHERE person_id = $1 AND is_current = true
         LIMIT 1`,
        [personId],
      );
      const currentNumber =
        current.rows[0]?.number != null ? String(current.rows[0].number).trim() : "";
      if (currentNumber === nextNumber) {
        continue;
      }

      await client.query(
        `UPDATE ding_numbers SET is_current = false WHERE person_id = $1`,
        [personId],
      );
      await client.query(
        `INSERT INTO ding_numbers (person_id, number, is_current, source, updated_at)
         VALUES ($1, $2, true, 'google_sheets', $3)`,
        [personId, nextNumber, syncedAt],
      );
      dingMerged += 1;
    }

    const stagingApplicants = await client.query(`SELECT * FROM applicants_staging`);
    for (const row of stagingApplicants.rows) {
      const result = await client.query(
        `INSERT INTO applicants (
           aesop_id, email, name, applied_level, age, essay,
           round1, round2, round2_prompt, applicant_links, submitted_at,
           drive_file_id, drive_file_name, drive_duration_seconds, synced_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (aesop_id) DO UPDATE SET
           email = COALESCE(EXCLUDED.email, applicants.email),
           name = EXCLUDED.name,
           applied_level = EXCLUDED.applied_level,
           age = EXCLUDED.age,
           essay = EXCLUDED.essay,
           round1 = EXCLUDED.round1,
           round2 = EXCLUDED.round2,
           round2_prompt = EXCLUDED.round2_prompt,
           applicant_links = EXCLUDED.applicant_links,
           submitted_at = EXCLUDED.submitted_at,
           drive_file_id = EXCLUDED.drive_file_id,
           drive_file_name = EXCLUDED.drive_file_name,
           drive_duration_seconds = EXCLUDED.drive_duration_seconds,
           synced_at = EXCLUDED.synced_at
         RETURNING id`,
        [
          row.aesop_id,
          row.email,
          row.name ?? "",
          row.applied_level ?? "",
          row.age ?? "",
          row.essay ?? "",
          row.round1 ?? "",
          row.round2 ?? "",
          row.round2_prompt ?? "",
          row.applicant_links ?? "",
          row.submitted_at ?? "",
          row.drive_file_id || null,
          row.drive_file_name || null,
          row.drive_duration_seconds ?? null,
          syncedAt,
        ],
      );
      if (result.rows[0]) {
        applicantsMerged += 1;
      }
    }

    const stagingReviews = await client.query(`SELECT * FROM applicant_reviews_staging`);
    for (const row of stagingReviews.rows) {
      const result = await client.query(
        `INSERT INTO applicant_reviews (
           aesop_id, reviewer_a, reviewer_b,
           a_english_level, a_suspected_ai, a_unable_to_grade, a_technical_flag,
           a_instruction_following, a_original_thinking, a_character,
           b_english_level, b_suspected_ai, b_unable_to_grade, b_technical_flag,
           b_instruction_following, b_original_thinking, b_character,
           sheet_row_number, synced_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (aesop_id) DO UPDATE SET
           reviewer_a = EXCLUDED.reviewer_a,
           reviewer_b = EXCLUDED.reviewer_b,
           a_english_level = EXCLUDED.a_english_level,
           a_suspected_ai = EXCLUDED.a_suspected_ai,
           a_unable_to_grade = EXCLUDED.a_unable_to_grade,
           a_technical_flag = EXCLUDED.a_technical_flag,
           a_instruction_following = EXCLUDED.a_instruction_following,
           a_original_thinking = EXCLUDED.a_original_thinking,
           a_character = EXCLUDED.a_character,
           b_english_level = EXCLUDED.b_english_level,
           b_suspected_ai = EXCLUDED.b_suspected_ai,
           b_unable_to_grade = EXCLUDED.b_unable_to_grade,
           b_technical_flag = EXCLUDED.b_technical_flag,
           b_instruction_following = EXCLUDED.b_instruction_following,
           b_original_thinking = EXCLUDED.b_original_thinking,
           b_character = EXCLUDED.b_character,
           sheet_row_number = COALESCE(EXCLUDED.sheet_row_number, applicant_reviews.sheet_row_number),
           synced_at = EXCLUDED.synced_at
         RETURNING id`,
        [
          row.aesop_id,
          row.reviewer_a ?? "",
          row.reviewer_b ?? "",
          row.a_english_level ?? "",
          row.a_suspected_ai ?? "",
          row.a_unable_to_grade ?? "",
          row.a_technical_flag ?? "",
          row.a_instruction_following ?? "",
          row.a_original_thinking ?? "",
          row.a_character ?? "",
          row.b_english_level ?? "",
          row.b_suspected_ai ?? "",
          row.b_unable_to_grade ?? "",
          row.b_technical_flag ?? "",
          row.b_instruction_following ?? "",
          row.b_original_thinking ?? "",
          row.b_character ?? "",
          row.sheet_row_number ?? null,
          syncedAt,
        ],
      );
      if (result.rows[0]) {
        reviewsMerged += 1;
      }
    }

    const existingPeople = await client.query(
      `SELECT id, aesop_id, email, name, sheet_row FROM people`,
    );
    const toDelete = [];
    for (const row of existingPeople.rows) {
      const sheetRow = row.sheet_row && typeof row.sheet_row === "object" ? row.sheet_row : {};
      const key = personSheetIdentityKey({
        id: row.aesop_id,
        email: row.email,
        name: row.name,
        sheetRowNumber: sheetRow.__rowNumber,
      });
      if (!stagingIdentityKeys.has(key)) {
        toDelete.push(row.id);
      }
    }
    if (toDelete.length > 0) {
      const deleted = await client.query(`DELETE FROM people WHERE id = ANY($1::int[])`, [
        toDelete,
      ]);
      peoplePruned = deleted.rowCount || 0;
    }

    await truncateMirrorStagingTables(client);
    await client.query("COMMIT");

    return {
      people: peopleMerged,
      peoplePruned,
      dingNumbers: dingMerged,
      applicants: applicantsMerged,
      applicantReviews: reviewsMerged,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  useMirrorStaging,
  truncateMirrorStagingTables,
  truncateMirrorStagingTable,
  createMirrorSyncRun,
  finalizeMirrorSyncRun,
  getLastSuccessfulMirrorSyncRun,
  isHourlyMirrorFresh,
  isApplicantsMirrorTableFresh,
  isApplicantReviewsMirrorTableFresh,
  getHourlyMirrorLastSyncedAt,
  describeHourlyMirrorFreshness,
  promoteStagingMirror,
};
