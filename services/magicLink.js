const crypto = require('crypto');
const { eq, lt } = require('drizzle-orm');
const { sendEmail } = require('./email');
const { getDb, isDatabaseEnabled } = require('../db/index');
const { magicLinks } = require('../db/schema');
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
  if (isDatabaseEnabled()) {
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
        console.error('[magic-link] DB read failed; checking memory fallback:', error.message);
      }
    }
  }

  return magicLinkStore.get(token) || null;
}

async function writeMagicLinkRecord(token, { email, userId, expiresAt }) {
  if (isDatabaseEnabled()) {
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
        console.error('[magic-link] DB store failed; using memory fallback:', error.message);
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
  if (isDatabaseEnabled()) {
    const db = getDb();
    if (!db) {
      return;
    }
    await db.update(magicLinks).set({ used: true }).where(eq(magicLinks.token, token));
    return;
  }

  const linkData = magicLinkStore.get(token);
  if (linkData) {
    linkData.used = true;
  }
}

async function deleteMagicLinkRecord(token) {
  if (isDatabaseEnabled()) {
    const db = getDb();
    if (!db) {
      return;
    }
    await db.delete(magicLinks).where(eq(magicLinks.token, token));
    return;
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
 * @returns {Promise<{valid: boolean, email?: string, userId?: string, canResend?: boolean}>}
 */
async function verifyMagicLink(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) {
    return { valid: false };
  }

  const linkData = await readMagicLinkRecord(token);

  if (!linkData) {
    return { valid: false };
  }

  const now = new Date();
  const expired = now > linkData.expiresAt;

  if (linkData.used || expired) {
    return {
      valid: false,
      canResend: !!(linkData.email && linkData.userId),
    };
  }

  await markMagicLinkUsed(token);

  return {
    valid: true,
    email: linkData.email,
    userId: linkData.userId,
  };
}

function magicLinkSiteOrigin() {
  const raw = (
    process.env.PORTAL_BASE_URL ||
    process.env.BASE_URL ||
    'http://localhost:3000'
  ).trim();
  return raw.replace(/\/+$/, '');
}

async function sendMagicLinkEmail(email, token) {
  const origin = magicLinkSiteOrigin();
  const magicLink = `${origin}/verify.html?token=${token}`;

  const emailSubject = 'Sign in to your AESOP student portal';
  const { ink, muted, accent, accentDark, skyTint, line } = AESOP_EMAIL;
  const safeLinkText = escapeHtml(magicLink);
  const innerHtml = `
      <p style="margin:0 0 16px;font-family:${FONT_HEADING};font-size:18px;font-weight:700;color:${ink};">
        Sign in to the student portal
      </p>
      <p style="margin:0 0 18px;line-height:1.5;">
        Use the link below on the same device where you requested access. It expires in <strong>15 minutes</strong>.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr>
          <td style="border-radius:12px;background-color:${accent};">
            <a href="${magicLink.replace(/&/g, '&amp;')}" style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">
              Sign in
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:18px 0 6px;font-size:13px;color:${muted};">Or paste this URL:</p>
      <p style="margin:0;padding:12px 14px;word-break:break-all;font-size:12px;line-height:1.45;color:${accentDark};background-color:${skyTint};border:1px solid ${line};border-radius:12px;">
        ${safeLinkText}
      </p>
      <p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:${muted};">
        If you did not request this email, you may disregard it.
      </p>
  `;
  const emailHtml = wrapAesopEmail(innerHtml, { title: emailSubject, showContactFooter: false });

  const emailText = [
    'AESOP Afghanistan — Student portal',
    '',
    'Use this link to sign in (same device you used to request it). Expires in 15 minutes:',
    magicLink,
    '',
    'If you did not request this email, you may disregard it.',
    '',
    'AESOP · https://aesopafghanistan.org/',
  ].join('\n');

  await sendEmail({
    to: email,
    subject: emailSubject,
    html: emailHtml,
    text: emailText,
  });
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
  await sendMagicLinkEmail(email, newToken);

  return {
    success: true,
    message: 'A new magic link has been sent to your registered email.',
  };
}

module.exports = {
  generateAndStoreMagicLink,
  verifyMagicLink,
  sendMagicLinkEmail,
  resendMagicLinkByToken,
};
