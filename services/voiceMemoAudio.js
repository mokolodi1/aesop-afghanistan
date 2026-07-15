const { Readable } = require("stream");
const { getPool, isDatabaseEnabled } = require("../db/index");
const {
  downloadVoiceMemoFile,
  streamVoiceMemoFile,
  VOICE_MEMO_AUDIO_CACHE_MAX_BYTES,
} = require("./googleDrive");
const { voiceMemoExtensionFromFileName } = require("../utils/voiceMemoExtensions");
const { resolveVoiceMemoMimeType } = require("../utils/voiceMemoContentType");
const {
  voiceMemoNeedsTranscodeForPlayback,
  isFfmpegAvailable,
  isMp4FamilyBuffer,
  transcodeVoiceMemoToM4aStream,
  remuxVoiceMemoMp4Faststart,
} = require("../utils/voiceMemoTranscode");
const {
  VOICE_MEMO_ERROR_CODES,
  VOICE_MEMO_NOT_CACHED_MESSAGE,
  createVoiceMemoPlaybackError,
} = require("./voiceMemoStreamErrors");

/** Download/cache in chunks so cron jobs can reclaim memory between files. */
const VOICE_MEMO_AUDIO_SYNC_CHUNK_SIZE = 10;

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
 * @returns {Promise<{ driveFiles: number, cached: number, downloaded: number, skipped: number, pruned: number }>}
 */
async function syncVoiceMemoAudioFromScan(scan, options = {}) {
  if (!isDatabaseEnabled()) {
    return { driveFiles: 0, alreadyCached: 0, downloaded: 0, skipped: 0, pruned: 0 };
  }

  const currentFileIds = collectDriveFileIdsFromScan(scan);
  const cachedIds = await listCachedVoiceMemoFileIds();
  const missingIds = currentFileIds.filter((fileId) => !cachedIds.has(fileId));

  /** @type {Map<string, string>} */
  const fileNameById = new Map();
  for (const parsed of scan?.parsedFiles || []) {
    const fileId = String(parsed?.fileId || "").trim();
    if (!fileId) {
      continue;
    }
    fileNameById.set(fileId, String(parsed?.fileName || "").trim() || "voice-memo.m4a");
  }

  let downloaded = 0;
  let skipped = 0;
  const chunks = chunkArray(missingIds, VOICE_MEMO_AUDIO_SYNC_CHUNK_SIZE);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    for (const fileId of chunk) {
      const download = await downloadVoiceMemoFile(fileId, { deadlineAt: options.deadlineAt });
      if (!download) {
        skipped += 1;
        continue;
      }
      if (download.sizeBytes > VOICE_MEMO_AUDIO_CACHE_MAX_BYTES) {
        console.warn(
          `[voice-memo-audio] skipping ${download.fileName}: downloaded size ${download.sizeBytes} exceeds cache limit`,
        );
        skipped += 1;
        download.content = null;
        continue;
      }

      const prepared = await prepareVoiceMemoAudioCacheEntry(
        download.content,
        download.fileName || fileNameById.get(fileId) || "voice-memo.m4a",
        download.mimeType,
      );

      await upsertVoiceMemoAudio({
        driveFileId: download.fileId,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        sizeBytes: prepared.sizeBytes,
        content: prepared.content,
      });
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
      `alreadyCached=${currentFileIds.length - missingIds.length}, skipped=${skipped}, pruned=${pruned}`,
  );

  return {
    driveFiles: currentFileIds.length,
    alreadyCached: currentFileIds.length - missingIds.length,
    downloaded,
    skipped,
    pruned,
  };
}

/**
 * @param {Buffer} content
 * @param {string} fileName
 * @param {string} mimeType
 * @returns {Promise<{ content: Buffer, fileName: string, mimeType: string, sizeBytes: number }>}
 */
async function prepareVoiceMemoAudioCacheEntry(content, fileName, mimeType) {
  let prepared = content;
  prepared = await remuxVoiceMemoMp4Faststart(prepared);
  const resolvedMimeType = resolveVoiceMemoMimeType({
    fileName,
    driveMimeType: mimeType,
    buffer: prepared,
  });
  return {
    content: prepared,
    fileName,
    mimeType: resolvedMimeType,
    sizeBytes: prepared.length,
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

  if (isMp4FamilyBuffer(content)) {
    content = await remuxVoiceMemoMp4Faststart(content);
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

  const extension = voiceMemoExtensionFromFileName(row.fileName);
  const shouldTranscode =
    extension != null && voiceMemoNeedsTranscodeForPlayback(extension) && (await isFfmpegAvailable());

  if (shouldTranscode) {
    const { stream } = transcodeVoiceMemoToM4aStream(Readable.from(content));
    return {
      stream,
      mimeType: "audio/mp4",
      fileName: voiceMemoPlaybackFileName(row.fileName),
      size: null,
      status: 200,
      contentRange: null,
      contentLength: null,
    };
  }

  const range = parseVoiceMemoByteRange(rangeHeader, actualSize);
  return {
    stream: sliceBufferToStream(content, range.start, range.end),
    mimeType,
    fileName: row.fileName,
    size: actualSize,
    status: range.status,
    contentRange: range.contentRange,
    contentLength: range.contentLength,
  };
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

  return streamVoiceMemoFile(normalizedFileId, rangeHeader);
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
  pruneVoiceMemoAudioNotInDrive,
  upsertVoiceMemoAudio,
};
