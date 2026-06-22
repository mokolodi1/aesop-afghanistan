#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getPool, isDatabaseEnabled, closeDatabase } = require("./index");

async function runMigrations() {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL is not set. Configure database.url in secrets or DATABASE_URL env.");
    process.exit(1);
  }

  const pool = getPool();
  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const filename of files) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
    if (applied.rowCount > 0) {
      console.log(`[migrate] skip ${filename} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      console.log(`[migrate] applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  console.log("[migrate] done");
}

if (require.main === module) {
  runMigrations()
    .catch((error) => {
      console.error("[migrate] failed:", error.message);
      process.exit(1);
    })
    .finally(() => closeDatabase());
}

module.exports = { runMigrations };
