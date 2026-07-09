const crypto = require("crypto");
const config = require("../config/secrets");
const { formatEasternSheetTimestamp } = require("../utils/dingSheetTime");
const {
  classifyVoiceMemoDuration,
  voiceMemoDurationWarning,
  formatVoiceMemoDurationLabel,
} = require("../utils/voiceMemoDuration");
const { findProfileById } = require("./googleSheets");
const { streamVoiceMemoFile, getVoiceMemoFileForAesopId, getVoiceMemoDurationSeconds } = require("./googleDrive");
const { updateApplicantDriveDurationSeconds } = require("./classroomDb");
const {
  getApplicantRowByAesopId,
  getVoiceMemoSheetConfig,
  getVoiceMemoDriveScanOptions,
  getVoiceMemoDurationLimits,
} = require("./voiceMemoSync");

const STREAM_TOKEN_TTL_MS = 15 * 60 * 1000;
const STREAM_TOKEN_DOMAIN = "voice-stream-v1";
const REVIEW_STREAM_TOKEN_DOMAIN = "review-voice-stream-v1";

/** @type {Buffer|null} */
let cachedStreamSigningKey = null;
/** @type {Buffer|null} */
let ephemeralStreamSigningKey = null;

/**
 * 32-byte HMAC key for stream tokens. Prefers the explicit STREAM_TOKEN_SECRET;
 * otherwise derives a stable key from another shared secret so tokens validate
 * across all Fly machines. Falls back to a per-process random key only when no
 * shared secret exists (e.g. local dev without secrets).
 * @returns {Buffer}
 */
function getStreamSigningKey() {
  if (cachedStreamSigningKey) {
    return cachedStreamSigningKey;
  }
  const explicit = config.security?.streamTokenSecret;
  const base =
    (explicit && String(explicit).trim()) ||
    (config.postmark?.serverToken && String(config.postmark.serverToken).trim()) ||
    (config.database?.url && String(config.database.url).trim()) ||
    "";
  if (base) {
    cachedStreamSigningKey = crypto
      .createHash("sha256")
      .update(`${STREAM_TOKEN_DOMAIN}:${base}`)
      .digest();
    return cachedStreamSigningKey;
  }
  if (!ephemeralStreamSigningKey) {
    ephemeralStreamSigningKey = crypto.randomBytes(32);
  }
  return ephemeralStreamSigningKey;
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToString(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64").toString("utf8");
}

function signStreamPayload(payloadB64) {
  return base64UrlEncode(
    crypto.createHmac("sha256", getStreamSigningKey()).update(payloadB64).digest(),
  );
}

function signReviewStreamPayload(payloadB64) {
  return base64UrlEncode(
    crypto
      .createHmac("sha256", getStreamSigningKey())
      .update(`${REVIEW_STREAM_TOKEN_DOMAIN}:${payloadB64}`)
      .digest(),
  );
}

/**
 * Mint a short-lived signed token authorizing playback of one user's voice
 * memo. Carries only an opaque, expiring payload — no email or raw ID in the URL.
 * @param {string} userId
 * @returns {string}
 */
function mintVoiceStreamToken(userId) {
  const id = String(userId || "").trim();
  if (!id) {
    return "";
  }
  const payloadB64 = base64UrlEncode(
    JSON.stringify({ u: id, exp: Date.now() + STREAM_TOKEN_TTL_MS }),
  );
  return `${payloadB64}.${signStreamPayload(payloadB64)}`;
}

/**
 * Verify a stream token; returns the signed userId when valid and unexpired.
 * @param {string} token
 * @returns {{ userId: string }|null}
 */
function verifyVoiceStreamToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [payloadB64, sig] = parts;
  const expectedSig = signStreamPayload(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(base64UrlToString(payloadB64));
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (Date.now() > payload.exp) {
    return null;
  }
  return { userId: payload.u };
}

/**
 * Mint a short-lived token for a reviewer to stream an assigned applicant's voice memo.
 * @param {string} reviewerAesopId
 * @param {string} applicantAesopId
 * @returns {string}
 */
function mintReviewVoiceStreamToken(reviewerAesopId, applicantAesopId) {
  const reviewerId = String(reviewerAesopId || "").trim();
  const applicantId = String(applicantAesopId || "").trim();
  if (!reviewerId || !applicantId) {
    return "";
  }
  const payloadB64 = base64UrlEncode(
    JSON.stringify({ r: reviewerId, a: applicantId, exp: Date.now() + STREAM_TOKEN_TTL_MS }),
  );
  return `${payloadB64}.${signReviewStreamPayload(payloadB64)}`;
}

/**
 * @param {string} token
 * @returns {{ reviewerId: string, applicantId: string }|null}
 */
function verifyReviewVoiceStreamToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [payloadB64, sig] = parts;
  const expectedSig = signReviewStreamPayload(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(base64UrlToString(payloadB64));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.r !== "string" ||
    typeof payload.a !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (Date.now() > payload.exp) {
    return null;
  }
  return { reviewerId: payload.r, applicantId: payload.a };
}

/**
 * @param {string} email
 * @returns {string}
 */
function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/**
 * @param {{ userId: string, email: string }} params
 * @returns {Promise<{ id: string, email: string, name: string }|null>}
 */
async function verifyPortalVoiceMemoSession({ userId, email }) {
  const idKey = String(userId || "").trim();
  const emailKey = normalizeEmail(email);
  if (!idKey || !emailKey) {
    return null;
  }

  const profile = await findProfileById(idKey);
  if (!profile) {
    return null;
  }

  if (normalizeEmail(profile.email) !== emailKey) {
    return null;
  }

  return profile;
}

/**
 * @param {Awaited<ReturnType<typeof getApplicantRowByAesopId>>} applicant
 * @param {ReturnType<typeof getVoiceMemoSheetConfig>} cfg
 * @returns {Promise<{ fileId: string, fileName: string|null, submittedAt: Date|null }|null>}
 */
async function resolveDriveFileForApplicant(applicant, cfg) {
  const cachedFileId = applicant?.driveFileId ? String(applicant.driveFileId).trim() : "";
  if (cachedFileId) {
    return {
      fileId: cachedFileId,
      fileName: applicant.driveFileName ? String(applicant.driveFileName).trim() : null,
      submittedAt: null,
    };
  }

  const folderId = String(cfg.voiceMemo.driveFolderId || "").trim();
  if (!folderId || !applicant?.aesopId) {
    return null;
  }

  const scanOptions = getVoiceMemoDriveScanOptions(cfg.voiceMemo);
  const driveFile = await getVoiceMemoFileForAesopId(folderId, applicant.aesopId, scanOptions);
  if (!driveFile) {
    return null;
  }

  return {
    fileId: driveFile.fileId,
    fileName: driveFile.fileName,
    submittedAt: driveFile.submittedAt,
  };
}

/**
 * @param {Awaited<ReturnType<typeof getApplicantRowByAesopId>>} applicant
 * @param {{ minSeconds: number, maxSeconds: number }} durationLimits
 * @param {ReturnType<typeof getVoiceMemoSheetConfig>} cfg
 * @param {{ forceRefreshDuration?: boolean }} [options]
 * @returns {Promise<{ fileName: string|null, fileId: string|null, hasRecording: boolean, durationSeconds: number|null, durationStatus: 'valid'|'too_short'|'too_long'|'unknown', durationWarning: string|null, submittedAt: Date|null }>}
 */
async function resolveVoiceMemoRecordingFromApplicant(applicant, durationLimits, cfg, options = {}) {
  const forceRefreshDuration = options.forceRefreshDuration === true;
  const driveFile = await resolveDriveFileForApplicant(applicant, cfg);
  if (!driveFile) {
    return {
      fileName: null,
      fileId: null,
      hasRecording: false,
      durationSeconds: null,
      durationStatus: "unknown",
      durationWarning: null,
      submittedAt: null,
    };
  }

  const cachedFileId = applicant.driveFileId ? String(applicant.driveFileId).trim() : "";
  const cachedDurationSeconds =
    applicant.driveDurationSeconds != null && Number.isFinite(Number(applicant.driveDurationSeconds))
      ? Number(applicant.driveDurationSeconds)
      : null;
  const cacheMatchesCurrentFile =
    Boolean(cachedFileId) &&
    cachedFileId === driveFile.fileId &&
    cachedDurationSeconds != null;

  // Cache is keyed by Drive file id: reuse duration when the file has not changed.
  // Probe Drive when the file is new/unknown, duration is missing, or a refresh is requested.
  let durationSeconds = !forceRefreshDuration && cacheMatchesCurrentFile ? cachedDurationSeconds : null;
  if (durationSeconds == null) {
    durationSeconds = await getVoiceMemoDurationSeconds(driveFile.fileId);
    if (durationSeconds != null) {
      updateApplicantDriveDurationSeconds(applicant.aesopId, {
        driveDurationSeconds: durationSeconds,
        driveFileId: driveFile.fileId,
        driveFileName: driveFile.fileName,
      }).catch(() => {});
    } else if (cacheMatchesCurrentFile) {
      // Keep the previous cache if a refresh probe fails.
      durationSeconds = cachedDurationSeconds;
    }
  }

  const durationStatus = classifyVoiceMemoDuration(durationSeconds, durationLimits);
  return {
    fileName: driveFile.fileName,
    fileId: driveFile.fileId,
    hasRecording: true,
    durationSeconds,
    durationStatus,
    durationWarning: voiceMemoDurationWarning(durationStatus, durationLimits),
    submittedAt: driveFile.submittedAt,
  };
}

/**
 * @param {string} userId
 * @returns {Promise<{ eligible: false }|{
 *   eligible: true,
 *   submitted: boolean,
 *   submittedAt: string|null,
 *   fileName: string|null,
 *   submissionInstructions: string,
 *   hasRecording: boolean,
 *   durationSeconds: number|null,
 *   durationLabel: string|null,
 *   durationStatus: 'valid'|'too_short'|'too_long'|'unknown',
 *   durationWarning: string|null,
 *   minDurationSeconds: number,
 *   maxDurationSeconds: number,
 * }>}
 */
async function getPortalVoiceMemoStatus({ userId, email, refreshDuration = false }) {
  const profile = await verifyPortalVoiceMemoSession({ userId, email });
  if (!profile) {
    const error = new Error("Unable to load voice memo status. Please sign in again from the login link.");
    error.statusCode = 403;
    throw error;
  }

  const cfg = getVoiceMemoSheetConfig();
  const durationLimits = getVoiceMemoDurationLimits(cfg.voiceMemo);
  const submissionInstructions = String(cfg.voiceMemo.submissionInstructions || "").trim();
  const applicant = await getApplicantRowByAesopId(profile.id || userId);
  if (!applicant) {
    return { eligible: false };
  }

  const acceptedValue = cfg.acceptedValue.toLowerCase();
  if (applicant.round1.trim().toLowerCase() !== acceptedValue) {
    return { eligible: false };
  }

  const submittedValue = cfg.submittedValue.toLowerCase();
  let submitted = applicant.round2.trim().toLowerCase() === submittedValue;
  let submittedAt = applicant.submittedAt.trim() || null;
  let fileName = null;
  let fileId = null;
  let hasRecording = false;
  let durationSeconds = null;
  let durationStatus = "unknown";
  let durationWarning = null;

  const recording = await resolveVoiceMemoRecordingFromApplicant(applicant, durationLimits, cfg, {
    forceRefreshDuration: refreshDuration === true,
  });
  if (recording.hasRecording) {
    fileName = recording.fileName;
    fileId = recording.fileId;
    hasRecording = true;
    durationSeconds = recording.durationSeconds;
    durationStatus = recording.durationStatus;
    durationWarning = recording.durationWarning;
    if (!submitted) {
      submitted = true;
      submittedAt =
        submittedAt ||
        (recording.submittedAt ? formatEasternSheetTimestamp(recording.submittedAt) : formatEasternSheetTimestamp(new Date()));
    }
  }

  return {
    eligible: true,
    submitted,
    submittedAt,
    fileName,
    fileId,
    hasRecording,
    submissionInstructions,
    // Short-lived signed token the <audio> element uses to stream, so the URL
    // carries no email/ID (keeps PII out of access logs and browser history).
    streamToken: hasRecording ? mintVoiceStreamToken(profile.id || userId) : null,
    durationSeconds,
    durationLabel: formatVoiceMemoDurationLabel(durationSeconds),
    durationStatus,
    durationWarning,
    minDurationSeconds: durationLimits.minSeconds,
    maxDurationSeconds: durationLimits.maxSeconds,
  };
}

/**
 * Persist a browser-measured voice memo duration for the current Drive file.
 * @param {{ userId: string, email: string, durationSeconds: number, fileId?: string }} params
 */
async function reportPortalVoiceMemoDuration({ userId, email, durationSeconds, fileId }) {
  const profile = await verifyPortalVoiceMemoSession({ userId, email });
  if (!profile) {
    const error = new Error("Unable to update voice memo duration. Please sign in again from the login link.");
    error.statusCode = 403;
    throw error;
  }

  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60 * 30) {
    const error = new Error("A valid recording duration is required.");
    error.statusCode = 400;
    throw error;
  }

  const cfg = getVoiceMemoSheetConfig();
  const applicant = await getApplicantRowByAesopId(profile.id || userId);
  if (!applicant) {
    const error = new Error("Voice memo is not available for your account.");
    error.statusCode = 404;
    throw error;
  }

  const driveFile = await resolveDriveFileForApplicant(applicant, cfg);
  if (!driveFile) {
    const error = new Error("No voice memo file was found for your account.");
    error.statusCode = 404;
    throw error;
  }

  const reportedFileId = String(fileId || "").trim();
  if (reportedFileId && reportedFileId !== driveFile.fileId) {
    const error = new Error("That voice memo file is no longer the current submission.");
    error.statusCode = 409;
    throw error;
  }

  const rounded = Math.round(seconds);
  await updateApplicantDriveDurationSeconds(applicant.aesopId, {
    driveDurationSeconds: rounded,
    driveFileId: driveFile.fileId,
    driveFileName: driveFile.fileName,
  });

  const durationLimits = getVoiceMemoDurationLimits(cfg.voiceMemo);
  const durationStatus = classifyVoiceMemoDuration(rounded, durationLimits);
  return {
    success: true,
    fileId: driveFile.fileId,
    durationSeconds: rounded,
    durationLabel: formatVoiceMemoDurationLabel(rounded),
    durationStatus,
    durationWarning: voiceMemoDurationWarning(durationStatus, durationLimits),
    minDurationSeconds: durationLimits.minSeconds,
    maxDurationSeconds: durationLimits.maxSeconds,
  };
}

/**
 * @param {{ userId: string, email: string, rangeHeader?: string }} params
 * @returns {Promise<{ stream: import('stream').Readable, mimeType: string, fileName: string, size: number|null, status: number, contentRange: string|null, contentLength: string|null }>}
 */
/**
 * Resolve and stream the voice memo for an already-authorized userId.
 * @param {string} userId
 * @param {string} rangeHeader
 */
async function streamVoiceMemoForUserId(userId, rangeHeader = "") {
  const cfg = getVoiceMemoSheetConfig();
  const applicant = await getApplicantRowByAesopId(userId);
  if (!applicant) {
    const error = new Error("Voice memo is not available for your account.");
    error.statusCode = 404;
    throw error;
  }

  const acceptedValue = cfg.acceptedValue.toLowerCase();
  if (applicant.round1.trim().toLowerCase() !== acceptedValue) {
    const error = new Error("Voice memo is not available for your account.");
    error.statusCode = 404;
    throw error;
  }

  const driveFile = await resolveDriveFileForApplicant(applicant, cfg);
  if (!driveFile) {
    const error = new Error("No voice memo file was found for your account.");
    error.statusCode = 404;
    throw error;
  }

  return streamVoiceMemoFile(driveFile.fileId, rangeHeader);
}

async function getPortalVoiceMemoStream({ userId, email, rangeHeader = "" }) {
  const profile = await verifyPortalVoiceMemoSession({ userId, email });
  if (!profile) {
    const error = new Error("Unable to play voice memo. Please sign in again from the login link.");
    error.statusCode = 403;
    throw error;
  }
  return streamVoiceMemoForUserId(profile.id || userId, rangeHeader);
}

/**
 * Stream an applicant voice memo for an assigned reviewer using a signed token.
 * @param {{ token: string, rangeHeader?: string }} params
 */
async function getReviewVoiceMemoStreamByToken({ token, rangeHeader = "" }) {
  const verified = verifyReviewVoiceStreamToken(token);
  if (!verified) {
    const error = new Error("This voice memo link has expired. Reload the page and try again.");
    error.statusCode = 403;
    throw error;
  }

  const { isReviewerAssignedToApplicant } = require("./applicantReviews");
  const allowed = await isReviewerAssignedToApplicant(verified.reviewerId, verified.applicantId);
  if (!allowed) {
    const error = new Error("You are not assigned to review this applicant.");
    error.statusCode = 403;
    throw error;
  }

  const cfg = getVoiceMemoSheetConfig();
  const applicant = await getApplicantRowByAesopId(verified.applicantId);
  if (!applicant) {
    const error = new Error("No voice memo file was found for this applicant.");
    error.statusCode = 404;
    throw error;
  }

  const driveFile = await resolveDriveFileForApplicant(applicant, cfg);
  if (!driveFile) {
    const error = new Error("No voice memo file was found for this applicant.");
    error.statusCode = 404;
    throw error;
  }

  return streamVoiceMemoFile(driveFile.fileId, rangeHeader);
}

/**
 * Stream a voice memo authorized by a signed short-lived token (no email/ID in
 * the URL). Used by the GET stream route that backs the <audio> element.
 * @param {{ token: string, rangeHeader?: string }} params
 */
async function getPortalVoiceMemoStreamByToken({ token, rangeHeader = "" }) {
  const verified = verifyVoiceStreamToken(token);
  if (!verified) {
    const error = new Error("This voice memo link has expired. Reload the page and try again.");
    error.statusCode = 403;
    throw error;
  }
  return streamVoiceMemoForUserId(verified.userId, rangeHeader);
}

module.exports = {
  getPortalVoiceMemoStatus,
  reportPortalVoiceMemoDuration,
  getPortalVoiceMemoStream,
  getPortalVoiceMemoStreamByToken,
  getReviewVoiceMemoStreamByToken,
  mintVoiceStreamToken,
  mintReviewVoiceStreamToken,
  verifyVoiceStreamToken,
  verifyReviewVoiceStreamToken,
};
