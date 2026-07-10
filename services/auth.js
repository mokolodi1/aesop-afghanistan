const { findProfileById } = require('./googleSheets');
const { generateAndStoreMagicLink, sendMagicLinkEmail, isFlyProduction } = require('./magicLink');
const { sanitizeEmail, sanitizeIdentifier } = require('../utils/validation');
const { formatErrorForLog } = require('../utils/errorLogging');
const { recordMagicLinkUnknownId, recordMagicLinkSendFailed } = require('./portalMetrics');

/**
 * Look up user by ID in Google Sheet and send magic link if found
 * @param {string} userId - User ID to check (should be pre-validated)
 * @returns {Promise<{success: boolean, userFound: boolean}>}
 */
async function checkIdAndSendMagicLink(userId) {
  try {
    const sanitizedId = sanitizeIdentifier(userId);

    let profile;
    try {
      profile = await findProfileById(sanitizedId);
    } catch (error) {
      if (isFlyProduction()) {
        throw error;
      }
      // Local dev: profile lookups routinely fail (no Postgres, no Google
      // credentials). Don't block sign-in on that — issue a link anyway.
      // Off Fly the link is only logged to the console, never emailed.
      console.warn(
        '[magic-link] profile lookup failed (local dev); logging a sign-in link anyway:',
        error.message
      );
      profile = { email: `dev+${sanitizedId || 'unknown'}@localhost`, name: '' };
    }

    if (!profile?.email) {
      recordMagicLinkUnknownId(1);
      if (!isFlyProduction()) {
        console.log(`[magic-link] no profile found for "${sanitizedId}"; no link issued.`);
      }
      return { success: true, userFound: false };
    }

    const sanitizedEmail = sanitizeEmail(profile.email);

    // Generate and store magic link
    const magicLinkData = await generateAndStoreMagicLink(sanitizedEmail, sanitizedId);

    // Send magic link email
    await sendMagicLinkEmail(sanitizedEmail, magicLinkData.token, {
      name: profile.name,
      userId: sanitizedId,
    });
    
    return { success: true, userFound: true };
  } catch (error) {
    recordMagicLinkSendFailed(1);
    if (error?.code === 'EMAIL_SEND_QUOTA_EXCEEDED') {
      console.warn('[magic-link] hourly email quota exceeded; login link not sent');
      return { success: true, userFound: false };
    }
    console.error('Error in checkIdAndSendMagicLink:', formatErrorForLog(error));
    throw error;
  }
}

module.exports = {
  checkIdAndSendMagicLink
};
