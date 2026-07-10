/**
 * Resolve the end-user IP behind Fly.io's proxy.
 *
 * Fly sets req.ip to the proxy hop (66.x) when trust proxy is enabled. The
 * leftmost X-Forwarded-For entry is the client; Fly-Client-IP is a fallback.
 */

function isFlyRuntime() {
  return Boolean(process.env.FLY_APP_NAME);
}

/**
 * @param {string|undefined|null} value
 * @returns {string}
 */
function firstHeaderIp(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return value.split(',')[0].trim();
}

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  const xffClientIp = firstHeaderIp(req.get('x-forwarded-for'));
  if (xffClientIp) {
    return xffClientIp;
  }

  if (isFlyRuntime()) {
    const flyClientIp = firstHeaderIp(req.get('fly-client-ip'));
    if (flyClientIp) {
      return flyClientIp;
    }
  }

  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

/**
 * Extra IP fields for access / rate-limit logs (see where the address came from).
 * @param {import('express').Request} req
 * @returns {{ ip: string, reqIp?: string, flyClientIp?: string, xForwardedFor?: string, remoteAddress?: string }}
 */
function getClientIpContext(req) {
  const ip = getClientIp(req);
  const reqIp = req.ip || undefined;
  const flyClientIp = req.get('fly-client-ip') || undefined;
  const xForwardedFor = req.get('x-forwarded-for') || undefined;
  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress || undefined;

  const context = { ip };
  if (reqIp && reqIp !== ip) {
    context.reqIp = reqIp;
  }
  if (flyClientIp && flyClientIp !== ip) {
    context.flyClientIp = flyClientIp;
  }
  if (xForwardedFor) {
    context.xForwardedFor = xForwardedFor;
  }
  if (remoteAddress && remoteAddress !== ip && remoteAddress !== reqIp) {
    context.remoteAddress = remoteAddress;
  }
  return context;
}

module.exports = {
  getClientIp,
  getClientIpContext,
  isFlyRuntime,
};
