const { eq, and, sql } = require("drizzle-orm");
const { getDb, getPool, isDatabaseEnabled } = require("../db/index");
const { people, dingNumbers, dingChangeHistory } = require("../db/schema");
const {
  loadEmailToPeopleProfileMap,
  buildLatestDingNumberByUserIdMap,
  getPortalDingChangeHistory,
  isAppliedPeopleStatus,
  resolvePeopleStatus,
  isPeopleSheetAdminRole,
  backfillAppliedStatusOnPeopleSheet,
} = require("./googleSheets");

async function upsertPersonFromSheetProfile(profile, syncedAt = new Date()) {
  const db = getDb();
  if (!db || !profile?.email) {
    return null;
  }
  const email = profile.email.trim().toLowerCase();
  const peopleStatus = resolvePeopleStatus(profile.id, profile.peopleStatus);
  let portalRole =
    profile.portalRole && String(profile.portalRole).trim()
      ? String(profile.portalRole).trim()
      : null;
  if (isAppliedPeopleStatus(peopleStatus)) {
    portalRole = "Applied";
  } else if (isPeopleSheetAdminRole(portalRole)) {
    portalRole = "Admin";
  }
  const updateSet = {
    aesopId: sql`COALESCE(EXCLUDED.aesop_id, ${people.aesopId})`,
    name: sql`COALESCE(EXCLUDED.name, ${people.name})`,
    phone: sql`COALESCE(EXCLUDED.phone, ${people.phone})`,
    syncedAt,
  };
  if (portalRole) {
    updateSet.portalRole = portalRole;
  }
  const rows = await db
    .insert(people)
    .values({
      aesopId: profile.id ? String(profile.id).trim() : null,
      email,
      name: profile.name || null,
      phone: profile.phone || null,
      portalRole,
      syncedAt,
    })
    .onConflictDoUpdate({
      target: people.email,
      set: updateSet,
    })
    .returning();
  return rows[0] || null;
}

async function mirrorAllPeopleFromSheets() {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0 };
  }

  const profileMap = await loadEmailToPeopleProfileMap();
  const syncedAt = new Date();
  let mirrored = 0;

  for (const [email, profile] of profileMap.entries()) {
    const row = await upsertPersonFromSheetProfile({ ...profile, email }, syncedAt);
    if (row) {
      mirrored += 1;
    }
  }

  return { mirrored };
}

async function mirrorDingNumbersFromSheets() {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0 };
  }

  const db = getDb();
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
    const person = await upsertPersonFromSheetProfile({ ...profile, email }, syncedAt);
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

async function mirrorDingHistoryFromSheets(options = {}) {
  if (!isDatabaseEnabled()) {
    return { mirrored: 0 };
  }

  const db = getDb();
  const profileMap = await loadEmailToPeopleProfileMap();
  const syncedAt = new Date();
  let mirrored = 0;

  for (const profile of profileMap.values()) {
    if (!profile?.id) {
      continue;
    }
    const person = await upsertPersonFromSheetProfile(profile, syncedAt);
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

async function mirrorPeopleAndDingFromSheets() {
  try {
    const statusBackfill = await backfillAppliedStatusOnPeopleSheet();
    if (statusBackfill.updated > 0) {
      console.log(`[people-mirror] backfilled Applied status on ${statusBackfill.updated} People row(s).`);
    }
  } catch (error) {
    console.warn("[people-mirror] Applied status backfill failed:", error.message);
  }

  const peopleResult = await mirrorAllPeopleFromSheets();
  const dingResult = await mirrorDingNumbersFromSheets();
  const historyResult = await mirrorDingHistoryFromSheets();
  return {
    people: peopleResult.mirrored,
    dingNumbers: dingResult.mirrored,
    dingHistory: historyResult.mirrored,
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
  mirrorDingNumbersFromSheets,
  mirrorDingHistoryFromSheets,
  mirrorPeopleAndDingFromSheets,
  upsertPersonFromSheetProfile,
  getPersonIdByAesopId,
};
