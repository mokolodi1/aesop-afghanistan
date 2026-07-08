#!/usr/bin/env node
/**
 * Backfill NULL people.portal_role from People sheet Type column (incl. Stud./Teach dual roles)
 * and classroom enrollment fallback when Type is blank.
 *
 * Usage:
 *   node scripts/backfill-missing-portal-roles.js
 *   node scripts/backfill-missing-portal-roles.js --dry-run
 */
require("../config/secrets");
const { getPool, closeDatabase, isDatabaseEnabled } = require("../db/index");
const {
  loadEmailToPeopleProfileMap,
  resolvePortalRoleFromPeopleSheet,
} = require("../services/googleSheets");
const { loadApplicantAesopIdSetFromSheets } = require("../services/voiceMemoSync");

const DRY_RUN = process.argv.includes("--dry-run");

function resolvePortalRoleFromEnrollments(roles) {
  const normalized = new Set(
    (roles || []).map((role) => String(role || "").trim().toLowerCase()).filter(Boolean),
  );
  const isTeacher = normalized.has("teacher");
  const isStudent = normalized.has("student");
  if (isTeacher && isStudent) {
    return "Teacher";
  }
  if (isTeacher) {
    return "Teacher";
  }
  if (isStudent) {
    return "Student";
  }
  return null;
}

function resolvePortalRoleForPerson(person, profileMap, applicantIdSet) {
  const email = String(person.email || "").trim().toLowerCase();
  const profile = profileMap.get(email);
  if (profile) {
    const fromSheet = resolvePortalRoleFromPeopleSheet(
      {
        ...profile,
        email,
        id: person.aesop_id || profile.id || "",
      },
      applicantIdSet,
    );
    if (fromSheet) {
      return { portalRole: fromSheet, source: "people_sheet" };
    }
  }

  const fromEnrollments = resolvePortalRoleFromEnrollments(person.enrollment_roles);
  if (fromEnrollments) {
    return { portalRole: fromEnrollments, source: "classroom_enrollments" };
  }

  return { portalRole: null, source: "unresolved" };
}

async function loadMissingPortalRolePeople() {
  const pool = getPool();
  const result = await pool.query(
    `SELECT
       p.id,
       p.aesop_id,
       p.email,
       p.name,
       p.portal_role,
       COALESCE(array_agg(DISTINCT ce.role) FILTER (WHERE ce.role IS NOT NULL), '{}') AS enrollment_roles
     FROM people p
     LEFT JOIN course_enrollments ce ON ce.person_id = p.id
     WHERE p.portal_role IS NULL OR trim(p.portal_role) = ''
     GROUP BY p.id
     ORDER BY lower(trim(p.email))`,
  );
  return result.rows;
}

async function applyBackfill(people) {
  const [profileMap, applicantIdSet] = await Promise.all([
    loadEmailToPeopleProfileMap(),
    loadApplicantAesopIdSetFromSheets(),
  ]);

  const pool = getPool();
  const client = await pool.connect();
  const stats = {
    updated: 0,
    fromPeopleSheet: 0,
    fromEnrollments: 0,
    unresolved: 0,
  };
  /** @type {{ email: string, aesop_id: string|null, source: string }[]} */
  const unresolved = [];

  try {
    if (!DRY_RUN) {
      await client.query("BEGIN");
    }

    for (const person of people) {
      const { portalRole, source } = resolvePortalRoleForPerson(person, profileMap, applicantIdSet);
      if (!portalRole) {
        stats.unresolved += 1;
        unresolved.push({
          email: person.email,
          aesop_id: person.aesop_id,
          source,
        });
        continue;
      }

      if (source === "people_sheet") {
        stats.fromPeopleSheet += 1;
      } else if (source === "classroom_enrollments") {
        stats.fromEnrollments += 1;
      }

      if (DRY_RUN) {
        stats.updated += 1;
        console.log(`[backfill-portal-role] would set ${person.email} -> ${portalRole} (${source})`);
        continue;
      }

      const result = await client.query(
        `UPDATE people
         SET portal_role = $1,
             synced_at = NOW()
         WHERE id = $2
           AND (portal_role IS NULL OR trim(portal_role) = '')`,
        [portalRole, person.id],
      );
      stats.updated += result.rowCount;
    }

    if (!DRY_RUN) {
      await client.query("COMMIT");
    }
  } catch (error) {
    if (!DRY_RUN) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }

  return { stats, unresolved };
}

async function main() {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_URL is not set.");
  }

  const people = await loadMissingPortalRolePeople();
  console.log(`[backfill-portal-role] found ${people.length} row(s) with missing portal_role.`);

  const { stats, unresolved } = await applyBackfill(people);
  console.log("[backfill-portal-role] result:", { ...stats, dryRun: DRY_RUN });

  if (unresolved.length > 0) {
    console.log("[backfill-portal-role] still unresolved:");
    for (const row of unresolved) {
      console.log(`  - ${row.email} (${row.aesop_id || "no id"})`);
    }
  }

  const pool = getPool();
  const remaining = await pool.query(
    `SELECT COUNT(*)::int AS c FROM people WHERE portal_role IS NULL OR trim(portal_role) = ''`,
  );
  console.log("[backfill-portal-role] remaining missing portal_role:", remaining.rows[0].c);
}

main()
  .catch((error) => {
    console.error("[backfill-portal-role] failed:", error.message);
    process.exit(1);
  })
  .finally(() => closeDatabase());
