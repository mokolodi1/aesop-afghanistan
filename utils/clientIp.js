/**
 * Resolve the end-user IP behind Fly.io's proxy.
 *
 * With `trust proxy: 1`, Express often sets req.ip to the Fly proxy address
 * (e.g. 66.x) rather than the browser. Fly documents `Fly-Client-IP` as the
 * reliable client address when Fly Proxy is the only reverse proxy in front.
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
