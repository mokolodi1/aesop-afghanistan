const { drizzle } = require("drizzle-orm/node-postgres");
const { Pool } = require("pg");
const config = require("../config/secrets");
const schema = require("./schema");

/** @type {import('pg').Pool | null} */
let pool = null;
/** @type {ReturnType<typeof drizzle> | null} */
let db = null;

function getDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    return String(fromEnv).trim();
  }
  const fromSecrets = config.database?.url;
  if (fromSecrets != null && String(fromSecrets).trim() !== "") {
    return String(fromSecrets).trim();
  }
  return "";
}

function isDatabaseEnabled() {
  return getDatabaseUrl().length > 0;
}

function getPool() {
  if (!isDatabaseEnabled()) {
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: Number.parseInt(process.env.DATABASE_POOL_MAX || "5", 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    });
    pool.on("error", (err) => {
      console.error("[db] pool error:", err.message);
    });
  }
  return pool;
}

function getDb() {
  if (!isDatabaseEnabled()) {
    return null;
  }
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

async function checkDatabaseHealth() {
  const p = getPool();
  if (!p) {
    return { enabled: false, ok: false };
  }
  try {
    await p.query("SELECT 1");
    return { enabled: true, ok: true };
  } catch (error) {
    return { enabled: true, ok: false, error: error.message };
  }
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

module.exports = {
  getDatabaseUrl,
  isDatabaseEnabled,
  getPool,
  getDb,
  checkDatabaseHealth,
  closeDatabase,
  schema,
};
