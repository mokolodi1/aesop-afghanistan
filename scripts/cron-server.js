#!/usr/bin/env node
/**
 * Entrypoint for the Fly `cron` process group Machine (see fly.toml).
 *
 * Runs two things:
 *   1. Supercronic with the repo crontab — the scheduled syncs, each wrapped
 *      by scripts/run-job.js so every run lands in the job_runs table.
 *   2. A small HTTP API on the Fly private network (6PN) so the web app's
 *      admin Jobs tab can trigger the same jobs on demand on this Machine.
 *      Not reachable from the public internet: the cron group has no Fly
 *      services, and we bind to the 6PN address.
 *
 * Endpoints (see services/cronRemote.js for the client):
 *   GET  /health
 *   POST /jobs/run  { job, payload?, triggeredBy? } → 202 { success, runId }
 *
 * Triggers return immediately; progress and logs are read from job_runs.
 */
require("../config/secrets");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { getCronTriggerPort } = require("../services/cronRemote");
const { listJobDefinitions } = require("../services/jobRegistry");
const { startJobRunChild } = require("../services/jobRuns");

const CRONTAB_PATH = process.env.CRONTAB_PATH || path.join(__dirname, "..", "crontab");
// On Fly, fly-local-6pn maps to the Machine's private IPv6 address.
const BIND_HOST =
  process.env.CRON_TRIGGER_BIND || (process.env.FLY_APP_NAME ? "fly-local-6pn" : "127.0.0.1");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, jobs: listJobDefinitions().map((job) => job.name) });
    return;
  }

  if (req.method !== "POST" || req.url !== "/jobs/run") {
    sendJson(res, 404, { success: false, error: "Unknown endpoint." });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { success: false, error: error.message });
    return;
  }

  const jobName = typeof body.job === "string" ? body.job.trim() : "";
  try {
    const { runId } = await startJobRunChild({
      jobName,
      triggerSource: "admin",
      triggeredBy: typeof body.triggeredBy === "string" ? body.triggeredBy : null,
      payload: body.payload && typeof body.payload === "object" ? body.payload : null,
    });
    console.log(
      `[cron-server] triggered ${jobName} (run ${runId ?? "unrecorded"})` +
        `${body.triggeredBy ? ` for ${body.triggeredBy}` : ""}`,
    );
    sendJson(res, 202, { success: true, runId });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      success: false,
      error: error.message || "Could not start job.",
    });
  }
});

server.listen(getCronTriggerPort(), BIND_HOST, () => {
  console.log(`[cron-server] trigger API listening on ${BIND_HOST}:${getCronTriggerPort()}`);
});

const supercronic = spawn("supercronic", [CRONTAB_PATH], { stdio: "inherit" });

supercronic.on("error", (error) => {
  console.error(`[cron-server] could not start supercronic: ${error.message}`);
  process.exit(1);
});

supercronic.on("exit", (code, signal) => {
  console.error(`[cron-server] supercronic exited (code=${code}, signal=${signal}); shutting down.`);
  // Let Fly restart the Machine so the schedule never silently stops.
  process.exit(code == null ? 1 : code);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    supercronic.kill(signal);
    server.close(() => process.exit(0));
  });
}
