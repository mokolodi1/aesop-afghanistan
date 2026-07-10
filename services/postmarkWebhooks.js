const crypto = require("crypto");
const { eq, and, isNull } = require("drizzle-orm");
const config = require("../config/secrets");
const { getDb, isDatabaseEnabled } = require("../db/index");
const { emailCampaignRecipients } = require("../db/schema");

const WEBHOOK_SECRET_HEADER = "x-aesop-postmark-webhook-secret";

function getWebhookSecret() {
  return config.postmark?.webhookSecret || process.env.POSTMARK_WEBHOOK_SECRET || "";
}

function getWebhookUsername() {
  return (
    config.postmark?.webhookUsername ||
    process.env.POSTMARK_WEBHOOK_USERNAME ||
    "aesop"
  );
}

function parseBasicAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return null;
  }
  try {
    const decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon === -1) {
      return null;
    }
    return {
      username: decoded.slice(0, colon),
      password: decoded.slice(colon + 1),
    };
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison. Returns false for unequal lengths without
 * leaking content via timing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPostmarkWebhookAuth(req) {
  const secret = getWebhookSecret();
  if (!secret) {
    return false;
  }
  const authHeader = req.get("authorization") || "";
  if (safeEqual(authHeader, `Bearer ${secret}`)) {
    return true;
  }
  if (safeEqual(req.get(WEBHOOK_SECRET_HEADER) || "", secret)) {
    return true;
  }
  const basic = parseBasicAuth(authHeader);
  if (basic) {
    const expectedUsername = getWebhookUsername();
    if (safeEqual(basic.username, expectedUsername) && safeEqual(basic.password, secret)) {
      return true;
    }
  }
  return false;
}

function parsePostmarkTimestamp(value) {
  if (!value) {
    return new Date();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeMetadata(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw;
}

async function findRecipientForWebhook(payload) {
  const db = getDb();
  if (!db) {
    return null;
  }

  const messageId =
    typeof payload.MessageID === "string" ? payload.MessageID.trim() : "";
  if (messageId) {
    const byMessageId = await db
      .select()
      .from(emailCampaignRecipients)
      .where(eq(emailCampaignRecipients.postmarkMessageId, messageId))
      .limit(1);
    if (byMessageId[0]) {
      return byMessageId[0];
    }
  }

  const metadata = normalizeMetadata(payload.Metadata);
  const recipientIdRaw = metadata.recipientId ?? metadata.recipient_id;
  const recipientId = Number.parseInt(String(recipientIdRaw ?? ""), 10);
  if (Number.isFinite(recipientId) && recipientId > 0) {
    const byRecipientId = await db
      .select()
      .from(emailCampaignRecipients)
      .where(eq(emailCampaignRecipients.id, recipientId))
      .limit(1);
    if (byRecipientId[0]) {
      return byRecipientId[0];
    }
  }

  return null;
}

/**
 * @param {Record<string, unknown>} payload
 */
async function handlePostmarkWebhook(payload) {
  if (!isDatabaseEnabled()) {
    return { handled: false, reason: "database_disabled" };
  }

  const recordType = typeof payload.RecordType === "string" ? payload.RecordType.trim() : "";
  const messageStream =
    typeof payload.MessageStream === "string" ? payload.MessageStream.trim() : "";
  const allowedStreams = new Set(
    [
      config.email?.postmark?.messageStream,
      config.email?.postmark?.broadcastMessageStream,
      process.env.POSTMARK_MESSAGE_STREAM,
      process.env.POSTMARK_BROADCAST_MESSAGE_STREAM,
      "outbound",
      "broadcast",
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  if (messageStream && !allowedStreams.has(messageStream)) {
    return { handled: false, reason: "ignored_stream" };
  }
  if (!recordType) {
    return { handled: false, reason: "missing_record_type" };
  }

  const recipient = await findRecipientForWebhook(payload);
  if (!recipient) {
    return { handled: false, reason: "recipient_not_found" };
  }

  const db = getDb();
  const messageId =
    typeof payload.MessageID === "string" ? payload.MessageID.trim() : "";

  if (recordType === "Delivery") {
    await db
      .update(emailCampaignRecipients)
      .set({
        postmarkMessageId: messageId || recipient.postmarkMessageId,
        deliveredAt: parsePostmarkTimestamp(payload.DeliveredAt),
      })
      .where(
        and(
          eq(emailCampaignRecipients.id, recipient.id),
          isNull(emailCampaignRecipients.deliveredAt),
        ),
      );
    return { handled: true, recordType, recipientId: recipient.id };
  }

  if (recordType === "Open") {
    await db
      .update(emailCampaignRecipients)
      .set({
        postmarkMessageId: messageId || recipient.postmarkMessageId,
        openedAt: parsePostmarkTimestamp(payload.ReceivedAt),
      })
      .where(
        and(eq(emailCampaignRecipients.id, recipient.id), isNull(emailCampaignRecipients.openedAt)),
      );
    return { handled: true, recordType, recipientId: recipient.id };
  }

  if (recordType === "Click") {
    await db
      .update(emailCampaignRecipients)
      .set({
        postmarkMessageId: messageId || recipient.postmarkMessageId,
        clickedAt: parsePostmarkTimestamp(payload.ReceivedAt),
      })
      .where(
        and(eq(emailCampaignRecipients.id, recipient.id), isNull(emailCampaignRecipients.clickedAt)),
      );
    return { handled: true, recordType, recipientId: recipient.id };
  }

  if (recordType === "Bounce") {
    const description =
      typeof payload.Description === "string"
        ? payload.Description.trim()
        : "Email bounced.";
    await db
      .update(emailCampaignRecipients)
      .set({
        postmarkMessageId: messageId || recipient.postmarkMessageId,
        status: "bounced",
        bouncedAt: parsePostmarkTimestamp(payload.BouncedAt),
        error: description,
      })
      .where(eq(emailCampaignRecipients.id, recipient.id));
    return { handled: true, recordType, recipientId: recipient.id };
  }

  return { handled: false, reason: "unsupported_record_type", recordType };
}

module.exports = {
  WEBHOOK_SECRET_HEADER,
  verifyPostmarkWebhookAuth,
  handlePostmarkWebhook,
  getWebhookSecret,
  getWebhookUsername,
};
