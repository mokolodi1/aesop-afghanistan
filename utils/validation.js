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

/**
 * Strip to digits only (no validation).
 * @param {string} value
 * @returns {string}
 */
function digitsOnly(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return value.replace(/\D/g, '');
}

/**
 * Normalize user input to Afghan MSISDN digits: `93` + 9-digit national number (11 digits total).
 * Rejects too-short or too-long digit strings (no silent truncation).
 * Accepts +93, 0093, optional separators, 9-digit mobiles starting with 7, or leading 0 domestic (07…).
 * @param {string} value
 * @returns {string} Normalized string or '' if not parseable as Afghan international format
 */
function normalizeAfghanistanPhoneDigits(value) {
  let d = digitsOnly(value);
  if (!d) {
    return '';
  }
  if (d.startsWith('0093')) {
    d = '93' + d.slice(4);
  }
  if (d.startsWith('93')) {
    if (d.length === 11) {
      return d;
    }
    return '';
  }
  if (d.length === 9 && d.startsWith('7')) {
    return `93${d}`;
  }
  if (d.length === 10 && d.startsWith('07')) {
    return `93${d.slice(1)}`;
  }
  return '';
}

/**
 * True if value is a plausible Afghanistan national number in international form (after normalization).
 * Requires leading 93 and exactly 9 further digits. Allows mobile (NSN starting with 7) or geographic (NSN starting with 2–6).
 * @param {string} value - Raw or normalized input
 * @returns {boolean}
 */
function isValidAfghanistanPhoneNumber(value) {
  const normalized = normalizeAfghanistanPhoneDigits(value);
  if (!/^93\d{9}$/.test(normalized)) {
    return false;
  }
  const nsn = normalized.slice(2);
  if (/^7\d{8}$/.test(nsn)) {
    return true;
  }
  if (/^[2-6]\d{8}$/.test(nsn)) {
    return true;
  }
  return false;
}

/** Shown next to the Ding / phone field so users know the expected shape. */
const AFGHAN_PHONE_FORMAT_HINT =
  'Afghanistan numbers only: country code 93 and exactly 9 digits after it (11 digits in total). Too few or too many digits are not accepted. Examples: 93701234567, +93 70 123 4567, or 0701234567.';

/** Wrong digits/prefix at a plausible length (hint explains accepted shapes). */
const INVALID_AFGHAN_PHONE_MESSAGE = 'That number is not in the right format.';

const AFGHAN_PHONE_TOO_SHORT_MESSAGE =
  'That number is too short. Use country code 93 and 9 digits after it (11 digits in total), or 07 followed by 9 digits, or 9 digits starting with 7.';

const AFGHAN_PHONE_TOO_LONG_MESSAGE =
  'That number is too long. Use country code 93 and exactly 9 digits after it (11 digits in total), or 07 followed by exactly 9 digits, or exactly 9 digits starting with 7.';

/**
 * When invalid, detect obvious length mismatch for the prefix the user typed.
 * @param {string} value
 * @returns {'short' | 'long' | null}
 */
function classifyAfghanPhoneLengthIssue(value) {
  let d = digitsOnly(value);
  if (!d) {
    return null;
  }
  if (d.startsWith('0093')) {
    d = `93${d.slice(4)}`;
  }
  if (d.startsWith('93')) {
    if (d.length < 11) {
      return 'short';
    }
    if (d.length > 11) {
      return 'long';
    }
    return null;
  }
  if (d.startsWith('07')) {
    if (d.length < 10) {
      return 'short';
    }
    if (d.length > 10) {
      return 'long';
    }
    return null;
  }
  if (d.startsWith('7')) {
    if (d.length < 9) {
      return 'short';
    }
    if (d.length > 9) {
      return 'long';
    }
    return null;
  }
  if (d.length > 11) {
    return 'long';
  }
  if (d.length > 0 && d.length < 9) {
    return 'short';
  }
  return null;
}

/**
 * User-facing error for an invalid Afghanistan phone (short / long / generic).
 * @param {string} value
 * @returns {string}
 */
function getAfghanistanPhoneFormatMessage(value) {
  if (isValidAfghanistanPhoneNumber(value)) {
    return '';
  }
  switch (classifyAfghanPhoneLengthIssue(value)) {
    case 'short':
      return AFGHAN_PHONE_TOO_SHORT_MESSAGE;
    case 'long':
      return AFGHAN_PHONE_TOO_LONG_MESSAGE;
    default:
      return INVALID_AFGHAN_PHONE_MESSAGE;
  }
}

function isAfghanPhoneFormatErrorMessage(msg) {
  return (
    msg === INVALID_AFGHAN_PHONE_MESSAGE ||
    msg === AFGHAN_PHONE_TOO_SHORT_MESSAGE ||
    msg === AFGHAN_PHONE_TOO_LONG_MESSAGE
  );
}

/** Second field empty on submit */
const DING_CONFIRM_REQUIRED_MESSAGE = 'Type your Ding number again to confirm.';

/** Primary and confirm fields disagree after normalization */
const DING_CONFIRM_MISMATCH_MESSAGE =
  'The two numbers do not match. Enter the same number in both fields.';

/** Max digits while typing (covers 0093 + 9-digit NSN). International form is always 11 digits after normalization. */
const AFGHAN_PHONE_MAX_INPUT_DIGITS = 13;

/**
 * Keep only characters allowed when typing an international phone (+ digits, spaces, common separators).
 * Stops accepting digits after AFGHAN_PHONE_MAX_INPUT_DIGITS so numbers cannot be typed too long.
 * @param {string} value
 * @returns {string}
 */
function filterDingPhoneInputChars(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  let out = '';
  let digitCount = 0;
  for (const ch of value) {
    if (/\d/.test(ch)) {
      if (digitCount >= AFGHAN_PHONE_MAX_INPUT_DIGITS) {
        continue;
      }
      digitCount += 1;
      out += ch;
    } else if (/[+()\s.\-]/.test(ch)) {
      out += ch;
    }
  }
  return out.slice(0, 48);
}

/** Portal “contact us” Ding help: allowed phone-ish characters only */
function sanitizePortalDingHelpPhone(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return value.replace(/[^\d+()\s.\-]/g, '').slice(0, 96).trim();
}

/** Portal help note: strip control chars, cap length */
function sanitizePortalDingHelpNote(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const ch of value.slice(0, 2000)) {
    const code = ch.charCodeAt(0);
    if (ch === '\n' || (code >= 32 && code !== 127)) {
      out += ch;
    }
  }
  return out.trim();
}

const PORTAL_DING_HELP_NEED_DETAIL_MESSAGE =
  'Enter the phone number you need for Ding, or add a short note so we can help.';

function sanitizeTicketText(value, maxLength) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value.slice(0, maxLength + 1)) {
    const code = ch.charCodeAt(0);
    if (ch === '\n' || ch === '\t' || (code >= 32 && code !== 127)) out += ch;
  }
  return out.trim().slice(0, maxLength);
}

function sanitizeTicketSubject(value) { return sanitizeTicketText(value, 200); }
function sanitizeTicketMessage(value) { return sanitizeTicketText(value, 5000); }
function sanitizeTicketCategory(value) { return sanitizeTicketText(value, 64); }
function isValidTicketStatus(value) {
  return ['open', 'waiting', 'resolved', 'closed'].includes(value);
}

module.exports = {
  isValidEmail,
  sanitizeEmail,
  isValidToken,
  sanitizeString,
  sanitizeIdentifier,
  sanitizeDingNumberInput,
  sanitizePortalDisplayName,
  normalizeAfghanistanPhoneDigits,
  isValidAfghanistanPhoneNumber,
  AFGHAN_PHONE_FORMAT_HINT,
  INVALID_AFGHAN_PHONE_MESSAGE,
  AFGHAN_PHONE_TOO_SHORT_MESSAGE,
  AFGHAN_PHONE_TOO_LONG_MESSAGE,
  getAfghanistanPhoneFormatMessage,
  isAfghanPhoneFormatErrorMessage,
  DING_CONFIRM_REQUIRED_MESSAGE,
  DING_CONFIRM_MISMATCH_MESSAGE,
  filterDingPhoneInputChars,
  sanitizePortalDingHelpPhone,
  sanitizePortalDingHelpNote,
  PORTAL_DING_HELP_NEED_DETAIL_MESSAGE,
  sanitizeTicketSubject,
  sanitizeTicketMessage,
  sanitizeTicketCategory,
  isValidTicketStatus,
};
