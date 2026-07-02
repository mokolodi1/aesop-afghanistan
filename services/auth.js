const { findProfileById } = require('./googleSheets');
const { generateAndStoreMagicLink, sendMagicLinkEmail } = require('./magicLink');
const { sanitizeEmail, sanitizeIdentifier } = require('../utils/validation');
const { formatErrorForLog } = require('../utils/errorLogging');

/**
 * Look up user by ID in Google Sheet and send magic link if found
 * @param {string} userId - User ID to check (should be pre-validated)
 * @returns {Promise<{success: boolean, userFound: boolean}>}
 */
async function checkIdAndSendMagicLink(userId) {
  try {
    const sanitizedId = sanitizeIdentifier(userId);
    const profile = await findProfileById(sanitizedId);

    if (!profile?.email) {
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
    console.error('Error in checkIdAndSendMagicLink:', formatErrorForLog(error));
    throw error;
  }
}

module.exports = {
  checkIdAndSendMagicLink
};
