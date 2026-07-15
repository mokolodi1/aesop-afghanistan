const { Readable } = require("stream");
const { getPool, isDatabaseEnabled } = require("../db/index");
const { downloadVoiceMemoFile } = require("./googleDrive");
const { voiceMemoExtensionFromFileName } = require("../utils/voiceMemoExtensions");
const {
  voiceMemoNeedsTranscodeForPlayback,
  isFfmpegAvailable,
  transcodeVoiceMemoToM4aStream,
} = require("../utils/voiceMemoTranscode");

/** Match duration probing: voice notes are small; skip oversized Drive files. */
const VOICE_MEMO_AUDIO_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** Download/cache in chunks so cron jobs can reclaim memory between files. */
const VOICE_MEMO_AUDIO_SYNC_CHUNK_SIZE = 10;

const VOICE_MEMO_NOT_CACHED_MESSAGE =
  "Your voice note is safe and submitted. Audio is being prepared and should be available shortly. Please try again in a few minutes.";

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

      await upsertVoiceMemoAudio({
        driveFileId: download.fileId,
        fileName: download.fileName || fileNameById.get(fileId) || "voice-memo.m4a",
        mimeType: download.mimeType,
        sizeBytes: download.sizeBytes,
        content: download.content,
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
 * Stream a cached voice memo from Postgres (primary playback path).
 * @param {string} fileId
 * @param {string} [rangeHeader]
 * @returns {Promise<{ stream: import('stream').Readable, mimeType: string, fileName: string, size: number|null, status: number, contentRange: string|null, contentLength: string|null }>}
 */
async function streamVoiceMemoFromCache(fileId, rangeHeader = "") {
  const normalizedFileId = String(fileId || "").trim();
  if (!normalizedFileId) {
    const error = new Error("A voice memo file id is required.");
    error.statusCode = 404;
    throw error;
  }

  const row = await getVoiceMemoAudioRow(normalizedFileId);
  if (!row || !row.content || row.sizeBytes <= 0) {
    const error = new Error(VOICE_MEMO_NOT_CACHED_MESSAGE);
    error.statusCode = 503;
    error.code = "VOICE_MEMO_NOT_CACHED";
    throw error;
  }

  const extension = voiceMemoExtensionFromFileName(row.fileName);
  const shouldTranscode =
    extension != null && voiceMemoNeedsTranscodeForPlayback(extension) && (await isFfmpegAvailable());

  if (shouldTranscode) {
    const { stream } = transcodeVoiceMemoToM4aStream(Readable.from(row.content));
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

  const range = parseVoiceMemoByteRange(rangeHeader, row.sizeBytes);
  return {
    stream: sliceBufferToStream(row.content, range.start, range.end),
    mimeType: row.mimeType,
    fileName: row.fileName,
    size: row.sizeBytes,
    status: range.status,
    contentRange: range.contentRange,
    contentLength: range.contentLength,
  };
}

module.exports = {
  VOICE_MEMO_NOT_CACHED_MESSAGE,
  collectDriveFileIdsFromScan,
  parseVoiceMemoByteRange,
  syncVoiceMemoAudioFromScan,
  streamVoiceMemoFromCache,
  getVoiceMemoAudioRow,
  listCachedVoiceMemoFileIds,
  pruneVoiceMemoAudioNotInDrive,
  upsertVoiceMemoAudio,
};
