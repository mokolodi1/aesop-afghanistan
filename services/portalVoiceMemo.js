const config = require("../config/secrets");
const { formatEasternSheetTimestamp } = require("../utils/dingSheetTime");
const {
  classifyVoiceMemoDuration,
  voiceMemoDurationWarning,
  formatVoiceMemoDurationLabel,
} = require("../utils/voiceMemoDuration");
const { findProfileById } = require("./googleSheets");
const {
  getVoiceMemoFileForAesopId,
  streamVoiceMemoFile,
  getVoiceMemoDurationSeconds,
} = require("./googleDrive");
const {
  getApplicantRowByAesopId,
  getVoiceMemoSheetConfig,
  getVoiceMemoDriveScanOptions,
  getVoiceMemoDurationLimits,
} = require("./voiceMemoSync");

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
async function getPortalVoiceMemoStatus({ userId, email }) {
  const profile = await verifyPortalVoiceMemoSession({ userId, email });
  if (!profile) {
    const error = new Error("Unable to load voice memo status. Please sign in again from the magic link.");
    error.statusCode = 403;
    throw error;
  }

  const cfg = getVoiceMemoSheetConfig();
  const durationLimits = getVoiceMemoDurationLimits(cfg.voiceMemo);
  const scanOptions = getVoiceMemoDriveScanOptions(cfg.voiceMemo);
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
  let hasRecording = false;
  let durationSeconds = null;
  let durationStatus = "unknown";
  let durationWarning = null;

  const folderId = String(cfg.voiceMemo.driveFolderId || "").trim();
  if (folderId) {
    const driveFile = await getVoiceMemoFileForAesopId(folderId, applicant.aesopId, scanOptions);
    if (driveFile) {
      fileName = driveFile.fileName;
      hasRecording = true;
      if (!submitted) {
        submitted = true;
        submittedAt = submittedAt || formatEasternSheetTimestamp(driveFile.submittedAt);
      }
      durationSeconds = await getVoiceMemoDurationSeconds(driveFile.fileId);
      durationStatus = classifyVoiceMemoDuration(durationSeconds, durationLimits);
      durationWarning = voiceMemoDurationWarning(durationStatus, durationLimits);
    }
  }

  return {
    eligible: true,
    submitted,
    submittedAt,
    fileName,
    hasRecording,
    submissionInstructions,
    durationSeconds,
    durationLabel: formatVoiceMemoDurationLabel(durationSeconds),
    durationStatus,
    durationWarning,
    minDurationSeconds: durationLimits.minSeconds,
    maxDurationSeconds: durationLimits.maxSeconds,
  };
}

/**
 * @param {{ userId: string, email: string, rangeHeader?: string }} params
 * @returns {Promise<{ stream: import('stream').Readable, mimeType: string, fileName: string, size: number|null, status: number, contentRange: string|null, contentLength: string|null }>}
 */
async function getPortalVoiceMemoStream({ userId, email, rangeHeader = "" }) {
  const profile = await verifyPortalVoiceMemoSession({ userId, email });
  if (!profile) {
    const error = new Error("Unable to play voice memo. Please sign in again from the magic link.");
    error.statusCode = 403;
    throw error;
  }

  const cfg = getVoiceMemoSheetConfig();
  const scanOptions = getVoiceMemoDriveScanOptions(cfg.voiceMemo);
  const applicant = await getApplicantRowByAesopId(profile.id || userId);
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

  const folderId = String(cfg.voiceMemo.driveFolderId || "").trim();
  if (!folderId) {
    const error = new Error("Voice memo playback is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const driveFile = await getVoiceMemoFileForAesopId(folderId, applicant.aesopId, scanOptions);

  if (!driveFile) {
    const error = new Error("No voice memo file was found for your account.");
    error.statusCode = 404;
    throw error;
  }

  const streamResult = await streamVoiceMemoFile(driveFile.fileId, rangeHeader);
  return streamResult;
}

module.exports = {
  getPortalVoiceMemoStatus,
  getPortalVoiceMemoStream,
};
