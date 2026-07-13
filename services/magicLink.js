const crypto = require('crypto');
const { DateTime } = require('luxon');
const { eq, lt } = require('drizzle-orm');
const { sendEmail } = require('./email');
const { findProfileById } = require('./googleSheets');
const { getDb, isDatabaseEnabled } = require('../db/index');
const { magicLinks } = require('../db/schema');
const { formatErrorForLog } = require('../utils/errorLogging');
const {
  AESOP_EMAIL,
  FONT_HEADING,
  FONT_STACK,
  escapeHtml,
  wrapAesopEmail,
} = require('./emailBranding');

// Fallback when DATABASE_URL is not configured (local dev without Postgres).
const magicLinkStore = new Map();

const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000;

// Time zones shown in the sign-in email so recipients can tell at a glance
// when their link expires in their local wall-clock time.
const EXPIRY_DISPLAY_ZONES = [
  { label: 'Afghanistan', zone: 'Asia/Kabul' },
  { label: 'Pakistan', zone: 'Asia/Karachi' },
  { label: 'Iran', zone: 'Asia/Tehran' },
  { label: 'East Coast USA', zone: 'America/New_York' },
  { label: 'West Coast USA', zone: 'America/Los_Angeles' },
  { label: 'China', zone: 'Asia/Shanghai' },
];

function formatExpiryAcrossZones(expiresAt) {
  const expiry = DateTime.fromJSDate(expiresAt);
  return EXPIRY_DISPLAY_ZONES.map(
    ({ label, zone }) => `${expiry.setZone(zone).toFormat('h:mm a')} ${label}`
  ).join(', ');
}

/**
 * Build bilingual (English + Dari) magic-link email content.
 * @param {{ magicLink: string, name?: string, userId?: string }} params
 * @returns {{ subject: string, html: string, text: string }}
 */
function buildMagicLinkEmailContent({ magicLink, name = '', userId = '' }) {
  const safeName = String(name || '').trim();
  const safeUserId = String(userId || '').trim();
  const greetingNameEn = safeName ? escapeHtml(safeName) : 'there';
  const greetingNameFa = safeName ? escapeHtml(safeName) : '';
  const emailSubject = 'AESOP Portal Sign In Link / لینک ورود به پورتال AESOP';
  const { ink, muted, accent, accentDark, skyTint, line } = AESOP_EMAIL;
  const safeLinkText = escapeHtml(magicLink);
  const safeHref = magicLink.replace(/&/g, '&amp;');
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);
  const expiryAcrossZones = formatExpiryAcrossZones(expiresAt);

  const idBlockEn = safeUserId
    ? `<p style="margin:0 0 18px;line-height:1.5;">Your AESOP ID: <strong dir="ltr">${escapeHtml(safeUserId)}</strong></p>`
    : '';
  const idBlockFa = safeUserId
    ? `<p style="margin:0 0 18px;line-height:1.8;" dir="rtl">شناسه AESOP شما: <strong dir="ltr">${escapeHtml(safeUserId)}</strong></p>`
    : '';
  const greetingFa = greetingNameFa
    ? `سلام <strong>${greetingNameFa}</strong>،`
    : 'سلام،';

  const signInButton = `
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr>
          <td style="border-radius:12px;background-color:${accent};">
            <a href="${safeHref}" style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">
              Click to Sign In / برای ورود کلیک کنید
            </a>
          </td>
        </tr>
      </table>`;

  const urlBox = `
      <p style="margin:0;padding:12px 14px;word-break:break-all;font-size:12px;line-height:1.45;color:${accentDark};background-color:${skyTint};border:1px solid ${line};border-radius:12px;" dir="ltr">
        ${safeLinkText}
      </p>`;

  const innerHtml = `
      <p style="margin:0 0 16px;font-family:${FONT_HEADING};font-size:18px;font-weight:700;color:${ink};">
        Link to Sign In to the AESOP Portal
      </p>
      <p style="margin:0 0 12px;line-height:1.5;">
        Hello <strong>${greetingNameEn}</strong>,
      </p>
      ${idBlockEn}
      <p style="margin:0 0 18px;line-height:1.5;">
        Use the link below on the device you would like to log in on.
      </p>
      ${signInButton}
      <p style="margin:18px 0 6px;font-size:13px;color:${muted};">Or paste this URL:</p>
      ${urlBox}
      <p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:${muted};">
        The login link expires in <strong>15 minutes</strong>. (Expires at ${expiryAcrossZones})
      </p>
      <p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:${muted};">
        If you did not request this email, you may disregard it.
      </p>

      <hr style="margin:28px 0;border:0;border-top:1px solid ${line};" />

      <div dir="rtl" lang="fa" style="text-align:right;">
        <p style="margin:0 0 16px;font-family:${FONT_HEADING};font-size:18px;font-weight:700;color:${ink};line-height:1.6;">
          لینک ورود به پورتال AESOP
        </p>
        <p style="margin:0 0 12px;line-height:1.8;">
          ${greetingFa}
        </p>
        ${idBlockFa}
        <p style="margin:0 0 18px;line-height:1.8;">
          از لینک زیر روی دستگاهی که می‌خواهید با آن وارد شوید استفاده کنید.
        </p>
        ${signInButton}
        <p style="margin:18px 0 6px;font-size:13px;color:${muted};line-height:1.8;">یا این آدرس را جای‌گذاری کنید:</p>
        ${urlBox}
        <p style="margin:18px 0 0;font-size:13px;line-height:1.8;color:${muted};">
          لینک ورود تا <strong>۱۵ دقیقه</strong> اعتبار دارد. (انقضا: ${escapeHtml(expiryAcrossZones)})
        </p>
        <p style="margin:12px 0 0;font-size:13px;line-height:1.8;color:${muted};">
          اگر شما این ایمیل را درخواست نکرده‌اید، می‌توانید آن را نادیده بگیرید.
        </p>
      </div>
  `;

  const emailHtml = wrapAesopEmail(innerHtml, { title: emailSubject });
  const emailText = [
    'AESOP Afghanistan — AESOP portal',
    '',
    safeName ? `Hello ${safeName},` : 'Hello,',
    safeUserId ? `Your AESOP ID: ${safeUserId}` : '',
    '',
    'Use this link to sign in on the device you would like to log in on:',
    magicLink,
    '',
    `The login link expires in 15 minutes. (Expires at ${expiryAcrossZones})`,
    '',
    'If you did not request this email, you may disregard it.',
    '',
    '---',
    '',
    'پورتال AESOP',
    '',
    safeName ? `سلام ${safeName}،` : 'سلام،',
    safeUserId ? `شناسه AESOP شما: ${safeUserId}` : '',
    '',
    'از لینک زیر روی دستگاهی که می‌خواهید با آن وارد شوید استفاده کنید:',
    magicLink,
    '',
    `لینک ورود تا ۱۵ دقیقه اعتبار دارد. (انقضا: ${expiryAcrossZones})`,
    '',
    'اگر شما این ایمیل را درخواست نکرده‌اید، می‌توانید آن را نادیده بگیرید.',
    '',
    'AESOP · https://aesopafghanistan.org/',
  ]
    .filter((line, index, arr) => !(line === '' && arr[index - 1] === ''))
    .join('\n');

  return { subject: emailSubject, html: emailHtml, text: emailText };
}

/**
 * Write a local HTML preview of the magic-link email so it can be opened in a browser.
 * @param {string} html
 * @returns {string} absolute path written
 */
function writeMagicLinkEmailPreview(html) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'magic-link-email-preview.html');
  fs.writeFileSync(filePath, html, 'utf8');
  return filePath;
}

async function sendMagicLinkEmail(email, token, { name = '', userId = '' } = {}) {
  const magicLink = isFlyProduction()
    ? `${magicLinkSiteOrigin()}/verify.html#token=${token}`
    : `${localDevMagicLinkOrigin()}/verify.html#token=${token}`;

  // Token goes in the URL fragment (#), which browsers never send to the
  // server — keeps it out of Fly/proxy access logs and Referer headers.
  const { subject, html, text } = buildMagicLinkEmailContent({
    magicLink,
    name,
    userId,
  });

  if (!isFlyProduction()) {
    const previewPath = writeMagicLinkEmailPreview(html);
    console.log(`[magic-link] sign-in link for ${email}${name ? ` (${name})` : ''}${userId ? ` [${userId}]` : ''}:`);
    console.log(magicLink);
    console.log(`[magic-link] email preview (open in browser):`);
    console.log(`file://${previewPath}`);
    return;
  }

  await sendEmail({
    to: email,
    subject,
    html,
    text,
  });
}

function magicLinkSiteOrigin() {
  const raw = (
    process.env.PORTAL_BASE_URL ||
    process.env.BASE_URL ||
    'http://localhost:3000'
  ).trim();
  return raw.replace(/\/+$/, '');
}

function isFlyProduction() {
  return Boolean(process.env.FLY_APP_NAME);
}

function localDevMagicLinkOrigin() {
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  return `http://localhost:${Number.isFinite(port) ? port : 3000}`;
}

function shouldPersistMagicLinksInDb() {
  return isDatabaseEnabled() && isFlyProduction();
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanupExpiredTokensInMemory() {
  const now = new Date();
  for (const [token, data] of magicLinkStore.entries()) {
    if (now > data.expiresAt) {
      magicLinkStore.delete(token);
    }
  }
}

async function cleanupExpiredTokensInDb() {
  const db = getDb();
  if (!db) {
    return;
  }
  try {
    await db.delete(magicLinks).where(lt(magicLinks.expiresAt, new Date()));
  } catch (error) {
    console.warn('[magic-link] expired token cleanup failed:', error.message);
  }
}

async function readMagicLinkRecord(token) {
  if (shouldPersistMagicLinksInDb()) {
    const db = getDb();
    if (db) {
      try {
        const rows = await db.select().from(magicLinks).where(eq(magicLinks.token, token)).limit(1);
        if (rows.length) {
          const row = rows[0];
          return {
            email: row.email,
            userId: row.userId || undefined,
            expiresAt: row.expiresAt,
            used: row.used === true,
          };
        }
      } catch (error) {
        console.error('[magic-link] DB read failed; checking memory fallback:', formatErrorForLog(error));
      }
    }
  }

  return magicLinkStore.get(token) || null;
}

async function writeMagicLinkRecord(token, { email, userId, expiresAt }) {
  if (shouldPersistMagicLinksInDb()) {
    const db = getDb();
    if (db) {
      try {
        await db.insert(magicLinks).values({
          token,
          email,
          userId: userId || null,
          expiresAt,
          used: false,
          createdAt: new Date(),
        });
        if (Math.random() < 0.05) {
          await cleanupExpiredTokensInDb();
        }
        return;
      } catch (error) {
        console.error('[magic-link] DB store failed; using memory fallback:', formatErrorForLog(error));
      }
    }
  }

  magicLinkStore.set(token, {
    email,
    userId: userId && typeof userId === 'string' ? userId : undefined,
    expiresAt,
    used: false,
    createdAt: new Date(),
  });

  if (magicLinkStore.size > 1000) {
    cleanupExpiredTokensInMemory();
  }
}

async function markMagicLinkUsed(token) {
  if (shouldPersistMagicLinksInDb()) {
    const db = getDb();
    if (db) {
      try {
        await db.update(magicLinks).set({ used: true }).where(eq(magicLinks.token, token));
        return;
      } catch (error) {
        console.error('[magic-link] DB mark-used failed; using memory fallback:', formatErrorForLog(error));
      }
    }
  }

  const linkData = magicLinkStore.get(token);
  if (linkData) {
    linkData.used = true;
  }
}

async function deleteMagicLinkRecord(token) {
  if (shouldPersistMagicLinksInDb()) {
    const db = getDb();
    if (db) {
      try {
        await db.delete(magicLinks).where(eq(magicLinks.token, token));
        return;
      } catch (error) {
        console.error('[magic-link] DB delete failed; using memory fallback:', formatErrorForLog(error));
      }
    }
  }

  magicLinkStore.delete(token);
}

/**
 * Generate and store a magic link for an email
 * @param {string} email - Email address
 * @param {string} [userId] - Student ID (sanitized) used to look up the row; shown on the portal after verify
 * @returns {Promise<{token: string, expiresAt: Date}>}
 */
async function generateAndStoreMagicLink(email, userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);

  await writeMagicLinkRecord(token, { email, userId, expiresAt });

  return { token, expiresAt };
}

/**
 * Verify a magic link token
 * @param {string} token - Magic link token (should be pre-validated)
 * @returns {Promise<{valid: boolean, email?: string, userId?: string, canResend?: boolean, reason?: 'expired'|'used'|'unknown'}>}
 */
async function verifyMagicLink(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) {
    return { valid: false, reason: 'unknown' };
  }

  const linkData = await readMagicLinkRecord(token);

  if (!linkData) {
    return { valid: false, reason: 'unknown' };
  }

  const now = new Date();
  const expired = now > linkData.expiresAt;

  if (linkData.used || expired) {
    return {
      valid: false,
      canResend: !!(linkData.email && linkData.userId),
      reason: linkData.used ? 'used' : 'expired',
    };
  }

  await markMagicLinkUsed(token);

  return {
    valid: true,
    email: linkData.email,
    userId: linkData.userId,
  };
}

/**
 * Issue a fresh magic link using data from an expired or used token.
 * @param {string} token - Previous magic link token
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function resendMagicLinkByToken(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) {
    return { success: false, error: 'Invalid token format.' };
  }

  const linkData = await readMagicLinkRecord(token);
  if (!linkData?.email || !linkData.userId) {
    return {
      success: false,
      error: 'This link can no longer be used. Enter your AESOP ID below to request a new link.',
    };
  }

  const { email, userId } = linkData;
  await deleteMagicLinkRecord(token);
  const { token: newToken } = await generateAndStoreMagicLink(email, userId);
  let profileName = '';
  try {
    const profile = await findProfileById(userId);
    profileName = profile?.name || '';
  } catch {
    profileName = '';
  }
  try {
    await sendMagicLinkEmail(email, newToken, { name: profileName, userId });
  } catch (error) {
    if (error?.code === 'EMAIL_SEND_QUOTA_EXCEEDED') {
      return {
        success: false,
        error: 'Login emails are temporarily unavailable. Please try again later.',
      };
    }
    throw error;
  }

  return {
    success: true,
    message: 'A new login link has been sent to your registered email.',
  };
}

module.exports = {
  generateAndStoreMagicLink,
  verifyMagicLink,
  sendMagicLinkEmail,
  buildMagicLinkEmailContent,
  resendMagicLinkByToken,
  isFlyProduction,
};
