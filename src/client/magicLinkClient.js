import { getStoredPortalLocale, translatePortalText } from './portalI18n.js';

/** @type {Map<string, Promise<any>>} */
const inFlightMagicLinkRequests = new Map();

function defaultTranslate(key, params) {
  return translatePortalText(getStoredPortalLocale(), key, params);
}

/**
 * @param {string} userId
 * @param {{ t?: (key: string, params?: Record<string, string>) => string }} [options]
 * @returns {Promise<{ ok: true, data: any } | { ok: false, message: string, data?: any }>}
 */
export async function postMagicLinkRequest(userId, options = {}) {
  const t = options.t || defaultTranslate;
  const trimmedUserId = String(userId || '').trim();

  const inFlightKey = `request:${trimmedUserId || '__empty__'}`;
  const inFlight = inFlightMagicLinkRequests.get(inFlightKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const response = await fetch('/api/request-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: trimmedUserId }),
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      return {
        ok: false,
        message:
          response.status >= 500
            ? data.error || t('magicLink.networkError')
            : data.error || data.message || t('magicLink.networkError'),
        data,
      };
    }

    sessionStorage.setItem('studentPortalPendingMagicUserId', trimmedUserId);
    return { ok: true, data };
  })();

  inFlightMagicLinkRequests.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    inFlightMagicLinkRequests.delete(inFlightKey);
  }
}

/**
 * @param {string} token
 * @param {{ t?: (key: string, params?: Record<string, string>) => string, userId?: string }} [options]
 * @returns {Promise<{ ok: true, data: any } | { ok: false, message: string, data?: any }>}
 */
export async function postResendMagicLink(token, options = {}) {
  const t = options.t || defaultTranslate;
  const trimmedToken = String(token || '').trim();

  const inFlightKey = `resend:${trimmedToken || '__empty__'}`;
  const inFlight = inFlightMagicLinkRequests.get(inFlightKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const response = await fetch('/api/resend-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: trimmedToken }),
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok || data.success === false) {
      return {
        ok: false,
        message: data.error || data.message || t('magicLink.resendFailed'),
        data,
      };
    }

    return { ok: true, data };
  })();

  inFlightMagicLinkRequests.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    inFlightMagicLinkRequests.delete(inFlightKey);
  }
}
