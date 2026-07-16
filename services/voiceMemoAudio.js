const { Readable } = require("stream");
const { getPool, isDatabaseEnabled } = require("../db/index");
const {
  downloadVoiceMemoFile,
  DRIVE_TRY_AGAIN_LATER_MESSAGE,
  VOICE_MEMO_AUDIO_CACHE_MAX_BYTES,
} = require("./googleDrive");
const { voiceMemoExtensionFromFileName } = require("../utils/voiceMemoExtensions");
const { resolveVoiceMemoMimeType } = require("../utils/voiceMemoContentType");
const {
  voiceMemoNeedsTranscodeForPlayback,
  voiceMemoNeedsBrowserPlaybackTranscode,
  isFfmpegAvailable,
  isMp4FamilyBuffer,
  isValidVoiceMemoPlaybackM4a,
  transcodeVoiceMemoToM4aBuffer,
  remuxVoiceMemoMp4Faststart,
} = require("../utils/voiceMemoTranscode");
const {
  VOICE_MEMO_ERROR_CODES,
  VOICE_MEMO_NOT_CACHED_MESSAGE,
  createVoiceMemoPlaybackError,
  mapVoiceMemoStreamError,
} = require("./voiceMemoStreamErrors");

/** Download/cache in chunks so cron jobs can reclaim memory between files. */
const VOICE_MEMO_AUDIO_SYNC_CHUNK_SIZE = 10;

/**
 * @param {string} fileName
 * @returns {string|null}
 */
function voiceMemoAesopIdFromFileName(fileName) {
  const name = String(fileName || "").trim();
  if (!name) {
    return null;
  }
  const match = /^(.+)\.[^.]+$/i.exec(name);
  return match ? match[1].trim() : name;
}

/**
 * @param {{
 *   parsedFiles?: Array<{ fileId?: string, fileName?: string, aesopId?: string }>,
 * }|null|undefined} scan
 * @returns {Map<string, string>}
 */
function buildVoiceMemoAesopIdByFileIdMap(scan) {
  /** @type {Map<string, string>} */
  const aesopIdByFileId = new Map();
  for (const parsed of scan?.parsedFiles || []) {
    const fileId = String(parsed?.fileId || "").trim();
    const aesopId = String(parsed?.aesopId || "").trim();
    if (fileId && aesopId) {
      aesopIdByFileId.set(fileId, aesopId);
    }
  }
  return aesopIdByFileId;
}

/**
 * @param {{ fileId?: string, fileName?: string, aesopId?: string, aesopIdByFileId?: Map<string, string> }} params
 * @returns {string|null}
 */
function resolveVoiceMemoAesopId({ fileId, fileName, aesopId, aesopIdByFileId }) {
  const direct = String(aesopId || "").trim();
  if (direct) {
    return direct;
  }
  const normalizedFileId = String(fileId || "").trim();
  if (normalizedFileId && aesopIdByFileId?.has(normalizedFileId)) {
    return aesopIdByFileId.get(normalizedFileId) || null;
  }
  return voiceMemoAesopIdFromFileName(fileName);
}

/**
 * @param {string} message
 * @param {{ fileId?: string, fileName?: string, aesopId?: string, aesopIdByFileId?: Map<string, string> }} [context]
 */
function logVoiceMemoAudioProgress(message, context = {}) {
  const aesopId = resolveVoiceMemoAesopId(context);
  if (aesopId) {
    console.info(`[voice-memo-audio] AESOP ID ${aesopId}: ${message}`);
    return;
  }
  const fileName = String(context.fileName || "").trim();
  if (fileName) {
    console.info(`[voice-memo-audio] ${fileName}: ${message}`);
    return;
  }
  console.info(`[voice-memo-audio] ${message}`);
}

/**
 * @param {string} message
 * @param {{ fileId?: string, fileName?: string, aesopId?: string, aesopIdByFileId?: Map<string, string> }} [context]
 */
function logVoiceMemoAudioWarning(message, context = {}) {
  const aesopId = resolveVoiceMemoAesopId(context);
  if (aesopId) {
    console.warn(`[voice-memo-audio] AESOP ID ${aesopId}: ${message}`);
    return;
  }
  const fileName = String(context.fileName || "").trim();
  if (fileName) {
    console.warn(`[voice-memo-audio] ${fileName}: ${message}`);
    return;
  }
  console.warn(`[voice-memo-audio] ${message}`);
}

/**
 * @param {Array<{ fileId: string|null, fileName: string, reason: string }>|null|undefined} failures
 * @param {{ fileId?: string, fileName?: string, reason: string }} entry
 */
function recordVoiceMemoCacheFailure(failures, { fileId, fileName, aesopId, reason }) {
  if (!Array.isArray(failures)) {
    return;
  }
  failures.push({
    fileId: String(fileId || "").trim() || null,
    fileName: String(fileName || "").trim() || "voice-memo",
    aesopId: String(aesopId || voiceMemoAesopIdFromFileName(fileName) || "").trim() || null,
    reason: String(reason || "unknown"),
  });
}

/**
 * @param {Array<{ fileId: string|null, fileName: string, reason: string }>|null|undefined} failures
 * @param {{ label?: string }} [options]
 */
function logVoiceMemoAudioTranscodeFailures(failures, { label = "[voice-memo-audio]" } = {}) {
  const items = Array.isArray(failures) ? failures : [];
  if (items.length === 0) {
    console.info(`${label} audio cache: no transcode failures.`);
    return;
  }
  const sorted = [...items].sort(
    (a, b) =>
      a.fileName.localeCompare(b.fileName) || String(a.fileId || "").localeCompare(String(b.fileId || "")),
  );
  console.warn(
    `${label} ===== Audio transcode failures (${sorted.length}) — manual review needed =====`,
  );
  for (const entry of sorted) {
    const aesopLabel = entry.aesopId ? `AESOP ID ${entry.aesopId}` : entry.fileName;
    const idSuffix = entry.fileId ? ` · Drive ${entry.fileId}` : "";
    console.warn(`${label}   - ${aesopLabel}${idSuffix}: ${entry.reason}`);
  }
  console.warn(`${label} ================================================================`);
}

/**
 * @param {{
 *   memosById?: Map<string, unknown>,
 *   parsedFiles?: Array<{ fileId?: string, fileName?: string }>,
 * }|null|undefined} scan
 * @returns {string[]}
 */
function collectDriveFileIdsFromScan(scan) {
  const ids = new Set();
  for (const parsed of scan?.parsedFiles || []) {
    const fileId = String(parsed?.fileId || "").trim();
    if (fileId) {
      ids.add(fileId);
    }
  }
  return [...ids];
}

/**
 * @param {string} fileName
 * @returns {string}
 */
function voiceMemoPlaybackFileName(fileName) {
  const base = String(fileName || "voice-memo.m4a").trim() || "voice-memo.m4a";
  const extension = voiceMemoExtensionFromFileName(base);
  if (!extension || !voiceMemoNeedsTranscodeForPlayback(extension)) {
    return base;
  }
  return base.replace(/\.[^.]+$/i, ".m4a");
}

/**
 * @param {string} rangeHeader
 * @param {number} totalSize
 * @returns {{ start: number, end: number, status: number, contentRange: string|null, contentLength: string }}
 */
function parseVoiceMemoByteRange(rangeHeader, totalSize) {
  const normalized = String(rangeHeader || "").trim();
  if (!normalized.startsWith("bytes=")) {
    return {
      start: 0,
      end: totalSize - 1,
      status: 200,
      contentRange: null,
      contentLength: String(totalSize),
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(normalized);
  if (!match) {
    return {
      start: 0,
      end: totalSize - 1,
      status: 200,
      contentRange: null,
      contentLength: String(totalSize),
    };
  }

  let start = match[1] === "" ? Math.max(0, totalSize - 1) : Number.parseInt(match[1], 10);
  let end = match[2] === "" ? totalSize - 1 : Number.parseInt(match[2], 10);
  if (!Number.isFinite(start) || start < 0) {
    start = 0;
  }
  if (!Number.isFinite(end) || end >= totalSize) {
    end = totalSize - 1;
  }
  if (start > end || start >= totalSize) {
    const error = new Error("Invalid byte range.");
    error.statusCode = 416;
    throw error;
  }

  return {
    start,
    end,
    status: 206,
    contentRange: `bytes ${start}-${end}/${totalSize}`,
    contentLength: String(end - start + 1),
  };
}

/**
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {import('stream').Readable}
 */
function sliceBufferToStream(buffer, start, end) {
  return Readable.from(buffer.subarray(start, end + 1));
}

/**
 * @param {string} driveFileId
 * @returns {Promise<{ driveFileId: string, fileName: string, mimeType: string, sizeBytes: number, content: Buffer }|null>}
 */
async function getVoiceMemoAudioRow(driveFileId) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const normalizedFileId = String(driveFileId || "").trim();
  if (!normalizedFileId) {
    return null;
  }

  const result = await pool.query(
    `SELECT drive_file_id, file_name, mime_type, size_bytes, content
     FROM voice_memo_audio
     WHERE drive_file_id = $1`,
    [normalizedFileId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    driveFileId: String(row.drive_file_id),
    fileName: String(row.file_name || "voice-memo.m4a"),
    mimeType: String(row.mime_type || "audio/mp4"),
    sizeBytes: Number(row.size_bytes) || 0,
    content: row.content,
  };
}

/**
 * @returns {Promise<Set<string>>}
 */
async function listCachedVoiceMemoFileIds() {
  const pool = getPool();
  if (!pool) {
    return new Set();
  }
  const result = await pool.query(`SELECT drive_file_id FROM voice_memo_audio`);
  return new Set(
    result.rows
      .map((row) => String(row.drive_file_id || "").trim())
      .filter(Boolean),
  );
}

/**
 * @param {{
 *   driveFileId: string,
 *   fileName: string,
 *   mimeType: string,
 *   sizeBytes: number,
 *   content: Buffer,
 * }} entry
 */
async function upsertVoiceMemoAudio(entry) {
  const pool = getPool();
  if (!pool) {
    return false;
  }
  await pool.query(
    `INSERT INTO voice_memo_audio (
       drive_file_id, file_name, mime_type, size_bytes, content, cached_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (drive_file_id) DO UPDATE SET
       file_name = EXCLUDED.file_name,
       mime_type = EXCLUDED.mime_type,
       size_bytes = EXCLUDED.size_bytes,
       content = EXCLUDED.content,
       cached_at = NOW()`,
    [
      entry.driveFileId,
      entry.fileName,
      entry.mimeType,
      entry.sizeBytes,
      entry.content,
    ],
  );
  return true;
}

/**
 * @param {string} driveFileId
 * @returns {Promise<boolean>}
 */
async function deleteVoiceMemoAudioRow(driveFileId) {
  const pool = getPool();
  if (!pool) {
    return false;
  }
  const normalizedFileId = String(driveFileId || "").trim();
  if (!normalizedFileId) {
    return false;
  }
  const result = await pool.query(`DELETE FROM voice_memo_audio WHERE drive_file_id = $1`, [
    normalizedFileId,
  ]);
  return (result.rowCount || 0) > 0;
}

/**
 * @param {Buffer} content
 * @param {string} fileName
 * @param {string} rangeHeader
 * @param {{ mimeType?: string, playbackFileName?: string }} [options]
 */
function buildBufferedVoiceMemoStreamResult(content, fileName, rangeHeader, options = {}) {
  const range = parseVoiceMemoByteRange(rangeHeader, content.length);
  return {
    stream: sliceBufferToStream(content, range.start, range.end),
    mimeType: options.mimeType || "audio/mp4",
    fileName: options.playbackFileName || fileName,
    size: content.length,
    status: range.status,
    contentRange: range.contentRange,
    contentLength: range.contentLength,
  };
}

/**
 * @param {Buffer} content
 * @param {string} fileName
 * @returns {Promise<Buffer|null>}
 */
async function normalizeVoiceMemoContentForBrowserPlayback(content, fileName) {
  if (!(await isFfmpegAvailable())) {
    return content;
  }

  if (await voiceMemoNeedsBrowserPlaybackTranscode(content, fileName)) {
    const transcoded = await transcodeVoiceMemoToM4aBuffer(content);
    return transcoded;
  }

  if (isMp4FamilyBuffer(content)) {
    const remuxed = await remuxVoiceMemoMp4Faststart(content, { fallbackToInput: false });
    return remuxed || null;
  }

  return content;
}

/**
 * @param {string} fileId
 * @param {string} rangeHeader
 */
async function streamVoiceMemoFromDriveForPlayback(fileId, rangeHeader = "") {
  let download;
  try {
    download = await downloadVoiceMemoFile(fileId);
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

  const normalized = await normalizeVoiceMemoContentForBrowserPlayback(
    download.content,
    download.fileName,
  );
  if (!normalized) {
    console.warn(
      `[voice-memo-audio] drive playback transcode failed for ${download.fileName || fileId} ` +
        `(bytes=${download.content.length})`,
    );
    throw createVoiceMemoPlaybackError(
      DRIVE_TRY_AGAIN_LATER_MESSAGE,
      503,
      "TRANSCODE_FAILED",
      VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED,
    );
  }

  return buildBufferedVoiceMemoStreamResult(normalized, download.fileName, rangeHeader, {
    mimeType: "audio/mp4",
    playbackFileName: voiceMemoPlaybackFileName(download.fileName),
  });
}

/**
 * Cached rows should already be browser-ready AAC. Raw AMR/3GP leftovers are stale.
 * @param {Buffer} content
 * @param {string} fileName
 * @returns {Promise<boolean>}
 */
async function isVoiceMemoCacheStale(content, fileName) {
  if (!content || content.length < 16) {
    return true;
  }
  if (!(await isFfmpegAvailable())) {
    return false;
  }
  return voiceMemoNeedsBrowserPlaybackTranscode(content, fileName);
}

/**
 * @param {string[]} currentFileIds
 * @param {Map<string, string>} fileNameById
 * @param {{ deadlineAt?: number }} [options]
 * @returns {Promise<number>}
 */
async function refreshStaleVoiceMemoCacheEntries(currentFileIds, fileNameById, options = {}) {
  const failures = options.failures;
  const aesopIdByFileId = options.aesopIdByFileId || new Map();
  let refreshed = 0;
  for (const fileId of currentFileIds) {
    const row = await getVoiceMemoAudioRow(fileId);
    if (!row?.content) {
      continue;
    }
    const content = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    if (!(await isVoiceMemoCacheStale(content, row.fileName))) {
      continue;
    }

    const logContext = {
      fileId,
      fileName: row.fileName,
      aesopIdByFileId,
    };
    logVoiceMemoAudioWarning(
      `stale cache (bytes=${content.length}); deleting and re-downloading from Drive`,
      logContext,
    );
    await deleteVoiceMemoAudioRow(fileId);

    logVoiceMemoAudioProgress("processing (refresh stale cache)", logContext);
    const download = await downloadVoiceMemoFile(fileId, { deadlineAt: options.deadlineAt });
    if (!download?.content || download.content.length <= 0) {
      continue;
    }
    if (download.sizeBytes > VOICE_MEMO_AUDIO_CACHE_MAX_BYTES) {
      continue;
    }

    const prepared = await prepareVoiceMemoAudioCacheEntry(
      download.content,
      download.fileName || fileNameById.get(fileId) || "voice-memo.m4a",
      download.mimeType,
      {
        fileId,
        failures,
        aesopId: resolveVoiceMemoAesopId(logContext),
        aesopIdByFileId,
      },
    );
    if (!prepared) {
      download.content = null;
      continue;
    }

    await upsertVoiceMemoAudio({
      driveFileId: download.fileId,
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      sizeBytes: prepared.sizeBytes,
      content: prepared.content,
    });
    logVoiceMemoAudioProgress(
      `cached (${prepared.fileName}, ${prepared.sizeBytes} bytes)`,
      logContext,
    );
    refreshed += 1;
    download.content = null;
  }
  return refreshed;
}

/**
 * Delete every cached voice memo audio row so the next sync re-downloads all files.
 * @returns {Promise<{ cleared: number }>}
 */
async function clearAllVoiceMemoAudioCache() {
  const pool = getPool();
  if (!pool) {
    const error = new Error("Postgres is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const result = await pool.query(`DELETE FROM voice_memo_audio`);
  return { cleared: result.rowCount || 0 };
}

/**
 * Remove cached audio rows that are no longer present in the Drive folder scan.
 * @param {string[]} currentFileIds
 * @returns {Promise<number>}
 */
async function pruneVoiceMemoAudioNotInDrive(currentFileIds) {
  const pool = getPool();
  if (!pool) {
    return 0;
  }

  const ids = [...new Set(currentFileIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length === 0) {
    const result = await pool.query(`DELETE FROM voice_memo_audio`);
    return result.rowCount || 0;
  }

  const result = await pool.query(
    `DELETE FROM voice_memo_audio
     WHERE NOT (drive_file_id = ANY($1::text[]))`,
    [ids],
  );
  return result.rowCount || 0;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(items, size) {
  const chunkSize = Math.max(1, Math.floor(size) || 1);
  /** @type {T[][]} */
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Mirror voice memo audio bytes from Drive into Postgres.
 * @param {{
 *   parsedFiles?: Array<{ fileId?: string, fileName?: string }>,
 * }|null|undefined} scan
 * @param {{ deadlineAt?: number }} [options]
 * @returns {Promise<{ driveFiles: number, cached: number, downloaded: number, skipped: number, pruned: number, transcodeFailures: Array<{ fileId: string|null, fileName: string, reason: string }> }>}
 */
async function syncVoiceMemoAudioFromScan(scan, options = {}) {
  if (!isDatabaseEnabled()) {
    return {
      driveFiles: 0,
      alreadyCached: 0,
      downloaded: 0,
      skipped: 0,
      pruned: 0,
      transcodeFailures: [],
    };
  }

  /** @type {Array<{ fileId: string|null, fileName: string, aesopId?: string|null, reason: string }>} */
  const transcodeFailures = [];

  const currentFileIds = collectDriveFileIdsFromScan(scan);
  const cachedIds = await listCachedVoiceMemoFileIds();
  const missingIds = currentFileIds.filter((fileId) => !cachedIds.has(fileId));
  const aesopIdByFileId = buildVoiceMemoAesopIdByFileIdMap(scan);

  /** @type {Map<string, string>} */
  const fileNameById = new Map();
  for (const parsed of scan?.parsedFiles || []) {
    const fileId = String(parsed?.fileId || "").trim();
    if (!fileId) {
      continue;
    }
    fileNameById.set(fileId, String(parsed?.fileName || "").trim() || "voice-memo.m4a");
  }

  const refreshed = await refreshStaleVoiceMemoCacheEntries(currentFileIds, fileNameById, {
    ...options,
    failures: transcodeFailures,
    aesopIdByFileId,
  });

  let downloaded = 0;
  let skipped = 0;
  const chunks = chunkArray(missingIds, VOICE_MEMO_AUDIO_SYNC_CHUNK_SIZE);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    for (const fileId of chunk) {
      const fileName = fileNameById.get(fileId) || "voice-memo.m4a";
      const logContext = { fileId, fileName, aesopIdByFileId };
      logVoiceMemoAudioProgress("processing", logContext);

      const download = await downloadVoiceMemoFile(fileId, { deadlineAt: options.deadlineAt });
      if (!download) {
        skipped += 1;
        logVoiceMemoAudioWarning("skipped: Drive download failed", logContext);
        continue;
      }
      if (download.sizeBytes > VOICE_MEMO_AUDIO_CACHE_MAX_BYTES) {
        logVoiceMemoAudioWarning(
          `skipped: downloaded size ${download.sizeBytes} exceeds cache limit`,
          { ...logContext, fileName: download.fileName || fileName },
        );
        skipped += 1;
        download.content = null;
        continue;
      }

      const prepared = await prepareVoiceMemoAudioCacheEntry(
        download.content,
        download.fileName || fileName,
        download.mimeType,
        {
          fileId,
          failures: transcodeFailures,
          aesopId: resolveVoiceMemoAesopId(logContext),
          aesopIdByFileId,
        },
      );
      if (!prepared) {
        skipped += 1;
        download.content = null;
        continue;
      }

      await upsertVoiceMemoAudio({
        driveFileId: download.fileId,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        sizeBytes: prepared.sizeBytes,
        content: prepared.content,
      });
      logVoiceMemoAudioProgress(
        `cached (${prepared.fileName}, ${prepared.sizeBytes} bytes)`,
        logContext,
      );
      downloaded += 1;
      download.content = null;
    }
    console.info(
      `[voice-memo-audio] cached chunk ${chunkIndex + 1}/${chunks.length} ` +
        `(downloaded=${downloaded}, skipped=${skipped})`,
    );
  }

  const pruned = await pruneVoiceMemoAudioNotInDrive(currentFileIds);

  console.info(
    `[voice-memo-audio] driveFiles=${currentFileIds.length}, downloaded=${downloaded}, ` +
      `alreadyCached=${currentFileIds.length - missingIds.length}, refreshed=${refreshed}, ` +
      `skipped=${skipped}, pruned=${pruned}, transcodeFailures=${transcodeFailures.length}`,
  );

  return {
    driveFiles: currentFileIds.length,
    alreadyCached: currentFileIds.length - missingIds.length,
    refreshed,
    downloaded,
    skipped,
    pruned,
    transcodeFailures,
  };
}

/**
 * @param {Buffer} content
 * @param {string} fileName
 * @param {string} mimeType
 * @param {{ fileId?: string, failures?: Array<{ fileId: string|null, fileName: string, reason: string }> }} [cacheOptions]
 * @returns {Promise<{ content: Buffer, fileName: string, mimeType: string, sizeBytes: number }|null>}
 */
async function prepareVoiceMemoAudioCacheEntry(content, fileName, mimeType, cacheOptions = {}) {
  const { fileId, failures, aesopId: aesopIdOption, aesopIdByFileId } = cacheOptions;
  const aesopId = resolveVoiceMemoAesopId({
    fileId,
    fileName,
    aesopId: aesopIdOption,
    aesopIdByFileId,
  });
  const logContext = { fileId, fileName, aesopId, aesopIdByFileId };
  const transcodeContext = { aesopId: aesopId || undefined, fileName };

  if (await isFfmpegAvailable()) {
    if (await voiceMemoNeedsBrowserPlaybackTranscode(content, fileName, transcodeContext)) {
      const transcoded = await transcodeVoiceMemoToM4aBuffer(content, transcodeContext);
      if (!transcoded) {
        logVoiceMemoAudioWarning("skipping cache: browser transcode failed", logContext);
        recordVoiceMemoCacheFailure(failures, {
          fileId,
          fileName,
          aesopId,
          reason: "browser transcode failed",
        });
        return null;
      }
      content = transcoded;
    } else if (isMp4FamilyBuffer(content)) {
      const remuxed = await remuxVoiceMemoMp4Faststart(content, {
        fallbackToInput: false,
        context: transcodeContext,
      });
      if (!remuxed) {
        logVoiceMemoAudioWarning("skipping cache: mp4 faststart remux failed", logContext);
        recordVoiceMemoCacheFailure(failures, {
          fileId,
          fileName,
          aesopId,
          reason: "mp4 faststart remux failed",
        });
        return null;
      }
      content = remuxed;
    }
  }

  if (
    (await isFfmpegAvailable()) &&
    (await voiceMemoNeedsBrowserPlaybackTranscode(content, fileName, transcodeContext))
  ) {
    logVoiceMemoAudioWarning("skipping cache: still needs browser transcode", logContext);
    recordVoiceMemoCacheFailure(failures, {
      fileId,
      fileName,
      aesopId,
      reason: "still needs browser transcode after processing",
    });
    return null;
  }

  const resolvedMimeType = resolveVoiceMemoMimeType({
    fileName,
    driveMimeType: mimeType,
    buffer: content,
  });
  return {
    content,
    fileName,
    mimeType: resolvedMimeType,
    sizeBytes: content.length,
  };
}

/**
 * @param {string} fileId
 * @param {string} [rangeHeader]
 * @returns {Promise<{ stream: import('stream').Readable, mimeType: string, fileName: string, size: number|null, status: number, contentRange: string|null, contentLength: string|null }>}
 */
async function streamVoiceMemoFromCache(fileId, rangeHeader = "") {
  const normalizedFileId = String(fileId || "").trim();
  if (!normalizedFileId) {
    throw createVoiceMemoPlaybackError(
      "A voice memo file id is required.",
      404,
      "MISSING_FILE_ID",
      VOICE_MEMO_ERROR_CODES.MISSING_FILE_ID,
    );
  }

  const row = await getVoiceMemoAudioRow(normalizedFileId);
  if (!row || !row.content) {
    throw createVoiceMemoPlaybackError(
      VOICE_MEMO_NOT_CACHED_MESSAGE,
      503,
      "VOICE_MEMO_NOT_CACHED",
      VOICE_MEMO_ERROR_CODES.NOT_CACHED,
    );
  }

  let content = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
  if (content.length <= 0) {
    throw createVoiceMemoPlaybackError(
      VOICE_MEMO_NOT_CACHED_MESSAGE,
      503,
      "VOICE_MEMO_NOT_CACHED",
      VOICE_MEMO_ERROR_CODES.NOT_CACHED,
    );
  }

  const needsBrowserTranscode =
    (await isFfmpegAvailable()) &&
    (await voiceMemoNeedsBrowserPlaybackTranscode(content, row.fileName));

  if (needsBrowserTranscode) {
    const transcoded = await transcodeVoiceMemoToM4aBuffer(content);
    if (!transcoded) {
      console.warn(
        `[voice-memo-audio] cache transcode failed for ${row.fileName || normalizedFileId} ` +
          `(bytes=${content.length}); deleting cache row and retrying from Drive`,
      );
      await deleteVoiceMemoAudioRow(normalizedFileId);
      return streamVoiceMemoFromDriveForPlayback(normalizedFileId, rangeHeader);
    }
    return buildBufferedVoiceMemoStreamResult(transcoded, row.fileName, rangeHeader, {
      mimeType: "audio/mp4",
      playbackFileName: voiceMemoPlaybackFileName(row.fileName),
    });
  }

  if (isMp4FamilyBuffer(content)) {
    const remuxed = await remuxVoiceMemoMp4Faststart(content, { fallbackToInput: false });
    if (!remuxed) {
      console.warn(
        `[voice-memo-audio] cache remux failed for ${row.fileName || normalizedFileId} ` +
          `(bytes=${content.length}); deleting cache row and retrying from Drive`,
      );
      await deleteVoiceMemoAudioRow(normalizedFileId);
      return streamVoiceMemoFromDriveForPlayback(normalizedFileId, rangeHeader);
    }
    content = remuxed;
  }

  const actualSize = content.length;
  if (row.sizeBytes !== actualSize) {
    console.warn(
      `[voice-memo-audio] size mismatch driveFileId=${normalizedFileId} ` +
        `db=${row.sizeBytes} actual=${actualSize}`,
    );
  }

  const mimeType = resolveVoiceMemoMimeType({
    fileName: row.fileName,
    driveMimeType: row.mimeType,
    buffer: content,
  });

  return buildBufferedVoiceMemoStreamResult(content, row.fileName, rangeHeader, { mimeType });
}

/**
 * Stream a voice memo: Postgres cache first, then Drive on cache miss.
 * @param {string} fileId
 * @param {string} [rangeHeader]
 */
async function streamVoiceMemoForPlayback(fileId, rangeHeader = "") {
  const normalizedFileId = String(fileId || "").trim();
  if (!normalizedFileId) {
    throw createVoiceMemoPlaybackError(
      "A voice memo file id is required.",
      404,
      "MISSING_FILE_ID",
      VOICE_MEMO_ERROR_CODES.MISSING_FILE_ID,
    );
  }

  const row = await getVoiceMemoAudioRow(normalizedFileId);
  const cachedBytes =
    row?.content != null
      ? (Buffer.isBuffer(row.content) ? row.content.length : Buffer.byteLength(row.content))
      : 0;
  if (cachedBytes > 0) {
    return streamVoiceMemoFromCache(normalizedFileId, rangeHeader);
  }

  return streamVoiceMemoFromDriveForPlayback(normalizedFileId, rangeHeader);
}

/**
 * @param {import('stream').Readable} stream
 * @param {number} [maxBytes]
 * @returns {Promise<{ bytesRead: number, buffer: Buffer }>}
 */
function drainReadableStream(stream, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ bytesRead: total, buffer: Buffer.concat(chunks) });
    };

    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      total += buffer.length;
      if (total >= maxBytes) {
        stream.destroy();
        finish();
      }
    });
    stream.on("end", finish);
    stream.on("close", () => {
      if (total > 0) {
        finish();
      }
    });
    stream.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

/**
 * Delete any cached row, download from Drive, and store a browser-playable cache entry.
 * @param {string} driveFileId
 */
async function recacheSingleVoiceMemoFromDrive(driveFileId) {
  const normalizedFileId = String(driveFileId || "").trim();
  if (!normalizedFileId) {
    throw createVoiceMemoPlaybackError(
      "A voice memo file id is required.",
      400,
      "MISSING_FILE_ID",
      VOICE_MEMO_ERROR_CODES.MISSING_FILE_ID,
    );
  }

  const existing = await getVoiceMemoAudioRow(normalizedFileId);
  const hadCache = Boolean(existing?.content && existing.content.length > 0);
  await deleteVoiceMemoAudioRow(normalizedFileId);

  const download = await downloadVoiceMemoFile(normalizedFileId);
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

  const needsTranscode = await voiceMemoNeedsBrowserPlaybackTranscode(
    download.content,
    download.fileName,
  );
  const prepared = await prepareVoiceMemoAudioCacheEntry(
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

  await upsertVoiceMemoAudio({
    driveFileId: normalizedFileId,
    fileName: prepared.fileName,
    mimeType: prepared.mimeType,
    sizeBytes: prepared.sizeBytes,
    content: prepared.content,
  });

  return {
    hadCache,
    clearedCache: hadCache,
    driveFileId: normalizedFileId,
    fileName: download.fileName,
    driveBytes: download.content.length,
    driveMimeType: download.mimeType,
    cachedBytes: prepared.sizeBytes,
    cachedMimeType: prepared.mimeType,
    transcoded: needsTranscode,
  };
}

/**
 * Exercise the same playback path applicants use after cache is populated.
 * @param {string} driveFileId
 * @param {string} [rangeHeader]
 */
async function probeVoiceMemoPlaybackStream(driveFileId, rangeHeader = "") {
  const streamResult = await streamVoiceMemoForPlayback(driveFileId, rangeHeader);
  const drained = await drainReadableStream(streamResult.stream);
  return {
    status: streamResult.status,
    mimeType: streamResult.mimeType,
    fileName: streamResult.fileName,
    size: streamResult.size,
    contentRange: streamResult.contentRange,
    contentLength: streamResult.contentLength,
    bytesRead: drained.bytesRead,
    playableHeader: isMp4FamilyBuffer(drained.buffer) || drained.bytesRead > 0,
  };
}

module.exports = {
  VOICE_MEMO_AUDIO_CACHE_MAX_BYTES,
  VOICE_MEMO_NOT_CACHED_MESSAGE,
  collectDriveFileIdsFromScan,
  parseVoiceMemoByteRange,
  syncVoiceMemoAudioFromScan,
  streamVoiceMemoFromCache,
  streamVoiceMemoForPlayback,
  getVoiceMemoAudioRow,
  listCachedVoiceMemoFileIds,
  clearAllVoiceMemoAudioCache,
  logVoiceMemoAudioTranscodeFailures,
  pruneVoiceMemoAudioNotInDrive,
  upsertVoiceMemoAudio,
  deleteVoiceMemoAudioRow,
  recacheSingleVoiceMemoFromDrive,
  probeVoiceMemoPlaybackStream,
  prepareVoiceMemoAudioCacheEntry,
};
