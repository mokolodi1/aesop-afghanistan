const crypto = require("crypto");
const { eq, and, lte, asc, sql, isNotNull } = require("drizzle-orm");
const config = require("../config/secrets");
const { getDb, isDatabaseEnabled } = require("../db/index");
const {
  emailAdminTests,
  emailCampaigns,
  emailCampaignRecipients,
} = require("../db/schema");
const {
  loadAdmissionsSheet,
  filterAdmissionsRows,
  getAdmissionsFilterOptions,
} = require("./googleSheets");
const { sendPostmarkEmail, sendPostmarkBatch } = require("./postmark");
const { escapeHtml, wrapAesopEmail } = require("./emailBranding");

const PLACEHOLDER_RE = /\[\[([^\]]+)\]\]/g;
const BATCH_SIZE = 250;
const BATCH_INTERVAL_MS = 5 * 60 * 1000;

const BUILTIN_RESOLVERS = {
  "aesop id": (recipient) => recipient.id || "",
  name: (recipient) => recipient.name || "",
  email: (recipient) => recipient.email || "",
};

const IDENTITY_PLACEHOLDERS = new Set(["aesop id", "name", "email"]);

function assertDatabaseForCampaigns() {
  if (!isDatabaseEnabled() || !getDb()) {
    const error = new Error("Bulk email campaigns require a configured database.");
    error.statusCode = 503;
    throw error;
  }
}

function normalizeFilter(filter) {
  if (!filter || typeof filter !== "object") {
    return null;
  }
  const column = typeof filter.column === "string" ? filter.column.trim() : "";
  const values = Array.isArray(filter.values)
    ? filter.values.map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];
  if (!column || values.length === 0) {
    return null;
  }
  return { column, values };
}

function normalizeGlobalVars(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key).trim();
    if (!k) {
      continue;
    }
    out[k] = String(value ?? "");
  }
  return out;
}

/** JSONB columns may already be objects when read from Postgres. */
function parseJsonColumn(value, fallback = {}) {
  if (value == null || value === "") {
    return fallback;
  }
  if (typeof value === "object") {
    return value;
  }
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return fallback;
}

function extractPlaceholders(subject, body) {
  const found = new Set();
  for (const text of [subject, body]) {
    if (typeof text !== "string") {
      continue;
    }
    let match;
    const re = new RegExp(PLACEHOLDER_RE.source, "g");
    while ((match = re.exec(text)) !== null) {
      found.add(match[1].trim());
    }
  }
  return Array.from(found);
}

function classifyPlaceholder(name, sheetHeaders = []) {
  const lower = String(name).trim().toLowerCase();
  if (IDENTITY_PLACEHOLDERS.has(lower)) {
    return "identity";
  }
  const headerMatch = sheetHeaders.find((h) => h.toLowerCase() === lower);
  if (headerMatch) {
    return "row";
  }
  return "global";
}

function resolvePlaceholder(name, recipient, globalVars) {
  const trimmed = String(name).trim();
  const lower = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BUILTIN_RESOLVERS, lower)) {
    return BUILTIN_RESOLVERS[lower](recipient);
  }
  if (recipient.fields) {
    if (Object.prototype.hasOwnProperty.call(recipient.fields, trimmed)) {
      return recipient.fields[trimmed];
    }
    for (const [key, value] of Object.entries(recipient.fields)) {
      if (key.toLowerCase() === lower) {
        return value;
      }
    }
  }
  if (globalVars) {
    if (Object.prototype.hasOwnProperty.call(globalVars, trimmed)) {
      return globalVars[trimmed];
    }
    for (const [key, value] of Object.entries(globalVars)) {
      if (key.toLowerCase() === lower) {
        return value;
      }
    }
  }
  return `[[${trimmed}]]`;
}

function renderTemplate(template, recipient, globalVars) {
  if (typeof template !== "string") {
    return "";
  }
  return template.replace(PLACEHOLDER_RE, (_match, name) =>
    resolvePlaceholder(name, recipient, globalVars),
  );
}

function textToHtmlParagraphs(text) {
  const normalized = String(text || "");
  if (!normalized.trim()) {
    return `<p style="margin:0;">&nbsp;</p>`;
  }
  return normalized
    .split(/\n\n+/)
    .map((paragraph) => {
      const escaped = escapeHtml(paragraph).replace(/\n/g, "<br />");
      return `<p style="margin:0 0 16px;">${escaped}</p>`;
    })
    .join("");
}

function buildEmailBodies(subject, body, recipient, globalVars) {
  const renderedSubject = renderTemplate(subject, recipient, globalVars);
  const renderedText = renderTemplate(body, recipient, globalVars);
  const innerHtml = textToHtmlParagraphs(renderedText);
  const renderedHtml = wrapAesopEmail(innerHtml, { title: renderedSubject });
  return {
    subject: renderedSubject,
    text: renderedText,
    html: renderedHtml,
  };
}

function computeContentHash({ group, subject, body, globalVars, filter }) {
  const payload = JSON.stringify({
    group,
    subject: String(subject || ""),
    body: String(body || ""),
    globalVars: normalizeGlobalVars(globalVars),
    filter: normalizeFilter(filter),
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

async function resolveAdmissionsRecipients(filter) {
  const sheetData = await loadAdmissionsSheet();
  const filtered = filterAdmissionsRows(sheetData.rows, normalizeFilter(filter));
  const seen = new Set();
  const recipients = [];
  for (const row of filtered) {
    const emailKey = String(row.email || "")
      .trim()
      .toLowerCase();
    if (!emailKey || seen.has(emailKey)) {
      continue;
    }
    seen.add(emailKey);
    recipients.push(row);
  }
  return { sheetData, recipients };
}

function getEmailGroups() {
  return [
    { id: "admissions", label: "Admissions", enabled: true },
    { id: "students", label: "Students", enabled: false },
  ];
}

async function getAdmissionsMetadata() {
  const sheetData = await loadAdmissionsSheet();
  const filterOptions = getAdmissionsFilterOptions(sheetData);
  return {
    sheetName: config.googleSheets?.admissionsSheetName || "Admissions",
    totalRows: sheetData.rows.length,
    ...filterOptions,
  };
}

async function previewEmailRecipients({ group, filter }) {
  if (group !== "admissions") {
    return { recipients: [], count: 0, filter: normalizeFilter(filter) };
  }
  const { recipients } = await resolveAdmissionsRecipients(filter);
  return {
    recipients: recipients.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      fields: row.fields,
    })),
    count: recipients.length,
    filter: normalizeFilter(filter),
  };
}

function validateComposePayload(payload) {
  const group = typeof payload.group === "string" ? payload.group.trim() : "";
  const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const globalVars = normalizeGlobalVars(payload.globalVars);
  const filter = normalizeFilter(payload.filter);

  if (group !== "admissions") {
    const error = new Error("Only the Admissions group is available right now.");
    error.statusCode = 400;
    throw error;
  }
  if (!subject) {
    const error = new Error("Subject is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!body) {
    const error = new Error("Message body is required.");
    error.statusCode = 400;
    throw error;
  }

  return { group, subject, body, globalVars, filter };
}

async function sendAdminEmailTest(adminEmail, payload) {
  assertDatabaseForCampaigns();
  const { group, subject, body, globalVars, filter } = validateComposePayload(payload);
  const { recipients } = await resolveAdmissionsRecipients(filter);
  if (recipients.length === 0) {
    const error = new Error("No recipients match the current filter.");
    error.statusCode = 400;
    throw error;
  }

  const previewRecipient = recipients[0];
  const emailBodies = buildEmailBodies(subject, body, previewRecipient, globalVars);
  const testSubject = `[TEST] ${emailBodies.subject}`;

  await sendPostmarkEmail({
    to: adminEmail,
    subject: testSubject,
    text: emailBodies.text,
    html: emailBodies.html,
  });

  const contentHash = computeContentHash({ group, subject, body, globalVars, filter });
  const db = getDb();
  const now = new Date();

  await db
    .insert(emailAdminTests)
    .values({
      adminEmail: adminEmail.toLowerCase(),
      contentHash,
      testSentAt: now,
      testSentTo: adminEmail,
    })
    .onConflictDoUpdate({
      target: [emailAdminTests.adminEmail, emailAdminTests.contentHash],
      set: {
        testSentAt: now,
        testSentTo: adminEmail,
      },
    });

  return {
    contentHash,
    testSentAt: now.toISOString(),
    previewRecipient: {
      id: previewRecipient.id,
      name: previewRecipient.name,
      email: previewRecipient.email,
      fields: previewRecipient.fields,
    },
  };
}

async function verifyAdminEmailTest(adminEmail, contentHash) {
  const db = getDb();
  const rows = await db
    .select()
    .from(emailAdminTests)
    .where(
      and(
        eq(emailAdminTests.adminEmail, adminEmail.toLowerCase()),
        eq(emailAdminTests.contentHash, contentHash),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function startAdminEmailCampaign(adminEmail, payload) {
  assertDatabaseForCampaigns();
  const { group, subject, body, globalVars, filter } = validateComposePayload(payload);
  const contentHash = computeContentHash({ group, subject, body, globalVars, filter });

  const tested = await verifyAdminEmailTest(adminEmail, contentHash);
  if (!tested) {
    const error = new Error("Send a test email for this message and filter before sending.");
    error.statusCode = 400;
    throw error;
  }

  const { recipients } = await resolveAdmissionsRecipients(filter);
  if (recipients.length === 0) {
    const error = new Error("No recipients match the current filter.");
    error.statusCode = 400;
    throw error;
  }

  const db = getDb();
  const now = new Date();
  const filterJson = filter ? JSON.stringify(filter) : null;
  const globalVarsJson = JSON.stringify(globalVars);

  const [campaign] = await db
    .insert(emailCampaigns)
    .values({
      createdByEmail: adminEmail.toLowerCase(),
      recipientGroup: group,
      subject,
      body,
      globalVars: globalVarsJson,
      recipientFilter: filterJson,
      contentHash,
      testSentAt: now,
      testSentTo: adminEmail,
      status: "sending",
      totalRecipients: recipients.length,
      sentCount: 0,
      failedCount: 0,
      nextBatchAt: now,
      createdAt: now,
    })
    .returning({ id: emailCampaigns.id });

  await db.insert(emailCampaignRecipients).values(
    recipients.map((row) => ({
      campaignId: campaign.id,
      aesopId: row.id,
      name: row.name,
      email: row.email,
      rowFields: JSON.stringify(row.fields || {}),
      status: "pending",
    })),
  );

  await processEmailCampaignBatches();

  return {
    campaignId: campaign.id,
    totalRecipients: recipients.length,
    batchSize: BATCH_SIZE,
    batchIntervalMinutes: BATCH_INTERVAL_MS / 60_000,
  };
}

async function getAdminEmailCampaignStatus(campaignId) {
  assertDatabaseForCampaigns();
  const db = getDb();
  const rows = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, campaignId))
    .limit(1);
  const campaign = rows[0];
  if (!campaign) {
    const error = new Error("Campaign not found.");
    error.statusCode = 404;
    throw error;
  }

  const pendingRows = await db
    .select({ count: sql`count(*)::int` })
    .from(emailCampaignRecipients)
    .where(
      and(
        eq(emailCampaignRecipients.campaignId, campaignId),
        eq(emailCampaignRecipients.status, "pending"),
      ),
    );
  const pendingCount = pendingRows[0]?.count ?? 0;

  const [deliveredRows, openedRows, bouncedRows] = await Promise.all([
    db
      .select({ count: sql`count(*)::int` })
      .from(emailCampaignRecipients)
      .where(
        and(
          eq(emailCampaignRecipients.campaignId, campaignId),
          isNotNull(emailCampaignRecipients.deliveredAt),
        ),
      ),
    db
      .select({ count: sql`count(*)::int` })
      .from(emailCampaignRecipients)
      .where(
        and(
          eq(emailCampaignRecipients.campaignId, campaignId),
          isNotNull(emailCampaignRecipients.openedAt),
        ),
      ),
    db
      .select({ count: sql`count(*)::int` })
      .from(emailCampaignRecipients)
      .where(
        and(eq(emailCampaignRecipients.campaignId, campaignId), eq(emailCampaignRecipients.status, "bounced")),
      ),
  ]);

  return {
    campaignId: campaign.id,
    status: campaign.status,
    totalRecipients: campaign.totalRecipients,
    sentCount: campaign.sentCount,
    failedCount: campaign.failedCount,
    deliveredCount: deliveredRows[0]?.count ?? 0,
    openedCount: openedRows[0]?.count ?? 0,
    bouncedCount: bouncedRows[0]?.count ?? 0,
    pendingCount,
    nextBatchAt: campaign.nextBatchAt ? new Date(campaign.nextBatchAt).toISOString() : null,
    completedAt: campaign.completedAt ? new Date(campaign.completedAt).toISOString() : null,
    batchSize: BATCH_SIZE,
    batchIntervalMinutes: BATCH_INTERVAL_MS / 60_000,
  };
}

async function processEmailCampaignBatches() {
  if (!isDatabaseEnabled()) {
    return { processedCampaigns: 0 };
  }
  const db = getDb();
  if (!db) {
    return { processedCampaigns: 0 };
  }

  const now = new Date();
  const dueCampaigns = await db
    .select()
    .from(emailCampaigns)
    .where(and(eq(emailCampaigns.status, "sending"), lte(emailCampaigns.nextBatchAt, now)));

  for (const campaign of dueCampaigns) {
    await processSingleCampaignBatch(campaign);
  }

  return { processedCampaigns: dueCampaigns.length };
}

async function processSingleCampaignBatch(campaign) {
  const db = getDb();
  const globalVars = normalizeGlobalVars(parseJsonColumn(campaign.globalVars, {}));
  const pending = await db
    .select()
    .from(emailCampaignRecipients)
    .where(
      and(
        eq(emailCampaignRecipients.campaignId, campaign.id),
        eq(emailCampaignRecipients.status, "pending"),
      ),
    )
    .orderBy(asc(emailCampaignRecipients.id))
    .limit(BATCH_SIZE);

  if (pending.length === 0) {
    await db
      .update(emailCampaigns)
      .set({
        status: "completed",
        nextBatchAt: null,
        completedAt: new Date(),
      })
      .where(eq(emailCampaigns.id, campaign.id));
    return;
  }

  const batchNumber =
    Math.floor((campaign.sentCount + campaign.failedCount) / BATCH_SIZE) + 1;
  const messages = [];
  const messageRecipients = [];

  for (const row of pending) {
    const recipient = {
      id: row.aesopId || "",
      name: row.name || "",
      email: row.email,
      fields: parseJsonColumn(row.rowFields, {}),
    };
    const bodies = buildEmailBodies(campaign.subject, campaign.body, recipient, globalVars);
    messages.push({
      to: row.email,
      subject: bodies.subject,
      text: bodies.text,
      html: bodies.html,
      metadata: {
        campaignId: String(campaign.id),
        recipientId: String(row.id),
      },
      tag: `aesop-campaign-${campaign.id}`,
    });
    messageRecipients.push(row);
  }

  let sentCount = 0;
  let failedCount = 0;
  const now = new Date();

  try {
    const results = await sendPostmarkBatch(messages);
    for (let i = 0; i < messageRecipients.length; i += 1) {
      const row = messageRecipients[i];
      const result = results[i];
      const ok = result && result.ErrorCode === 0;
      if (ok) {
        sentCount += 1;
        await db
          .update(emailCampaignRecipients)
          .set({
            status: "sent",
            sentAt: now,
            batchNumber,
            postmarkMessageId: result?.MessageID || null,
            error: null,
          })
          .where(eq(emailCampaignRecipients.id, row.id));
      } else {
        failedCount += 1;
        await db
          .update(emailCampaignRecipients)
          .set({
            status: "failed",
            sentAt: now,
            batchNumber,
            error: result?.Message || "Postmark send failed.",
          })
          .where(eq(emailCampaignRecipients.id, row.id));
      }
    }
  } catch (error) {
    failedCount = messageRecipients.length;
    for (const row of messageRecipients) {
      await db
        .update(emailCampaignRecipients)
        .set({
          status: "failed",
          sentAt: now,
          batchNumber,
          error: error.message || "Postmark batch send failed.",
        })
        .where(eq(emailCampaignRecipients.id, row.id));
    }
  }

  const remainingRows = await db
    .select({ count: sql`count(*)::int` })
    .from(emailCampaignRecipients)
    .where(
      and(
        eq(emailCampaignRecipients.campaignId, campaign.id),
        eq(emailCampaignRecipients.status, "pending"),
      ),
    );
  const remaining = remainingRows[0]?.count ?? 0;
  const nextBatchAt = remaining > 0 ? new Date(Date.now() + BATCH_INTERVAL_MS) : null;

  await db
    .update(emailCampaigns)
    .set({
      sentCount: campaign.sentCount + sentCount,
      failedCount: campaign.failedCount + failedCount,
      nextBatchAt,
      status: remaining > 0 ? "sending" : "completed",
      completedAt: remaining > 0 ? null : new Date(),
    })
    .where(eq(emailCampaigns.id, campaign.id));
}

function startEmailCampaignWorker() {
  processEmailCampaignBatches().catch((error) => {
    console.error("[email-campaigns] initial batch processing failed:", error.message);
  });
  setInterval(() => {
    processEmailCampaignBatches().catch((error) => {
      console.error("[email-campaigns] batch processing failed:", error.message);
    });
  }, BATCH_INTERVAL_MS);
}

module.exports = {
  BATCH_SIZE,
  BATCH_INTERVAL_MS,
  extractPlaceholders,
  classifyPlaceholder,
  renderTemplate,
  computeContentHash,
  getEmailGroups,
  getAdmissionsMetadata,
  previewEmailRecipients,
  sendAdminEmailTest,
  startAdminEmailCampaign,
  getAdminEmailCampaignStatus,
  processEmailCampaignBatches,
  startEmailCampaignWorker,
};
