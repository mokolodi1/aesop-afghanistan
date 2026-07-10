const { google } = require("googleapis");
const { buildServiceAccountJwt } = require("./googleAuth");
const { parseVoiceMemoFileExtensions, DEFAULT_VOICE_MEMO_FILE_EXTENSIONS } = require("../utils/voiceMemoExtensions");
const { recordDriveFilesList, recordDriveFilesGet } = require("./portalMetrics");

const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/**
 * @param {string|string[]} extensionOrList
 * @returns {RegExp}
 */
function buildVoiceMemoFilenamePattern(extensionOrList) {
  const rawList = Array.isArray(extensionOrList)
    ? extensionOrList
    : String(extensionOrList || "m4a")
        .split(/[,|\s]+/)
        .map((part) => part.trim())
        .filter(Boolean);
  const extensions = rawList.length ? rawList : ["m4a"];
  const extGroup = extensions
    .map((extension) =>
      String(extension || "")
        .trim()
        .replace(/^\./, "")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .filter(Boolean)
    .join("|");
  return new RegExp(`^(.+)\\.(${extGroup})$`, "i");
}

/**
 * @param {{ extension?: string, extensions?: string[], submissionTimeSource?: 'createdTime'|'modifiedTime' }} options
 * @returns {{ extensions: string[], submissionTimeSource: 'createdTime'|'modifiedTime' }}
 */
function normalizeVoiceMemoScanOptions(options = {}) {
  const extensions = parseVoiceMemoFileExtensions(
    options.extensions ?? options.extension,
    DEFAULT_VOICE_MEMO_FILE_EXTENSIONS,
  );
  const submissionTimeSource =
    options.submissionTimeSource === "modifiedTime" ? "modifiedTime" : "createdTime";
  return { extensions, submissionTimeSource };
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeDriveQueryValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * @param {import('googleapis').drive_v3.Schema$File} file
 * @param {'createdTime'|'modifiedTime'} submissionTimeSource
 * @param {RegExp} filenamePattern
 * @returns {{ aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }|null}
 */
function parseVoiceMemoFile(file, submissionTimeSource, filenamePattern) {
  const name = String(file.name || "").trim();
  const match = name.match(filenamePattern);
  if (!match) {
    return null;
  }

  const aesopId = String(match[1] || "").trim();
  if (!aesopId) {
    return null;
  }

  const timeRaw = file[submissionTimeSource] || file.createdTime;
  const submittedAt = timeRaw ? new Date(timeRaw) : new Date(0);
  if (Number.isNaN(submittedAt.getTime())) {
    return null;
  }

  const fileId = String(file.id || "").trim();
  if (!fileId) {
    return null;
  }

  return {
    aesopId,
    fileId,
    webViewLink: String(file.webViewLink || "").trim(),
    submittedAt,
    fileName: name,
  };
}

/**
 * @param {string} folderId
 * @param {{ extension?: string, submissionTimeSource?: 'createdTime'|'modifiedTime' }} [options]
 * @returns {Promise<{
 *   memosById: Map<string, { aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }>,
 *   duplicateAesopIds: Array<{ aesopId: string, files: Array<{ fileName: string, submittedAt: string }> }>,
 *   parsedFiles: Array<{ aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }>,
 *   invalidFileNames: string[],
 *   totalDriveFiles: number,
 * }>}
 */
async function scanVoiceMemoFolder(folderId, options = {}) {
  const normalizedFolderId = String(folderId || "").trim();
  if (!normalizedFolderId) {
    throw new Error("voiceMemo.driveFolderId is required.");
  }

  const { extensions, submissionTimeSource } = normalizeVoiceMemoScanOptions(options);
  const filenamePattern = buildVoiceMemoFilenamePattern(extensions);

  const auth = await buildServiceAccountJwt([DRIVE_READONLY_SCOPE]);
  const drive = google.drive({ version: "v3", auth });

  /** @type {Array<{ aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }>} */
  const parsedFiles = [];
  /** @type {string[]} */
  const invalidFileNames = [];
  let totalDriveFiles = 0;
  let pageToken;

  do {
    const response = await drive.files.list({
      q: `'${normalizedFolderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id, name, webViewLink, createdTime, modifiedTime)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    recordDriveFilesList(1);

    for (const file of response.data.files || []) {
      totalDriveFiles += 1;
      const name = String(file.name || "").trim();
      const parsed = parseVoiceMemoFile(file, submissionTimeSource, filenamePattern);
      if (!parsed) {
        if (name) {
          invalidFileNames.push(name);
        }
        continue;
      }
      if (!parsed.webViewLink) {
        invalidFileNames.push(parsed.fileName);
        continue;
      }
      parsedFiles.push(parsed);
    }

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  /** @type {Map<string, Array<{ aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }>>} */
  const filesByAesopId = new Map();
  for (const parsed of parsedFiles) {
    const group = filesByAesopId.get(parsed.aesopId) || [];
    group.push(parsed);
    filesByAesopId.set(parsed.aesopId, group);
  }

  /** @type {Map<string, { aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }>} */
  const memosById = new Map();
  /** @type {Array<{ aesopId: string, files: Array<{ fileName: string, submittedAt: string }> }>} */
  const duplicateAesopIds = [];

  for (const [aesopId, files] of filesByAesopId.entries()) {
    if (files.length > 1) {
      duplicateAesopIds.push({
        aesopId,
        files: files
          .slice()
          .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
          .map((file) => ({
            fileName: file.fileName,
            submittedAt: file.submittedAt.toISOString(),
          })),
      });
    }
    const best = files.reduce((latest, file) =>
      !latest || file.submittedAt.getTime() > latest.submittedAt.getTime() ? file : latest,
    );
    memosById.set(aesopId, best);
  }

  duplicateAesopIds.sort((a, b) => a.aesopId.localeCompare(b.aesopId));

  return {
    memosById,
    duplicateAesopIds,
    parsedFiles,
    invalidFileNames,
    totalDriveFiles,
  };
}

/**
 * List voice memo files in a Drive folder keyed by AESOP ID parsed from filename.
 * @param {string} folderId
 * @param {{ extension?: string, submissionTimeSource?: 'createdTime'|'modifiedTime' }} [options]
 * @returns {Promise<Map<string, { aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }>>}
 */
async function listVoiceMemoFiles(folderId, options = {}) {
  const scan = await scanVoiceMemoFolder(folderId, options);
  return scan.memosById;
}

/**
 * @param {string} folderId
 * @param {string} aesopId
 * @param {{ extension?: string, submissionTimeSource?: 'createdTime'|'modifiedTime' }} [options]
 * @returns {Promise<{ aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }|null>}
 */
async function getVoiceMemoFileForAesopId(folderId, aesopId, options = {}) {
  const normalizedFolderId = String(folderId || "").trim();
  const normalizedId = String(aesopId || "").trim();
  if (!normalizedFolderId || !normalizedId) {
    return null;
  }

  const scan = await scanVoiceMemoFolder(folderId, options);
  const exact = scan.memosById.get(normalizedId);
  if (exact) {
    return exact;
  }
  const normalizedLower = normalizedId.toLowerCase();
  for (const [aesopId, memo] of scan.memosById.entries()) {
    if (aesopId.toLowerCase() === normalizedLower) {
      return memo;
    }
  }
  return null;
}

/**
 * Google Drive often reports .m4a as audio/mpeg, which browsers refuse to play.
 * @param {string} fileName
 * @param {string} driveMimeType
 * @returns {string}
 */
function resolveVoiceMemoStreamMimeType(fileName, driveMimeType) {
  const name = String(fileName || "").trim().toLowerCase();
  if (name.endsWith(".m4a")) {
    return "audio/mp4";
  }
  if (name.endsWith(".aac")) {
    return "audio/aac";
  }
  if (name.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  if (name.endsWith(".ogg")) {
    return "audio/ogg";
  }
  if (name.endsWith(".opus")) {
    return "audio/opus";
  }
  if (name.endsWith(".mp4")) {
    return "audio/mp4";
  }
  const mime = String(driveMimeType || "").trim();
  if (mime && !/^audio\/mpeg$/i.test(mime)) {
    return mime;
  }
  return "audio/mp4";
}

/**
 * @param {string} fileId
 * @param {string} [rangeHeader]
 * @returns {Promise<{ stream: import('stream').Readable, mimeType: string, fileName: string, size: number|null, status: number, contentRange: string|null, contentLength: string|null }>}
 */
async function streamVoiceMemoFile(fileId, rangeHeader) {
  const normalizedFileId = String(fileId || "").trim();
  if (!normalizedFileId) {
    throw new Error("A Drive file id is required.");
  }

  const auth = await buildServiceAccountJwt([DRIVE_READONLY_SCOPE]);
  const drive = google.drive({ version: "v3", auth });

  const meta = await drive.files.get({
    fileId: normalizedFileId,
    fields: "mimeType,name,size",
    supportsAllDrives: true,
  });
  recordDriveFilesGet(1);

  const requestOptions = { responseType: "stream" };
  if (rangeHeader) {
    requestOptions.headers = { Range: rangeHeader };
  }

  const media = await drive.files.get(
    { fileId: normalizedFileId, alt: "media", supportsAllDrives: true },
    requestOptions,
  );
  recordDriveFilesGet(1);

  const sizeRaw = meta.data.size;
  const size = sizeRaw != null && String(sizeRaw).trim() !== "" ? Number.parseInt(String(sizeRaw), 10) : null;
  const fileName = String(meta.data.name || "voice-memo.m4a");

  return {
    stream: media.data,
    mimeType: resolveVoiceMemoStreamMimeType(fileName, meta.data.mimeType),
    fileName,
    size: Number.isFinite(size) ? size : null,
    status: media.status || 200,
    contentRange: media.headers?.["content-range"] || null,
    contentLength: media.headers?.["content-length"] || null,
  };
}

/** Voice notes are small; reading the whole file avoids wrong lengths from partial m4a/ogg probes. */
const VOICE_MEMO_FULL_DURATION_PROBE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * @param {string} fileName
 * @param {string} [mimeType]
 * @returns {boolean}
 */
function isLikelyAudioVoiceMemo(fileName, mimeType) {
  const name = String(fileName || "").trim().toLowerCase();
  if (/\.(m4a|aac|mp3|ogg|opus|wav|flac|mp4)$/i.test(name)) {
    return true;
  }
  const mime = String(mimeType || "").trim().toLowerCase();
  return mime.startsWith("audio/");
}

/**
 * @param {number|null|undefined} duration
 * @returns {number|null}
 */
function normalizeParsedDurationSeconds(duration) {
  if (duration == null || !Number.isFinite(duration) || duration < 0) {
    return null;
  }
  return duration;
}

/**
 * @param {string} fileId
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<number|null>} duration in seconds, or null if unknown
 */
async function getVoiceMemoDurationSeconds(fileId, options = {}) {
  const normalizedFileId = String(fileId || "").trim();
  if (!normalizedFileId) {
    return null;
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;

  try {
    return await Promise.race([
      readVoiceMemoDurationSeconds(normalizedFileId),
      new Promise((resolve) => {
        setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  }
}

/**
 * @param {Buffer} buffer
 * @param {{ mimeType: string, size?: number }} fileInfo
 * @returns {Promise<number|null>}
 */
async function parseDurationFromAudioBuffer(buffer, fileInfo) {
  const { parseBuffer } = await import("music-metadata");
  const metadata = await parseBuffer(
    buffer,
    {
      mimeType: fileInfo.mimeType,
      size: Number.isFinite(fileInfo.size) ? fileInfo.size : buffer.length,
    },
    { duration: true },
  );
  return normalizeParsedDurationSeconds(metadata?.format?.duration);
}

/**
 * @param {string} fileId
 * @returns {Promise<number|null>}
 */
async function readVoiceMemoDurationSeconds(fileId) {
  const auth = await buildServiceAccountJwt([DRIVE_READONLY_SCOPE]);
  const drive = google.drive({ version: "v3", auth });

  const meta = await drive.files.get({
    fileId,
    fields: "mimeType,name,size,videoMediaMetadata(durationMillis)",
    supportsAllDrives: true,
  });
  recordDriveFilesGet(1);

  const fileName = String(meta.data.name || "");
  const driveMimeType = String(meta.data.mimeType || "");
  const mimeType = resolveVoiceMemoStreamMimeType(fileName, driveMimeType);
  const sizeRaw = meta.data.size;
  const size =
    sizeRaw != null && String(sizeRaw).trim() !== "" ? Number.parseInt(String(sizeRaw), 10) : undefined;
  const knownSize = Number.isFinite(size) ? size : undefined;

  // Drive's videoMediaMetadata is often wrong for Signal/voice m4a uploads.
  // Only trust it for non-audio files.
  if (!isLikelyAudioVoiceMemo(fileName, driveMimeType)) {
    const durationMillis = meta.data.videoMediaMetadata?.durationMillis;
    if (durationMillis != null && Number.isFinite(Number(durationMillis)) && Number(durationMillis) > 0) {
      return Number(durationMillis) / 1000;
    }
  }

  // Download the full file into a buffer for accurate duration (moov/tags may be at end).
  if (knownSize != null && knownSize > VOICE_MEMO_FULL_DURATION_PROBE_MAX_BYTES) {
    return null;
  }

  const media = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  recordDriveFilesGet(1);

  const buffer = Buffer.from(media.data);
  return parseDurationFromAudioBuffer(buffer, {
    mimeType,
    size: knownSize ?? buffer.length,
  });
}

/**
 * @param {string[]} fileIds
 * @param {{ concurrency?: number, timeoutMs?: number }} [options]
 * @returns {Promise<Map<string, number|null>>}
 */
async function resolveVoiceMemoDurationsMap(fileIds, options = {}) {
  const uniqueIds = [...new Set(fileIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const map = new Map();
  if (uniqueIds.length === 0) {
    return map;
  }

  const concurrency = Math.min(Math.max(Number(options.concurrency) || 4, 1), 8);
  let index = 0;

  async function worker() {
    while (index < uniqueIds.length) {
      const current = uniqueIds[index];
      index += 1;
      const duration = await getVoiceMemoDurationSeconds(current, options);
      map.set(current, duration);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueIds.length) }, () => worker()));
  return map;
}

module.exports = {
  DRIVE_READONLY_SCOPE,
  normalizeVoiceMemoScanOptions,
  buildVoiceMemoFilenamePattern,
  scanVoiceMemoFolder,
  listVoiceMemoFiles,
  getVoiceMemoFileForAesopId,
  streamVoiceMemoFile,
  getVoiceMemoDurationSeconds,
  resolveVoiceMemoDurationsMap,
};
