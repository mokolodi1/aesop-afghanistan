const { eq, and, sql } = require("drizzle-orm");
const { getDb, getPool, isDatabaseEnabled } = require("../db/index");
const { people, dingNumbers, dingChangeHistory } = require("../db/schema");
const { upsertApplicantFromMirror } = require("./classroomDb");
const {
  loadAllPeopleRowsFromSheets,
  loadEmailToPeopleProfileMap,
  buildLatestDingNumberByUserIdMap,
  getPortalDingChangeHistory,
  resolvePortalRoleFromPeopleSheet,
  syncPeopleStatusOnPeopleSheet,
  loadClassroomRoleEmailSetsFromSheets,
} = require("./googleSheets");
const {
  loadApplicantsDataForStats,
  loadApplicantAesopIdSetFromSheets,
  getVoiceMemoDriveScanOptions,
  findVoiceMemoInScan,
} = require("./voiceMemoSync");
const { scanVoiceMemoFolder, resolveVoiceMemoDurationsMap } = require("./googleDrive");

const UPSERT_PERSON_FROM_SHEET_SQL = `
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
  ON CONFLICT (email) DO UPDATE SET
    aesop_id = CASE
      WHEN NULLIF(trim(EXCLUDED.aesop_id), '') IS NULL THEN people.aesop_id
      WHEN people.aesop_id IS NOT NULL
        AND lower(people.aesop_id) = lower(trim(EXCLUDED.aesop_id)) THEN people.aesop_id
      WHEN EXISTS (
        SELECT 1 FROM people p
        WHERE p.id <> people.id
          AND p.aesop_id IS NOT NULL
          AND lower(p.aesop_id) = lower(trim(EXCLUDED.aesop_id))
      ) THEN people.aesop_id
      ELSE trim(EXCLUDED.aesop_id)
    END,
    name = COALESCE(EXCLUDED.name, people.name),
    phone = COALESCE(EXCLUDED.phone, people.phone),
    portal_role = EXCLUDED.portal_role,
    reviewer_role = EXCLUDED.reviewer_role,
    people_type = EXCLUDED.people_type,
    admin_role = EXCLUDED.admin_role,
    people_status = EXCLUDED.people_status,
    last_login = EXCLUDED.last_login,
    past_ding = EXCLUDED.past_ding,
    sheet_row = EXCLUDED.sheet_row,
    synced_at = EXCLUDED.synced_at
  RETURNING *
`;

const INSERT_PERSON_FROM_SHEET_SQL = `
  INSERT INTO people (
    aesop_id, email, name, phone, portal_role, reviewer_role,
    people_type, admin_role, people_status, last_login, past_ding, sheet_row, synced_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
  RETURNING *
`;

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
  if ((!pool && !options.client) || !profile?.email) {
    return null;
  }
  const params = buildPersonInsertParams(profile, syncedAt, applicantIdSet);
  const sqlText = options.insertOnly ? INSERT_PERSON_FROM_SHEET_SQL : UPSERT_PERSON_FROM_SHEET_SQL;
  if (options.client) {
    const result = await options.client.query(sqlText, params);
    return result.rows[0] || null;
  }
  const result = await pool.query(sqlText, params);
  return result.rows[0] || null;
}

/**
 * @param {string[]} emails
 * @param {import("pg").PoolClient} [client]
 */
async function prunePeopleNotOnSheet(emails, client) {
  if (!emails.length) {
    return 0;
  }
  const runner = client || getPool();
  if (!runner) {
    return 0;
  }
  const result = await runner.query(
    `DELETE FROM people
     WHERE lower(trim(email)) NOT IN (SELECT unnest($1::text[]))`,
    [emails],
  );
  return result.rowCount || 0;
}

/**
 * People sheet can contain duplicate emails; DB email is UNIQUE — keep last row per email.
 * @param {Array<object>} rows
 * @returns {{ rows: Array<object>, duplicateCount: number }}
 */
function dedupePeopleRowsByEmail(rows) {
  const byEmail = new Map();
  let duplicateCount = 0;
  for (const row of rows) {
    const email = String(row.email || "").trim().toLowerCase();
    if (!email) {
      continue;
    }
    if (byEmail.has(email)) {
      duplicateCount += 1;
    }
    byEmail.set(email, { ...row, email });
  }
  return { rows: [...byEmail.values()], duplicateCount };
}

async function mirrorAllPeopleFromSheets(options = {}) {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0, pruned: 0, duplicateEmails: 0 };
  }

  const [rawRows, applicantIdSet] = await Promise.all([
    loadAllPeopleRowsFromSheets(),
    loadApplicantAesopIdSetFromSheets(),
  ]);
  const { rows, duplicateCount } = dedupePeopleRowsByEmail(rawRows);
  if (duplicateCount > 0) {
    console.warn(
      `[people-mirror] ${duplicateCount} duplicate People sheet email(s); keeping last row per email.`,
    );
  }
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
    pruned = await prunePeopleNotOnSheet(
      rows.map((row) => row.email),
    );
  }

  return { mirrored, pruned, duplicateEmails: duplicateCount };
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
  const { rows, duplicateCount } = dedupePeopleRowsByEmail(rawRows);

  if (options.dryRun) {
    return {
      dryRun: true,
      sheetRows: rawRows.length,
      uniqueEmails: rows.length,
      duplicateEmails: duplicateCount,
      wouldTruncate: true,
      sampleHeaders: rows[0]?.sheetRow ? Object.keys(rows[0].sheetRow).slice(0, 12) : [],
    };
  }

  if (rows.length === 0) {
    throw new Error("People sheet returned zero rows — aborting rebuild.");
  }

  if (duplicateCount > 0) {
    console.warn(
      `[people-mirror] ${duplicateCount} duplicate People sheet email(s); keeping last row per email.`,
    );
  }

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

  return { inserted, sheetRows: rawRows.length, uniqueEmails: rows.length, duplicateEmails: duplicateCount };
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
  for (const rowData of dataRows) {
    const aesopId = String(rowData[cfg.idColumnIndex] ?? "").trim();
    if (!aesopId) {
      continue;
    }

    const email = String(rowData[cfg.emailColumnIndex] ?? "").trim();
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

async function mirrorPeopleAndDingFromSheets() {
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
  const historyResult = await mirrorDingHistoryFromSheets({}, applicantIdSet);
  let applicantsResult = { mirrored: 0, driveFiles: 0 };
  try {
    applicantsResult = await mirrorApplicantsAndDriveFromSheets();
    console.log(
      `[people-mirror] Applicants/Drive: mirrored=${applicantsResult.mirrored}, driveFiles=${applicantsResult.driveFiles}`,
    );
  } catch (error) {
    console.warn("[people-mirror] Applicants/Drive mirror failed:", error.message);
  }
  return {
    people: peopleResult.mirrored,
    peoplePruned: peopleResult.pruned,
    dingNumbers: dingResult.mirrored,
    dingHistory: historyResult.mirrored,
    applicants: applicantsResult.mirrored,
    driveFiles: applicantsResult.driveFiles,
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
  mirrorDingNumbersFromSheets,
  mirrorDingHistoryFromSheets,
  mirrorApplicantsAndDriveFromSheets,
  mirrorPeopleAndApplicantsFromSheets,
  mirrorPeopleAndDingFromSheets,
  upsertPersonFromSheetProfile,
  getPersonIdByAesopId,
};
