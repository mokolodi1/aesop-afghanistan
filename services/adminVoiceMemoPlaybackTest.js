const { getApplicantRowByAesopId } = require("./voiceMemoSync");
const {
  resolveDriveFileFromApplicantCache,
  mintVoiceStreamToken,
} = require("./portalVoiceMemo");
const { downloadVoiceMemoFile, VOICE_MEMO_AUDIO_CACHE_MAX_BYTES, DRIVE_TRY_AGAIN_LATER_MESSAGE } = require("./googleDrive");
const {
  getVoiceMemoAudioRow,
  deleteVoiceMemoAudioRow,
  prepareVoiceMemoAudioCacheEntry,
  upsertVoiceMemoAudio,
  probeVoiceMemoPlaybackStream,
} = require("./voiceMemoAudio");
const { voiceMemoNeedsBrowserPlaybackTranscode, getFfmpegToolingStatus } = require("../utils/voiceMemoTranscode");
const {
  VOICE_MEMO_ERROR_CODES,
  createVoiceMemoPlaybackError,
  mapVoiceMemoStreamError,
} = require("./voiceMemoStreamErrors");
const { formatGoogleDriveOperationError } = require("../utils/errorLogging");

const PLAYBACK_TEST_STEP_DEFINITIONS = [
  { id: "resolve", label: "Resolve Drive file" },
  { id: "ffmpeg", label: "Check ffmpeg/ffprobe" },
  { id: "clear-cache", label: "Clear Postgres cache" },
  { id: "drive-download", label: "Download from Drive" },
  { id: "transcode", label: "Transcode for browser playback" },
  { id: "cache-store", label: "Store in Postgres cache" },
  { id: "playback-full", label: "Probe playback stream (full)" },
  { id: "playback-range", label: 'Probe playback stream (Range: bytes=0-0)' },
  { id: "stream-token", label: "Mint applicant stream token" },
];

/**
 * @returns {Array<{
 *   id: string,
 *   label: string,
 *   status: 'pending'|'running'|'succeeded'|'failed'|'skipped',
 *   detail: Record<string, unknown>|string|null,
 *   durationMs: number|null,
 *   error: string|null,
 *   errorCode: string|null,
 * }>}
 */
function createPlaybackTestSteps() {
  return PLAYBACK_TEST_STEP_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    status: "pending",
    detail: null,
    durationMs: null,
    error: null,
    errorCode: null,
  }));
}

/**
 * @param {ReturnType<typeof createPlaybackTestSteps>} steps
 * @param {string} failedStepId
 */
function skipRemainingPlaybackTestSteps(steps, failedStepId) {
  let foundFailed = false;
  for (const step of steps) {
    if (step.id === failedStepId) {
      foundFailed = true;
      continue;
    }
    if (foundFailed && step.status === "pending") {
      step.status = "skipped";
      step.detail = "Not run because a previous step failed.";
    }
  }
}

/**
 * @param {ReturnType<typeof createPlaybackTestSteps>} steps
 * @param {string} stepId
 * @param {() => Promise<Record<string, unknown>|string|null|undefined>} fn
 */
async function runPlaybackTestStep(steps, stepId, fn) {
  const step = steps.find((item) => item.id === stepId);
  if (!step) {
    throw new Error(`Unknown playback test step: ${stepId}`);
  }

  step.status = "running";
  const startedAt = Date.now();
  try {
    const detail = await fn();
    step.status = "succeeded";
    step.detail = detail ?? null;
    step.durationMs = Date.now() - startedAt;
    return detail;
  } catch (error) {
    step.status = "failed";
    step.durationMs = Date.now() - startedAt;
    const formatted = formatAdminVoiceMemoPlaybackTestError(error);
    step.error = formatted.message;
    step.errorCode = formatted.errorCode;
    step.detail = formatted.diagnostic || step.detail;
    skipRemainingPlaybackTestSteps(steps, stepId);
    throw error;
  }
}

/**
 * @param {ReturnType<typeof createPlaybackTestSteps>} steps
 * @param {string} stepId
 * @param {Record<string, unknown>|string|null} [detail]
 */
function skipPlaybackTestStep(steps, stepId, detail = null) {
  const step = steps.find((item) => item.id === stepId);
  if (!step) {
    return;
  }
  step.status = "skipped";
  step.detail = detail;
}

/**
 * Clear cache, pull from Drive, store in Postgres, and probe playback for one memo.
 * @param {{ aesopId?: string, driveFileId?: string }} params
 */
async function runAdminVoiceMemoPlaybackTest(params = {}) {
  const steps = createPlaybackTestSteps();
  const startedAt = Date.now();
  const aesopId = String(params.aesopId || "").trim();
  let driveFileId = String(params.driveFileId || "").trim();
  let fileName = null;
  /** @type {{ fileId: string, fileName: string, mimeType: string, sizeBytes: number, content: Buffer }|null} */
  let download = null;

  try {
    const resolveDetail = await runPlaybackTestStep(steps, "resolve", async () => {
      if (aesopId) {
        const applicant = await getApplicantRowByAesopId(aesopId);
        if (!applicant) {
          const error = new Error(`No applicant found for AESOP ID ${aesopId}.`);
          error.statusCode = 404;
          throw error;
        }
        const driveFile = resolveDriveFileFromApplicantCache(applicant);
        if (!driveFile?.fileId) {
          const error = new Error(`Applicant ${aesopId} has no Drive voice memo on file.`);
          error.statusCode = 404;
          throw error;
        }
        driveFileId = driveFileId || driveFile.fileId;
        fileName = driveFile.fileName || applicant.driveFileName || null;
        return {
          aesopId,
          driveFileId,
          fileName,
          source: "applicant",
        };
      }

      if (!driveFileId) {
        const error = new Error("AESOP ID or Drive file ID is required.");
        error.statusCode = 400;
        throw error;
      }

      return {
        aesopId: null,
        driveFileId,
        fileName: null,
        source: "drive-file-id",
      };
    });
    driveFileId = String(resolveDetail?.driveFileId || driveFileId).trim();
    fileName = fileName || (typeof resolveDetail?.fileName === "string" ? resolveDetail.fileName : null);

    await runPlaybackTestStep(steps, "ffmpeg", async () => {
      const tooling = await getFfmpegToolingStatus();
      if (!tooling.ffmpeg || !tooling.ffprobe) {
        const missing = [!tooling.ffmpeg && "ffmpeg", !tooling.ffprobe && "ffprobe"]
          .filter(Boolean)
          .join(" and ");
        const error = new Error(
          `${missing} not found on PATH. Install ffmpeg locally (e.g. brew install ffmpeg) and restart the server.`,
        );
        error.statusCode = 503;
        error.code = "FFMPEG_UNAVAILABLE";
        throw error;
      }
      return tooling;
    });

    const clearDetail = await runPlaybackTestStep(steps, "clear-cache", async () => {
      const existing = await getVoiceMemoAudioRow(driveFileId);
      const hadCache = Boolean(existing?.content && existing.content.length > 0);
      const deleted = await deleteVoiceMemoAudioRow(driveFileId);
      return {
        hadCache,
        deleted,
        previousBytes: hadCache
          ? Buffer.isBuffer(existing.content)
            ? existing.content.length
            : Buffer.byteLength(existing.content)
          : 0,
        previousFileName: existing?.fileName || null,
      };
    });

    const downloadDetail = await runPlaybackTestStep(steps, "drive-download", async () => {
      try {
        download = await downloadVoiceMemoFile(driveFileId);
      } catch (error) {
        throw mapVoiceMemoStreamError(error);
      }
      if (!download?.content || download.content.length <= 0) {
        throw createVoiceMemoPlaybackError(
          "No voice memo file was found for your account.",
          404,
          "NOT_FOUND",
          VOICE_MEMO_ERROR_CODES.NOT_FOUND,
        );
      }
      if (download.sizeBytes > VOICE_MEMO_AUDIO_CACHE_MAX_BYTES) {
        throw createVoiceMemoPlaybackError(
          DRIVE_TRY_AGAIN_LATER_MESSAGE,
          503,
          "TRANSCODE_FAILED",
          VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED,
        );
      }
      fileName = download.fileName || fileName;
      return {
        bytes: download.content.length,
        mimeType: download.mimeType,
        fileName: download.fileName,
      };
    });

    /** @type {{ content: Buffer, fileName: string, mimeType: string, sizeBytes: number }|null} */
    let prepared = null;
    const transcodeDetail = await runPlaybackTestStep(steps, "transcode", async () => {
      if (!download?.content || download.content.length <= 0) {
        throw createVoiceMemoPlaybackError(
          "No voice memo file was found for your account.",
          404,
          "NOT_FOUND",
          VOICE_MEMO_ERROR_CODES.NOT_FOUND,
        );
      }

      const needsTranscode = await voiceMemoNeedsBrowserPlaybackTranscode(
        download.content,
        download.fileName,
      );
      prepared = await prepareVoiceMemoAudioCacheEntry(
        download.content,
        download.fileName,
        download.mimeType,
      );

      if (!prepared) {
        throw createVoiceMemoPlaybackError(
          DRIVE_TRY_AGAIN_LATER_MESSAGE,
          503,
          "TRANSCODE_FAILED",
          VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED,
        );
      }

      return {
        needsTranscode,
        driveBytes: downloadDetail?.bytes ?? download.content.length,
        driveMimeType: downloadDetail?.mimeType ?? download.mimeType,
        cachedBytes: prepared.sizeBytes,
        cachedMimeType: prepared.mimeType,
        fileName: prepared.fileName,
      };
    });
    download = null;

    await runPlaybackTestStep(steps, "cache-store", async () => {
      if (!prepared) {
        throw createVoiceMemoPlaybackError(
          DRIVE_TRY_AGAIN_LATER_MESSAGE,
          503,
          "TRANSCODE_FAILED",
          VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED,
        );
      }
      await upsertVoiceMemoAudio({
        driveFileId,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        sizeBytes: prepared.sizeBytes,
        content: prepared.content,
      });
      return {
        driveFileId,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        sizeBytes: prepared.sizeBytes,
        replacedExisting: clearDetail?.hadCache === true,
      };
    });

    const fullPlayback = await runPlaybackTestStep(steps, "playback-full", async () => {
      const probe = await probeVoiceMemoPlaybackStream(driveFileId);
      if (!probe.playableHeader) {
        throw createVoiceMemoPlaybackError(
          DRIVE_TRY_AGAIN_LATER_MESSAGE,
          503,
          "TRANSCODE_FAILED",
          VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED,
        );
      }
      return probe;
    });

    const rangePlayback = await runPlaybackTestStep(steps, "playback-range", async () => {
      const probe = await probeVoiceMemoPlaybackStream(driveFileId, "bytes=0-0");
      if (probe.status !== 206 && probe.status !== 200) {
        throw createVoiceMemoPlaybackError(
          DRIVE_TRY_AGAIN_LATER_MESSAGE,
          503,
          "STREAM_ERROR",
          VOICE_MEMO_ERROR_CODES.STREAM_ERROR,
        );
      }
      return probe;
    });

    let streamToken = null;
    let streamPath = null;
    if (aesopId) {
      const tokenDetail = await runPlaybackTestStep(steps, "stream-token", async () => {
        const token = mintVoiceStreamToken(aesopId);
        if (!token) {
          throw new Error("Could not mint a stream token for this AESOP ID.");
        }
        streamToken = token;
        streamPath = `/api/portal-voice-memo/stream?st=${token}`;
        return { aesopId, streamPath };
      });
      streamPath = tokenDetail?.streamPath || streamPath;
    } else {
      skipPlaybackTestStep(steps, "stream-token", "Skipped — provide an AESOP ID to test portal playback URL.");
    }

    return {
      ok: true,
      steps,
      aesopId: aesopId || null,
      driveFileId,
      fileName,
      durationMs: Date.now() - startedAt,
      streamToken,
      streamPath,
      playback: {
        full: fullPlayback,
        rangeProbe: rangePlayback,
      },
    };
  } catch (error) {
    const formatted = formatAdminVoiceMemoPlaybackTestError(error);
    return {
      ok: false,
      steps,
      aesopId: aesopId || null,
      driveFileId: driveFileId || null,
      fileName,
      durationMs: Date.now() - startedAt,
      error: formatted.message,
      errorCode: formatted.errorCode,
      code: formatted.code,
      streamToken: null,
      streamPath: null,
    };
  }
}

/**
 * @param {unknown} error
 */
function formatAdminVoiceMemoPlaybackTestError(error) {
  const mapped = mapVoiceMemoStreamError(error);
  const diagnostic = formatGoogleDriveOperationError(error);
  const useDiagnostic =
    /unregistered callers|missing a valid api key|drive-api-identity|drive request failed/i.test(
      diagnostic,
    );
  return {
    message: useDiagnostic ? diagnostic : mapped.message,
    statusCode: mapped.statusCode,
    code: mapped.code,
    errorCode: mapped.errorCode,
    diagnostic: useDiagnostic ? diagnostic : null,
  };
}

module.exports = {
  PLAYBACK_TEST_STEP_DEFINITIONS,
  createPlaybackTestSteps,
  runAdminVoiceMemoPlaybackTest,
  formatAdminVoiceMemoPlaybackTestError,
};
