// Rate limiter with shared Postgres buckets in production (Fly runs multiple machines).

const { recordRateLimitHit } = require('../services/portalMetrics');
const { getPool, isDatabaseEnabled } = require('../db/index');
const { getClientIp, getClientIpContext } = require('../utils/clientIp');

const rateLimitStore = new Map();
let postgresCleanupScheduled = false;

// Clean up old in-memory entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

function schedulePostgresRateLimitCleanup() {
  if (postgresCleanupScheduled || !isDatabaseEnabled()) {
    return;
  }
  postgresCleanupScheduled = true;
  setInterval(() => {
    const pool = getPool();
    if (!pool) {
      return;
    }
    pool
      .query(`DELETE FROM rate_limit_buckets WHERE reset_time < NOW() - INTERVAL '1 hour'`)
      .catch((error) => {
        console.warn('[rate-limit] cleanup failed:', error.message);
      });
  }, 5 * 60 * 1000);
}

/**
 * @param {import('express').Request} req
 * @param {string} ip
 * @param {(req: import('express').Request) => (string|null|undefined)} [resolveKeySuffix]
 * @returns {string}
 */
function buildRateLimitKey(req, ip, resolveKeySuffix) {
  if (typeof resolveKeySuffix === 'function') {
    const suffix = String(resolveKeySuffix(req) || '').trim();
    if (suffix) {
      return suffix;
    }
  }
  return `ip:${ip}`;
}

/**
 * @param {number} resetTime
 * @param {number} now
 * @returns {number}
 */
function retryAfterSeconds(resetTime, now) {
  return Math.max(1, Math.ceil((resetTime - now) / 1000));
}

/**
 * @param {import('express').Response} res
 * @param {{ max: number, resetTime: number, now: number, count: number }} options
 */
function setRateLimitHeaders(res, { max, resetTime, now, count }) {
  res.setHeader('X-RateLimit-Limit', max);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
  res.setHeader('X-RateLimit-Reset', new Date(resetTime).toISOString());
  if (count >= max) {
    res.setHeader('Retry-After', String(retryAfterSeconds(resetTime, now)));
  }
}

/**
 * @param {string} key
 * @param {number} windowMs
 * @returns {Promise<{ count: number, resetTime: number } | null>}
 */
async function consumePostgresRateLimit(key, windowMs) {
  const pool = getPool();
  if (!pool) {
    return null;
  }

  schedulePostgresRateLimitCleanup();

  const resetAt = new Date(Date.now() + windowMs);

  const result = await pool.query(
    `
      INSERT INTO rate_limit_buckets (bucket_key, count, reset_time)
      VALUES ($1, 1, $2)
      ON CONFLICT (bucket_key) DO UPDATE SET
        count = CASE
          WHEN rate_limit_buckets.reset_time <= NOW() THEN 1
          ELSE rate_limit_buckets.count + 1
        END,
        reset_time = CASE
          WHEN rate_limit_buckets.reset_time <= NOW() THEN $2
          ELSE rate_limit_buckets.reset_time
        END
      RETURNING count, FLOOR(EXTRACT(EPOCH FROM reset_time) * 1000)::bigint AS reset_time_ms
    `,
    [key, resetAt],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    count: Number(row.count) || 0,
    resetTime: Number(row.reset_time_ms) || Date.now() + windowMs,
  };
}

/**
 * @param {string} key
 * @param {number} windowMs
 * @returns {{ count: number, resetTime: number }}
 */
function consumeMemoryRateLimit(key, windowMs) {
  const now = Date.now();
  const record = rateLimitStore.get(key);

  if (!record || now > record.resetTime) {
    const next = { count: 1, resetTime: now + windowMs };
    rateLimitStore.set(key, next);
    return next;
  }

  record.count += 1;
  rateLimitStore.set(key, record);
  return record;
}

/**
 * @param {string} key
 * @param {number} windowMs
 * @returns {Promise<{ count: number, resetTime: number }>}
 */
async function consumeRateLimit(key, windowMs) {
  if (isDatabaseEnabled()) {
    try {
      const fromPostgres = await consumePostgresRateLimit(key, windowMs);
      if (fromPostgres) {
        return fromPostgres;
      }
    } catch (error) {
      console.warn('[rate-limit] postgres bucket failed; using memory fallback:', error.message);
    }
  }
  return consumeMemoryRateLimit(key, windowMs);
}

/**
 * @param {import('express').Request} req
 * @param {string} key
 * @param {string} name
 */
function logRateLimitBlock(req, key, name) {
  console.warn(
    JSON.stringify({
      type: 'rate_limit_block',
      at: new Date().toISOString(),
      name,
      key,
      ...getClientIpContext(req),
      path: req.path,
      instance: process.env.FLY_MACHINE_ID || undefined,
    }),
  );
}

/**
 * Simple rate limiter middleware
 * @param {Object} options - Rate limit options
 * @param {number} [options.windowMs] - Time window in milliseconds
 * @param {number} [options.max] - Maximum number of requests per window
 * @param {string} [options.name] - Metric / limiter name
 * @param {(req: import('express').Request) => (string|null|undefined)} [options.resolveKeySuffix]
 *   When set, the store key is `${name}:${suffix}` instead of `${name}:${ip}`.
 * @param {string} [options.message] - 429 response message
 * @returns {Function} Express middleware
 */
function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 50,
  name = 'default',
  resolveKeySuffix = null,
  message = 'Too many requests. Please try again later.',
}) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${name}:${buildRateLimitKey(req, ip, resolveKeySuffix)}`;
    const now = Date.now();

    consumeRateLimit(key, windowMs)
      .then((record) => {
        setRateLimitHeaders(res, { max, resetTime: record.resetTime, now, count: record.count });

        if (record.count > max) {
          recordRateLimitHit(name);
          logRateLimitBlock(req, key, name);
          return res.status(429).json({
            error: message,
            retryAfterSeconds: retryAfterSeconds(record.resetTime, now),
            rateLimitName: name,
          });
        }

        return next();
      })
      .catch(next);
  };
}

module.exports = {
  createRateLimiter,
  consumeRateLimit,
};
