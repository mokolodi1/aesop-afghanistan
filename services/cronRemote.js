/**
 * Reach the `cron` process group Machine over Fly private networking (6PN).
 *
 * The cron Machine (scripts/cron-server.js) exposes a small HTTP API so the
 * web app's admin Jobs tab can start sync jobs on that Machine (more memory,
 * and one place where all runs are recorded) instead of on a web Machine.
 * Triggers are asynchronous: they return a job_runs id immediately and the
 * UI follows progress/logs through the job_runs table.
 *
 * Base URL resolution:
 *   1. CRON_TRIGGER_URL (explicit, e.g. http://localhost:3100 in dev)
 *   2. http://cron.process.<FLY_APP_NAME>.internal:<port> when running on Fly
 *   3. null — caller spawns the job locally instead (local dev).
 */
const { startJobRunChild, cancelJobRun } = require("./jobRuns");

const DEFAULT_CRON_TRIGGER_PORT = 3100;
const DEFAULT_CRON_TRIGGER_TIMEOUT_MS = 30 * 1000;

function getCronTriggerPort() {
  const raw = process.env.CRON_TRIGGER_PORT;
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CRON_TRIGGER_PORT;
}

function getCronTriggerTimeoutMs() {
  const raw = process.env.CRON_TRIGGER_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CRON_TRIGGER_TIMEOUT_MS;
}

/** @returns {string|null} */
function getCronTriggerBaseUrl() {
  const explicit = process.env.CRON_TRIGGER_URL;
  if (explicit != null && explicit.trim() !== "") {
    return explicit.trim().replace(/\/+$/, "");
  }
  // Already on the cron Machine — start jobs directly, never loop back.
  if (process.env.FLY_PROCESS_GROUP === "cron") {
    return null;
  }
  const appName = process.env.FLY_APP_NAME;
  if (!appName) {
    return null;
  }
  return `http://cron.process.${appName}.internal:${getCronTriggerPort()}`;
}

/**
 * Start a job on the cron Machine, falling back to spawning it locally when
 * the Machine can't be reached (local dev, cron group not deployed). Job
 * rejections (unknown job, already running) propagate with statusCode.
 *
 * @param {string} jobName job name from services/jobRegistry.js
 * @param {Record<string, unknown>|null} payload
 * @param {{ triggeredBy?: string|null }} [meta]
 * @returns {Promise<{ runId: number|null, ranOn: "cron-machine"|"web-machine" }>}
 */
async function triggerCronJob(jobName, payload = null, meta = {}) {
  const baseUrl = getCronTriggerBaseUrl();
  if (baseUrl) {
    let response;
    try {
      response = await fetch(`${baseUrl}/jobs/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: jobName, payload, triggeredBy: meta.triggeredBy || null }),
        signal: AbortSignal.timeout(getCronTriggerTimeoutMs()),
      });
    } catch (error) {
      response = null;
      console.warn(
        `[cron-remote] cron Machine unreachable (${error?.cause?.code || error?.name || error?.message}); ` +
          `starting ${jobName} on this machine instead.`,
      );
    }
    if (response) {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) {
        const jobError = new Error(
          (data && data.error) || `Could not start ${jobName} (HTTP ${response.status}).`,
        );
        jobError.statusCode = response.status >= 400 ? response.status : 500;
        throw jobError;
      }
      return { runId: data.runId ?? null, ranOn: "cron-machine" };
    }
  }

  const { runId } = await startJobRunChild({
    jobName,
    triggerSource: "admin",
    triggeredBy: meta.triggeredBy || null,
    payload,
  });
  return { runId, ranOn: "web-machine" };
}

/**
 * Cancel a running job on the cron Machine (SIGTERM + clear job_runs lock).
 * Falls back to local cancel when the Machine can't be reached — that still
 * clears the DB lock even if the child process lives elsewhere.
 *
 * @param {number} runId
 * @param {{ reason?: string }} [options]
 * @returns {Promise<{ run: Record<string, unknown>, killedProcess: boolean, ranOn: "cron-machine"|"web-machine" }>}
 */
async function cancelCronJob(runId, { reason = "Cancelled by admin." } = {}) {
  const baseUrl = getCronTriggerBaseUrl();
  if (baseUrl) {
    let response;
    try {
      response = await fetch(`${baseUrl}/jobs/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, reason }),
        signal: AbortSignal.timeout(getCronTriggerTimeoutMs()),
      });
    } catch (error) {
      response = null;
      console.warn(
        `[cron-remote] cron Machine unreachable for cancel (${error?.cause?.code || error?.name || error?.message}); ` +
          `clearing run #${runId} on this machine instead.`,
      );
    }
    if (response) {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) {
        const jobError = new Error(
          (data && data.error) || `Could not cancel run #${runId} (HTTP ${response.status}).`,
        );
        jobError.statusCode = response.status >= 400 ? response.status : 500;
        throw jobError;
      }
      return {
        run: data.run,
        killedProcess: Boolean(data.killedProcess),
        ranOn: "cron-machine",
      };
    }
  }

  const result = await cancelJobRun(runId, { reason });
  return { ...result, ranOn: "web-machine" };
}

module.exports = {
  DEFAULT_CRON_TRIGGER_PORT,
  getCronTriggerPort,
  getCronTriggerBaseUrl,
  triggerCronJob,
  cancelCronJob,
};
