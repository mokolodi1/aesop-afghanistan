const { eq, and, gte, sql, count, countDistinct } = require("drizzle-orm");
const { getDb, isDatabaseEnabled } = require("../db/index");
const { portalEvents, people } = require("../db/schema");
const { getPersonByAesopId } = require("./classroomDb");

const PORTAL_LOGIN_EVENT = "login";

/**
 * @param {{ userId?: string, email?: string, personId?: number|null, ip?: string|null, loginAt?: Date }} params
 * @returns {Promise<{ recorded: boolean, loginAt?: Date }>}
 */
async function recordPortalLogin(params = {}) {
  if (!isDatabaseEnabled()) {
    return { recorded: false };
  }

  const db = getDb();
  if (!db) {
    return { recorded: false };
  }

  const loginAt = params.loginAt instanceof Date ? params.loginAt : new Date();
  const aesopId = typeof params.userId === "string" ? params.userId.trim() : "";
  const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : "";

  if (!aesopId && !email) {
    return { recorded: false };
  }

  let personId = params.personId ?? null;
  if (!personId && aesopId) {
    const person = await getPersonByAesopId(aesopId);
    personId = person?.id ?? null;
  }

  await db.insert(portalEvents).values({
    eventType: PORTAL_LOGIN_EVENT,
    aesopId: aesopId || null,
    email: email || null,
    personId,
    ipAddress: params.ip ? String(params.ip).slice(0, 64) : null,
    createdAt: loginAt,
  });

  if (personId) {
    await db
      .update(people)
      .set({
        lastLoginAt: loginAt,
        loginCount: sql`${people.loginCount} + 1`,
      })
      .where(eq(people.id, personId));
  }

  return { recorded: true, loginAt };
}

/**
 * @param {{ since?: Date }} [options]
 * @returns {Promise<{
 *   enabled: boolean,
 *   totalLoginEvents: number,
 *   uniqueUsersEver: number,
 *   loginsLast24Hours: number,
 *   loginsLast7Days: number,
 *   uniqueUsersLast24Hours: number,
 * }>}
 */
async function getPortalLoginStats(options = {}) {
  if (!isDatabaseEnabled()) {
    return {
      enabled: false,
      totalLoginEvents: 0,
      uniqueUsersEver: 0,
      loginsLast24Hours: 0,
      loginsLast7Days: 0,
      uniqueUsersLast24Hours: 0,
    };
  }

  const db = getDb();
  if (!db) {
    return {
      enabled: false,
      totalLoginEvents: 0,
      uniqueUsersEver: 0,
      loginsLast24Hours: 0,
      loginsLast7Days: 0,
      uniqueUsersLast24Hours: 0,
    };
  }

  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000);
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const loginType = eq(portalEvents.eventType, PORTAL_LOGIN_EVENT);

  const [totalRow] = await db.select({ value: count() }).from(portalEvents).where(loginType);
  const [uniqueEverRow] = await db
    .select({ value: count() })
    .from(people)
    .where(sql`${people.loginCount} > 0`);

  const [last24Row] = await db
    .select({ value: count() })
    .from(portalEvents)
    .where(and(loginType, gte(portalEvents.createdAt, since24h)));

  const [last7Row] = await db
    .select({ value: count() })
    .from(portalEvents)
    .where(and(loginType, gte(portalEvents.createdAt, since7d)));

  const [unique24Row] = await db
    .select({ value: countDistinct(portalEvents.aesopId) })
    .from(portalEvents)
    .where(and(loginType, gte(portalEvents.createdAt, since24h)));

  return {
    enabled: true,
    totalLoginEvents: totalRow?.value ?? 0,
    uniqueUsersEver: uniqueEverRow?.value ?? 0,
    loginsLast24Hours: last24Row?.value ?? 0,
    loginsLast7Days: last7Row?.value ?? 0,
    uniqueUsersLast24Hours: unique24Row?.value ?? 0,
  };
}

/**
 * @param {string} aesopId
 * @returns {Promise<{ lastLoginAt: Date|null, loginCount: number }|null>}
 */
async function getPersonLoginSummary(aesopId) {
  if (!isDatabaseEnabled()) {
    return null;
  }
  const person = await getPersonByAesopId(aesopId);
  if (!person) {
    return null;
  }
  return {
    lastLoginAt: person.lastLoginAt ?? null,
    loginCount: person.loginCount ?? 0,
  };
}

function shouldSyncLoginToSheets() {
  return String(process.env.PORTAL_LOGIN_SHEET_SYNC || "").trim().toLowerCase() === "true";
}

module.exports = {
  PORTAL_LOGIN_EVENT,
  recordPortalLogin,
  getPortalLoginStats,
  getPersonLoginSummary,
  shouldSyncLoginToSheets,
};
