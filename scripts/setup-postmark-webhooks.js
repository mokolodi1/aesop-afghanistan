#!/usr/bin/env node
/**
 * Register or update Postmark webhooks for delivery/open/click/bounce tracking.
 *
 * Ensures each stream webhook sends the shared secret our receiver expects.
 * Requires config/secrets.json (or SECRETS_JSON) with postmark.serverToken and
 * postmark.webhookSecret.
 *
 * Usage:
 *   node scripts/setup-postmark-webhooks.js
 *   node scripts/setup-postmark-webhooks.js --dry-run
 */

require("../config/secrets");
const {
  getPostmarkToken,
  getPostmarkMessageStream,
  getPostmarkBroadcastMessageStream,
} = require("../services/postmark");
const {
  WEBHOOK_SECRET_HEADER,
  getWebhookSecret,
} = require("../services/postmarkWebhooks");

const POSTMARK_API = "https://api.postmarkapp.com";
const dryRun = process.argv.includes("--dry-run");

function resolveWebhookUrl() {
  const candidates = [
    process.env.PORTAL_BASE_URL,
    process.env.BASE_URL,
    "https://portal.aesopafghanistan.org",
  ];
  for (const value of candidates) {
    if (value != null && String(value).trim() !== "") {
      return `${String(value).trim().replace(/\/+$/, "")}/api/postmark/webhook`;
    }
  }
  throw new Error("Set PORTAL_BASE_URL or BASE_URL to the public portal origin.");
}

function defaultTriggers(messageStream) {
  const isBroadcast = messageStream === getPostmarkBroadcastMessageStream();
  return {
    Open: {
      Enabled: true,
      PostFirstOpenOnly: isBroadcast,
    },
    Click: {
      Enabled: true,
    },
    Delivery: {
      Enabled: true,
    },
    Bounce: {
      Enabled: true,
      IncludeContent: isBroadcast,
    },
    SpamComplaint: {
      Enabled: false,
      IncludeContent: false,
    },
    SubscriptionChange: {
      Enabled: false,
    },
  };
}

async function postmarkRequest(path, options = {}) {
  const token = getPostmarkToken();
  if (!token) {
    throw new Error("Postmark is not configured. Set postmark.serverToken.");
  }
  const response = await fetch(`${POSTMARK_API}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg =
      (data && (data.Message || data.ErrorCode)) ||
      `Postmark API failed (HTTP ${response.status}).`;
    throw new Error(String(msg));
  }
  return data;
}

function buildWebhookPayload({ url, messageStream, triggers }) {
  const secret = getWebhookSecret();
  if (!secret) {
    throw new Error("postmark.webhookSecret is missing. Set it in secrets before configuring webhooks.");
  }
  return {
    Url: url,
    MessageStream: messageStream,
    HttpHeaders: [
      {
        Name: WEBHOOK_SECRET_HEADER,
        Value: secret,
      },
    ],
    Triggers: triggers,
  };
}

async function listWebhooks() {
  const data = await postmarkRequest("/webhooks");
  return Array.isArray(data.Webhooks) ? data.Webhooks : [];
}

async function upsertWebhook({ url, messageStream, existing }) {
  const payload = buildWebhookPayload({
    url,
    messageStream,
    triggers: existing?.Triggers || defaultTriggers(messageStream),
  });

  if (dryRun) {
    console.log(`[dry-run] Would ${existing ? "update" : "create"} ${messageStream} webhook -> ${url}`);
    return { MessageStream: messageStream, ID: existing?.ID || "(new)" };
  }

  if (existing?.ID) {
    return postmarkRequest(`/webhooks/${existing.ID}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  return postmarkRequest("/webhooks", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function main() {
  const url = resolveWebhookUrl();
  const secret = getWebhookSecret();
  const streams = [
    getPostmarkMessageStream(),
    getPostmarkBroadcastMessageStream(),
  ];
  const uniqueStreams = [...new Set(streams.map((value) => String(value || "").trim()).filter(Boolean))];

  console.log(`Webhook URL: ${url}`);
  console.log(`Auth header: ${WEBHOOK_SECRET_HEADER} (${secret.length} char secret)`);
  if (dryRun) {
    console.log("Dry run only — no Postmark changes will be made.");
  }

  const existingWebhooks = await listWebhooks();
  for (const messageStream of uniqueStreams) {
    const existing = existingWebhooks.find((row) => row.MessageStream === messageStream);
    const result = await upsertWebhook({ url, messageStream, existing });
    console.log(
      `${existing ? "Updated" : "Created"} ${messageStream} webhook (ID ${result.ID || existing?.ID || "?"})`,
    );
  }
}

main().catch((error) => {
  console.error("Failed to configure Postmark webhooks:", error.message || error);
  process.exit(1);
});
