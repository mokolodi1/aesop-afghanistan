const crypto = require('crypto');
const { sendEmail } = require('./email');
const config = require('../config/secrets');

// In-memory store for magic links (in production, use Redis or database)
// Format: { token: { email, userId, expiresAt, used } }
const magicLinkStore = new Map();

// Magic link expiration time (15 minutes)
const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000;

/**
 * Generate a secure random token for magic link
 * @returns {string} Random token
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
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
  
  magicLinkStore.set(token, {
    email,
    userId: userId && typeof userId === "string" ? userId : undefined,
    expiresAt,
    used: false,
    createdAt: new Date()
  });

  // Clean up expired tokens periodically (simple cleanup)
  if (magicLinkStore.size > 1000) {
    cleanupExpiredTokens();
  }

  return { token, expiresAt };
}

/**
 * Verify a magic link token
 * @param {string} token - Magic link token (should be pre-validated)
 * @returns {Promise<{valid: boolean, email?: string, userId?: string}>}
 */
async function verifyMagicLink(token) {
  // Additional validation (should already be done, but double-check)
  if (!token || typeof token !== 'string' || token.length !== 64) {
    return { valid: false };
  }

  const linkData = magicLinkStore.get(token);
  
  if (!linkData) {
    return { valid: false };
  }

  // Check if already used
  if (linkData.used) {
    return { valid: false };
  }

  // Check if expired
  const now = new Date();
  if (now > linkData.expiresAt) {
    magicLinkStore.delete(token);
    return { valid: false };
  }

  // Mark as used
  linkData.used = true;

  return {
    valid: true,
    email: linkData.email,
    userId: linkData.userId,
  };
}

/**
 * Clean up expired tokens from memory
 */
function cleanupExpiredTokens() {
  const now = new Date();
  for (const [token, data] of magicLinkStore.entries()) {
    if (now > data.expiresAt) {
      magicLinkStore.delete(token);
    }
  }
}

/**
 * Send magic link email to user
 * @param {string} email - Recipient email
 * @param {string} token - Magic link token
 */
async function sendMagicLinkEmail(email, token) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  // Use landing page that will POST the token securely
  const magicLink = `${baseUrl}/verify.html?token=${token}`;
  
  const emailSubject = 'Your AESOP Afghanistan Magic Link';
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
        }
        .button {
          display: inline-block;
          padding: 12px 24px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          text-decoration: none;
          border-radius: 8px;
          margin: 20px 0;
        }
        .footer {
          margin-top: 30px;
          font-size: 12px;
          color: #666;
        }
      </style>
    </head>
    <body>
      <h2>Welcome to AESOP Afghanistan</h2>
      <p>Click the button below to log in:</p>
      <a href="${magicLink}" class="button">Log In</a>
      <p>Or copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #667eea;">${magicLink}</p>
      <p><strong>This link will expire in 15 minutes.</strong></p>
      <div class="footer">
        <p>If you didn't request this link, please ignore this email.</p>
      </div>
    </body>
    </html>
  `;

  const emailText = `
Welcome to AESOP Afghanistan

Click the link below to log in:
${magicLink}

This link will expire in 15 minutes.

If you didn't request this link, please ignore this email.
  `;

  await sendEmail({
    to: email,
    subject: emailSubject,
    html: emailHtml,
    text: emailText
  });
}

module.exports = {
  generateAndStoreMagicLink,
  verifyMagicLink,
  sendMagicLinkEmail
};
