const { eq, and, sql } = require("drizzle-orm");
const config = require("../config/secrets");
const { getDb, getPool, isDatabaseEnabled } = require("../db/index");
const { people, dingNumbers, dingChangeHistory } = require("../db/schema");
const { upsertApplicantFromMirror, upsertApplicantReviewFromMirror } = require("./classroomDb");
const {
  loadAllPeopleRowsFromSheets,
  loadEmailToPeopleProfileMap,
  buildLatestDingNumberByUserIdMap,
  getPortalDingChangeHistory,
  resolvePortalRoleFromPeopleSheet,
  syncPeopleStatusOnPeopleSheet,
  loadClassroomRoleEmailSetsFromSheets,
  initGoogleSheets,
  getWorksheetByTitle,
  resolveColumnIndex,
} = require("./googleSheets");
const { getApplicantReviewsConfig } = require("./applicantReviews");
const {
  loadApplicantsDataForStats,
  loadApplicantAesopIdSetFromSheets,
  getVoiceMemoDriveScanOptions,
  findVoiceMemoInScan,
} = require("./voiceMemoSync");
const { scanVoiceMemoFolder, resolveVoiceMemoDurationsMap } = require("./googleDrive");


const INSERT_PERSON_FROM_SHEET_SQL = `
  INSERT INTO people (
    aesop_id, email, name, phone, portal_role, reviewer_role,
    people_type, admin_role, people_status, last_login, past_ding, sheet_row, synced_at
  )
  SELECT
    CASE
      WHEN NULLIF(trim($1::text), '') IS NULL THEN NULL
      WHEN EXISTS (
        SELECT 1 FROM people p
        WHERE p.aesop_id IS NOT NULL AND lower(p.aesop_id) = lower(trim($1::text))
      ) THEN NULL
      ELSE trim($1::text)
    END,
    $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13
  RETURNING *
`;

const UPDATE_PERSON_FROM_SHEET_SQL = `
  UPDATE people SET
    aesop_id = CASE
      WHEN NULLIF(trim($1::text), '') IS NULL THEN people.aesop_id
      WHEN people.aesop_id IS NOT NULL
        AND lower(people.aesop_id) = lower(trim($1::text)) THEN people.aesop_id
      WHEN EXISTS (
        SELECT 1 FROM people p
        WHERE p.id <> people.id
          AND p.aesop_id IS NOT NULL
          AND lower(p.aesop_id) = lower(trim($1::text))
      ) THEN people.aesop_id
      ELSE trim($1::text)
    END,
    email = $2,
    name = $3,
    phone = COALESCE($4, people.phone),
    portal_role = $5,
    reviewer_role = $6,
    people_type = $7,
    admin_role = $8,
    people_status = $9,
    last_login = $10,
    past_ding = $11,
    sheet_row = $12::jsonb,
    synced_at = $13
  WHERE id = $14
  RETURNING *
`;

function normalizePersonName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Sheet identity: AESOP ID when present, otherwise normalized email + name.
 * @param {{ id?: string, email?: string, name?: string }} profile
 */
function personSheetIdentityKey(profile) {
  const aesopId = profile?.id ? String(profile.id).trim().toLowerCase() : "";
  if (aesopId) {
    return `id:${aesopId}`;
  }
  const email = String(profile.email || "").trim().toLowerCase();
  const nameKey = normalizePersonName(profile.name);
  return `email:${email}|${nameKey}`;
}

/**
 * Collapse only same email + same name duplicates (keep last row).
 * Different names on the same email are kept (shared family accounts).
 * @param {Array<object>} rows
 */
function preparePeopleRowsForMirror(rows) {
  const byEmailName = new Map();
  let sameEmailSameNameCollapsed = 0;

  for (const row of rows) {
    const email = String(row.email || "").trim().toLowerCase();
    if (!email) {
      continue;
    }
    const key = `${email}\0${normalizePersonName(row.name)}`;
    if (byEmailName.has(key)) {
      sameEmailSameNameCollapsed += 1;
    }
    byEmailName.set(key, { ...row, email });
  }

  const prepared = [...byEmailName.values()];
  const rowsByEmail = new Map();
  for (const row of prepared) {
    rowsByEmail.set(row.email, (rowsByEmail.get(row.email) || 0) + 1);
  }
  let sharedEmailRows = 0;
  let sharedEmailAddresses = 0;
  for (const count of rowsByEmail.values()) {
    if (count > 1) {
      sharedEmailAddresses += 1;
      sharedEmailRows += count;
    }
  }

  return {
    rows: prepared,
    sameEmailSameNameCollapsed,
    sharedEmailRows,
    sharedEmailAddresses,
  };
}

function logPeopleMirrorDedupeStats(stats) {
  if (stats.sharedEmailRows > 0) {
    console.log(
      `[people-mirror] ${stats.sharedEmailRows} row(s) across ${stats.sharedEmailAddresses} shared email(s) kept (distinct names).`,
    );
  }
  if (stats.sameEmailSameNameCollapsed > 0) {
    console.warn(
      `[people-mirror] ${stats.sameEmailSameNameCollapsed} same email+name duplicate(s) collapsed (kept last row).`,
    );
  }
}

/**
 * @param {import("pg").Pool | import("pg").PoolClient} runner
 * @param {object} profile
 */
async function findExistingPersonId(runner, profile) {
  const aesopId = profile.id ? String(profile.id).trim() : "";
  if (aesopId) {
    const byId = await runner.query(
      `SELECT id FROM people
       WHERE aesop_id IS NOT NULL AND lower(trim(aesop_id)) = lower(trim($1))
       LIMIT 1`,
      [aesopId],
    );
    if (byId.rows[0]?.id) {
      return byId.rows[0].id;
    }
  }

  const email = String(profile.email || "").trim().toLowerCase();
  const nameKey = normalizePersonName(profile.name);
  const byEmailName = await runner.query(
    `SELECT id FROM people
     WHERE lower(btrim(email)) = $1
       AND lower(btrim(coalesce(name, ''))) = $2
     LIMIT 1`,
    [email, nameKey],
  );
  return byEmailName.rows[0]?.id || null;
}

/**
 * @param {object} profile
 * @param {Date} syncedAt
 * @param {Set<string>} applicantIdSet
 */
function buildPersonInsertParams(profile, syncedAt, applicantIdSet) {
  const email = profile.email.trim().toLowerCase();
  const portalRole = resolvePortalRoleFromPeopleSheet(profile, applicantIdSet);
  const aesopId = profile.id ? String(profile.id).trim() : null;
  return [
    aesopId,
    email,
    profile.name || null,
    profile.phone || null,
    portalRole,
    profile.reviewerRole ? String(profile.reviewerRole).trim() : null,
    profile.peopleType ? String(profile.peopleType).trim() : null,
    profile.adminRole ? String(profile.adminRole).trim() : null,
    profile.peopleStatus ? String(profile.peopleStatus).trim() : null,
    profile.lastLogin ? String(profile.lastLogin).trim() : null,
    profile.pastDing ? String(profile.pastDing).trim() : null,
    JSON.stringify(profile.sheetRow || {}),
    syncedAt,
  ];
}

/**
 * @param {object} profile
 * @param {Date} syncedAt
 * @param {Set<string>} applicantIdSet
 * @param {{ client?: import("pg").PoolClient, insertOnly?: boolean }} [options]
 */
async function upsertPersonFromSheetProfile(profile, syncedAt = new Date(), applicantIdSet, options = {}) {
  const pool = getPool();
  const runner = options.client || pool;
  if (!runner || !profile?.email) {
    return null;
  }
  const params = buildPersonInsertParams(profile, syncedAt, applicantIdSet);

  if (options.insertOnly) {
    const result = await runner.query(INSERT_PERSON_FROM_SHEET_SQL, params);
    return result.rows[0] || null;
  }

  const existingId = await findExistingPersonId(runner, profile);
  if (existingId) {
    const result = await runner.query(UPDATE_PERSON_FROM_SHEET_SQL, [...params, existingId]);
    return result.rows[0] || null;
  }

  const result = await runner.query(INSERT_PERSON_FROM_SHEET_SQL, params);
  return result.rows[0] || null;
}

/**
 * @param {Array<object>} sheetRows
 * @param {import("pg").PoolClient} [client]
 */
async function prunePeopleNotOnSheet(sheetRows, client) {
  if (!sheetRows.length) {
    return 0;
  }
  const runner = client || getPool();
  if (!runner) {
    return 0;
  }

  const sheetKeys = new Set(sheetRows.map((row) => personSheetIdentityKey(row)));
  const existing = await runner.query(`SELECT id, aesop_id, email, name FROM people`);
  const toDelete = [];
  for (const row of existing.rows) {
    const key = personSheetIdentityKey({
      id: row.aesop_id,
      email: row.email,
      name: row.name,
    });
    if (!sheetKeys.has(key)) {
      toDelete.push(row.id);
    }
  }
  if (toDelete.length === 0) {
    return 0;
  }
  const result = await runner.query(`DELETE FROM people WHERE id = ANY($1::int[])`, [toDelete]);
  return result.rowCount || 0;
}

async function mirrorAllPeopleFromSheets(options = {}) {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0, pruned: 0, sharedEmailRows: 0, sameEmailSameNameCollapsed: 0 };
  }

  const [rawRows, applicantIdSet] = await Promise.all([
    loadAllPeopleRowsFromSheets(),
    loadApplicantAesopIdSetFromSheets(),
  ]);
  const prepared = preparePeopleRowsForMirror(rawRows);
  logPeopleMirrorDedupeStats(prepared);
  const { rows } = prepared;
  const syncedAt = new Date();
  let mirrored = 0;

  for (const profile of rows) {
    const row = await upsertPersonFromSheetProfile(profile, syncedAt, applicantIdSet);
    if (row) {
      mirrored += 1;
    }
  }

  let pruned = 0;
  if (options.pruneMissing !== false) {
    pruned = await prunePeopleNotOnSheet(rows);
  }

  return {
    mirrored,
    pruned,
    sharedEmailRows: prepared.sharedEmailRows,
    sameEmailSameNameCollapsed: prepared.sameEmailSameNameCollapsed,
  };
}

/**
 * Truncate people and rebuild entirely from the People Google Sheet tab.
 * @param {{ dryRun?: boolean }} [options]
 */
async function rebuildPeopleTableFromSheets(options = {}) {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not set.");
  }

  const [rawRows, applicantIdSet] = await Promise.all([
    loadAllPeopleRowsFromSheets(),
    loadApplicantAesopIdSetFromSheets(),
  ]);
  const prepared = preparePeopleRowsForMirror(rawRows);

  if (options.dryRun) {
    return {
      dryRun: true,
      sheetRows: rawRows.length,
      mirrorRows: prepared.rows.length,
      sharedEmailRows: prepared.sharedEmailRows,
      sharedEmailAddresses: prepared.sharedEmailAddresses,
      sameEmailSameNameCollapsed: prepared.sameEmailSameNameCollapsed,
      wouldTruncate: true,
      sampleHeaders: prepared.rows[0]?.sheetRow ? Object.keys(prepared.rows[0].sheetRow).slice(0, 12) : [],
    };
  }

  if (prepared.rows.length === 0) {
    throw new Error("People sheet returned zero rows — aborting rebuild.");
  }

  logPeopleMirrorDedupeStats(prepared);
  const { rows } = prepared;

  const pool = getPool();
  const client = await pool.connect();
  const syncedAt = new Date();
  let inserted = 0;

  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE people RESTART IDENTITY CASCADE");
    for (const profile of rows) {
      const row = await upsertPersonFromSheetProfile(profile, syncedAt, applicantIdSet, {
        client,
        insertOnly: true,
      });
      if (row) {
        inserted += 1;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    inserted,
    sheetRows: rawRows.length,
    mirrorRows: rows.length,
    sharedEmailRows: prepared.sharedEmailRows,
    sameEmailSameNameCollapsed: prepared.sameEmailSameNameCollapsed,
  };
}

async function mirrorDingNumbersFromSheets(applicantIdSet) {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0 };
  }

  const db = getDb();
  const ids = applicantIdSet || (await loadApplicantAesopIdSetFromSheets());
  const [profileMap, dingByUserId] = await Promise.all([
    loadEmailToPeopleProfileMap(),
    buildLatestDingNumberByUserIdMap(),
  ]);

  const syncedAt = new Date();
  let mirrored = 0;

  for (const [userId, dingNumber] of dingByUserId.entries()) {
    const match = [...profileMap.entries()].find(
      ([, entry]) => entry.id && String(entry.id).trim().toLowerCase() === userId,
    );
    if (!match) {
      continue;
    }
    const [email, profile] = match;
    const person = await upsertPersonFromSheetProfile({ ...profile, email }, syncedAt, ids);
    if (!person) {
      continue;
    }

    await db.update(dingNumbers).set({ isCurrent: false }).where(eq(dingNumbers.personId, person.id));
    await db.insert(dingNumbers).values({
      personId: person.id,
      number: String(dingNumber).trim(),
      isCurrent: true,
      source: "google_sheets",
      updatedAt: syncedAt,
    });
    mirrored += 1;
  }

  return { mirrored };
}

async function mirrorDingHistoryFromSheets(options = {}, applicantIdSet) {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0 };
  }

  const db = getDb();
  const ids = applicantIdSet || (await loadApplicantAesopIdSetFromSheets());
  const profileMap = await loadEmailToPeopleProfileMap();
  const syncedAt = new Date();
  let mirrored = 0;

  for (const profile of profileMap.values()) {
    if (!profile?.id) {
      continue;
    }
    const person = await upsertPersonFromSheetProfile(profile, syncedAt, ids);
    if (!person) {
      continue;
    }

    let entries = [];
    try {
      entries = await getPortalDingChangeHistory(profile.id, { maxRows: options.maxRowsPerPerson || 50 });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      const sheetRowKey = `${profile.id}:${entry.timestamp || entry.dingNumber}`;
      const existing = await db
        .select({ id: dingChangeHistory.id })
        .from(dingChangeHistory)
        .where(
          and(
            eq(dingChangeHistory.personId, person.id),
            eq(dingChangeHistory.sheetRowKey, sheetRowKey),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        continue;
      }
      await db.insert(dingChangeHistory).values({
        personId: person.id,
        dingNumber: String(entry.dingNumber || "").trim(),
        changedAt: entry.timestamp ? new Date(entry.timestamp) : syncedAt,
        source: entry.source || "google_sheets",
        sheetRowKey,
      });
      mirrored += 1;
    }
  }

  return { mirrored };
}

async function mirrorApplicantsAndDriveFromSheets() {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0, driveFiles: 0 };
  }

  const syncedAt = new Date();
  const { dataRows, columns, cfg } = await loadApplicantsDataForStats();

  const folderId = String(cfg.voiceMemo?.driveFolderId || "").trim();
  /** @type {Map<string, { aesopId: string, fileId: string, fileName: string }>} */
  let memoById = new Map();
  /** @type {Map<string, number|null>} */
  let durationsMap = new Map();

  if (folderId) {
    const scanOptions = getVoiceMemoDriveScanOptions(cfg.voiceMemo);
    const scan = await scanVoiceMemoFolder(folderId, scanOptions);
    memoById = scan.memosById;
    const fileIds = [...memoById.values()].map((memo) => memo.fileId);
    durationsMap = await resolveVoiceMemoDurationsMap(fileIds, { concurrency: 4 });
  }

  let mirrored = 0;
  const gs = config.googleSheets || {};
  const levelColumnIndex = resolveColumnIndex(gs.admissionsLevelColumn || "E");
  const essayColumnIndex = resolveColumnIndex(gs.admissionsEssayColumn || "K");

  for (const rowData of dataRows) {
    const aesopId = String(rowData[cfg.idColumnIndex] ?? "").trim();
    if (!aesopId) {
      continue;
    }

    const email = String(rowData[cfg.emailColumnIndex] ?? "").trim();
    const name = String(rowData[cfg.nameColumnIndex] ?? "").trim();
    const appliedLevel = String(rowData[levelColumnIndex] ?? "").trim();
    const essay = String(rowData[essayColumnIndex] ?? "").trim();
    const round1 = String(rowData[columns.round1] ?? "").trim();
    const round2 = String(rowData[columns.round2] ?? "").trim();
    const applicantLinks = String(rowData[columns.links] ?? "").trim();
    const submittedAt = String(rowData[columns.date] ?? "").trim();
    const driveFile = findVoiceMemoInScan(memoById, aesopId);
    const driveFileId = driveFile?.fileId ? String(driveFile.fileId).trim() : null;
    const driveFileName = driveFile?.fileName ? String(driveFile.fileName).trim() : null;
    const durationRaw = driveFileId ? durationsMap.get(driveFileId) : null;
    const driveDurationSeconds =
      durationRaw != null && Number.isFinite(Number(durationRaw))
        ? Math.round(Number(durationRaw))
        : null;

    const row = await upsertApplicantFromMirror({
      aesopId,
      email,
      name,
      appliedLevel,
      essay,
      round1,
      round2,
      applicantLinks,
      submittedAt,
      driveFileId,
      driveFileName,
      driveDurationSeconds,
      syncedAt,
    });
    if (row) {
      mirrored += 1;
    }
  }

  return { mirrored, driveFiles: memoById.size };
}

async function mirrorApplicantReviewsFromSheets() {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0 };
  }

  const reviewsCfg = getApplicantReviewsConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, reviewsCfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${reviewsCfg.sheetName}" was not found.`);
  }

  await worksheet.loadHeaderRow(reviewsCfg.headerRowNum);
  const rows = await worksheet.getRows();
  const syncedAt = new Date();
  let mirrored = 0;

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const aesopId = String(rowData[reviewsCfg.applicantIdCol] ?? "").trim();
    if (!aesopId) {
      continue;
    }

    const cell = (index) => String(rowData[index] ?? "").trim();
    const upserted = await upsertApplicantReviewFromMirror({
      aesopId,
      reviewerA: cell(reviewsCfg.reviewerACol),
      reviewerB: cell(reviewsCfg.reviewerBCol),
      aEnglishLevel: cell(reviewsCfg.aLevelCol),
      aSuspectedAi: cell(reviewsCfg.aSuspectedAiCol),
      aInstructionFollowing: cell(reviewsCfg.aInstructionCol),
      aOriginalThinking: cell(reviewsCfg.aOriginalThinkingCol),
      aCharacter: cell(reviewsCfg.aCharacterCol),
      bEnglishLevel: cell(reviewsCfg.bLevelCol),
      bSuspectedAi: cell(reviewsCfg.bSuspectedAiCol),
      bInstructionFollowing: cell(reviewsCfg.bInstructionCol),
      bOriginalThinking: cell(reviewsCfg.bOriginalThinkingCol),
      bCharacter: cell(reviewsCfg.bCharacterCol),
      sheetRowNumber: row.rowNumber,
      syncedAt,
    });
    if (upserted) {
      mirrored += 1;
    }
  }

  return { mirrored };
}

/**
 * @param {{ includeDingHistory?: boolean }} [options]
 *   includeDingHistory — mirror full Ding change history (heavy; use daily sync only).
 */
async function mirrorPeopleAndDingFromSheets(options = {}) {
  try {
    const { teacherEmails, studentEmails } = await loadClassroomRoleEmailSetsFromSheets();
    const statusSync = await syncPeopleStatusOnPeopleSheet({ teacherEmails, studentEmails });
    if (statusSync.updated > 0) {
      console.log(
        `[people-mirror] People status column: updated ${statusSync.updated} row(s), skipped ${statusSync.skipped}.`,
      );
    }
  } catch (error) {
    console.warn("[people-mirror] People status sync failed:", error.message);
  }

  const applicantIdSet = await loadApplicantAesopIdSetFromSheets();
  const peopleResult = await mirrorAllPeopleFromSheets();
  const dingResult = await mirrorDingNumbersFromSheets(applicantIdSet);
  let historyResult = { mirrored: 0 };
  if (options.includeDingHistory === true) {
    historyResult = await mirrorDingHistoryFromSheets({}, applicantIdSet);
  }
  let applicantsResult = { mirrored: 0, driveFiles: 0 };
  try {
    applicantsResult = await mirrorApplicantsAndDriveFromSheets();
    console.log(
      `[people-mirror] Applicants/Drive: mirrored=${applicantsResult.mirrored}, driveFiles=${applicantsResult.driveFiles}`,
    );
  } catch (error) {
    console.warn("[people-mirror] Applicants/Drive mirror failed:", error.message);
  }
  let reviewsResult = { mirrored: 0 };
  try {
    reviewsResult = await mirrorApplicantReviewsFromSheets();
    console.log(`[people-mirror] ApplicantReviews: mirrored=${reviewsResult.mirrored}`);
  } catch (error) {
    console.warn("[people-mirror] ApplicantReviews mirror failed:", error.message);
  }
  return {
    people: peopleResult.mirrored,
    peoplePruned: peopleResult.pruned,
    dingNumbers: dingResult.mirrored,
    dingHistory: historyResult.mirrored,
    applicants: applicantsResult.mirrored,
    driveFiles: applicantsResult.driveFiles,
    applicantReviews: reviewsResult.mirrored,
  };
}

/**
 * Mirror People + Applicants sheet + Drive into Postgres without Classroom sync or Ding tabs.
 * People rows land in people; applicant rows land in applicants.
 */
async function mirrorPeopleAndApplicantsFromSheets() {
  const peopleResult = await mirrorAllPeopleFromSheets();
  console.log(
    `[people-mirror] People sheet: mirrored=${peopleResult.mirrored}, pruned=${peopleResult.pruned}`,
  );

  const applicantsResult = await mirrorApplicantsAndDriveFromSheets();
  console.log(
    `[people-mirror] Applicants/Drive: mirrored=${applicantsResult.mirrored}, driveFiles=${applicantsResult.driveFiles}`,
  );

  return {
    people: peopleResult.mirrored,
    peoplePruned: peopleResult.pruned,
    applicants: applicantsResult.mirrored,
    driveFiles: applicantsResult.driveFiles,
  };
}

async function getPersonIdByAesopId(aesopId) {
  const db = getDb();
  if (!db) {
    return null;
  }
  const id = typeof aesopId === "string" ? aesopId.trim().toLowerCase() : "";
  if (!id) {
    return null;
  }
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(sql`lower(${people.aesopId}) = ${id}`)
    .limit(1);
  return rows[0]?.id || null;
}

module.exports = {
  mirrorAllPeopleFromSheets,
  rebuildPeopleTableFromSheets,
  preparePeopleRowsForMirror,
  personSheetIdentityKey,
  normalizePersonName,
  mirrorDingNumbersFromSheets,
  mirrorDingHistoryFromSheets,
  mirrorApplicantsAndDriveFromSheets,
  mirrorApplicantReviewsFromSheets,
  mirrorPeopleAndApplicantsFromSheets,
  mirrorPeopleAndDingFromSheets,
  upsertPersonFromSheetProfile,
  getPersonIdByAesopId,
};
