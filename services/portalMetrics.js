const { getPool, isDatabaseEnabled } = require("../db/index");
const { getClientIpContext } = require("../utils/clientIp");

const BUCKET_SECONDS = 10;
const FLUSH_INTERVAL_MS = 5_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_ERROR_LIMIT = 1000;

/** @type {Array<{ id: string, at: string, method: string, path: string, statusCode: number, statusClass: string, pageType: string, latencyMs: number, instance?: string }>} */
const recentErrors = [];
let recentErrorSeq = 0;

const WINDOW_MS = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

const PAGE_TYPES = ["login", "verify", "profile", "ding", "admin", "reviewer", "other"];

const INCIDENT_SERIES_KEYS = [
  "magicLinkRequest",
  "magicLinkUnknownId",
  "magicLinkSendFailed",
  "verifySuccess",
  "verifyExpired",
  "verifyError",
  "rateLimitHits",
  "portalClassGradeFail",
  "sheetsApiError",
  "sheetsApiThrottle",
  "driveApiThrottle",
];

/** Page types excluded from user-facing HTTP error-rate totals (expected or login-specific noise). */
const USER_FACING_ERROR_PAGE_TYPES = PAGE_TYPES.filter((pageType) => pageType !== "verify");

/** @type {Map<string, number>} */
const localBuckets = new Map();

let flushTimer = null;
let flushInFlight = false;
/** @type {Promise<void>|null} */
let flushPromise = null;
let started = false;

/**
 * @param {number} [nowMs]
 * @returns {Date}
 */
function floorBucketStart(nowMs = Date.now()) {
  const ms = Math.floor(nowMs / (BUCKET_SECONDS * 1000)) * BUCKET_SECONDS * 1000;
  return new Date(ms);
}

/**
 * @param {Record<string, string|number|boolean|null|undefined>} [labels]
 * @returns {string}
 */
function stableLabelsJson(labels = {}) {
  const keys = Object.keys(labels)
    .filter((key) => labels[key] != null && labels[key] !== "")
    .sort();
  /** @type {Record<string, string>} */
  const normalized = {};
  for (const key of keys) {
    normalized[key] = String(labels[key]);
  }
  return JSON.stringify(normalized);
}

/**
 * @param {string} metric
 * @param {number} amount
 * @param {Record<string, string|number|boolean|null|undefined>} [labels]
 * @param {number} [nowMs]
 */
function recordMetric(metric, amount = 1, labels = {}, nowMs = Date.now()) {
  if (!metric || !Number.isFinite(amount) || amount === 0) {
    return;
  }
  const bucketStart = floorBucketStart(nowMs);
  const labelsJson = stableLabelsJson(labels);
  const key = `${bucketStart.toISOString()}\0${metric}\0${labelsJson}`;
  localBuckets.set(key, (localBuckets.get(key) || 0) + amount);
}

/**
 * @param {string} pageType
 * @param {number} statusCode
 * @param {number} latencyMs
 */
/**
 * @param {number} statusCode
 * @returns {"2xx"|"3xx"|"4xx"|"5xx"}
 */
function statusClassForCode(statusCode) {
  if (statusCode >= 500) {
    return "5xx";
  }
  if (statusCode >= 400) {
    return "4xx";
  }
  if (statusCode >= 300) {
    return "3xx";
  }
  return "2xx";
}

/**
 * @param {{ at: string, method: string, path: string, statusCode: number, pageType: string, latencyMs: number }} entry
 */
function recordRecentError(entry) {
  recentErrorSeq += 1;
  const instance = process.env.FLY_MACHINE_ID || "local";
  recentErrors.push({
    id: `${instance}:${recentErrorSeq}`,
    statusClass: statusClassForCode(entry.statusCode),
    instance,
    ...entry,
  });
  if (recentErrors.length > RECENT_ERROR_LIMIT) {
    recentErrors.splice(0, recentErrors.length - RECENT_ERROR_LIMIT);
  }
}

/**
 * @returns {Array<{ id: string, at: string, method: string, path: string, statusCode: number, statusClass: string, pageType: string, latencyMs: number, instance?: string }>}
 */
function getRecentErrors() {
  return recentErrors.slice().reverse();
}

function isRequestLogEnabled() {
  const value = String(process.env.REQUEST_LOG || "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function recordPageServe(pageType, statusCode, latencyMs) {
  const type = PAGE_TYPES.includes(pageType) ? pageType : "other";
  const statusClass = statusClassForCode(statusCode);
  recordMetric("page.serve", 1, { pageType: type, statusClass });
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    recordMetric("page.latency_ms", latencyMs, { pageType: type, kind: "sum" });
    recordMetric("page.latency_ms", 1, { pageType: type, kind: "count" });
  }
}

function recordLoginSuccess() {
  recordMetric("login.success", 1);
  recordMetric("verify.success", 1);
}

function recordLoginFailed() {
  recordMetric("login.failed", 1);
  recordMetric("verify.expired", 1);
}

function recordVerifyError(count = 1) {
  recordMetric("verify.error", count);
}

function recordMagicLinkRequest(count = 1) {
  recordMetric("magic_link.request", count);
}

function recordMagicLinkUnknownId(count = 1) {
  recordMetric("magic_link.unknown_id", count);
}

function recordMagicLinkSendFailed(count = 1) {
  recordMetric("magic_link.send_failed", count);
}

function recordRateLimitHit(route = "unknown") {
  recordMetric("rate_limit.hit", 1, { route: String(route || "unknown") });
}

function recordPortalClassGradeFail(count = 1) {
  recordMetric("portal_class_grade.fail", count);
}

function recordDriveFilesList(count = 1) {
  recordMetric("drive.files_list", count);
}

function recordDriveFilesGet(count = 1) {
  recordMetric("drive.files_get", count);
}

function recordSheetsApiCall(count = 1) {
  recordMetric("sheets.api", count);
}

function recordSheetsApiError(count = 1) {
  recordMetric("sheets.api_error", count);
}

function recordSheetsApiThrottle(count = 1) {
  recordMetric("sheets.api_throttle", count);
}

function recordDriveApiThrottle(count = 1) {
  recordMetric("drive.api_throttle", count);
}

/**
 * @param {string} pathname
 * @param {{ isPortalHost?: boolean }} [options]
 * @returns {string}
 */
function classifyPageType(pathname, options = {}) {
  const path = String(pathname || "").split("?")[0] || "/";
  const lower = path.toLowerCase();

  if (
    lower === "/api/verify-magic-link" ||
    lower === "/verify.html" ||
    lower.startsWith("/verify.html/")
  ) {
    return "verify";
  }

  if (
    lower === "/api/request-magic-link" ||
    lower === "/api/resend-magic-link" ||
    lower === "/index.html"
  ) {
    return "login";
  }

  if (
    lower === "/admin" ||
    lower.startsWith("/admin/") ||
    lower.startsWith("/api/portal-admin/")
  ) {
    return "admin";
  }

  if (lower === "/reviews" || lower.startsWith("/reviews/") || lower.startsWith("/api/portal-reviews/")) {
    return "reviewer";
  }

  if (
    lower === "/profile" ||
    lower.startsWith("/profile/") ||
    lower === "/api/update-ding-number" ||
    lower === "/api/portal-ding-history" ||
    lower === "/api/portal-request-ding-help"
  ) {
    return "ding";
  }

  if (
    lower.startsWith("/api/portal-") ||
    lower === "/portal.html" ||
    lower === "/faq" ||
    lower.startsWith("/faq/")
  ) {
    return "profile";
  }

  if (lower === "/") {
    return options.isPortalHost ? "profile" : "login";
  }

  return "other";
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
function shouldSkipPath(pathname) {
  const path = String(pathname || "").split("?")[0].toLowerCase();
  if (
    path.endsWith(".js") ||
    path.endsWith(".css") ||
    path.endsWith(".map") ||
    path.endsWith(".ico") ||
    path.endsWith(".png") ||
    path.endsWith(".jpg") ||
    path.endsWith(".jpeg") ||
    path.endsWith(".gif") ||
    path.endsWith(".webp") ||
    path.endsWith(".svg") ||
    path.endsWith(".woff") ||
    path.endsWith(".woff2") ||
    path.endsWith(".ttf")
  ) {
    return true;
  }
  if (path === "/health" || path === "/api/health") {
    return true;
  }
  return false;
}

/**
 * Express middleware: record page serve counts and latency.
 * @param {{ isPortalHost?: (req: import('express').Request) => boolean }} [options]
 */
function createPortalMetricsMiddleware(options = {}) {
  return function portalMetricsMiddleware(req, res, next) {
    if (shouldSkipPath(req.path)) {
      return next();
    }
    const startedAt = Date.now();
    const isPortalHost =
      typeof options.isPortalHost === "function" ? Boolean(options.isPortalHost(req)) : false;
    const pageType = classifyPageType(req.path, { isPortalHost });

    res.on("finish", () => {
      const statusCode = res.statusCode || 200;
      const latencyMs = Date.now() - startedAt;
      recordPageServe(pageType, statusCode, latencyMs);
      if (statusCode >= 400) {
        recordRecentError({
          at: new Date().toISOString(),
          method: req.method,
          path: req.path,
          statusCode,
          pageType,
          latencyMs,
        });
      }
    });
    next();
  };
}

/**
 * Log each request as a JSON line to stdout when REQUEST_LOG=true.
 * View with: flyctl logs -a aesop-afghanistan
 */
function createRequestLogMiddleware() {
  return function requestLogMiddleware(req, res, next) {
    if (!isRequestLogEnabled() || shouldSkipPath(req.path)) {
      return next();
    }
    const startedAt = Date.now();
    const pageType = classifyPageType(req.path);

    res.on("finish", () => {
      const statusCode = res.statusCode || 200;
      console.log(
        JSON.stringify({
          type: "access",
          at: new Date().toISOString(),
          method: req.method,
          path: req.path,
          status: statusCode,
          pageType,
          ms: Date.now() - startedAt,
          ...getClientIpContext(req),
          instance: process.env.FLY_MACHINE_ID || undefined,
        }),
      );
    });
    next();
  };
}

/**
 * @returns {Array<{ bucketStart: Date, metric: string, labels: Record<string, string>, value: number }>}
 */
function drainLocalBuckets() {
  if (localBuckets.size === 0) {
    return [];
  }
  const rows = [];
  for (const [key, value] of localBuckets.entries()) {
    const [iso, metric, labelsJson] = key.split("\0");
    rows.push({
      bucketStart: new Date(iso),
      metric,
      labels: JSON.parse(labelsJson || "{}"),
      value,
    });
  }
  localBuckets.clear();
  return rows;
}

/**
 * Snapshot local buckets without clearing (for DB-less query merge).
 * @returns {Array<{ bucketStart: Date, metric: string, labels: Record<string, string>, value: number }>}
 */
function snapshotLocalBuckets() {
  const rows = [];
  for (const [key, value] of localBuckets.entries()) {
    const [iso, metric, labelsJson] = key.split("\0");
    rows.push({
      bucketStart: new Date(iso),
      metric,
      labels: JSON.parse(labelsJson || "{}"),
      value,
    });
  }
  return rows;
}

async function flushMetricsToDatabase() {
  if (flushPromise) {
    return flushPromise;
  }
  if (!isDatabaseEnabled()) {
    return;
  }

  flushPromise = (async () => {
    const rows = drainLocalBuckets();
    if (rows.length === 0) {
      return;
    }

    flushInFlight = true;
    const pool = getPool();
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const row of rows) {
          await client.query(
            `INSERT INTO portal_metric_buckets (bucket_start, metric, labels, value)
             VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (bucket_start, metric, labels)
             DO UPDATE SET value = portal_metric_buckets.value + EXCLUDED.value`,
            [row.bucketStart.toISOString(), row.metric, JSON.stringify(row.labels), row.value],
          );
        }
        await client.query(`DELETE FROM portal_metric_buckets WHERE bucket_start < $1`, [
          new Date(Date.now() - RETENTION_MS).toISOString(),
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      // Put rows back so a transient DB blip does not drop metrics.
      for (const row of rows) {
        recordMetric(row.metric, row.value, row.labels, row.bucketStart.getTime());
      }
      console.warn("[portal-metrics] flush failed:", error.message || error);
    } finally {
      flushInFlight = false;
    }
  })().finally(() => {
    flushPromise = null;
  });

  return flushPromise;
}

function startPortalMetricsFlusher() {
  if (started) {
    return;
  }
  started = true;
  flushTimer = setInterval(() => {
    flushMetricsToDatabase().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === "function") {
    flushTimer.unref();
  }
}

/**
 * @param {string} windowKey
 * @returns {number}
 */
function resolveWindowMs(windowKey) {
  return WINDOW_MS[windowKey] || WINDOW_MS["5m"];
}

/**
 * Coarser buckets for long dashboard windows keep chart point counts reasonable.
 * @param {number} windowMs
 * @returns {number}
 */
function resolveChartBucketSeconds(windowMs) {
  if (windowMs <= 60 * 60_000) {
    return BUCKET_SECONDS;
  }
  if (windowMs <= 6 * 60 * 60_000) {
    return 60;
  }
  if (windowMs <= 24 * 60 * 60_000) {
    return 5 * 60;
  }
  if (windowMs <= 3 * 24 * 60 * 60_000) {
    return 15 * 60;
  }
  return 60 * 60;
}

/**
 * @param {number} nowMs
 * @param {number} bucketSeconds
 * @returns {Date}
 */
function floorBucketStartForSeconds(nowMs, bucketSeconds) {
  const ms = Math.floor(nowMs / (bucketSeconds * 1000)) * bucketSeconds * 1000;
  return new Date(ms);
}

/**
 * @param {Date} from
 * @param {Date} to
 * @param {number} [bucketSeconds]
 * @returns {Date[]}
 */
function buildBucketTimeline(from, to, bucketSeconds = BUCKET_SECONDS) {
  const start = floorBucketStartForSeconds(from.getTime(), bucketSeconds);
  const end = floorBucketStartForSeconds(to.getTime(), bucketSeconds);
  const points = [];
  for (let t = start.getTime(); t <= end.getTime(); t += bucketSeconds * 1000) {
    points.push(new Date(t));
  }
  return points;
}

/**
 * @param {Array<{ bucket_start: Date|string, metric: string, labels: any, value: number|string }>} rows
 * @returns {Array<{ bucketStart: Date, metric: string, labels: Record<string, string>, value: number }>}
 */
function normalizeDbRows(rows) {
  return (rows || []).map((row) => {
    const labels =
      row.labels && typeof row.labels === "object" && !Array.isArray(row.labels)
        ? Object.fromEntries(Object.entries(row.labels).map(([k, v]) => [k, String(v)]))
        : {};
    return {
      bucketStart: row.bucket_start instanceof Date ? row.bucket_start : new Date(row.bucket_start),
      metric: String(row.metric),
      labels,
      value: Number(row.value) || 0,
    };
  });
}

/**
 * @param {Array<{ bucketStart: Date, metric: string, labels: Record<string, string>, value: number }>} rows
 * @param {string} metric
 * @param {(labels: Record<string, string>) => boolean} [labelFilter]
 * @param {number} [displayBucketSeconds]
 * @returns {Map<string, number>}
 */
function seriesMapForMetric(rows, metric, labelFilter, displayBucketSeconds = BUCKET_SECONDS) {
  /** @type {Map<string, number>} */
  const map = new Map();
  const bucketMs = displayBucketSeconds * 1000;
  const aggregate = displayBucketSeconds > BUCKET_SECONDS;
  for (const row of rows) {
    if (row.metric !== metric) {
      continue;
    }
    if (labelFilter && !labelFilter(row.labels)) {
      continue;
    }
    const key = aggregate
      ? floorBucketStartForSeconds(row.bucketStart.getTime(), displayBucketSeconds).toISOString()
      : row.bucketStart.toISOString();
    map.set(key, (map.get(key) || 0) + row.value);
  }
  return map;
}

/**
 * @param {Date[]} timeline
 * @param {Map<string, number>} valueMap
 * @returns {Array<{ t: string, v: number }>}
 */
function mapToSeries(timeline, valueMap) {
  return timeline.map((bucket) => {
    const key = bucket.toISOString();
    return { t: key, v: valueMap.get(key) || 0 };
  });
}

/**
 * @param {string} [windowKey]
 * @returns {Promise<object>}
 */
async function getPortalStats(windowKey = "5m") {
  const resolvedWindow = WINDOW_MS[windowKey] ? windowKey : "5m";
  const windowMs = resolveWindowMs(resolvedWindow);
  const chartBucketSeconds = resolveChartBucketSeconds(windowMs);
  const now = new Date();
  const from = new Date(now.getTime() - windowMs);
  const timeline = buildBucketTimeline(from, now, chartBucketSeconds);

  /** @type {Array<{ bucketStart: Date, metric: string, labels: Record<string, string>, value: number }>} */
  let rows = [];

  if (isDatabaseEnabled()) {
    // Flush first so the query does not double-count in-memory + already-persisted values.
    await flushMetricsToDatabase();
    // Capture anything recorded during the flush round-trip.
    const localAfterFlush = snapshotLocalBuckets().filter(
      (row) => row.bucketStart.getTime() >= from.getTime() && row.bucketStart.getTime() <= now.getTime(),
    );
    try {
      const pool = getPool();
      const result =
        chartBucketSeconds > BUCKET_SECONDS
          ? await pool.query(
              `SELECT
                 to_timestamp(
                   floor(extract(epoch from bucket_start) / $2::double precision) * $2::double precision
                 ) AS bucket_start,
                 metric,
                 labels,
                 SUM(value) AS value
               FROM portal_metric_buckets
               WHERE bucket_start >= $1
               GROUP BY 1, 2, 3
               ORDER BY 1 ASC`,
              [from.toISOString(), chartBucketSeconds],
            )
          : await pool.query(
              `SELECT bucket_start, metric, labels, value
               FROM portal_metric_buckets
               WHERE bucket_start >= $1
               ORDER BY bucket_start ASC`,
              [from.toISOString()],
            );
      rows = [...normalizeDbRows(result.rows), ...localAfterFlush];
    } catch (error) {
      console.warn("[portal-metrics] query failed:", error.message || error);
      rows = localAfterFlush;
    }
  } else {
    rows = snapshotLocalBuckets().filter(
      (row) => row.bucketStart.getTime() >= from.getTime() && row.bucketStart.getTime() <= now.getTime(),
    );
  }

  // Merge duplicate keys (e.g. overlapping query rows).
  /** @type {Map<string, { bucketStart: Date, metric: string, labels: Record<string, string>, value: number }>} */
  const merged = new Map();
  for (const row of rows) {
    const key = `${row.bucketStart.toISOString()}\0${row.metric}\0${stableLabelsJson(row.labels)}`;
    const existing = merged.get(key);
    if (existing) {
      existing.value += row.value;
    } else {
      merged.set(key, { ...row, labels: { ...row.labels } });
    }
  }
  const allRows = [...merged.values()];

  const loginSuccessMap = seriesMapForMetric(allRows, "login.success", undefined, chartBucketSeconds);
  const loginFailedMap = seriesMapForMetric(allRows, "login.failed", undefined, chartBucketSeconds);
  const loginSuccessSeries = mapToSeries(timeline, loginSuccessMap);
  const loginFailedSeries = mapToSeries(timeline, loginFailedMap);

  /** @type {Record<string, { success: number, error: number, errorRate: number, avgLatencyMs: number|null, serveSeries: Array<{t:string,v:number}>, latencySeries: Array<{t:string,v:number|null}> }>} */
  const byType = {};
  /** @type {Record<string, Array<{ t: string, v: number }>>} */
  const serveSeries = {};
  /** @type {Record<string, Array<{ t: string, v: number|null }>>} */
  const latencySeries = {};

  for (const pageType of PAGE_TYPES) {
    const successMap = seriesMapForMetric(
      allRows,
      "page.serve",
      (labels) => labels.pageType === pageType && labels.statusClass === "2xx",
      chartBucketSeconds,
    );
    const error4xxMap = seriesMapForMetric(
      allRows,
      "page.serve",
      (labels) => labels.pageType === pageType && labels.statusClass === "4xx",
      chartBucketSeconds,
    );
    const error5xxMap = seriesMapForMetric(
      allRows,
      "page.serve",
      (labels) => labels.pageType === pageType && labels.statusClass === "5xx",
      chartBucketSeconds,
    );
    const latencySumMap = seriesMapForMetric(
      allRows,
      "page.latency_ms",
      (labels) => labels.pageType === pageType && labels.kind === "sum",
      chartBucketSeconds,
    );
    const latencyCountMap = seriesMapForMetric(
      allRows,
      "page.latency_ms",
      (labels) => labels.pageType === pageType && labels.kind === "count",
      chartBucketSeconds,
    );

    let success = 0;
    let error = 0;
    let latencySum = 0;
    let latencyCount = 0;
    for (const v of successMap.values()) success += v;
    for (const v of error4xxMap.values()) error += v;
    for (const v of error5xxMap.values()) error += v;
    for (const v of latencySumMap.values()) latencySum += v;
    for (const v of latencyCountMap.values()) latencyCount += v;

    const total = success + error;
    const pageServeSeries = mapToSeries(timeline, successMap);
    const pageLatencySeries = timeline.map((bucket) => {
      const key = bucket.toISOString();
      const count = latencyCountMap.get(key) || 0;
      const sum = latencySumMap.get(key) || 0;
      return { t: key, v: count > 0 ? Math.round(sum / count) : null };
    });

    byType[pageType] = {
      success,
      error,
      errorRate: total > 0 ? error / total : 0,
      avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    };
    serveSeries[pageType] = pageServeSeries;
    latencySeries[pageType] = pageLatencySeries;
  }

  const allSuccessMap = seriesMapForMetric(
    allRows,
    "page.serve",
    (labels) => labels.statusClass === "2xx",
    chartBucketSeconds,
  );
  const all4xxMap = seriesMapForMetric(
    allRows,
    "page.serve",
    (labels) => labels.statusClass === "4xx",
    chartBucketSeconds,
  );
  const all5xxMap = seriesMapForMetric(
    allRows,
    "page.serve",
    (labels) => labels.statusClass === "5xx",
    chartBucketSeconds,
  );
  const userFacing4xxMap = seriesMapForMetric(
    allRows,
    "page.serve",
    (labels) =>
      USER_FACING_ERROR_PAGE_TYPES.includes(labels.pageType) && labels.statusClass === "4xx",
    chartBucketSeconds,
  );
  const userFacing5xxMap = seriesMapForMetric(
    allRows,
    "page.serve",
    (labels) =>
      USER_FACING_ERROR_PAGE_TYPES.includes(labels.pageType) && labels.statusClass === "5xx",
    chartBucketSeconds,
  );
  const userFacingSuccessMap = seriesMapForMetric(
    allRows,
    "page.serve",
    (labels) =>
      USER_FACING_ERROR_PAGE_TYPES.includes(labels.pageType) && labels.statusClass === "2xx",
    chartBucketSeconds,
  );
  const errorRateSeries = timeline.map((bucket) => {
    const key = bucket.toISOString();
    const success = allSuccessMap.get(key) || 0;
    const error = (all4xxMap.get(key) || 0) + (all5xxMap.get(key) || 0);
    const total = success + error;
    return { t: key, v: total > 0 ? error / total : 0 };
  });
  const userFacingErrorRateSeries = timeline.map((bucket) => {
    const key = bucket.toISOString();
    const success = userFacingSuccessMap.get(key) || 0;
    const error = (userFacing4xxMap.get(key) || 0) + (userFacing5xxMap.get(key) || 0);
    const total = success + error;
    return { t: key, v: total > 0 ? error / total : 0 };
  });

  const filesListMap = seriesMapForMetric(allRows, "drive.files_list", undefined, chartBucketSeconds);
  const filesGetMap = seriesMapForMetric(allRows, "drive.files_get", undefined, chartBucketSeconds);
  const sheetsMap = seriesMapForMetric(allRows, "sheets.api", undefined, chartBucketSeconds);
  const filesListSeries = mapToSeries(timeline, filesListMap);
  const filesGetSeries = mapToSeries(timeline, filesGetMap);
  const sheetsSeries = mapToSeries(timeline, sheetsMap);
  let filesList = 0;
  let filesGet = 0;
  let sheetsApi = 0;
  for (const v of filesListMap.values()) filesList += v;
  for (const v of filesGetMap.values()) filesGet += v;
  for (const v of sheetsMap.values()) sheetsApi += v;

  const incidentMetricByKey = {
    magicLinkRequest: "magic_link.request",
    magicLinkUnknownId: "magic_link.unknown_id",
    magicLinkSendFailed: "magic_link.send_failed",
    verifySuccess: "verify.success",
    verifyExpired: "verify.expired",
    verifyError: "verify.error",
    rateLimitHits: "rate_limit.hit",
    portalClassGradeFail: "portal_class_grade.fail",
    sheetsApiError: "sheets.api_error",
    sheetsApiThrottle: "sheets.api_throttle",
    driveApiThrottle: "drive.api_throttle",
  };

  /** @type {Record<string, number>} */
  const incidentTotals = {};
  /** @type {Record<string, Array<{ t: string, v: number }>>} */
  const incidentSeries = {};
  for (const key of INCIDENT_SERIES_KEYS) {
    const metricName = incidentMetricByKey[key];
    const valueMap = seriesMapForMetric(allRows, metricName, undefined, chartBucketSeconds);
    const series = mapToSeries(timeline, valueMap);
    incidentSeries[key] = series;
    incidentTotals[key] = series.reduce((sum, p) => sum + p.v, 0);
  }

  // Prefer verify.* when present; fall back to legacy login.* for older buckets.
  if (incidentTotals.verifySuccess === 0 && loginSuccessSeries.some((p) => p.v > 0)) {
    incidentSeries.verifySuccess = loginSuccessSeries;
    incidentTotals.verifySuccess = loginSuccessSeries.reduce((sum, p) => sum + p.v, 0);
  }
  if (incidentTotals.verifyExpired === 0 && loginFailedSeries.some((p) => p.v > 0)) {
    incidentSeries.verifyExpired = loginFailedSeries;
    incidentTotals.verifyExpired = loginFailedSeries.reduce((sum, p) => sum + p.v, 0);
  }

  return {
    window: resolvedWindow,
    bucketSeconds: chartBucketSeconds,
    storageBucketSeconds: BUCKET_SECONDS,
    generatedAt: now.toISOString(),
    logins: {
      successful: loginSuccessSeries.reduce((sum, p) => sum + p.v, 0),
      failed: loginFailedSeries.reduce((sum, p) => sum + p.v, 0),
      series: {
        successful: loginSuccessSeries,
        failed: loginFailedSeries,
      },
    },
    pages: {
      byType,
      serveSeries,
      latencySeries,
      errorRateSeries,
      userFacingErrorRateSeries,
    },
    drive: {
      filesList,
      filesGet,
      series: {
        filesList: filesListSeries,
        filesGet: filesGetSeries,
      },
    },
    sheets: {
      apiCalls: sheetsApi,
      series: {
        apiCalls: sheetsSeries,
      },
    },
    incidents: {
      totals: incidentTotals,
      series: incidentSeries,
    },
  };
}

module.exports = {
  BUCKET_SECONDS,
  WINDOW_MS,
  PAGE_TYPES,
  USER_FACING_ERROR_PAGE_TYPES,
  INCIDENT_SERIES_KEYS,
  RECENT_ERROR_LIMIT,
  recordMetric,
  recordPageServe,
  recordRecentError,
  getRecentErrors,
  recordLoginSuccess,
  recordLoginFailed,
  recordVerifyError,
  recordMagicLinkRequest,
  recordMagicLinkUnknownId,
  recordMagicLinkSendFailed,
  recordRateLimitHit,
  recordPortalClassGradeFail,
  recordDriveFilesList,
  recordDriveFilesGet,
  recordSheetsApiCall,
  recordSheetsApiError,
  recordSheetsApiThrottle,
  recordDriveApiThrottle,
  classifyPageType,
  shouldSkipPath,
  isRequestLogEnabled,
  createPortalMetricsMiddleware,
  createRequestLogMiddleware,
  startPortalMetricsFlusher,
  flushMetricsToDatabase,
  getPortalStats,
  floorBucketStart,
};
