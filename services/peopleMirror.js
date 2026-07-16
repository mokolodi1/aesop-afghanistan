const { eq, and, sql } = require("drizzle-orm");
const config = require("../config/secrets");
const { getDb, getPool, isDatabaseEnabled } = require("../db/index");
const { people, dingNumbers, dingChangeHistory } = require("../db/schema");
const {
  upsertApplicantFromMirror,
  upsertApplicantReviewFromMirror,
  getApplicantVoiceMemoDurationsMapFromDb,
} = require("./classroomDb");
const {
  loadAllPeopleRowsFromSheets,
  loadEmailToPeopleProfileMap,
  buildLatestDingNumberByUserIdMap,
  getPortalDingChangeHistory,
  resolvePortalRoleFromPeopleSheet,
  applyDerivedPeopleStatusToRows,
  loadClassroomRoleEmailSetsFromSheets,
  initGoogleSheets,
  getWorksheetByTitle,
  resolveColumnIndex,
  sheetsApiCall,
} = require("./googleSheets");
const { getApplicantReviewsConfig } = require("./applicantReviews");
const {
  loadApplicantsDataForStats,
  loadApplicantAesopIdSetFromSheets,
  getVoiceMemoDriveScanOptions,
  getVoiceMemoDurationLimits,
  findVoiceMemoInScan,
  readApplicantRound2Prompt,
  parseVoiceMemoSheetLengthSeconds,
} = require("./voiceMemoSync");
const { useMirrorStaging } = require("./mirrorPromote");
const { syncVoiceMemoAudioFromScan } = require("./voiceMemoAudio");
const {
  sheetVoiceMemoLengthSeconds,
  isTrustedVoiceMemoCachedDurationSeconds,
} = require("../utils/voiceMemoDuration");
const {
  scanVoiceMemoFolder,
  resolveVoiceMemoDurationsMap,
  extractDriveFileIdFromLink,
} = require("./googleDrive");
const { JOB_MAX_RUNTIME_MS } = require("./jobRuns");

/** Drive/Sheets throttling can stretch the mirror; retry 429s for up to 6 hours. */
const MIRROR_DRIVE_TIME_BUDGET_MS = JOB_MAX_RUNTIME_MS;


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
 * Sheet identity: AESOP ID when present, otherwise sheet row number.
 * @param {{ id?: string, email?: string, name?: string, sheetRowNumber?: number }} profile
 */
function personSheetIdentityKey(profile) {
  const aesopId = profile?.id ? String(profile.id).trim().toLowerCase() : "";
  if (aesopId) {
    return `id:${aesopId}`;
  }
  const sheetRowNumber = profile?.sheetRowNumber;
  if (sheetRowNumber != null && Number.isFinite(Number(sheetRowNumber))) {
    return `row:${Number(sheetRowNumber)}`;
  }
  const email = String(profile.email || "").trim().toLowerCase();
  const nameKey = normalizePersonName(profile.name);
  return `email:${email}|${nameKey}`;
}

/**
 * Drop rows without email and collapse duplicate sheet identities (keep last row).
 * @param {Array<object>} rows
 */
function preparePeopleRowsForMirror(rows) {
  const byIdentity = new Map();
  let duplicateSheetRowsCollapsed = 0;

  for (const row of rows) {
    const email = String(row.email || "").trim().toLowerCase();
    if (!email) {
      continue;
    }
    const normalized = { ...row, email };
    const key = personSheetIdentityKey(normalized);
    if (byIdentity.has(key)) {
      duplicateSheetRowsCollapsed += 1;
    }
    byIdentity.set(key, normalized);
  }

  return {
    rows: [...byIdentity.values()],
    duplicateSheetRowsCollapsed,
  };
}

function logPeopleMirrorDedupeStats(stats) {
  if (stats.duplicateSheetRowsCollapsed > 0) {
    console.warn(
      `[people-mirror] ${stats.duplicateSheetRowsCollapsed} duplicate sheet row(s) collapsed (kept last row).`,
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

  const sheetRowNumber = profile.sheetRowNumber;
  if (sheetRowNumber != null && Number.isFinite(Number(sheetRowNumber))) {
    const byRow = await runner.query(
      `SELECT id FROM people
       WHERE aesop_id IS NULL
         AND (sheet_row->>'__rowNumber')::int = $1
       LIMIT 1`,
      [Number(sheetRowNumber)],
    );
    if (byRow.rows[0]?.id) {
      return byRow.rows[0].id;
    }
  }

  return null;
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
  const sheetRowPayload = { ...(profile.sheetRow || {}) };
  if (profile.sheetRowNumber != null && Number.isFinite(Number(profile.sheetRowNumber))) {
    sheetRowPayload.__rowNumber = Number(profile.sheetRowNumber);
  }
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
    JSON.stringify(sheetRowPayload),
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
  const existing = await runner.query(`SELECT id, aesop_id, email, name, sheet_row FROM people`);
  const toDelete = [];
  for (const row of existing.rows) {
    const sheetRow = row.sheet_row && typeof row.sheet_row === "object" ? row.sheet_row : {};
    const key = personSheetIdentityKey({
      id: row.aesop_id,
      email: row.email,
      name: row.name,
      sheetRowNumber: sheetRow.__rowNumber,
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
    return { mirrored: 0, pruned: 0, duplicateSheetRowsCollapsed: 0 };
  }

  const [rawRows, applicantIdSet, classroomRoles] = await Promise.all([
    loadAllPeopleRowsFromSheets(),
    loadApplicantAesopIdSetFromSheets(),
    loadClassroomRoleEmailSetsFromSheets().catch((error) => {
      console.warn("[people-mirror] Classroom role sets unavailable:", error.message);
      return { teacherEmails: new Set(), studentEmails: new Set() };
    }),
  ]);
  const prepared = preparePeopleRowsForMirror(rawRows);
  logPeopleMirrorDedupeStats(prepared);
  const { rows } = prepared;
  applyDerivedPeopleStatusToRows(rows, {
    teacherEmails: classroomRoles.teacherEmails,
    studentEmails: classroomRoles.studentEmails,
    applicantIdSet,
  });
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
    duplicateSheetRowsCollapsed: prepared.duplicateSheetRowsCollapsed,
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

  const [rawRows, applicantIdSet, classroomRoles] = await Promise.all([
    loadAllPeopleRowsFromSheets(),
    loadApplicantAesopIdSetFromSheets(),
    loadClassroomRoleEmailSetsFromSheets().catch((error) => {
      console.warn("[people-mirror] Classroom role sets unavailable:", error.message);
      return { teacherEmails: new Set(), studentEmails: new Set() };
    }),
  ]);
  const prepared = preparePeopleRowsForMirror(rawRows);

  if (options.dryRun) {
    return {
      dryRun: true,
      sheetRows: rawRows.length,
      mirrorRows: prepared.rows.length,
      duplicateSheetRowsCollapsed: prepared.duplicateSheetRowsCollapsed,
      wouldTruncate: true,
      sampleHeaders: prepared.rows[0]?.sheetRow ? Object.keys(prepared.rows[0].sheetRow).slice(0, 12) : [],
    };
  }

  if (prepared.rows.length === 0) {
    throw new Error("People sheet returned zero rows — aborting rebuild.");
  }

  logPeopleMirrorDedupeStats(prepared);
  const { rows } = prepared;
  applyDerivedPeopleStatusToRows(rows, {
    teacherEmails: classroomRoles.teacherEmails,
    studentEmails: classroomRoles.studentEmails,
    applicantIdSet,
  });

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
    duplicateSheetRowsCollapsed: prepared.duplicateSheetRowsCollapsed,
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

/**
 * Build applicant mirror rows from the Applicants sheet, optionally enriched from a Drive scan.
 *
 * @param {{
 *   deadlineAt?: number,
 *   syncedAt?: Date,
 *   dataRows?: Array<Array<unknown>>,
 *   columns?: Record<string, number>,
 *   cfg?: Record<string, unknown>,
 *   memoById?: Map<string, { aesopId: string, fileId: string, fileName: string }>,
 *   useDriveScan?: boolean,
 *   probeDriveDurations?: boolean,
 * }} [options]
 */
async function collectApplicantMirrorEntriesFromSheet(options = {}) {
  const deadlineAt = options.deadlineAt ?? Date.now() + MIRROR_DRIVE_TIME_BUDGET_MS;
  const syncedAt = options.syncedAt instanceof Date ? options.syncedAt : new Date();
  const useDriveScan = options.useDriveScan === true;
  const probeDriveDurations = options.probeDriveDurations === true;

  let dataRows = options.dataRows;
  let columns = options.columns;
  let cfg = options.cfg;
  if (!dataRows || !columns || !cfg) {
    const loaded = await loadApplicantsDataForStats({ deadlineAt });
    dataRows = loaded.dataRows;
    columns = loaded.columns;
    cfg = loaded.cfg;
  }

  const durationLimits = getVoiceMemoDurationLimits(cfg.voiceMemo);
  /** @type {Map<string, { aesopId: string, fileId: string, fileName: string }>} */
  const memoById = options.memoById || new Map();

  /** @type {Map<string, number>} */
  let cachedDurationByFileId = new Map();
  if (useDriveScan || probeDriveDurations) {
    try {
      const cached = await getApplicantVoiceMemoDurationsMapFromDb();
      if (cached) {
        cachedDurationByFileId = cached.byFileId;
      }
    } catch (error) {
      console.warn(
        "[mirror] could not load cached voice memo durations:",
        error.message || error,
      );
    }
  }

  const gs = config.googleSheets || {};
  const levelColumnIndex = resolveColumnIndex(gs.admissionsLevelColumn || "E");
  const ageColumnIndex = resolveColumnIndex(gs.admissionsAgeColumn || "L");
  const essayColumnIndex = resolveColumnIndex(gs.admissionsEssayColumn || "K");

  /** @type {Array<Record<string, unknown> & { driveFileId: string|null, driveDurationSeconds: number|null }>} */
  const entries = [];
  /** @type {Set<string>} */
  const probeFileIds = new Set();
  let durationsFromSheet = 0;
  let durationsFromDb = 0;

  for (const rowData of dataRows) {
    const aesopId = String(rowData[cfg.idColumnIndex] ?? "").trim();
    if (!aesopId) {
      continue;
    }

    const email = String(rowData[cfg.emailColumnIndex] ?? "").trim();
    const name = String(rowData[cfg.nameColumnIndex] ?? "").trim();
    const appliedLevel = String(rowData[levelColumnIndex] ?? "").trim();
    const age = String(rowData[ageColumnIndex] ?? "").trim();
    const essay = String(rowData[essayColumnIndex] ?? "").trim();
    const round1 = String(rowData[columns.round1] ?? "").trim();
    const round2 = String(rowData[columns.round2] ?? "").trim();
    const round2Prompt = readApplicantRound2Prompt(rowData, columns);
    const applicantLinks = String(rowData[columns.links] ?? "").trim();
    const submittedAt = String(rowData[columns.date] ?? "").trim();

    let driveFileId = null;
    let driveFileName = null;
    if (useDriveScan) {
      const driveFile = findVoiceMemoInScan(memoById, aesopId);
      driveFileId = driveFile?.fileId ? String(driveFile.fileId).trim() : null;
      driveFileName = driveFile?.fileName ? String(driveFile.fileName).trim() : null;
      const webViewLink = driveFile?.webViewLink ? String(driveFile.webViewLink).trim() : "";
      if (webViewLink && !applicantLinks) {
        applicantLinks = webViewLink;
      }
    } else {
      driveFileId = extractDriveFileIdFromLink(applicantLinks);
    }

    let driveDurationSeconds = null;
    if (driveFileId) {
      const sheetLengthSeconds =
        columns.length >= 0 ? parseVoiceMemoSheetLengthSeconds(rowData[columns.length]) : null;
      const sheetLinkFileId = extractDriveFileIdFromLink(applicantLinks);
      const cached = cachedDurationByFileId.get(driveFileId);
      if (sheetLengthSeconds != null && sheetLinkFileId === driveFileId) {
        driveDurationSeconds = sheetVoiceMemoLengthSeconds(sheetLengthSeconds, durationLimits);
        durationsFromSheet += 1;
      } else if (useDriveScan && isTrustedVoiceMemoCachedDurationSeconds(cached)) {
        driveDurationSeconds = sheetVoiceMemoLengthSeconds(cached, durationLimits);
        durationsFromDb += 1;
      } else if (probeDriveDurations) {
        probeFileIds.add(driveFileId);
      }
    }

    entries.push({
      aesopId,
      email,
      name,
      appliedLevel,
      age,
      essay,
      round1,
      round2,
      round2Prompt,
      applicantLinks,
      submittedAt,
      driveFileId,
      driveFileName,
      driveDurationSeconds,
      syncedAt,
    });
  }

  /** @type {Map<string, number|null>} */
  let probedDurations = new Map();
  if (probeDriveDurations && probeFileIds.size > 0) {
    const probeStartedAt = Date.now();
    probedDurations = await resolveVoiceMemoDurationsMap([...probeFileIds], {
      concurrency: 4,
      deadlineAt,
    });
    console.info(
      `[mirror] probed ${probeFileIds.size} missing voice memo duration(s) from Drive in ${Date.now() - probeStartedAt}ms`,
    );
  }

  let durationsUnknown = 0;
  for (const entry of entries) {
    if (entry.driveFileId && entry.driveDurationSeconds == null && probeDriveDurations) {
      const probed = probedDurations.get(entry.driveFileId);
      if (probed != null && Number.isFinite(Number(probed))) {
        entry.driveDurationSeconds = sheetVoiceMemoLengthSeconds(probed, durationLimits);
      } else {
        durationsUnknown += 1;
      }
    }
  }

  if (useDriveScan || probeDriveDurations) {
    console.info(
      `[mirror] voice memo durations: sheet=${durationsFromSheet}, dbCache=${durationsFromDb}, probed=${probeFileIds.size}, unknown=${durationsUnknown}`,
    );
  }

  return {
    entries,
    memoById,
    driveFiles: memoById.size,
    durationsFromSheet,
    durationsFromDb,
    probedCount: probeFileIds.size,
    durationsUnknown,
  };
}

/**
 * List voice memo files in Drive (metadata only — no audio download).
 * @param {{ deadlineAt?: number, cfg?: Record<string, unknown> }} [options]
 * @returns {Promise<{ memoById: Map<string, { aesopId: string, fileId: string, fileName: string, webViewLink?: string }>, driveFiles: number }>}
 */
async function loadVoiceMemoDriveScanMap(options = {}) {
  const deadlineAt = options.deadlineAt ?? Date.now() + MIRROR_DRIVE_TIME_BUDGET_MS;
  let cfg = options.cfg;
  if (!cfg) {
    const loaded = await loadApplicantsDataForStats({ deadlineAt });
    cfg = loaded.cfg;
  }

  const folderId = String(cfg.voiceMemo?.driveFolderId || "").trim();
  if (!folderId) {
    return { memoById: new Map(), driveFiles: 0, driveScan: null };
  }

  const scanOptions = getVoiceMemoDriveScanOptions(cfg.voiceMemo);
  const driveScan = await scanVoiceMemoFolder(folderId, { ...scanOptions, deadlineAt });
  return { memoById: driveScan.memosById, driveFiles: driveScan.memosById.size, driveScan };
}

/**
 * Mirror Applicants sheet + Drive metadata (ids, links, durations) — no audio download.
 * @param {{ deadlineAt?: number }} [options]
 */
async function mirrorApplicantsFromSheetsOnly(options = {}) {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0, driveFiles: 0, driveScan: null };
  }

  const deadlineAt = options.deadlineAt ?? Date.now() + MIRROR_DRIVE_TIME_BUDGET_MS;
  const { dataRows, columns, cfg } = await loadApplicantsDataForStats({ deadlineAt });
  const { memoById, driveFiles, driveScan } = await loadVoiceMemoDriveScanMap({ deadlineAt, cfg });
  if (driveFiles > 0) {
    console.info(`[mirror] Drive folder scan: driveFiles=${driveFiles}`);
  }

  const { entries } = await collectApplicantMirrorEntriesFromSheet({
    deadlineAt,
    dataRows,
    columns,
    cfg,
    memoById,
    useDriveScan: true,
    probeDriveDurations: true,
  });

  let mirrored = 0;
  for (const entry of entries) {
    const row = await upsertApplicantFromMirror(entry);
    if (row) {
      mirrored += 1;
    }
  }

  return { mirrored, driveFiles, driveScan };
}

/**
 * One-directional Drive → Postgres audio cache (download/transcode only, no sheet writes).
 * Runs at the end of hourly-cache after metadata is promoted.
 * @param {{ deadlineAt?: number, driveScan?: object|null }} [options]
 */
async function syncApplicantVoiceMemoAudioCache(options = {}) {
  if (!isDatabaseEnabled()) {
    return { downloaded: 0, pruned: 0, driveFiles: 0 };
  }

  const deadlineAt = options.deadlineAt ?? Date.now() + MIRROR_DRIVE_TIME_BUDGET_MS;
  let driveScan = options.driveScan ?? null;
  let driveFiles = 0;

  if (!driveScan) {
    const { driveScan: scanned, driveFiles: count } = await loadVoiceMemoDriveScanMap({ deadlineAt });
    driveScan = scanned;
    driveFiles = count;
  } else {
    driveFiles = driveScan.memosById?.size ?? 0;
  }

  if (!driveScan || driveFiles === 0) {
    return { downloaded: 0, pruned: 0, driveFiles: 0 };
  }

  let audioResult = { driveFiles: 0, downloaded: 0, pruned: 0 };
  try {
    audioResult = await syncVoiceMemoAudioFromScan(driveScan, { deadlineAt });
    console.info(
      `[mirror] voice memo audio cache: driveFiles=${audioResult.driveFiles}, ` +
        `downloaded=${audioResult.downloaded}, pruned=${audioResult.pruned}`,
    );
  } catch (error) {
    console.warn("[mirror] voice memo audio cache failed:", error.message || error);
  }

  return {
    downloaded: audioResult.downloaded ?? 0,
    pruned: audioResult.pruned ?? 0,
    driveFiles,
  };
}

/** @deprecated Use syncApplicantVoiceMemoAudioCache */
async function syncApplicantVoiceMemoDriveData(options = {}) {
  return syncApplicantVoiceMemoAudioCache(options);
}

async function mirrorApplicantsAndDriveFromSheets(options = {}) {
  const deadlineAt = options.deadlineAt ?? Date.now() + MIRROR_DRIVE_TIME_BUDGET_MS;
  const sheetResult = await mirrorApplicantsFromSheetsOnly({ deadlineAt });
  const audioResult = await syncApplicantVoiceMemoAudioCache({
    deadlineAt,
    driveScan: sheetResult.driveScan,
  });
  return {
    mirrored: sheetResult.mirrored,
    driveFiles: sheetResult.driveFiles,
    voiceMemoDownloaded: audioResult.downloaded,
    voiceMemoPruned: audioResult.pruned,
  };
}

async function mirrorApplicantReviewsFromSheets(deadlineAt = Date.now() + MIRROR_DRIVE_TIME_BUDGET_MS) {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0 };
  }

  const reviewsCfg = getApplicantReviewsConfig();
  const doc = await initGoogleSheets();
  const worksheet = await getWorksheetByTitle(doc, reviewsCfg.sheetName);
  if (!worksheet) {
    throw new Error(`Sheet "${reviewsCfg.sheetName}" was not found.`);
  }

  await sheetsApiCall(
    "loadHeaderRow(applicant reviews)",
    () => worksheet.loadHeaderRow(reviewsCfg.headerRowNum),
    { deadlineAt },
  );
  const rows = await sheetsApiCall(
    "getRows(applicant reviews)",
    () => worksheet.getRows(),
    { deadlineAt },
  );
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
      aUnableToGrade: cell(reviewsCfg.aUnableToGradeCol),
      aTechnicalFlag: cell(reviewsCfg.aTechnicalFlagCol),
      aInstructionFollowing: cell(reviewsCfg.aInstructionCol),
      aOriginalThinking: cell(reviewsCfg.aOriginalThinkingCol),
      aCharacter: cell(reviewsCfg.aCharacterCol),
      bEnglishLevel: cell(reviewsCfg.bLevelCol),
      bSuspectedAi: cell(reviewsCfg.bSuspectedAiCol),
      bUnableToGrade: cell(reviewsCfg.bUnableToGradeCol),
      bTechnicalFlag: cell(reviewsCfg.bTechnicalFlagCol),
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
 * @param {{ includeDingHistory?: boolean, jobRunId?: number|null }} [options]
 *   includeDingHistory — mirror full Ding change history (heavy; use daily sync only).
 */
async function mirrorPeopleAndDingFromSheets(options = {}) {
  if (useMirrorStaging()) {
    const { mirrorPeopleAndDingViaStaging } = require("./mirrorStaging");
    const stagingResult = await mirrorPeopleAndDingViaStaging(options);
    if (options.includeDingHistory === true) {
      const deadlineAt = Date.now() + MIRROR_DRIVE_TIME_BUDGET_MS;
      const applicantIdSet = await loadApplicantAesopIdSetFromSheets({ deadlineAt });
      const historyResult = await mirrorDingHistoryFromSheets({}, applicantIdSet);
      return { ...stagingResult, dingHistory: historyResult.mirrored };
    }
    return stagingResult;
  }

  const deadlineAt = Date.now() + MIRROR_DRIVE_TIME_BUDGET_MS;
  const applicantIdSet = await loadApplicantAesopIdSetFromSheets({ deadlineAt });
  const peopleResult = await mirrorAllPeopleFromSheets();
  const dingResult = await mirrorDingNumbersFromSheets(applicantIdSet);
  let historyResult = { mirrored: 0 };
  if (options.includeDingHistory === true) {
    historyResult = await mirrorDingHistoryFromSheets({}, applicantIdSet);
  }

  let applicantsResult = { mirrored: 0, driveFiles: 0, driveScan: null };
  try {
    applicantsResult = await mirrorApplicantsFromSheetsOnly({ deadlineAt });
    console.log(
      `[people-mirror] Applicants: mirrored=${applicantsResult.mirrored}, driveFiles=${applicantsResult.driveFiles}`,
    );
  } catch (error) {
    console.warn("[people-mirror] Applicants mirror failed:", error.message);
  }

  let reviewsResult = { mirrored: 0 };
  try {
    reviewsResult = await mirrorApplicantReviewsFromSheets(deadlineAt);
    console.log(`[people-mirror] ApplicantReviews: mirrored=${reviewsResult.mirrored}`);
  } catch (error) {
    console.warn("[people-mirror] ApplicantReviews mirror failed:", error.message);
  }

  let voiceMemoResult = { downloaded: 0, pruned: 0 };
  try {
    console.log("[people-mirror] Phase 2: caching voice memo audio (Drive → Postgres)...");
    voiceMemoResult = await syncApplicantVoiceMemoAudioCache({
      deadlineAt,
      driveScan: applicantsResult.driveScan,
    });
    console.log(
      `[people-mirror] Voice memo audio: downloaded=${voiceMemoResult.downloaded}, pruned=${voiceMemoResult.pruned}`,
    );
  } catch (error) {
    console.warn("[people-mirror] Voice memo audio cache failed:", error.message);
  }

  return {
    people: peopleResult.mirrored,
    peoplePruned: peopleResult.pruned,
    dingNumbers: dingResult.mirrored,
    dingHistory: historyResult.mirrored,
    applicants: applicantsResult.mirrored,
    driveFiles: applicantsResult.driveFiles,
    applicantReviews: reviewsResult.mirrored,
    voiceMemoDownloaded: voiceMemoResult.downloaded,
    voiceMemoPruned: voiceMemoResult.pruned,
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

  const deadlineAt = Date.now() + MIRROR_DRIVE_TIME_BUDGET_MS;
  const applicantsResult = await mirrorApplicantsFromSheetsOnly({ deadlineAt });
  console.log(
    `[people-mirror] Applicants: mirrored=${applicantsResult.mirrored}, driveFiles=${applicantsResult.driveFiles}`,
  );

  const voiceMemoResult = await syncApplicantVoiceMemoAudioCache({
    deadlineAt,
    driveScan: applicantsResult.driveScan,
  });
  console.log(
    `[people-mirror] Voice memo audio: downloaded=${voiceMemoResult.downloaded}, pruned=${voiceMemoResult.pruned}`,
  );

  return {
    people: peopleResult.mirrored,
    peoplePruned: peopleResult.pruned,
    applicants: applicantsResult.mirrored,
    driveFiles: applicantsResult.driveFiles,
    voiceMemoDownloaded: voiceMemoResult.downloaded,
    voiceMemoPruned: voiceMemoResult.pruned,
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
  loadVoiceMemoDriveScanMap,
  mirrorApplicantsFromSheetsOnly,
  syncApplicantVoiceMemoAudioCache,
  syncApplicantVoiceMemoDriveData,
  collectApplicantMirrorEntriesFromSheet,
  mirrorApplicantsAndDriveFromSheets,
  mirrorApplicantReviewsFromSheets,
  mirrorPeopleAndApplicantsFromSheets,
  mirrorPeopleAndDingFromSheets,
  upsertPersonFromSheetProfile,
  getPersonIdByAesopId,
  findExistingPersonId,
  buildPersonInsertParams,
  INSERT_PERSON_FROM_SHEET_SQL,
  UPDATE_PERSON_FROM_SHEET_SQL,
  logPeopleMirrorDedupeStats,
};
