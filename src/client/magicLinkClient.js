import { getStoredPortalLocale, translatePortalText } from './portalI18n.js';

export const MAGIC_LINK_CLIENT_COOLDOWN_MS = 2 * 60 * 1000;

const LAST_SENT_AT_KEY = 'studentPortalMagicLinkLastSentAt';
const LAST_SENT_USER_KEY = 'studentPortalMagicLinkLastSentUserId';

/** @type {Map<string, Promise<any>>} */
const inFlightMagicLinkRequests = new Map();

function defaultTranslate(key, params) {
  return translatePortalText(getStoredPortalLocale(), key, params);
}

/**
 * @param {string} [userId]
 * @returns {number}
 */
export function readMagicLinkCooldownRemainingMs(userId = '') {
  const raw = sessionStorage.getItem(LAST_SENT_AT_KEY);
  if (!raw) {
    return 0;
  }
  const lastSent = Number(raw);
  if (!Number.isFinite(lastSent)) {
    return 0;
  }

  const trimmedUserId = String(userId || '').trim();
  const lastUserId = String(sessionStorage.getItem(LAST_SENT_USER_KEY) || '').trim();
  if (!trimmedUserId || !lastUserId || trimmedUserId !== lastUserId) {
    return 0;
  }

  return Math.max(0, MAGIC_LINK_CLIENT_COOLDOWN_MS - (Date.now() - lastSent));
}

/**
 * @param {string} [userId]
 */
export function markMagicLinkSent(userId = '') {
  sessionStorage.setItem(LAST_SENT_AT_KEY, String(Date.now()));
  const trimmedUserId = String(userId || '').trim();
  if (trimmedUserId) {
    sessionStorage.setItem(LAST_SENT_USER_KEY, trimmedUserId);
  }
}

/**
 * @param {number} retryAfterSeconds
 * @param {string} [userId]
 */
export function syncMagicLinkCooldownFrom429(retryAfterSeconds, userId = '') {
  const seconds = Number(retryAfterSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return;
  }
  const impliedLastSent = Date.now() + seconds * 1000 - MAGIC_LINK_CLIENT_COOLDOWN_MS;
  sessionStorage.setItem(LAST_SENT_AT_KEY, String(Math.max(Date.now(), impliedLastSent)));
  const trimmedUserId = String(userId || '').trim();
  if (trimmedUserId) {
    sessionStorage.setItem(LAST_SENT_USER_KEY, trimmedUserId);
  }
}

/**
 * @param {number} ms
 * @param {(key: string, params?: Record<string, string>) => string} [t]
 * @returns {string}
 */
export function formatMagicLinkWaitDuration(ms, t = defaultTranslate) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes <= 1) {
    return t('magicLink.waitAboutOneMinute');
  }
  return t('magicLink.waitAboutMinutes', { minutes: String(minutes) });
}

/**
 * @param {Response} response
 * @returns {number|null}
 */
export function parseRetryAfterHeader(response) {
  const raw = response.headers.get('Retry-After');
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds);
  }
  const retryAt = Date.parse(raw);
  if (Number.isFinite(retryAt)) {
    return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  }
  return null;
}

/**
 * @param {Response} response
 * @param {{ error?: string, retryAfterSeconds?: number }} data
 * @param {(key: string, params?: Record<string, string>) => string} [t]
 * @param {string} [userId]
 * @returns {string}
 */
const MAGIC_LINK_COOLDOWN_LIMITERS = new Set([
  'magic-link-request-cooldown',
  'magic-link-resend-cooldown',
]);

function isMagicLinkCooldown429(data = {}) {
  const name = String(data.rateLimitName || '').trim();
  if (MAGIC_LINK_COOLDOWN_LIMITERS.has(name)) {
    return true;
  }
  const error = String(data.error || '').toLowerCase();
  return error.includes('sent recently') || error.includes('wait a couple of minutes');
}

export function resolveMagicLink429Message(response, data = {}, t = defaultTranslate, userId = '') {
  const retryAfterSeconds =
    Number(data.retryAfterSeconds) || parseRetryAfterHeader(response) || Math.ceil(MAGIC_LINK_CLIENT_COOLDOWN_MS / 1000);
  syncMagicLinkCooldownFrom429(retryAfterSeconds, userId);
  const wait = formatMagicLinkWaitDuration(retryAfterSeconds * 1000, t);
  if (isMagicLinkCooldown429(data)) {
    return t('magicLink.alreadySentWait', { wait });
  }
  return t('magicLink.rateLimited', { wait });
}

/**
 * @param {string} userId
 * @param {{ t?: (key: string, params?: Record<string, string>) => string }} [options]
 * @returns {Promise<{ ok: true, data: any } | { ok: false, clientCooldown?: boolean, rateLimited?: boolean, message: string, data?: any }>}
 */
export async function postMagicLinkRequest(userId, options = {}) {
  const t = options.t || defaultTranslate;
  const trimmedUserId = String(userId || '').trim();
  const cooldownRemaining = readMagicLinkCooldownRemainingMs(trimmedUserId);
  if (cooldownRemaining > 0) {
    return {
      ok: false,
      clientCooldown: true,
      message: t('magicLink.waitBeforeRetry', {
        wait: formatMagicLinkWaitDuration(cooldownRemaining, t),
      }),
    };
  }

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

    if (response.status === 429) {
      const clientCooldown = isMagicLinkCooldown429(data);
      return {
        ok: false,
        clientCooldown,
        rateLimited: !clientCooldown,
        message: resolveMagicLink429Message(response, data, t, trimmedUserId),
        data,
      };
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
 * @returns {Promise<{ ok: true, data: any } | { ok: false, clientCooldown?: boolean, rateLimited?: boolean, message: string, data?: any }>}
 */
export async function postResendMagicLink(token, options = {}) {
  const t = options.t || defaultTranslate;
  const trimmedToken = String(token || '').trim();
  const trimmedUserId = String(options.userId || sessionStorage.getItem('studentPortalPendingMagicUserId') || '').trim();
  const cooldownRemaining = readMagicLinkCooldownRemainingMs(trimmedUserId);
  if (cooldownRemaining > 0) {
    return {
      ok: false,
      clientCooldown: true,
      message: t('magicLink.waitBeforeRetry', {
        wait: formatMagicLinkWaitDuration(cooldownRemaining, t),
      }),
    };
  }

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

    if (response.status === 429) {
      const clientCooldown = isMagicLinkCooldown429(data);
      return {
        ok: false,
        clientCooldown,
        rateLimited: !clientCooldown,
        message: resolveMagicLink429Message(response, data, t, trimmedUserId),
        data,
      };
    }

    if (!response.ok || data.success === false) {
      return {
        ok: false,
        message: data.error || data.message || t('magicLink.resendFailed'),
        data,
      };
    }

    markMagicLinkSent(trimmedUserId);
    return { ok: true, data };
  })();

  inFlightMagicLinkRequests.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    inFlightMagicLinkRequests.delete(inFlightKey);
  }
}
