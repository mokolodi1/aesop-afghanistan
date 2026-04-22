const { checkEmailInSheet } = require('./googleSheets');
const { generateAndStoreMagicLink, sendMagicLinkEmail } = require('./magicLink');
const { sanitizeEmail } = require('../utils/validation');

/**
 * Check if email exists in Google Sheet and send magic link if it does
 * @param {string} email - Email address to check (should be pre-validated)
 * @returns {Promise<{success: boolean, emailFound: boolean}>}
 */
async function checkEmailAndSendMagicLink(email) {
  try {
    // Ensure email is sanitized (should already be done, but double-check)
    const sanitizedEmail = sanitizeEmail(email);
    
    // Check if email exists in Google Sheet
    const emailFound = await checkEmailInSheet(sanitizedEmail);
    
    if (!emailFound) {
      // Email not found, but we don't reveal this to prevent enumeration
      return { success: true, emailFound: false };
    }

    // Generate and store magic link
    const magicLinkData = await generateAndStoreMagicLink(sanitizedEmail);
    
    // Send magic link email
    await sendMagicLinkEmail(sanitizedEmail, magicLinkData.token);
    
    return { success: true, emailFound: true };
  } catch (error) {
    // Don't expose email in error logs
    console.error('Error in checkEmailAndSendMagicLink:', error.message);
    throw error;
  }
}

module.exports = {
  checkEmailAndSendMagicLink
};
