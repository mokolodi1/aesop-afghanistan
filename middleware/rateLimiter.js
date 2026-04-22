// Simple in-memory rate limiter
// For production, use Redis-based rate limiting

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
 * Simple rate limiter middleware
 * @param {Object} options - Rate limit options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum number of requests per window
 * @returns {Function} Express middleware
 */
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 5 }) {
  return (req, res, next) => {
    // Use IP address as key (in production, consider using a more reliable method)
    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    const record = rateLimitStore.get(key);

    if (!record) {
      // First request
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + windowMs
      });
      return next();
    }

    // Check if window has expired
    if (now > record.resetTime) {
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + windowMs
      });
      return next();
    }

    // Check if limit exceeded
    if (record.count >= max) {
      return res.status(429).json({
        error: 'Too many requests. Please try again later.'
      });
    }

    // Increment count
    record.count++;
    rateLimitStore.set(key, record);

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - record.count));
    res.setHeader('X-RateLimit-Reset', new Date(record.resetTime).toISOString());

    next();
  };
}

module.exports = {
  createRateLimiter
};
