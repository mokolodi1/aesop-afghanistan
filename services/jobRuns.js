/**
 * job_runs records: one row per sync job run (scheduled or admin-triggered),
 * including captured console logs. Backs the admin portal's Jobs tab.
 */
const path = require("path");
const { spawn } = require("child_process");
const { isDatabaseEnabled, getPool } = require("../db/index");
const { getJobDefinition, getConflictingJobNames } = require("./jobRegistry");

/** Logs beyond this are middle-truncated before storage. */
const MAX_LOG_CHARS = 400 * 1024;
/** A 'running' row older than this no longer blocks new runs (crashed run). */
const ACTIVE_RUN_STALE_MS = 2 * 60 * 60 * 1000;
/** Runs kept per job when pruning. */
const KEEP_RUNS_PER_JOB = 100;

const RUN_JOB_SCRIPT = path.join(__dirname, "..", "scripts", "run-job.js");

function truncateLogsText(text) {
  if (typeof text !== "string" || text.length <= MAX_LOG_CHARS) {
    return text;
  }
  const head = text.slice(0, Math.floor(MAX_LOG_CHARS * 0.3));
  const tail = text.slice(-Math.floor(MAX_LOG_CHARS * 0.65));
  return `${head}\n\n… [log truncated: ${text.length - head.length - tail.length} characters omitted] …\n\n${tail}`;
}

/** @returns {Record<string, unknown>|null} */
function rowToRun(row, { includeLogs = false } = {}) {
  if (!row) {
    return null;
  }
  const startedAt = row.started_at ? new Date(row.started_at) : null;
  const finishedAt = row.finished_at ? new Date(row.finished_at) : null;
  const durationMs =
    startedAt != null
      ? (finishedAt ? finishedAt.getTime() : Date.now()) - startedAt.getTime()
      : null;
  const run = {
    id: Number(row.id),
    jobName: row.job_name,
    triggerSource: row.trigger_source,
    triggeredBy: row.triggered_by || null,
    status: row.status,
    startedAt: startedAt ? startedAt.toISOString() : null,
    finishedAt: finishedAt ? finishedAt.toISOString() : null,
    durationMs,
    result: row.result || null,
    error: row.error || null,
  };
  if (includeLogs) {
    run.logs = row.logs || "";
  }
  return run;
}

/**
 * @param {{ jobName: string, triggerSource: string, triggeredBy?: string|null }} params
 * @returns {Promise<number|null>} run id, or null when the DB is not configured
 */
async function createJobRun({ jobName, triggerSource, triggeredBy = null }) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const inserted = await pool.query(
    `INSERT INTO job_runs (job_name, trigger_source, triggered_by, status, started_at)
     VALUES ($1, $2, $3, 'running', NOW())
     RETURNING id`,
    [jobName, triggerSource, triggeredBy],
  );
  return Number(inserted.rows[0].id);
}

/**
 * @param {number} runId
 * @param {{ status: string, result?: unknown, error?: string|null, logs?: string|null }} params
 */
async function finalizeJobRun(runId, { status, result = null, error = null, logs = null }) {
  const pool = getPool();
  if (!pool || runId == null) {
    return;
  }
  await pool.query(
    `UPDATE job_runs
     SET status = $2,
         finished_at = NOW(),
         result = $3,
         error = $4,
         logs = COALESCE($5, logs)
     WHERE id = $1`,
    [
      runId,
      status,
      result == null ? null : JSON.stringify(result),
      error,
      logs == null ? null : truncateLogsText(logs),
    ],
  );
}

/**
 * Mark a still-'running' row as failed (e.g. the child process died without
 * finalizing). No-op when the run already finished normally.
 */
async function failJobRunIfStillRunning(runId, errorMessage) {
  const pool = getPool();
  if (!pool || runId == null) {
    return;
  }
  await pool.query(
    `UPDATE job_runs
     SET status = 'failed', finished_at = NOW(), error = $2
     WHERE id = $1 AND status = 'running'`,
    [runId, errorMessage],
  );
}

/** @param {number} runId @param {string} logs */
async function updateJobRunLogs(runId, logs) {
  const pool = getPool();
  if (!pool || runId == null) {
    return;
  }
  await pool.query(`UPDATE job_runs SET logs = $2 WHERE id = $1`, [
    runId,
    truncateLogsText(logs),
  ]);
}

/**
 * @param {string} jobName
 * @returns {Promise<Record<string, unknown>|null>} fresh 'running' run for the job
 */
async function findActiveJobRun(jobName) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const found = await pool.query(
    `SELECT id, job_name, trigger_source, triggered_by, status, started_at, finished_at, result, error
     FROM job_runs
     WHERE job_name = $1
       AND status = 'running'
       AND started_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')
     ORDER BY started_at DESC
     LIMIT 1`,
    [jobName, ACTIVE_RUN_STALE_MS],
  );
  return rowToRun(found.rows[0]);
}

/**
 * @param {string[]} jobNames
 * @returns {Promise<Record<string, unknown>|null>} freshest 'running' run among the names
 */
async function findActiveJobRunAmong(jobNames) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const names = [...new Set((jobNames || []).map((name) => String(name || "").trim()).filter(Boolean))];
  if (names.length === 0) {
    return null;
  }
  if (names.length === 1) {
    return findActiveJobRun(names[0]);
  }
  const found = await pool.query(
    `SELECT id, job_name, trigger_source, triggered_by, status, started_at, finished_at, result, error
     FROM job_runs
     WHERE job_name = ANY($1::text[])
       AND status = 'running'
       AND started_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')
     ORDER BY started_at DESC
     LIMIT 1`,
    [names, ACTIVE_RUN_STALE_MS],
  );
  return rowToRun(found.rows[0]);
}

/** @param {number} runId @returns {Promise<Record<string, unknown>|null>} run incl. logs */
async function getJobRun(runId) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const found = await pool.query(`SELECT * FROM job_runs WHERE id = $1`, [runId]);
  return rowToRun(found.rows[0], { includeLogs: true });
}

/**
 * @param {{ jobName: string, limit?: number }} params
 * @returns {Promise<Record<string, unknown>[]>} newest first, without logs
 */
async function listJobRuns({ jobName, limit = 20 }) {
  const pool = getPool();
  if (!pool) {
    return [];
  }
  const capped = Math.max(1, Math.min(100, Number.parseInt(String(limit), 10) || 20));
  const found = await pool.query(
    `SELECT id, job_name, trigger_source, triggered_by, status, started_at, finished_at, result, error
     FROM job_runs
     WHERE job_name = $1
     ORDER BY started_at DESC
     LIMIT $2`,
    [jobName, capped],
  );
  return found.rows.map((row) => rowToRun(row));
}

/**
 * @returns {Promise<Record<string, Record<string, unknown>>>} latest run per job name
 */
async function getLastRunsByJob() {
  const pool = getPool();
  if (!pool) {
    return {};
  }
  const found = await pool.query(
    `SELECT DISTINCT ON (job_name)
       id, job_name, trigger_source, triggered_by, status, started_at, finished_at, result, error
     FROM job_runs
     ORDER BY job_name, started_at DESC`,
  );
  const byJob = {};
  for (const row of found.rows) {
    byJob[row.job_name] = rowToRun(row);
  }
  return byJob;
}

/** Keep only the newest KEEP_RUNS_PER_JOB rows per job. Best-effort. */
async function pruneJobRuns() {
  const pool = getPool();
  if (!pool) {
    return;
  }
  await pool.query(
    `DELETE FROM job_runs
     WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY job_name ORDER BY started_at DESC) AS rn
         FROM job_runs
       ) ranked
       WHERE ranked.rn > $1
     )`,
    [KEEP_RUNS_PER_JOB],
  );
}

/**
 * Start a job as a child `run-job.js` process (fire-and-forget) and return the
 * pre-created run id. Used by the cron Machine's trigger API — and directly by
 * the web process in local dev when no cron Machine is reachable.
 *
 * @param {{ jobName: string, triggerSource: string, triggeredBy?: string|null, payload?: Record<string, unknown> }} params
 * @returns {Promise<{ runId: number|null }>}
 */
async function startJobRunChild({ jobName, triggerSource, triggeredBy = null, payload = null }) {
  const definition = getJobDefinition(jobName);
  if (!definition) {
    const unknown = new Error(`Unknown job: ${jobName}`);
    unknown.statusCode = 400;
    throw unknown;
  }

  let runId = null;
  if (isDatabaseEnabled()) {
    const conflictingNames = getConflictingJobNames(jobName);
    const active = await findActiveJobRunAmong(conflictingNames);
    if (active) {
      const activeLabel = getJobDefinition(String(active.jobName))?.label || active.jobName;
      const busy = new Error(
        active.jobName === jobName
          ? `${definition.label} is already running (started ${active.startedAt}` +
              `${active.triggeredBy ? ` by ${active.triggeredBy}` : ""}).`
          : `${definition.label} cannot start while ${activeLabel} is running ` +
              `(run #${active.id}, started ${active.startedAt}` +
              `${active.triggeredBy ? ` by ${active.triggeredBy}` : ""}).`,
      );
      busy.statusCode = 409;
      throw busy;
    }
    runId = await createJobRun({ jobName, triggerSource, triggeredBy });
  }

  const args = [RUN_JOB_SCRIPT, jobName, "--trigger", triggerSource];
  if (runId != null) {
    args.push("--run-id", String(runId));
  }
  if (triggeredBy) {
    args.push("--triggered-by", triggeredBy);
  }
  if (payload && Object.keys(payload).length > 0) {
    args.push("--payload", JSON.stringify(payload));
  }

  const child = spawn(process.execPath, args, {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (error) => {
    console.error(`[job-runs] could not start ${jobName}:`, error.message);
    failJobRunIfStillRunning(runId, `Could not start job process: ${error.message}`).catch(() => {});
  });
  child.on("exit", (code, signal) => {
    if (code !== 0) {
      // Normally run-job.js finalizes its own row; this covers hard crashes.
      failJobRunIfStillRunning(
        runId,
        `Job process exited unexpectedly (code=${code}, signal=${signal || "none"}).`,
      ).catch(() => {});
    }
  });

  return { runId };
}

module.exports = {
  MAX_LOG_CHARS,
  KEEP_RUNS_PER_JOB,
  truncateLogsText,
  createJobRun,
  finalizeJobRun,
  failJobRunIfStillRunning,
  updateJobRunLogs,
  findActiveJobRun,
  findActiveJobRunAmong,
  getJobRun,
  listJobRuns,
  getLastRunsByJob,
  pruneJobRuns,
  startJobRunChild,
};
