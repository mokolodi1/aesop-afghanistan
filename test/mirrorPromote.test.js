#!/usr/bin/env node
/**
 * Integration tests for interrupt-safe mirror staging + promote.
 * Requires a reachable DATABASE_URL; skipped when unset or unavailable.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { getPool, isDatabaseEnabled, closeDatabase } = require("../db/index");
const { runMigrations } = require("../db/migrate");
const {
  truncateMirrorStagingTables,
  truncateMirrorStagingTable,
  promoteStagingMirror,
  createMirrorSyncRun,
  finalizeMirrorSyncRun,
  useMirrorStaging,
} = require("../services/mirrorPromote");
const { personSheetIdentityKey } = require("../services/peopleMirror");

async function requireDatabase(t) {
  if (!isDatabaseEnabled()) {
    t.skip("DATABASE_URL not set");
    return false;
  }
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch {
    t.skip("Postgres unreachable");
    return false;
  }
}

test("useMirrorStaging respects MIRROR_USE_STAGING env", () => {
  const previous = process.env.MIRROR_USE_STAGING;
  try {
    process.env.MIRROR_USE_STAGING = "true";
    assert.equal(useMirrorStaging(), true);
    process.env.MIRROR_USE_STAGING = "false";
    assert.equal(useMirrorStaging(), false);
  } finally {
    if (previous == null) {
      delete process.env.MIRROR_USE_STAGING;
    } else {
      process.env.MIRROR_USE_STAGING = previous;
    }
  }
});

test("personSheetIdentityKey prefers AESOP id", () => {
  assert.equal(
    personSheetIdentityKey({ id: "ABC123", email: "a@example.com", name: "A" }),
    "id:abc123",
  );
});

test("partial staging does not change production people count", async (t) => {
  if (!(await requireDatabase(t))) {
    return;
  }
  await runMigrations();
  const pool = getPool();
  const before = await pool.query(`SELECT COUNT(*)::int AS count FROM people`);
  const beforeCount = before.rows[0].count;

  await truncateMirrorStagingTables(pool);
  await pool.query(
    `INSERT INTO people_staging (
       identity_key, aesop_id, email, name, portal_role, sheet_row
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    ["id:test-staging-only", "test-staging-only", "staging-only@example.com", "Staging Only", "Student", "{}"],
  );

  const after = await pool.query(`SELECT COUNT(*)::int AS count FROM people`);
  assert.equal(after.rows[0].count, beforeCount);

  await truncateMirrorStagingTables(pool);
});

test("promote preserves existing people.id for matched aesop_id", async (t) => {
  if (!(await requireDatabase(t))) {
    return;
  }
  await runMigrations();
  const pool = getPool();
  const aesopId = `promote-test-${Date.now()}`;
  const email = `${aesopId}@example.com`;

  const inserted = await pool.query(
    `INSERT INTO people (aesop_id, email, name, portal_role, synced_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id`,
    [aesopId, email, "Promote Test", "Student"],
  );
  const originalId = inserted.rows[0].id;

  await truncateMirrorStagingTables(pool);
  const identityKey = personSheetIdentityKey({ id: aesopId, email, name: "Promote Test Updated" });
  await pool.query(
    `INSERT INTO people_staging (
       identity_key, aesop_id, email, name, portal_role, sheet_row
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [identityKey, aesopId, email, "Promote Test Updated", "Teacher", "{}"],
  );

  const mirrorSyncRunId = await createMirrorSyncRun(null);
  await promoteStagingMirror(mirrorSyncRunId, new Set());
  await finalizeMirrorSyncRun(mirrorSyncRunId, "succeeded", { peopleCount: 1 });

  const row = await pool.query(`SELECT id, name, portal_role FROM people WHERE id = $1`, [originalId]);
  assert.equal(row.rows[0].id, originalId);
  assert.equal(row.rows[0].name, "Promote Test Updated");
  assert.equal(row.rows[0].portal_role, "Teacher");

  await pool.query(`DELETE FROM people WHERE id = $1`, [originalId]);
});

test("promote skips ding insert when number unchanged", async (t) => {
  if (!(await requireDatabase(t))) {
    return;
  }
  await runMigrations();
  const pool = getPool();
  const aesopId = `ding-test-${Date.now()}`;
  const email = `${aesopId}@example.com`;

  const person = await pool.query(
    `INSERT INTO people (aesop_id, email, name, portal_role, synced_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id`,
    [aesopId, email, "Ding Test", "Student"],
  );
  const personId = person.rows[0].id;

  await pool.query(
    `INSERT INTO ding_numbers (person_id, number, is_current, source, updated_at)
     VALUES ($1, $2, true, 'test', NOW())`,
    [personId, "42"],
  );
  const beforeDing = await pool.query(
    `SELECT COUNT(*)::int AS count FROM ding_numbers WHERE person_id = $1`,
    [personId],
  );

  await truncateMirrorStagingTables(pool);
  const identityKey = personSheetIdentityKey({ id: aesopId, email, name: "Ding Test" });
  await pool.query(
    `INSERT INTO people_staging (
       identity_key, aesop_id, email, name, portal_role, sheet_row
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [identityKey, aesopId, email, "Ding Test", "Student", "{}"],
  );
  await pool.query(
    `INSERT INTO ding_numbers_staging (identity_key, number) VALUES ($1, $2)`,
    [identityKey, "42"],
  );

  const mirrorSyncRunId = await createMirrorSyncRun(null);
  const result = await promoteStagingMirror(mirrorSyncRunId, new Set());
  await finalizeMirrorSyncRun(mirrorSyncRunId, "succeeded", { dingCount: result.dingNumbers });

  assert.equal(result.dingNumbers, 0);
  const afterDing = await pool.query(
    `SELECT COUNT(*)::int AS count FROM ding_numbers WHERE person_id = $1`,
    [personId],
  );
  assert.equal(afterDing.rows[0].count, beforeDing.rows[0].count);

  await pool.query(`DELETE FROM people WHERE id = $1`, [personId]);
});

test("cleared applicants_staging leaves production applicants unchanged", async (t) => {
  if (!(await requireDatabase(t))) {
    return;
  }
  await runMigrations();
  const pool = getPool();

  const aesopId = `id:test-applicant-soft-${Date.now()}`;
  await pool.query(
    `INSERT INTO applicants (aesop_id, name, round1, synced_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (aesop_id) DO UPDATE SET name = EXCLUDED.name`,
    [aesopId, "Before Promote", "Accepted"],
  );
  const before = await pool.query(`SELECT name FROM applicants WHERE aesop_id = $1`, [aesopId]);

  await truncateMirrorStagingTables(pool);
  const identityKey = personSheetIdentityKey({
    id: "id:test-people-anchor",
    email: "anchor-soft-fail@example.com",
    name: "Anchor",
  });
  await pool.query(
    `INSERT INTO people_staging (
       identity_key, aesop_id, email, name, portal_role, sheet_row
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [identityKey, "id:test-people-anchor", "anchor-soft-fail@example.com", "Anchor", "Student", "{}"],
  );
  await pool.query(
    `INSERT INTO applicants_staging (aesop_id, name, round1)
     VALUES ($1, $2, $3)`,
    [aesopId, "Partial Staging", "Accepted"],
  );
  await truncateMirrorStagingTable(pool, "applicants_staging");

  const mirrorSyncRunId = await createMirrorSyncRun(null);
  const result = await promoteStagingMirror(mirrorSyncRunId, new Set());
  await finalizeMirrorSyncRun(mirrorSyncRunId, "succeeded", {
    peopleCount: result.people,
    applicantsCount: result.applicants,
  });

  assert.equal(result.applicants, 0);
  const after = await pool.query(`SELECT name FROM applicants WHERE aesop_id = $1`, [aesopId]);
  assert.equal(after.rows[0].name, before.rows[0].name);

  await pool.query(`DELETE FROM applicants WHERE aesop_id = $1`, [aesopId]);
  await pool.query(`DELETE FROM people WHERE aesop_id = $1`, ["id:test-people-anchor"]);
});

test.after(async () => {
  await closeDatabase().catch(() => {});
});
