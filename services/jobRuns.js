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
/** Max wall-clock time a cron job may run before API retry budgets expire. */
const JOB_MAX_RUNTIME_MS = 6 * 60 * 60 * 1000;
/** A 'running' row older than this no longer blocks new runs (crashed run). */
const ACTIVE_RUN_STALE_MS = JOB_MAX_RUNTIME_MS;
/** Runs kept per job when pruning. */
const KEEP_RUNS_PER_JOB = 100;

const RUN_JOB_SCRIPT = path.join(__dirname, "..", "scripts", "run-job.js");

/** Live child processes started by startJobRunChild on this Machine, keyed by run id. */
const activeChildrenByRunId = new Map();

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
 * @param {{ exceptRunId?: number|null }} [options]
 * @returns {Promise<Record<string, unknown>|null>} fresh 'running' run for the job
 */
async function findActiveJobRun(jobName, { exceptRunId = null } = {}) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const params = [jobName, ACTIVE_RUN_STALE_MS];
  let exceptClause = "";
  if (exceptRunId != null) {
    exceptClause = " AND id <> $3";
    params.push(exceptRunId);
  }
  const found = await pool.query(
    `SELECT id, job_name, trigger_source, triggered_by, status, started_at, finished_at, result, error
     FROM job_runs
     WHERE job_name = $1
       AND status = 'running'
       AND started_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')${exceptClause}
     ORDER BY started_at DESC
     LIMIT 1`,
    params,
  );
  return rowToRun(found.rows[0]);
}

/**
 * @param {string[]} jobNames
 * @param {{ exceptRunId?: number|null }} [options]
 * @returns {Promise<Record<string, unknown>|null>} freshest 'running' run among the names
 */
async function findActiveJobRunAmong(jobNames, { exceptRunId = null } = {}) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const names = [...new Set((jobNames || []).map((name) => String(name || "").trim()).filter(Boolean))];
  if (names.length === 0) {
    return null;
  }
  if (names.length === 1) {
    return findActiveJobRun(names[0], { exceptRunId });
  }
  const params = [names, ACTIVE_RUN_STALE_MS];
  let exceptClause = "";
  if (exceptRunId != null) {
    exceptClause = " AND id <> $3";
    params.push(exceptRunId);
  }
  const found = await pool.query(
    `SELECT id, job_name, trigger_source, triggered_by, status, started_at, finished_at, result, error
     FROM job_runs
     WHERE job_name = ANY($1::text[])
       AND status = 'running'
       AND started_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')${exceptClause}
     ORDER BY started_at DESC
     LIMIT 1`,
    params,
  );
  return rowToRun(found.rows[0]);
}

/**
 * @param {{ exceptRunId?: number|null }} [options]
 * @returns {{ runId: number }|null}
 */
function findLocalActiveChild({ exceptRunId = null } = {}) {
  for (const [id, child] of activeChildrenByRunId) {
    if (exceptRunId != null && id === exceptRunId) {
      continue;
    }
    if (child.exitCode == null && child.signalCode == null && !child.killed) {
      return { runId: id };
    }
  }
  return null;
}

/**
 * @param {string} jobName
 * @param {Record<string, unknown>} active
 * @returns {string}
 */
function formatActiveJobBusyMessage(jobName, active) {
  const definition = getJobDefinition(jobName);
  const label = definition?.label || jobName;
  const activeLabel = getJobDefinition(String(active.jobName))?.label || active.jobName;
  if (active.jobName === jobName) {
    return (
      `${label} is already running (run #${active.id}, started ${active.startedAt}` +
      `${active.triggeredBy ? ` by ${active.triggeredBy}` : ""}).`
    );
  }
  return (
    `${label} cannot start while ${activeLabel} is running ` +
    `(run #${active.id}, started ${active.startedAt}` +
    `${active.triggeredBy ? ` by ${active.triggeredBy}` : ""}).`
  );
}

/**
 * @param {string} jobName
 * @param {{ exceptRunId?: number|null }} [options]
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function findBlockingJobRun(jobName, { exceptRunId = null } = {}) {
  const local = findLocalActiveChild({ exceptRunId });
  if (local) {
    const run = await getJobRun(local.runId);
    if (run && run.status === "running") {
      return run;
    }
  }
  return findActiveJobRunAmong(getConflictingJobNames(jobName), { exceptRunId });
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
 * Newest non-stale `running` row per job name (may differ from {@link getLastRunsByJob}
 * when a later skipped/failed row was recorded while an earlier run is still active).
 * @returns {Promise<Record<string, Record<string, unknown>>>}
 */
async function getActiveRunsByJob() {
  const pool = getPool();
  if (!pool) {
    return {};
  }
  const found = await pool.query(
    `SELECT DISTINCT ON (job_name)
       id, job_name, trigger_source, triggered_by, status, started_at, finished_at, result, error
     FROM job_runs
     WHERE status = 'running'
       AND started_at > NOW() - ($1::bigint * INTERVAL '1 millisecond')
     ORDER BY job_name, started_at DESC`,
    [ACTIVE_RUN_STALE_MS],
  );
  const byJob = {};
  for (const row of found.rows) {
    byJob[row.job_name] = rowToRun(row);
  }
  return byJob;
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
    const active = await findBlockingJobRun(jobName);
    if (active) {
      const busy = new Error(formatActiveJobBusyMessage(jobName, active));
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
  if (runId != null) {
    activeChildrenByRunId.set(runId, child);
  }
  child.on("error", (error) => {
    console.error(`[job-runs] could not start ${jobName}:`, error.message);
    if (runId != null) {
      activeChildrenByRunId.delete(runId);
    }
    failJobRunIfStillRunning(runId, `Could not start job process: ${error.message}`).catch(() => {});
  });
  child.on("exit", (code, signal) => {
    if (runId != null) {
      activeChildrenByRunId.delete(runId);
    }
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

/**
 * Stop a running job: SIGTERM the child when it was spawned on this Machine,
 * and mark the job_runs row failed so it no longer blocks new runs. Works for
 * zombie rows too (process already dead) — those only need the DB update.
 *
 * @param {number} runId
 * @param {{ reason?: string }} [options]
 * @returns {Promise<{ run: Record<string, unknown>, killedProcess: boolean }>}
 */
async function cancelJobRun(runId, { reason = "Cancelled by admin." } = {}) {
  const id = Number(runId);
  if (!Number.isFinite(id) || id <= 0) {
    const bad = new Error("runId is required.");
    bad.statusCode = 400;
    throw bad;
  }

  const run = await getJobRun(id);
  if (!run) {
    const missing = new Error("Run not found.");
    missing.statusCode = 404;
    throw missing;
  }
  if (run.status !== "running") {
    const done = new Error(`Run #${id} is already ${run.status}.`);
    done.statusCode = 409;
    throw done;
  }

  // Clear the DB lock first so a concurrent "Run now" is unblocked even if
  // the process is already dead or ignores signals. run-job's SIGTERM handler
  // uses failJobRunIfStillRunning, so it won't overwrite this reason.
  await failJobRunIfStillRunning(id, reason);

  const child = activeChildrenByRunId.get(id);
  let killedProcess = false;
  if (child && !child.killed) {
    try {
      killedProcess = Boolean(child.kill("SIGTERM"));
    } catch (error) {
      console.warn(`[job-runs] could not SIGTERM run #${id}:`, error.message);
    }
    // Escalate if the process ignores SIGTERM (hung I/O, etc.).
    const escalate = setTimeout(() => {
      if (!child.killed && child.exitCode == null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 5000);
    escalate.unref?.();
  }

  const updated = (await getJobRun(id)) || { ...run, status: "failed", error: reason };
  return { run: updated, killedProcess };
}

module.exports = {
  MAX_LOG_CHARS,
  KEEP_RUNS_PER_JOB,
  JOB_MAX_RUNTIME_MS,
  ACTIVE_RUN_STALE_MS,
  truncateLogsText,
  createJobRun,
  finalizeJobRun,
  failJobRunIfStillRunning,
  updateJobRunLogs,
  findActiveJobRun,
  findActiveJobRunAmong,
  findBlockingJobRun,
  formatActiveJobBusyMessage,
  getJobRun,
  listJobRuns,
  getLastRunsByJob,
  getActiveRunsByJob,
  pruneJobRuns,
  startJobRunChild,
  cancelJobRun,
};
