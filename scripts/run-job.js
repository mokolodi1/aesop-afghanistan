#!/usr/bin/env node
/**
 * Run a sync job from services/jobRegistry.js with a job_runs record and
 * captured console logs. Every scheduled and admin-triggered sync goes
 * through this wrapper so the Jobs tab has a complete history.
 *
 * Usage:
 *   node scripts/run-job.js <job-name> [--trigger schedule|admin]
 *     [--run-id <id>] [--triggered-by <email>] [--payload <json>]
 *
 * - Scheduled (crontab): no --run-id; creates its own job_runs row. If another
 *   run of the same job is active, records a 'skipped' row and exits 0.
 * - Admin-triggered: the trigger API pre-creates the row (after the same
 *   already-running check) and passes --run-id.
 */
require("../config/secrets");
const util = require("util");
const { formatErrorForLog } = require("../utils/errorLogging");
const { setDriveScriptRateLimit } = require("../services/googleDrive");
const { isDatabaseEnabled, closeDatabase } = require("../db/index");
const { getJobDefinition } = require("../services/jobRegistry");
const {
  createJobRun,
  finalizeJobRun,
  updateJobRunLogs,
  findActiveJobRun,
  pruneJobRuns,
} = require("../services/jobRuns");

const LOG_FLUSH_INTERVAL_MS = 5000;

function parseArgs(argv) {
  const args = { jobName: argv[0] || "", trigger: "schedule", runId: null, triggeredBy: null, payload: {} };
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--trigger" && value) {
      args.trigger = value === "admin" ? "admin" : "schedule";
    } else if (flag === "--run-id" && value) {
      args.runId = Number.parseInt(value, 10);
    } else if (flag === "--triggered-by" && value) {
      args.triggeredBy = value;
    } else if (flag === "--payload" && value) {
      try {
        args.payload = JSON.parse(value);
      } catch {
        console.warn(`[run-job] ignoring invalid --payload JSON`);
      }
    }
  }
  return args;
}

/**
 * Tee console output: keep printing to stdout/stderr (visible in fly logs)
 * while collecting timestamped lines for the job_runs row.
 */
function captureConsole() {
  const lines = [];
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const wrap = (level) => {
    return (...args) => {
      const text = util.format(...args);
      lines.push(`${new Date().toISOString()} [${level}] ${text}`);
      original[level](...args);
    };
  };
  console.log = wrap("log");
  console.info = wrap("info");
  console.warn = wrap("warn");
  console.error = wrap("error");
  return {
    getText: () => lines.join("\n"),
    restore: () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

async function main() {
  setDriveScriptRateLimit(true);
  const { jobName, trigger, runId: presetRunId, triggeredBy, payload } = parseArgs(process.argv.slice(2));
  const definition = getJobDefinition(jobName);
  if (!definition) {
    console.error(`[run-job] unknown job "${jobName}". See services/jobRegistry.js.`);
    process.exit(1);
  }

  const recording = isDatabaseEnabled();
  let runId = presetRunId;

  if (recording && runId == null) {
    const active = await findActiveJobRun(jobName);
    if (active) {
      const skipMessage =
        `Skipped: ${definition.label} is already running ` +
        `(run #${active.id}, started ${active.startedAt}` +
        `${active.triggeredBy ? ` by ${active.triggeredBy}` : ""}).`;
      console.warn(`[run-job] ${skipMessage}`);
      const skippedId = await createJobRun({ jobName, triggerSource: trigger, triggeredBy });
      await finalizeJobRun(skippedId, { status: "skipped", error: skipMessage, logs: skipMessage });
      return 0;
    }
    runId = await createJobRun({ jobName, triggerSource: trigger, triggeredBy });
  }
  if (!recording) {
    console.warn("[run-job] DATABASE_URL not set; running without a job_runs record.");
  }

  const capture = captureConsole();
  let flusher = null;
  if (recording && runId != null) {
    flusher = setInterval(() => {
      updateJobRunLogs(runId, capture.getText()).catch(() => {});
    }, LOG_FLUSH_INTERVAL_MS);
    flusher.unref();
  }

  // Finalize the row before the process dies on deploys/machine stops.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      console.error(`[run-job] received ${signal}; marking run as failed.`);
      const done = recording
        ? finalizeJobRun(runId, {
            status: "failed",
            error: `Interrupted by ${signal} (deploy or machine stop).`,
            logs: capture.getText(),
          })
        : Promise.resolve();
      done.catch(() => {}).finally(() => process.exit(1));
    });
  }

  console.log(
    `[run-job] ${jobName} started (trigger=${trigger}${triggeredBy ? `, by ${triggeredBy}` : ""}` +
      `${runId != null ? `, run #${runId}` : ""})`,
  );
  const startedMs = Date.now();
  try {
    const result = await definition.run(payload);
    console.log(`[run-job] ${jobName} succeeded in ${Math.round((Date.now() - startedMs) / 1000)}s.`);
    if (flusher) {
      clearInterval(flusher);
    }
    await finalizeJobRun(runId, { status: "succeeded", result, logs: capture.getText() });
    await pruneJobRuns().catch(() => {});
    return 0;
  } catch (error) {
    console.error(`[run-job] ${jobName} failed:`, formatErrorForLog(error));
    if (flusher) {
      clearInterval(flusher);
    }
    await finalizeJobRun(runId, {
      status: "failed",
      error: error?.message || String(error),
      logs: capture.getText(),
    });
    return 1;
  } finally {
    capture.restore();
  }
}

main()
  .then(async (code) => {
    await closeDatabase();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[run-job] fatal:", formatErrorForLog(error));
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
