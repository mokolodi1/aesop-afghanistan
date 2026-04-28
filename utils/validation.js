/**
 * Validate email address format
 * @param {string} email - Email address to validate
 * @returns {boolean} True if valid
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // Basic length check
  if (email.length > 254) {
    return false;
  }

  // RFC 5322 compliant regex (simplified but safe)
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  
  return emailRegex.test(email);
}

/**
 * Sanitize email address to prevent header injection
 * Removes newlines, carriage returns, and other dangerous characters
 * @param {string} email - Email address to sanitize
 * @returns {string} Sanitized email
 */
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') {
    return '';
  }

  // Remove newlines, carriage returns, and other control characters that could be used for header injection
  return email
    .replace(/[\r\n]/g, '') // Remove newlines and carriage returns
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .trim()
    .toLowerCase()
    .slice(0, 254); // Enforce max length
}

/**
 * Validate token format (hex string, 64 characters)
 * @param {string} token - Token to validate
 * @returns {boolean} True if valid format
 */
function isValidToken(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }

  // Token should be exactly 64 hex characters (32 bytes = 64 hex chars)
  const tokenRegex = /^[a-f0-9]{64}$/i;
  return tokenRegex.test(token) && token.length === 64;
}

/**
 * Sanitize string to prevent XSS
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string
 */
function sanitizeString(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }

  return str
    .replace(/[<>]/g, '') // Remove angle brackets
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, ''); // Remove event handlers
}

/**
 * Sanitize user identifier used for sheet lookups
 * @param {string} value - Identifier to sanitize
 * @returns {string}
 */
function sanitizeIdentifier(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/[\r\n]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, 100);
}

/**
 * Sanitize ding number for sheet storage (alphanumeric and common safe chars)
 * @param {string} value
 * @returns {string}
 */
function sanitizeDingNumberInput(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/[\r\n]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, 80);
}

/**
 * Name line for the Ding changes sheet (column D)
 * @param {string} value
 * @returns {string}
 */
function sanitizePortalDisplayName(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/[\r\n]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 200);
}

module.exports = {
  isValidEmail,
  sanitizeEmail,
  isValidToken,
  sanitizeString,
  sanitizeIdentifier,
  sanitizeDingNumberInput,
  sanitizePortalDisplayName
};
