const config = require("../config/secrets");

const POSTMARK_API = "https://api.postmarkapp.com";

/**
 * Resolve the Postmark Server API token from any supported config location.
 * Primary: secrets.postmark.serverToken (or POSTMARK_SERVER_TOKEN env).
 * Legacy: secrets.email.postmark.serverToken (Postmark branch layout).
 */
function getPostmarkToken() {
  const topLevel = config.postmark?.serverToken;
  if (topLevel != null && String(topLevel).trim() !== "") {
    return String(topLevel).trim();
  }
  const nested = config.email?.postmark?.serverToken;
  if (nested != null && String(nested).trim() !== "") {
    return String(nested).trim();
  }
  const fromEnv = process.env.POSTMARK_SERVER_TOKEN;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    return String(fromEnv).trim();
  }
  return "";
}

function getPostmarkMessageStream() {
  const nested = config.email?.postmark?.messageStream;
  if (nested != null && String(nested).trim() !== "") {
    return String(nested).trim();
  }
  const fromEnv = process.env.POSTMARK_MESSAGE_STREAM;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    return String(fromEnv).trim();
  }
  return "outbound";
}

function getFromAddress() {
  return config.email?.from || process.env.EMAIL_FROM || "noreply@aesopafghanistan.org";
}

function assertPostmarkConfigured() {
  const token = getPostmarkToken();
  if (!token) {
    throw new Error("Postmark is not configured. Set POSTMARK_SERVER_TOKEN.");
  }
  return token;
}

/**
 * @param {{ to: string, subject: string, text: string, html: string }} message
 */
async function sendPostmarkEmail(message) {
  const token = assertPostmarkConfigured();
  const response = await fetch(`${POSTMARK_API}/email`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: getFromAddress(),
      To: message.to,
      Subject: message.subject,
      TextBody: message.text,
      HtmlBody: message.html,
      MessageStream: "outbound",
      TrackOpens: message.trackOpens !== false,
      Tag: message.tag || undefined,
      Metadata: message.metadata || undefined,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg =
      (data && (data.Message || data.ErrorCode)) ||
      `Postmark send failed (HTTP ${response.status}).`;
    throw new Error(String(msg));
  }
  return data;
}

/**
 * @param {Array<{ to: string, subject: string, text: string, html: string }>} messages
 */
async function sendPostmarkBatch(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  if (messages.length > 500) {
    throw new Error("Postmark batch limit is 500 messages per request.");
  }

  const token = assertPostmarkConfigured();
  const from = getFromAddress();
  const response = await fetch(`${POSTMARK_API}/email/batch`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify(
      messages.map((message) => ({
        From: from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        HtmlBody: message.html,
        MessageStream: "outbound",
        TrackOpens: message.trackOpens !== false,
        Tag: message.tag || undefined,
        Metadata: message.metadata || undefined,
      })),
    ),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg =
      (data && (data.Message || data.ErrorCode)) ||
      `Postmark batch send failed (HTTP ${response.status}).`;
    throw new Error(String(msg));
  }
  return Array.isArray(data) ? data : [];
}

module.exports = {
  sendPostmarkEmail,
  sendPostmarkBatch,
  getPostmarkToken,
  getPostmarkMessageStream,
};
