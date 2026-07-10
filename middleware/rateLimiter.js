// Simple in-memory rate limiter
// For production, use Redis-based rate limiting

const { recordRateLimitHit } = require('../services/portalMetrics');

const rateLimitStore = new Map();

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

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
 * @param {{ max: number, resetTime: number, now: number }} options
 */
function setRateLimitHeaders(res, { max, resetTime, now }) {
  res.setHeader('X-RateLimit-Limit', max);
  res.setHeader('X-RateLimit-Remaining', 0);
  res.setHeader('X-RateLimit-Reset', new Date(resetTime).toISOString());
  res.setHeader('Retry-After', String(retryAfterSeconds(resetTime, now)));
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
  max = 5,
  name = 'default',
  resolveKeySuffix = null,
  message = 'Too many requests. Please try again later.',
}) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = `${name}:${buildRateLimitKey(req, ip, resolveKeySuffix)}`;
    const now = Date.now();

    const record = rateLimitStore.get(key);

    if (!record) {
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - 1));
      res.setHeader('X-RateLimit-Reset', new Date(now + windowMs).toISOString());
      return next();
    }

    if (now > record.resetTime) {
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - 1));
      res.setHeader('X-RateLimit-Reset', new Date(now + windowMs).toISOString());
      return next();
    }

    if (record.count >= max) {
      recordRateLimitHit(name);
      setRateLimitHeaders(res, { max, resetTime: record.resetTime, now });
      return res.status(429).json({
        error: message,
        retryAfterSeconds: retryAfterSeconds(record.resetTime, now),
      });
    }

    record.count++;
    rateLimitStore.set(key, record);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - record.count));
    res.setHeader('X-RateLimit-Reset', new Date(record.resetTime).toISOString());

    next();
  };
}

module.exports = {
  createRateLimiter,
};
