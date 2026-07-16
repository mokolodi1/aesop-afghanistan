const { formatErrorForLog } = require("../utils/errorLogging");
const { isDriveThrottleError } = require("../utils/driveThrottle");

const DRIVE_TRY_AGAIN_LATER_MESSAGE =
  "Your voice note is safe and submitted. We are experiencing high traffic volume and cannot play your audio right now. You may try refreshing the stream later to try again.";

const VOICE_MEMO_NOT_CACHED_MESSAGE =
  "Your voice note is safe and submitted. Audio is being prepared and should be available shortly. Please try again in a few minutes.";

/** Searchable 6-character codes for voice memo playback failures. */
const VOICE_MEMO_ERROR_CODES = {
  NOT_CACHED: "VMNC01",
  DRIVE_THROTTLED: "VMTH02",
  STREAM_ERROR: "VMSE03",
  STREAM_EXPIRED: "VMXP04",
  AUTH_REQUIRED: "VMAU05",
  NOT_FOUND: "VMNF06",
  MISSING_FILE_ID: "VMID07",
  MISSING_TOKEN: "VMTK08",
  NOT_ASSIGNED: "VMNA09",
  BAD_REQUEST: "VMBQ10",
  STREAM_PIPE: "VMPI11",
  STALE_SUBMISSION: "VMST12",
  INVALID_CREDENTIALS: "VMIN13",
  TRANSCODE_FAILED: "VMTR14",
};

/**
 * @typedef {{
 *   message: string,
 *   statusCode: number,
 *   code: string,
 *   errorCode: string,
 * }} VoiceMemoStreamErrorResolution
 */

/**
 * @param {string} message
 * @param {number} statusCode
 * @param {string} code
 * @param {string} errorCode
 * @returns {Error & { statusCode: number, code: string, errorCode: string }}
 */
function createVoiceMemoPlaybackError(message, statusCode, code, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.errorCode = errorCode;
  return error;
}

/**
 * @param {unknown} error
 * @returns {VoiceMemoStreamErrorResolution}
 */
function resolveVoiceMemoStreamError(error) {
  const err =
    error && typeof error === "object"
      ? /** @type {Error & { statusCode?: number, code?: string, errorCode?: string }} */ (error)
      : new Error(String(error ?? "Unknown voice memo stream error"));

  const message = String(err.message || "").trim();
  const statusCode = Number.isFinite(err.statusCode) ? Number(err.statusCode) : 503;
  const semanticCode = String(err.code || "").trim();
  const existingErrorCode = String(err.errorCode || "").trim();

  if (existingErrorCode && /^[A-Z0-9]{6}$/.test(existingErrorCode) && message) {
    return {
      message,
      statusCode,
      code: semanticCode || "VOICE_MEMO_STREAM_ERROR",
      errorCode: existingErrorCode,
    };
  }

  if (semanticCode === "TRANSCODE_FAILED" || semanticCode === "VOICE_MEMO_TRANSCODE_FAILED") {
    return {
      message: DRIVE_TRY_AGAIN_LATER_MESSAGE,
      statusCode: 503,
      code: "TRANSCODE_FAILED",
      errorCode: VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED,
    };
  }

  if (
    /partial file|invalid data found when processing input|incorrect codec parameters|ffmpeg exited/i.test(
      message,
    )
  ) {
    return {
      message: DRIVE_TRY_AGAIN_LATER_MESSAGE,
      statusCode: 503,
      code: "TRANSCODE_FAILED",
      errorCode: VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED,
    };
  }

  if (semanticCode === "VOICE_MEMO_NOT_CACHED" || message === VOICE_MEMO_NOT_CACHED_MESSAGE) {
    return {
      message: message || VOICE_MEMO_NOT_CACHED_MESSAGE,
      statusCode: 503,
      code: "VOICE_MEMO_NOT_CACHED",
      errorCode: VOICE_MEMO_ERROR_CODES.NOT_CACHED,
    };
  }

  if (semanticCode === "DRIVE_THROTTLED" || isDriveThrottleError(err)) {
    return {
      message: DRIVE_TRY_AGAIN_LATER_MESSAGE,
      statusCode: 503,
      code: "DRIVE_THROTTLED",
      errorCode: VOICE_MEMO_ERROR_CODES.DRIVE_THROTTLED,
    };
  }

  if (/expired/i.test(message)) {
    return {
      message,
      statusCode: statusCode === 403 ? 403 : 403,
      code: "STREAM_EXPIRED",
      errorCode: VOICE_MEMO_ERROR_CODES.STREAM_EXPIRED,
    };
  }

  if (/missing stream token/i.test(message)) {
    return {
      message,
      statusCode: 400,
      code: "MISSING_TOKEN",
      errorCode: VOICE_MEMO_ERROR_CODES.MISSING_TOKEN,
    };
  }

  if (/invalid id or email/i.test(message)) {
    return {
      message,
      statusCode: 400,
      code: "INVALID_CREDENTIALS",
      errorCode: VOICE_MEMO_ERROR_CODES.INVALID_CREDENTIALS,
    };
  }

  if (/not assigned to review/i.test(message)) {
    return {
      message,
      statusCode: 403,
      code: "NOT_ASSIGNED",
      errorCode: VOICE_MEMO_ERROR_CODES.NOT_ASSIGNED,
    };
  }

  if (/voice memo file id is required/i.test(message)) {
    return {
      message,
      statusCode: 404,
      code: "MISSING_FILE_ID",
      errorCode: VOICE_MEMO_ERROR_CODES.MISSING_FILE_ID,
    };
  }

  if (statusCode === 416 || /invalid byte range/i.test(message)) {
    return {
      message: message || "Invalid byte range.",
      statusCode: 416,
      code: "BAD_RANGE",
      errorCode: VOICE_MEMO_ERROR_CODES.BAD_REQUEST,
    };
  }

  if (statusCode === 409 || /no longer the current submission/i.test(message)) {
    return {
      message,
      statusCode: 409,
      code: "STALE_SUBMISSION",
      errorCode: VOICE_MEMO_ERROR_CODES.STALE_SUBMISSION,
    };
  }

  if (
    statusCode === 404 ||
    /not available for your account|no voice memo file was found/i.test(message)
  ) {
    return {
      message,
      statusCode: 404,
      code: "NOT_FOUND",
      errorCode: VOICE_MEMO_ERROR_CODES.NOT_FOUND,
    };
  }

  if (
    statusCode === 403 ||
    /sign in again|unable to play voice memo/i.test(message)
  ) {
    return {
      message,
      statusCode: 403,
      code: "AUTH_REQUIRED",
      errorCode: VOICE_MEMO_ERROR_CODES.AUTH_REQUIRED,
    };
  }

  if (statusCode === 400) {
    return {
      message,
      statusCode: 400,
      code: "BAD_REQUEST",
      errorCode: VOICE_MEMO_ERROR_CODES.BAD_REQUEST,
    };
  }

  if (statusCode === 403 || statusCode === 404) {
    return {
      message,
      statusCode,
      code: statusCode === 404 ? "NOT_FOUND" : "AUTH_REQUIRED",
      errorCode:
        statusCode === 404
          ? VOICE_MEMO_ERROR_CODES.NOT_FOUND
          : VOICE_MEMO_ERROR_CODES.AUTH_REQUIRED,
    };
  }

  return {
    message: DRIVE_TRY_AGAIN_LATER_MESSAGE,
    statusCode: 503,
    code: semanticCode || "STREAM_ERROR",
    errorCode: VOICE_MEMO_ERROR_CODES.STREAM_ERROR,
  };
}

/**
 * @param {unknown} error
 * @param {VoiceMemoStreamErrorResolution} resolved
 */
function logVoiceMemoStreamError(error, resolved) {
  console.error(
    `[voice-memo-stream] ${resolved.errorCode} ${resolved.code}: ${formatErrorForLog(error)}`,
  );
}

/**
 * Map a streaming failure to a safe portal error (no internal details).
 * @param {unknown} error
 * @returns {Error & { statusCode: number, code: string, errorCode: string }}
 */
function mapVoiceMemoStreamError(error) {
  const resolved = resolveVoiceMemoStreamError(error);
  return createVoiceMemoPlaybackError(
    resolved.message,
    resolved.statusCode,
    resolved.code,
    resolved.errorCode,
  );
}

module.exports = {
  VOICE_MEMO_ERROR_CODES,
  VOICE_MEMO_NOT_CACHED_MESSAGE,
  createVoiceMemoPlaybackError,
  resolveVoiceMemoStreamError,
  logVoiceMemoStreamError,
  mapVoiceMemoStreamError,
};
