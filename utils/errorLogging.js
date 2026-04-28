function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return "[unserializable]";
  }
}

function formatGoogleApiError(error) {
  if (!error) {
    return "Unknown Google API error";
  }

  const status = error.response?.status || error.status || "unknown-status";
  const statusText = error.response?.statusText || error.statusText || "unknown-status-text";
  const code = error.code || error.response?.data?.error?.code || "unknown-code";
  const apiMessage =
    error.response?.data?.error?.message ||
    error.response?.data?.error_description ||
    error.message ||
    "No error message";

  const reason =
    error.response?.data?.error?.errors?.[0]?.reason ||
    error.response?.data?.error?.status ||
    "unknown-reason";

  const payload =
    error.response?.data && Object.keys(error.response.data).length > 0
      ? safeStringify(error.response.data)
      : "no-response-payload";

  const invalidGrantHint =
    error.response?.data?.error === "invalid_grant"
      ? " hint=invalid_grant: verify service-account key is valid/not-rotated, server clock is synced, and auth flow/credentials source is correct."
      : "";

  return `Google API error [status=${status} ${statusText}] [code=${code}] [reason=${reason}] ${apiMessage} | payload=${payload}${invalidGrantHint}`;
}

function formatErrorForLog(error) {
  if (!error) {
    return "Unknown error";
  }

  if (error.stack) {
    return error.stack;
  }

  if (error.message) {
    return error.message;
  }

  return safeStringify(error);
}

function formatGmailAuthError(error, delegatedUser) {
  const base = formatGoogleApiError(error);
  const message = String(error?.message || "").toLowerCase();
  const isInvalidGrant =
    error?.response?.data?.error === "invalid_grant" ||
    message.includes("invalid_grant");

  if (!isInvalidGrant) {
    return base;
  }

  return `${base} hint=gmail-service-account-delegation: verify delegatedUser="${delegatedUser || "missing"}" exists in your Workspace domain, Gmail is enabled for that user, and Admin Console Domain-Wide Delegation includes scope https://www.googleapis.com/auth/gmail.send for this service account client ID.`;
}

/**
 * @param {import('axios').AxiosError} error
 * @returns {boolean}
 */
function isGoogleSheetsForbidden(error) {
  return error?.response?.status === 403;
}

/**
 * @param {import('axios').AxiosError} error
 * @returns {string}
 */
function formatGoogleSheetsWriteErrorForLog(error) {
  const base = formatGoogleApiError(error);
  if (isGoogleSheetsForbidden(error)) {
    return `${base} hint=sheets-write-403: share the spreadsheet with the service account (client_email in credentials) with role Editor, not Viewer; in Google Cloud enable "Google Sheets API" for the project; verify the app uses scope https://www.googleapis.com/auth/spreadsheets.`;
  }
  return base;
}

module.exports = {
  formatGoogleApiError,
  formatErrorForLog,
  formatGmailAuthError,
  formatGoogleSheetsWriteErrorForLog,
  isGoogleSheetsForbidden,
};
