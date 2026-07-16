const config = require("../config/secrets");
const { getPool, isDatabaseEnabled } = require("../db/index");
const { getApplicantVoiceMemoDurationsMapFromDb } = require("./classroomDb");
const {
  loadAllPeopleRowsFromSheets,
  loadEmailToPeopleProfileMap,
  buildLatestDingNumberByUserIdMap,
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
const { sheetVoiceMemoLengthSeconds, isTrustedVoiceMemoCachedDurationSeconds } = require("../utils/voiceMemoDuration");
const {
  scanVoiceMemoFolder,
  resolveVoiceMemoDurationsMap,
  extractDriveFileIdFromLink,
} = require("./googleDrive");
const {
  personSheetIdentityKey,
  preparePeopleRowsForMirror,
  logPeopleMirrorDedupeStats,
} = require("./peopleMirror");
const {
  truncateMirrorStagingTables,
  truncateMirrorStagingTable,
  createMirrorSyncRun,
  finalizeMirrorSyncRun,
  promoteStagingMirror,
} = require("./mirrorPromote");
const { syncVoiceMemoAudioFromScan } = require("./voiceMemoAudio");

/** Sheets/Drive throttling can stretch the mirror; retry 429s for up to ~45 minutes. */
const MIRROR_SYNC_TIME_BUDGET_MS = 45 * 60 * 1000;

/**
 * @param {object} profile
 * @param {Set<string>} applicantIdSet
 */
function buildPeopleStagingFields(profile, applicantIdSet) {
  const email = profile.email.trim().toLowerCase();
  const identityKey = personSheetIdentityKey(profile);
  const portalRole = resolvePortalRoleFromPeopleSheet(profile, applicantIdSet);
  const aesopId = profile.id ? String(profile.id).trim() : null;
  const sheetRowPayload = { ...(profile.sheetRow || {}) };
  if (profile.sheetRowNumber != null && Number.isFinite(Number(profile.sheetRowNumber))) {
    sheetRowPayload.__rowNumber = Number(profile.sheetRowNumber);
  }
  return {
    identityKey,
    aesopId,
    email,
    name: profile.name || null,
    phone: profile.phone || null,
    portalRole,
    reviewerRole: profile.reviewerRole ? String(profile.reviewerRole).trim() : null,
    peopleType: profile.peopleType ? String(profile.peopleType).trim() : null,
    adminRole: profile.adminRole ? String(profile.adminRole).trim() : null,
    peopleStatus: profile.peopleStatus ? String(profile.peopleStatus).trim() : null,
    lastLogin: profile.lastLogin ? String(profile.lastLogin).trim() : null,
    pastDing: profile.pastDing ? String(profile.pastDing).trim() : null,
    sheetRow: JSON.stringify(sheetRowPayload),
  };
}

/**
 * @param {import("pg").Pool | import("pg").PoolClient} runner
 * @param {object} profile
 * @param {Set<string>} applicantIdSet
 */
async function upsertPersonStagingRow(runner, profile, applicantIdSet) {
  const fields = buildPeopleStagingFields(profile, applicantIdSet);
  const result = await runner.query(
    `INSERT INTO people_staging (
       identity_key, aesop_id, email, name, phone, portal_role, reviewer_role,
       people_type, admin_role, people_status, last_login, past_ding, sheet_row
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     ON CONFLICT (identity_key) DO UPDATE SET
       aesop_id = EXCLUDED.aesop_id,
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       phone = EXCLUDED.phone,
       portal_role = EXCLUDED.portal_role,
       reviewer_role = EXCLUDED.reviewer_role,
       people_type = EXCLUDED.people_type,
       admin_role = EXCLUDED.admin_role,
       people_status = EXCLUDED.people_status,
       last_login = EXCLUDED.last_login,
       past_ding = EXCLUDED.past_ding,
       sheet_row = EXCLUDED.sheet_row
     RETURNING identity_key`,
    [
      fields.identityKey,
      fields.aesopId,
      fields.email,
      fields.name,
      fields.phone,
      fields.portalRole,
      fields.reviewerRole,
      fields.peopleType,
      fields.adminRole,
      fields.peopleStatus,
      fields.lastLogin,
      fields.pastDing,
      fields.sheetRow,
    ],
  );
  return result.rows[0] || null;
}

async function mirrorAllPeopleToStaging(deadlineAt, applicantIdSet = null) {
  const sheetOpts = { deadlineAt };
  const [rawRows, resolvedApplicantIds, classroomRoles] = await Promise.all([
    loadAllPeopleRowsFromSheets(sheetOpts),
    applicantIdSet ? Promise.resolve(applicantIdSet) : loadApplicantAesopIdSetFromSheets(sheetOpts),
    loadClassroomRoleEmailSetsFromSheets().catch((error) => {
      console.warn("[people-mirror] Classroom role sets unavailable:", error.message);
      return { teacherEmails: new Set(), studentEmails: new Set() };
    }),
  ]);
  const ids = applicantIdSet || resolvedApplicantIds;
  const prepared = preparePeopleRowsForMirror(rawRows);
  logPeopleMirrorDedupeStats(prepared);
  const { rows } = prepared;
  applyDerivedPeopleStatusToRows(rows, {
    teacherEmails: classroomRoles.teacherEmails,
    studentEmails: classroomRoles.studentEmails,
    applicantIdSet: ids,
  });

  const pool = getPool();
  if (!pool) {
    return { mirrored: 0, duplicateSheetRowsCollapsed: prepared.duplicateSheetRowsCollapsed };
  }

  let mirrored = 0;
  for (const profile of rows) {
    const row = await upsertPersonStagingRow(pool, profile, ids);
    if (row) {
      mirrored += 1;
    }
  }

  return {
    mirrored,
    duplicateSheetRowsCollapsed: prepared.duplicateSheetRowsCollapsed,
  };
}

async function mirrorDingNumbersToStaging(applicantIdSet, deadlineAt) {
  const pool = getPool();
  if (!pool) {
    return { mirrored: 0 };
  }

  const sheetOpts = { deadlineAt };
  const ids = applicantIdSet || (await loadApplicantAesopIdSetFromSheets(sheetOpts));
  const [profileMap, dingByUserId] = await Promise.all([
    loadEmailToPeopleProfileMap(sheetOpts),
    buildLatestDingNumberByUserIdMap(sheetOpts),
  ]);

  let mirrored = 0;
  for (const [userId, dingNumber] of dingByUserId.entries()) {
    const match = [...profileMap.entries()].find(
      ([, entry]) => entry.id && String(entry.id).trim().toLowerCase() === userId,
    );
    if (!match) {
      continue;
    }
    const [email, profile] = match;
    const identityKey = personSheetIdentityKey({ ...profile, email });
    const number = String(dingNumber).trim();
    if (!number) {
      continue;
    }

    await upsertPersonStagingRow(pool, { ...profile, email }, ids);
    await pool.query(
      `INSERT INTO ding_numbers_staging (identity_key, number)
       VALUES ($1, $2)
       ON CONFLICT (identity_key) DO UPDATE SET number = EXCLUDED.number`,
      [identityKey, number],
    );
    mirrored += 1;
  }

  return { mirrored };
}

async function mirrorApplicantsAndDriveToStaging(deadlineAt) {
  const pool = getPool();
  if (!pool) {
    return { mirrored: 0, driveFiles: 0 };
  }

  const { dataRows, columns, cfg } = await loadApplicantsDataForStats({ deadlineAt });
  const durationLimits = getVoiceMemoDurationLimits(cfg.voiceMemo);

  const folderId = String(cfg.voiceMemo?.driveFolderId || "").trim();
  /** @type {Map<string, { aesopId: string, fileId: string, fileName: string }>} */
  let memoById = new Map();
  /** @type {Awaited<ReturnType<typeof scanVoiceMemoFolder>>|null} */
  let driveScan = null;

  if (folderId) {
    const scanOptions = getVoiceMemoDriveScanOptions(cfg.voiceMemo);
    driveScan = await scanVoiceMemoFolder(folderId, { ...scanOptions, deadlineAt });
    memoById = driveScan.memosById;
    try {
      const audioResult = await syncVoiceMemoAudioFromScan(driveScan, { deadlineAt });
      console.info(
        `[mirror] voice memo audio cache: driveFiles=${audioResult.driveFiles}, ` +
          `downloaded=${audioResult.downloaded}, pruned=${audioResult.pruned}`,
      );
    } catch (error) {
      console.warn("[mirror] voice memo audio cache failed:", error.message || error);
    }
  }

  /** @type {Map<string, number>} */
  let cachedDurationByFileId = new Map();
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

  const gs = config.googleSheets || {};
  const levelColumnIndex = resolveColumnIndex(gs.admissionsLevelColumn || "E");
  const ageColumnIndex = resolveColumnIndex(gs.admissionsAgeColumn || "L");
  const essayColumnIndex = resolveColumnIndex(gs.admissionsEssayColumn || "K");

  /** @type {Array<Record<string, unknown>>} */
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
    const driveFile = findVoiceMemoInScan(memoById, aesopId);
    const driveFileId = driveFile?.fileId ? String(driveFile.fileId).trim() : null;
    const driveFileName = driveFile?.fileName ? String(driveFile.fileName).trim() : null;

    let driveDurationSeconds = null;
    if (driveFileId) {
      const sheetLengthSeconds =
        columns.length >= 0 ? parseVoiceMemoSheetLengthSeconds(rowData[columns.length]) : null;
      const sheetLinkFileId = extractDriveFileIdFromLink(applicantLinks);
      const cached = cachedDurationByFileId.get(driveFileId);
      if (sheetLengthSeconds != null && sheetLinkFileId === driveFileId) {
        driveDurationSeconds = sheetVoiceMemoLengthSeconds(sheetLengthSeconds, durationLimits);
        durationsFromSheet += 1;
      } else if (isTrustedVoiceMemoCachedDurationSeconds(cached)) {
        driveDurationSeconds = sheetVoiceMemoLengthSeconds(cached, durationLimits);
        durationsFromDb += 1;
      } else {
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
    });
  }

  /** @type {Map<string, number|null>} */
  let probedDurations = new Map();
  if (probeFileIds.size > 0) {
    const probeStartedAt = Date.now();
    probedDurations = await resolveVoiceMemoDurationsMap([...probeFileIds], {
      concurrency: 4,
      deadlineAt,
    });
    console.info(
      `[mirror] probed ${probeFileIds.size} missing voice memo duration(s) from Drive in ${Date.now() - probeStartedAt}ms`,
    );
  }

  let mirrored = 0;
  let durationsUnknown = 0;
  for (const entry of entries) {
    if (entry.driveFileId && entry.driveDurationSeconds == null) {
      const probed = probedDurations.get(entry.driveFileId);
      if (probed != null && Number.isFinite(Number(probed))) {
        entry.driveDurationSeconds = sheetVoiceMemoLengthSeconds(probed, durationLimits);
      } else {
        durationsUnknown += 1;
      }
    }

    const result = await pool.query(
      `INSERT INTO applicants_staging (
         aesop_id, email, name, applied_level, age, essay,
         round1, round2, round2_prompt, applicant_links, submitted_at,
         drive_file_id, drive_file_name, drive_duration_seconds
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (aesop_id) DO UPDATE SET
         email = EXCLUDED.email,
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
         drive_duration_seconds = EXCLUDED.drive_duration_seconds
       RETURNING aesop_id`,
      [
        entry.aesopId,
        entry.email || null,
        entry.name ?? "",
        entry.appliedLevel ?? "",
        entry.age ?? "",
        entry.essay ?? "",
        entry.round1 ?? "",
        entry.round2 ?? "",
        entry.round2Prompt ?? "",
        entry.applicantLinks ?? "",
        entry.submittedAt ?? "",
        entry.driveFileId || null,
        entry.driveFileName || null,
        entry.driveDurationSeconds ?? null,
      ],
    );
    if (result.rows[0]) {
      mirrored += 1;
    }
  }

  console.info(
    `[mirror] voice memo durations: sheet=${durationsFromSheet}, dbCache=${durationsFromDb}, probed=${probeFileIds.size}, unknown=${durationsUnknown}`,
  );

  return { mirrored, driveFiles: memoById.size };
}

async function mirrorApplicantReviewsToStaging(deadlineAt) {
  const pool = getPool();
  if (!pool) {
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
  let mirrored = 0;

  for (const row of rows) {
    const rowData = Array.isArray(row._rawData) ? row._rawData : [];
    const aesopId = String(rowData[reviewsCfg.applicantIdCol] ?? "").trim();
    if (!aesopId) {
      continue;
    }

    const cell = (index) => String(rowData[index] ?? "").trim();
    const result = await pool.query(
      `INSERT INTO applicant_reviews_staging (
         aesop_id, reviewer_a, reviewer_b,
         a_english_level, a_suspected_ai, a_unable_to_grade, a_technical_flag,
         a_instruction_following, a_original_thinking, a_character,
         b_english_level, b_suspected_ai, b_unable_to_grade, b_technical_flag,
         b_instruction_following, b_original_thinking, b_character,
         sheet_row_number
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
         sheet_row_number = COALESCE(EXCLUDED.sheet_row_number, applicant_reviews_staging.sheet_row_number)
       RETURNING aesop_id`,
      [
        aesopId,
        cell(reviewsCfg.reviewerACol),
        cell(reviewsCfg.reviewerBCol),
        cell(reviewsCfg.aLevelCol),
        cell(reviewsCfg.aSuspectedAiCol),
        cell(reviewsCfg.aUnableToGradeCol),
        cell(reviewsCfg.aTechnicalFlagCol),
        cell(reviewsCfg.aInstructionCol),
        cell(reviewsCfg.aOriginalThinkingCol),
        cell(reviewsCfg.aCharacterCol),
        cell(reviewsCfg.bLevelCol),
        cell(reviewsCfg.bSuspectedAiCol),
        cell(reviewsCfg.bUnableToGradeCol),
        cell(reviewsCfg.bTechnicalFlagCol),
        cell(reviewsCfg.bInstructionCol),
        cell(reviewsCfg.bOriginalThinkingCol),
        cell(reviewsCfg.bCharacterCol),
        row.rowNumber,
      ],
    );
    if (result.rows[0]) {
      mirrored += 1;
    }
  }

  return { mirrored };
}

/**
 * Interrupt-safe hourly mirror: build staging tables, then promote atomically.
 * @param {{ jobRunId?: number|null, includeDingHistory?: boolean }} [options]
 */
async function mirrorPeopleAndDingViaStaging(options = {}) {
  if (!isDatabaseEnabled()) {
    return {
      people: 0,
      peoplePruned: 0,
      dingNumbers: 0,
      dingHistory: 0,
      applicants: 0,
      driveFiles: 0,
      applicantReviews: 0,
    };
  }

  const pool = getPool();
  if (!pool) {
    throw new Error("Database is not configured.");
  }

  const mirrorSyncRunId = await createMirrorSyncRun(options.jobRunId ?? null);
  await truncateMirrorStagingTables(pool);
  const deadlineAt = Date.now() + MIRROR_SYNC_TIME_BUDGET_MS;

  try {
    const applicantIdSet = await loadApplicantAesopIdSetFromSheets({ deadlineAt });
    await mirrorAllPeopleToStaging(deadlineAt, applicantIdSet);

    let dingResult = { mirrored: 0 };
    let dingStagingFailed = false;
    try {
      dingResult = await mirrorDingNumbersToStaging(applicantIdSet, deadlineAt);
    } catch (error) {
      dingStagingFailed = true;
      console.warn("[people-mirror] Ding numbers staging failed:", error.message);
      await truncateMirrorStagingTable(pool, "ding_numbers_staging");
    }

    let applicantsResult = { mirrored: 0, driveFiles: 0 };
    let applicantsStagingFailed = false;
    try {
      applicantsResult = await mirrorApplicantsAndDriveToStaging(deadlineAt);
      console.log(
        `[people-mirror] Applicants/Drive staging: mirrored=${applicantsResult.mirrored}, driveFiles=${applicantsResult.driveFiles}`,
      );
    } catch (error) {
      applicantsStagingFailed = true;
      console.warn("[people-mirror] Applicants/Drive staging failed:", error.message);
      await truncateMirrorStagingTable(pool, "applicants_staging");
    }

    let reviewsResult = { mirrored: 0 };
    let reviewsStagingFailed = false;
    try {
      reviewsResult = await mirrorApplicantReviewsToStaging(deadlineAt);
      console.log(`[people-mirror] ApplicantReviews staging: mirrored=${reviewsResult.mirrored}`);
    } catch (error) {
      reviewsStagingFailed = true;
      console.warn("[people-mirror] ApplicantReviews staging failed:", error.message);
      await truncateMirrorStagingTable(pool, "applicant_reviews_staging");
    }

    const promoteResult = await promoteStagingMirror(mirrorSyncRunId, applicantIdSet);

    await finalizeMirrorSyncRun(mirrorSyncRunId, "succeeded", {
      peopleCount: promoteResult.people,
      dingCount: promoteResult.dingNumbers,
      applicantsCount: promoteResult.applicants,
      applicantReviewsCount: promoteResult.applicantReviews,
    });

    const partialFailures = [];
    if (dingStagingFailed) {
      partialFailures.push("ding_numbers");
    }
    if (applicantsStagingFailed) {
      partialFailures.push("applicants");
    }
    if (reviewsStagingFailed) {
      partialFailures.push("applicant_reviews");
    }
    if (partialFailures.length > 0) {
      console.warn(
        `[people-mirror] promoted people cache; left unchanged in Postgres: ${partialFailures.join(", ")}`,
      );
    }

    return {
      people: promoteResult.people,
      peoplePruned: promoteResult.peoplePruned,
      dingNumbers: promoteResult.dingNumbers,
      dingHistory: 0,
      applicants: promoteResult.applicants,
      driveFiles: applicantsResult.driveFiles,
      applicantReviews: promoteResult.applicantReviews,
      mirrorSyncRunId,
      partialFailures,
    };
  } catch (error) {
    await finalizeMirrorSyncRun(mirrorSyncRunId, "failed", { error: error.message });
    throw error;
  }
}

module.exports = {
  mirrorAllPeopleToStaging,
  mirrorDingNumbersToStaging,
  mirrorApplicantsAndDriveToStaging,
  mirrorApplicantReviewsToStaging,
  mirrorPeopleAndDingViaStaging,
  upsertPersonStagingRow,
};
