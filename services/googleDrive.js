const { google } = require("googleapis");
const { buildServiceAccountJwt } = require("./googleAuth");

const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/**
 * @param {string} extension
 * @returns {RegExp}
 */
function buildVoiceMemoFilenamePattern(extension) {
  const ext = String(extension || "m4a")
    .trim()
    .replace(/^\./, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(.+)\\.${ext}$`, "i");
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

  const extension = options.extension || "m4a";
  const submissionTimeSource =
    options.submissionTimeSource === "modifiedTime" ? "modifiedTime" : "createdTime";
  const filenamePattern = buildVoiceMemoFilenamePattern(extension);

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

  const requestOptions = { responseType: "stream" };
  if (rangeHeader) {
    requestOptions.headers = { Range: rangeHeader };
  }

  const media = await drive.files.get(
    { fileId: normalizedFileId, alt: "media", supportsAllDrives: true },
    requestOptions,
  );

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

module.exports = {
  DRIVE_READONLY_SCOPE,
  scanVoiceMemoFolder,
  listVoiceMemoFiles,
  getVoiceMemoFileForAesopId,
  streamVoiceMemoFile,
};
