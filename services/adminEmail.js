const crypto = require("crypto");
const { eq, and, lte, desc, sql, isNotNull } = require("drizzle-orm");
const config = require("../config/secrets");
const { getDb, isDatabaseEnabled, getPool } = require("../db/index");
const {
  emailAdminTests,
  emailCampaigns,
  emailCampaignRecipients,
} = require("../db/schema");
const {
  loadAdmissionsSheet,
  filterAdmissionsRows,
  getAdmissionsFilterOptions,
  analyzeDuplicateApplicantEmails,
  withApplicantRecipientEmails,
  loadReviewerEmailRecipients,
} = require("./googleSheets");
const { sendPostmarkEmail, sendPostmarkBatch, getPostmarkMessageStream, getPostmarkBroadcastMessageStream } = require("./postmark");
const { formatEmailBodyHtml, wrapAesopEmail } = require("./emailBranding");

const PLACEHOLDER_RE = /\[\[([^\]]+)\]\]|\{\{([^}]+)\}\}/g;
const BATCH_SIZE = 100;
const BATCH_INTERVAL_MS = 5 * 60 * 1000;
const SEND_PRIORITY_TRANSACTIONAL = 0;
const SEND_PRIORITY_BROADCAST = 1;

/**
 * Print AESOP IDs to server logs in fixed-size lots for grep-friendly tracing.
 * @param {string} prefix
 * @param {string} label
 * @param {Array<{ aesopId?: string, id?: number, email?: string }>} rows
 * @param {{ lotSize?: number, includeEmail?: boolean }} [options]
 */
function logCampaignRecipientIdsInLots(prefix, label, rows, options = {}) {
  const lotSize = options.lotSize ?? 40;
  const includeEmail = options.includeEmail === true;
  const entries = rows
    .map((row) => {
      const aesopId = String(row?.aesopId || "").trim();
      const fallback = row?.id != null ? `recipient#${row.id}` : "";
      const id = aesopId || fallback;
      if (!id) {
        return "";
      }
      if (includeEmail) {
        const email = String(row?.email || "").trim();
        return email ? `${id} <${email}>` : id;
      }
      return id;
    })
    .filter(Boolean);
  if (entries.length === 0) {
    return;
  }
  const totalLots = Math.ceil(entries.length / lotSize);
  for (let lotIndex = 0; lotIndex < totalLots; lotIndex += 1) {
    const lot = entries.slice(lotIndex * lotSize, (lotIndex + 1) * lotSize);
    const lotLabel = totalLots > 1 ? ` (lot ${lotIndex + 1}/${totalLots})` : "";
    console.warn(`${prefix} ${label}${lotLabel}: ${lot.join(", ")}`);
  }
}

function estimateCampaignDurationMs(totalRecipients) {
  if (totalRecipients <= 0) {
    return 0;
  }
  const batches = Math.ceil(totalRecipients / BATCH_SIZE);
  return (batches - 1) * BATCH_INTERVAL_MS;
}

function estimateCampaignCompletionAt(pendingCount, nextBatchAt) {
  if (pendingCount <= 0) {
    return null;
  }
  const batchesRemaining = Math.ceil(pendingCount / BATCH_SIZE);
  const nextAtMs = nextBatchAt ? new Date(nextBatchAt).getTime() : Date.now();
  const waitMs = Math.max(0, nextAtMs - Date.now());
  return new Date(Date.now() + waitMs + (batchesRemaining - 1) * BATCH_INTERVAL_MS);
}

async function tryAcquireCampaignLock(campaignId) {
  const pool = getPool();
  if (!pool) {
    return false;
  }
  const { rows } = await pool.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [
    campaignId,
  ]);
  return rows[0]?.acquired === true;
}

async function releaseCampaignLock(campaignId) {
  const pool = getPool();
  if (!pool) {
    return;
  }
  await pool.query("SELECT pg_advisory_unlock($1::bigint)", [campaignId]);
}

/**
 * Atomically claim pending recipients so concurrent workers skip locked rows.
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function claimPendingRecipients(campaignId, limit) {
  const pool = getPool();
  if (!pool) {
    return [];
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id
       FROM email_campaign_recipients
       WHERE campaign_id = $1 AND status = 'pending'
       ORDER BY send_priority ASC, id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [campaignId, limit],
    );
    if (selected.rows.length === 0) {
      await client.query("COMMIT");
      return [];
    }
    const ids = selected.rows.map((row) => row.id);
    const claimed = await client.query(
      `UPDATE email_campaign_recipients
       SET status = 'processing'
       WHERE id = ANY($1::int[])
       RETURNING *`,
      [ids],
    );
    await client.query("COMMIT");
    return claimed.rows.map(mapRecipientRow);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function mapRecipientRow(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    aesopId: row.aesop_id,
    name: row.name,
    email: row.email,
    rowFields: row.row_fields,
    status: row.status,
    sentAt: row.sent_at,
    postmarkMessageId: row.postmark_message_id,
    batchNumber: row.batch_number,
    sendPriority: row.send_priority ?? SEND_PRIORITY_BROADCAST,
  };
}

function duplicateApplicantIdSet(rows) {
  const { duplicateEmailSkips } = analyzeDuplicateApplicantEmails(rows);
  return new Set(
    duplicateEmailSkips
      .map((skip) => String(skip.id || "").trim())
      .filter(Boolean),
  );
}

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

const REVIEW_IN_ROUND_2_COLUMN = "Review in Round 2";
const ROUND_1_COLUMN = "Round 1";
const ROUND_1_ACCEPTED_VALUE = "Accepted";

/**
 * @param {{ column: string, values: string[] }| { filters: Array<{ column: string, values: string[] }> } | { aesopIds: string[] } | null} filter
 * @returns {string}
 */
function describeAdmissionsFilter(filter) {
  if (!filter) {
    return "all";
  }
  if (Array.isArray(filter.aesopIds)) {
    return `aesopIds (${filter.aesopIds.length} id(s))`;
  }
  if (Array.isArray(filter.filters)) {
    return filter.filters
      .map((part) => `${part.column}=${(part.values || []).join(",")}`)
      .join(" AND ");
  }
  if (filter.column && Array.isArray(filter.values)) {
    return `${filter.column}=${filter.values.join(",")}`;
  }
  return "all";
}

function normalizeFilter(filter) {
  if (!filter || typeof filter !== "object") {
    return null;
  }
  if (Array.isArray(filter.aesopIds)) {
    const aesopIds = filter.aesopIds
      .map((id) => String(id ?? "").trim())
      .filter(Boolean);
    if (aesopIds.length > 0) {
      return { aesopIds };
    }
  }

  /** @type {Array<{ column: string, values: string[] }>} */
  const filters = [];
  const pushPart = (part) => {
    if (!part || typeof part !== "object") {
      return;
    }
    const column = typeof part.column === "string" ? part.column.trim() : "";
    const values = Array.isArray(part.values)
      ? part.values.map((value) => String(value ?? "").trim()).filter(Boolean)
      : [];
    if (column && values.length > 0) {
      filters.push({ column, values });
    }
  };

  if (Array.isArray(filter.filters)) {
    for (const part of filter.filters) {
      pushPart(part);
    }
  } else {
    pushPart(filter);
  }

  // Review in Round 2 always implies Round 1 Accepted (exclude first-round rejects).
  const hasReviewInRound2 = filters.some(
    (part) => part.column.toLowerCase() === REVIEW_IN_ROUND_2_COLUMN.toLowerCase(),
  );
  const hasRound1 = filters.some(
    (part) => part.column.toLowerCase() === ROUND_1_COLUMN.toLowerCase(),
  );
  if (hasReviewInRound2 && !hasRound1) {
    filters.unshift({
      column: ROUND_1_COLUMN,
      values: [ROUND_1_ACCEPTED_VALUE],
    });
  }

  if (filters.length === 0) {
    return null;
  }
  if (filters.length === 1) {
    return filters[0];
  }
  return { filters };
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

function readPlaceholderName(match) {
  return String(match[1] || match[2] || "").trim();
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
      const name = readPlaceholderName(match);
      if (name) {
        found.add(name);
      }
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
  return template.replace(PLACEHOLDER_RE, (fullMatch, bracketName, braceName) => {
    const name = String(bracketName || braceName).trim();
    const resolved = resolvePlaceholder(name, recipient, globalVars);
    if (resolved !== `[[${name}]]`) {
      return resolved;
    }
    return braceName != null ? `{{${name}}}` : `[[${name}]]`;
  });
}

function buildEmailBodies(subject, body, recipient, globalVars) {
  const renderedSubject = renderTemplate(subject, recipient, globalVars);
  const renderedText = renderTemplate(body, recipient, globalVars);
  const innerHtml = formatEmailBodyHtml(renderedText);
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

function applicantRowKey(row) {
  const id = String(row.id || "").trim();
  if (id) {
    return `id:${id}`;
  }
  return `email:${String(row.email || "")
    .trim()
    .toLowerCase()}\0${String(row.name || "").trim()}`;
}

function buildExcludedFromSend(filtered, recipients, duplicateEmailSkips) {
  const sentKeys = new Set(recipients.map((row) => applicantRowKey(row)));
  const skipById = new Map(
    duplicateEmailSkips.map((skip) => [String(skip.id || "").trim(), skip]),
  );
  const excludedFromSend = [];
  for (const row of filtered) {
    if (sentKeys.has(applicantRowKey(row))) {
      continue;
    }
    const emailKey = String(row.email || "")
      .trim()
      .toLowerCase();
    if (!emailKey) {
      excludedFromSend.push({
        reason: "no-email",
        id: row.id || "",
        name: row.name || "",
        email: "",
        fields: row.fields || {},
      });
      continue;
    }
    const duplicate = skipById.get(String(row.id || "").trim());
    excludedFromSend.push({
      reason: "duplicate-email",
      id: row.id || "",
      name: row.name || "",
      email: row.email || "",
      fields: row.fields || {},
      sharedWith: duplicate?.sharedWith || null,
    });
  }
  return excludedFromSend;
}

async function resolveAdmissionsRecipients(filter) {
  const sheetData = await loadAdmissionsSheet();
  const normalizedFilter = normalizeFilter(filter);
  const filtered = filterAdmissionsRows(sheetData.rows, normalizedFilter);
  const rowsForSend = withApplicantRecipientEmails(filtered);
  const recipients = [];
  const skippedFromSend = [];
  for (const row of rowsForSend) {
    const emailKey = String(row.email || "")
      .trim()
      .toLowerCase();
    if (!emailKey) {
      skippedFromSend.push({
        reason: "no-email",
        id: row.id || "",
        name: row.name || "",
        email: "",
        fields: row.fields || {},
      });
      continue;
    }
    recipients.push(row);
  }
  const { duplicateEmailGroups, duplicateEmailSkips } = analyzeDuplicateApplicantEmails(rowsForSend);
  const excludedFromSend = buildExcludedFromSend(rowsForSend, recipients, duplicateEmailSkips);
  const matchedCount = filtered.length;
  const recipientStats = {
    rowsWithEmail: sheetData.rows.length,
    rowsAfterFilter: matchedCount,
    recipientCount: recipients.length,
    filter: normalizedFilter,
    rowsSkippedNoEmail: skippedFromSend.filter((row) => row.reason === "no-email").length,
    skippedFromSend,
    excludedFromSend,
    duplicateEmailGroupCount: duplicateEmailGroups.length,
    duplicateEmailSkips,
    duplicateEmailGroups,
    transactionalRecipientCount: duplicateEmailSkips.length,
    broadcastRecipientCount: recipients.length - duplicateEmailSkips.length,
  };
  if (normalizedFilter) {
    console.info(
      `[admissions-email] filter ${describeAdmissionsFilter(normalizedFilter)}: ` +
        `${matchedCount} row(s) matched, ${recipients.length} email(s) will be sent`,
    );
  } else {
    console.info(
      `[admissions-email] all applicants: ${matchedCount} row(s) with email, ${recipients.length} email(s) will be sent`,
    );
  }
  if (skippedFromSend.length > 0) {
    console.info(
      `[admissions-email] ${skippedFromSend.length} matched row(s) skipped — no email in column`,
    );
  }
  if (duplicateEmailSkips.length > 0) {
    console.info(
      `[admissions-email] ${duplicateEmailSkips.length} matched row(s) share an email address with another row in this filter`,
    );
  }
  return { sheetData, recipients, recipientStats };
}

async function resolveReviewersRecipients(filter) {
  let recipients = await loadReviewerEmailRecipients();
  const normalizedFilter = normalizeFilter(filter);
  if (normalizedFilter && Array.isArray(normalizedFilter.aesopIds)) {
    const idSet = new Set(
      normalizedFilter.aesopIds.map((id) => String(id).trim().toLowerCase()).filter(Boolean),
    );
    recipients = recipients.filter((row) => idSet.has(String(row.id || "").trim().toLowerCase()));
  }
  const recipientStats = {
    rowsWithEmail: recipients.length,
    rowsAfterFilter: recipients.length,
    recipientCount: recipients.length,
    filter: normalizedFilter,
    rowsSkippedNoEmail: 0,
    skippedFromSend: [],
    excludedFromSend: [],
    duplicateEmailGroupCount: 0,
    duplicateEmailSkips: [],
    duplicateEmailGroups: [],
    transactionalRecipientCount: 0,
    broadcastRecipientCount: recipients.length,
  };
  if (normalizedFilter?.aesopIds) {
    console.info(
      `[reviewers-email] filter aesopIds (${normalizedFilter.aesopIds.length} id(s)): ${recipients.length} recipient(s)`,
    );
  } else {
    console.info(
      `[reviewers-email] all reviewers: ${recipients.length} recipient(s) with email (Associated Email else Current Email)`,
    );
  }
  return { recipients, recipientStats };
}

async function resolveGroupRecipients(group, filter) {
  if (group === "admissions") {
    return resolveAdmissionsRecipients(filter);
  }
  if (group === "reviewers") {
    return resolveReviewersRecipients(filter);
  }
  const error = new Error("Only the Admissions and Reviewers groups are available right now.");
  error.statusCode = 400;
  throw error;
}

function getEmailGroups() {
  return [
    { id: "admissions", label: "Admissions", enabled: true },
    { id: "reviewers", label: "Reviewers", enabled: true },
    { id: "students", label: "Students", enabled: false },
  ];
}

async function getAdmissionsMetadata() {
  const sheetData = await loadAdmissionsSheet();
  const filterOptions = getAdmissionsFilterOptions(sheetData);
  return {
    sheetName: config.googleSheets?.admissionsSheetName || "Applicants",
    totalRows: sheetData.rows.length,
    stats: sheetData.stats || null,
    ...filterOptions,
  };
}

async function getReviewersMetadata() {
  const recipients = await loadReviewerEmailRecipients();
  return {
    sheetName: config.googleSheets?.sheetName || "People",
    totalRows: recipients.length,
    reviewerColumn: config.googleSheets?.peopleReviewerColumn || "W",
    associatedEmailColumn: config.googleSheets?.peopleAssociatedEmailColumn || "Y",
    emailColumn: config.googleSheets?.emailColumn || "D",
    filterColumns: [],
    variableColumns: ["AESOP ID", "Name", "Email", "Current Email", "Associated Email", "Reviewer"],
    columns: [],
    valuesByColumn: {},
    headers: [],
  };
}

async function previewEmailRecipients({ group, filter }) {
  if (group !== "admissions" && group !== "reviewers") {
    return { recipients: [], count: 0, filter: normalizeFilter(filter), stats: null, recipientStats: null };
  }
  const { recipients, sheetData, recipientStats } = await resolveGroupRecipients(group, filter);
  return {
    recipients: recipients.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      fields: row.fields,
    })),
    count: recipients.length,
    filter: normalizeFilter(filter),
    stats: sheetData?.stats || null,
    recipientStats,
  };
}

function validateComposePayload(payload) {
  const group = typeof payload.group === "string" ? payload.group.trim() : "";
  const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const globalVars = normalizeGlobalVars(payload.globalVars);
  // Reviewers: allow aesopIds subset filter; ignore Admissions-style column filters.
  let filter = normalizeFilter(payload.filter);
  if (group === "reviewers" && filter && !Array.isArray(filter.aesopIds)) {
    filter = null;
  }

  if (group !== "admissions" && group !== "reviewers") {
    const error = new Error("Only the Admissions and Reviewers groups are available right now.");
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

async function recordAdminEmailTest(adminEmail, contentHash) {
  const pool = getPool();
  if (!pool) {
    const error = new Error("Database is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const email = adminEmail.toLowerCase();
  const now = new Date();
  await pool.query(
    `INSERT INTO email_admin_tests (admin_email, content_hash, test_sent_at, test_sent_to)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (admin_email, content_hash)
     DO UPDATE SET
       test_sent_at = EXCLUDED.test_sent_at,
       test_sent_to = EXCLUDED.test_sent_to`,
    [email, contentHash, now, email],
  );
  return now;
}

async function sendAdminEmailTest(adminEmail, payload) {
  assertDatabaseForCampaigns();
  const { group, subject, body, globalVars, filter } = validateComposePayload(payload);
  const { recipients } = await resolveGroupRecipients(group, filter);
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
  let testSentAt;
  try {
    testSentAt = await recordAdminEmailTest(adminEmail, contentHash);
  } catch (error) {
    const dbError = new Error(
      "Test email was sent, but saving the confirmation failed. Try sending the test again.",
    );
    dbError.statusCode = 503;
    dbError.cause = error;
    throw dbError;
  }

  return {
    contentHash,
    testSentAt: testSentAt.toISOString(),
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

  const { recipients } = await resolveGroupRecipients(group, filter);
  if (recipients.length === 0) {
    const error = new Error("No recipients match the current filter.");
    error.statusCode = 400;
    throw error;
  }

  const duplicateIds = duplicateApplicantIdSet(recipients);
  const transactionalStream = getPostmarkMessageStream();
  const broadcastStream = getPostmarkBroadcastMessageStream();

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
    recipients.map((row) => {
      const isDuplicateRow = duplicateIds.has(String(row.id || "").trim());
      return {
        campaignId: campaign.id,
        aesopId: row.id,
        name: row.name,
        email: row.email,
        rowFields: JSON.stringify(row.fields || {}),
        status: "pending",
        sendPriority: isDuplicateRow ? SEND_PRIORITY_TRANSACTIONAL : SEND_PRIORITY_BROADCAST,
      };
    }),
  );

  if (duplicateIds.size > 0) {
    console.info(
      `[admissions-email] campaign ${campaign.id}: ${duplicateIds.size} duplicate-email row(s) queued on transactional stream "${transactionalStream}" first; remaining rows use broadcast stream "${broadcastStream}"`,
    );
  }

  await processEmailCampaignBatches();

  return {
    campaignId: campaign.id,
    totalRecipients: recipients.length,
    transactionalRecipients: duplicateIds.size,
    broadcastRecipients: recipients.length - duplicateIds.size,
    transactionalStream,
    broadcastStream,
    batchSize: BATCH_SIZE,
    batchIntervalMinutes: BATCH_INTERVAL_MS / 60_000,
    estimatedDurationMinutes: estimateCampaignDurationMs(recipients.length) / 60_000,
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

  const [deliveredRows, openedRows, clickedRows, bouncedRows] = await Promise.all([
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
        and(
          eq(emailCampaignRecipients.campaignId, campaignId),
          isNotNull(emailCampaignRecipients.clickedAt),
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
    clickedCount: clickedRows[0]?.count ?? 0,
    bouncedCount: bouncedRows[0]?.count ?? 0,
    pendingCount,
    nextBatchAt: campaign.nextBatchAt ? new Date(campaign.nextBatchAt).toISOString() : null,
    completedAt: campaign.completedAt ? new Date(campaign.completedAt).toISOString() : null,
    batchSize: BATCH_SIZE,
    batchIntervalMinutes: BATCH_INTERVAL_MS / 60_000,
    estimatedCompletionAt: estimateCampaignCompletionAt(pendingCount, campaign.nextBatchAt)?.toISOString() ?? null,
    processedCount: campaign.sentCount + campaign.failedCount,
  };
}

async function listAdminEmailCampaigns(limit = 100) {
  assertDatabaseForCampaigns();
  const db = getDb();
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 100, 1), 200);
  const rows = await db
    .select({
      id: emailCampaigns.id,
      subject: emailCampaigns.subject,
      status: emailCampaigns.status,
      recipientGroup: emailCampaigns.recipientGroup,
      totalRecipients: emailCampaigns.totalRecipients,
      sentCount: emailCampaigns.sentCount,
      failedCount: emailCampaigns.failedCount,
      createdAt: emailCampaigns.createdAt,
      completedAt: emailCampaigns.completedAt,
    })
    .from(emailCampaigns)
    .orderBy(desc(emailCampaigns.createdAt))
    .limit(safeLimit);

  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    status: row.status,
    recipientGroup: row.recipientGroup,
    totalRecipients: row.totalRecipients,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
  }));
}

function serializeRecipientRow(row) {
  return {
    id: row.id,
    aesopId: row.aesopId,
    name: row.name,
    email: row.email,
    status: row.status,
    sentAt: row.sentAt ? new Date(row.sentAt).toISOString() : null,
    deliveredAt: row.deliveredAt ? new Date(row.deliveredAt).toISOString() : null,
    openedAt: row.openedAt ? new Date(row.openedAt).toISOString() : null,
    clickedAt: row.clickedAt ? new Date(row.clickedAt).toISOString() : null,
    bouncedAt: row.bouncedAt ? new Date(row.bouncedAt).toISOString() : null,
    error: row.error || null,
    batchNumber: row.batchNumber,
  };
}

async function getAdminEmailCampaignDetail(campaignId) {
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

  const [status, recipientRows] = await Promise.all([
    getAdminEmailCampaignStatus(campaignId),
    db
      .select()
      .from(emailCampaignRecipients)
      .where(eq(emailCampaignRecipients.campaignId, campaignId))
      .orderBy(emailCampaignRecipients.id),
  ]);

  return {
    campaign: {
      id: campaign.id,
      subject: campaign.subject,
      body: campaign.body,
      recipientGroup: campaign.recipientGroup,
      createdByEmail: campaign.createdByEmail,
      status: campaign.status,
      totalRecipients: campaign.totalRecipients,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
      createdAt: campaign.createdAt ? new Date(campaign.createdAt).toISOString() : null,
      completedAt: campaign.completedAt ? new Date(campaign.completedAt).toISOString() : null,
      testSentAt: campaign.testSentAt ? new Date(campaign.testSentAt).toISOString() : null,
      recipientFilter: parseJsonColumn(campaign.recipientFilter, null),
    },
    status,
    recipients: recipientRows.map(serializeRecipientRow),
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
  const acquired = await tryAcquireCampaignLock(campaign.id);
  if (!acquired) {
    return;
  }

  const db = getDb();
  try {
    await db.execute(sql`
      UPDATE email_campaign_recipients
      SET status = 'pending'
      WHERE campaign_id = ${campaign.id}
        AND status = 'processing'
        AND sent_at IS NULL
    `);

    const globalVars = normalizeGlobalVars(parseJsonColumn(campaign.globalVars, {}));
    const pending = await claimPendingRecipients(campaign.id, BATCH_SIZE);

    if (pending.length === 0) {
      const remainingRows = await db
        .select({ count: sql`count(*)::int` })
        .from(emailCampaignRecipients)
        .where(
          and(
            eq(emailCampaignRecipients.campaignId, campaign.id),
            eq(emailCampaignRecipients.status, "pending"),
          ),
        );
      const processingRows = await db
        .select({ count: sql`count(*)::int` })
        .from(emailCampaignRecipients)
        .where(
          and(
            eq(emailCampaignRecipients.campaignId, campaign.id),
            eq(emailCampaignRecipients.status, "processing"),
          ),
        );
      const remaining = remainingRows[0]?.count ?? 0;
      const processing = processingRows[0]?.count ?? 0;
      if (remaining === 0 && processing === 0) {
        await db
          .update(emailCampaigns)
          .set({
            status: "completed",
            nextBatchAt: null,
            completedAt: new Date(),
          })
          .where(eq(emailCampaigns.id, campaign.id));
      }
      return;
    }

    const batchNumber =
      Math.floor((campaign.sentCount + campaign.failedCount) / BATCH_SIZE) + 1;
    const transactionalStream = getPostmarkMessageStream();
    const broadcastStream = getPostmarkBroadcastMessageStream();
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
      const useTransactional = row.sendPriority === SEND_PRIORITY_TRANSACTIONAL;
      messages.push({
        to: row.email,
        subject: bodies.subject,
        text: bodies.text,
        html: bodies.html,
        messageStream: useTransactional ? transactionalStream : broadcastStream,
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
    /** @type {Array<{ aesopId?: string|null, id?: number, email?: string, error?: string }>} */
    const failedRecipients = [];

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
          const errorMessage = result?.Message || "Postmark send failed.";
          failedRecipients.push({
            aesopId: row.aesopId,
            id: row.id,
            email: row.email,
            error: errorMessage,
          });
          await db
            .update(emailCampaignRecipients)
            .set({
              status: "failed",
              sentAt: now,
              batchNumber,
              error: errorMessage,
            })
            .where(eq(emailCampaignRecipients.id, row.id));
        }
      }
    } catch (error) {
      failedCount = messageRecipients.length;
      const errorMessage = error.message || "Postmark batch send failed.";
      for (const row of messageRecipients) {
        failedRecipients.push({
          aesopId: row.aesopId,
          id: row.id,
          email: row.email,
          error: errorMessage,
        });
        await db
          .update(emailCampaignRecipients)
          .set({
            status: "failed",
            sentAt: now,
            batchNumber,
            error: errorMessage,
          })
          .where(eq(emailCampaignRecipients.id, row.id));
      }
    }

    if (failedRecipients.length > 0) {
      console.warn(
        `[email-campaigns] campaign ${campaign.id} batch ${batchNumber}: ${failedRecipients.length} failed`,
      );
      for (const row of failedRecipients) {
        const recipientLabel =
          String(row.aesopId || "").trim() ||
          (row.id != null ? `recipient#${row.id}` : "unknown-recipient");
        const email = String(row.email || "").trim();
        console.warn(
          `[email-campaigns] failed ${recipientLabel}${email ? ` <${email}>` : ""}: ${row.error}`,
        );
      }
      logCampaignRecipientIdsInLots(
        "[email-campaigns]",
        `campaign ${campaign.id} batch ${batchNumber} failed AESOP IDs`,
        failedRecipients,
      );
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
  } finally {
    await releaseCampaignLock(campaign.id);
  }
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
  estimateCampaignDurationMs,
  estimateCampaignCompletionAt,
  extractPlaceholders,
  classifyPlaceholder,
  renderTemplate,
  computeContentHash,
  getEmailGroups,
  getAdmissionsMetadata,
  getReviewersMetadata,
  previewEmailRecipients,
  sendAdminEmailTest,
  startAdminEmailCampaign,
  getAdminEmailCampaignStatus,
  listAdminEmailCampaigns,
  getAdminEmailCampaignDetail,
  processEmailCampaignBatches,
  startEmailCampaignWorker,
};
