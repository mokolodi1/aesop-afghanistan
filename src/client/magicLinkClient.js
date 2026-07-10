import { getStoredPortalLocale, translatePortalText } from './portalI18n.js';

export const MAGIC_LINK_CLIENT_COOLDOWN_MS = 2 * 60 * 1000;

const LAST_SENT_AT_KEY = 'studentPortalMagicLinkLastSentAt';
const LAST_SENT_USER_KEY = 'studentPortalMagicLinkLastSentUserId';

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
  if (trimmedUserId && lastUserId && trimmedUserId !== lastUserId) {
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
 */
export function syncMagicLinkCooldownFrom429(retryAfterSeconds) {
  const seconds = Number(retryAfterSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return;
  }
  const impliedLastSent = Date.now() + seconds * 1000 - MAGIC_LINK_CLIENT_COOLDOWN_MS;
  sessionStorage.setItem(LAST_SENT_AT_KEY, String(Math.max(Date.now(), impliedLastSent)));
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
 * @returns {string}
 */
export function resolveMagicLink429Message(response, data = {}, t = defaultTranslate) {
  const retryAfterSeconds =
    Number(data.retryAfterSeconds) || parseRetryAfterHeader(response) || Math.ceil(MAGIC_LINK_CLIENT_COOLDOWN_MS / 1000);
  syncMagicLinkCooldownFrom429(retryAfterSeconds);
  return t('magicLink.rateLimited', {
    wait: formatMagicLinkWaitDuration(retryAfterSeconds * 1000, t),
  });
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
      message: t('magicLink.alreadySentWait', {
        wait: formatMagicLinkWaitDuration(cooldownRemaining, t),
      }),
    };
  }

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
    return {
      ok: false,
      rateLimited: true,
      message: resolveMagicLink429Message(response, data, t),
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

  markMagicLinkSent(trimmedUserId);
  sessionStorage.setItem('studentPortalPendingMagicUserId', trimmedUserId);
  return { ok: true, data };
}

/**
 * @param {string} token
 * @param {{ t?: (key: string, params?: Record<string, string>) => string }} [options]
 * @returns {Promise<{ ok: true, data: any } | { ok: false, clientCooldown?: boolean, rateLimited?: boolean, message: string, data?: any }>}
 */
export async function postResendMagicLink(token, options = {}) {
  const t = options.t || defaultTranslate;
  const trimmedToken = String(token || '').trim();
  const cooldownRemaining = readMagicLinkCooldownRemainingMs();
  if (cooldownRemaining > 0) {
    return {
      ok: false,
      clientCooldown: true,
      message: t('magicLink.alreadySentWait', {
        wait: formatMagicLinkWaitDuration(cooldownRemaining, t),
      }),
    };
  }

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
    return {
      ok: false,
      rateLimited: true,
      message: resolveMagicLink429Message(response, data, t),
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

  markMagicLinkSent();
  return { ok: true, data };
}
