const { google } = require("googleapis");
const { buildServiceAccountJwt } = require("./googleAuth");
const { parseVoiceMemoFileExtensions, DEFAULT_VOICE_MEMO_FILE_EXTENSIONS, voiceMemoExtensionFromFileName } = require("../utils/voiceMemoExtensions");
const { resolveVoiceMemoMimeType } = require("../utils/voiceMemoContentType");
const {
  voiceMemoNeedsTranscodeForPlayback,
  isFfmpegAvailable,
  transcodeVoiceMemoToM4aStream,
} = require("../utils/voiceMemoTranscode");
const { recordDriveFilesList, recordDriveFilesGet } = require("./portalMetrics");
const { mapVoiceMemoStreamError } = require("./voiceMemoStreamErrors");
const { driveErrorStatus, isDriveThrottleError } = require("../utils/driveThrottle");

const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Retry budget for Drive calls on request paths (portal streaming / on-demand probes). */
const DRIVE_RETRY_DEFAULT_BUDGET_MS = 20 * 1000;
const DRIVE_RETRY_BACKOFF_BASE_MS = 1000;
const DRIVE_RETRY_BACKOFF_CAP_MS = 60 * 1000;
const DRIVE_RETRY_AFTER_CAP_MS = 15 * 60 * 1000;

/** User-facing copy when Drive throttles on-demand portal streaming. */
const DRIVE_TRY_AGAIN_LATER_MESSAGE =
  "Your voice note is safe and submitted. We are experiencing high traffic volume and cannot play your audio right now. You may try refreshing the stream later to try again.";

/** Cap Drive traffic hard while sync scripts/jobs run (~20 req/min). */
const DRIVE_SCRIPT_MAX_REQUESTS_PER_MINUTE = 20;
const DRIVE_SCRIPT_RATE_WINDOW_MS = 60 * 1000;
/**
 * Google allows up to 100 sub-requests per HTTP batch.
 * Keep chunks at/under the script rate cap so acquireDriveRequestSlots can ever succeed
 * (requestSlots === chunk.length; wanting more than the cap spins forever).
 */
const DRIVE_BATCH_MAX_SUBREQUESTS = DRIVE_SCRIPT_MAX_REQUESTS_PER_MINUTE;

/** @type {number[]} */
let driveScriptRequestTimestamps = [];
let driveScriptRateLimitEnabled = false;

/**
 * Enable proactive Drive throttling for cron scripts and other batch runners.
 * Portal on-demand paths leave this off.
 * @param {boolean} enabled
 */
function setDriveScriptRateLimit(enabled) {
  driveScriptRateLimitEnabled = !!enabled;
  if (!enabled) {
    driveScriptRequestTimestamps = [];
  }
}

/** @returns {boolean} */
function isDriveScriptRateLimitEnabled() {
  return driveScriptRateLimitEnabled;
}

/**
 * Long-running syncs pass `deadlineAt`; treat that as script mode too.
 * @param {number|undefined|null} deadlineAt
 */
function maybeEnableDriveScriptRateLimit(deadlineAt) {
  if (Number.isFinite(deadlineAt)) {
    driveScriptRateLimitEnabled = true;
  }
}

/**
 * Wait until the rolling minute window has room for `count` more Drive calls.
 * @param {number} [count]
 */
async function acquireDriveRequestSlots(count = 1) {
  if (!driveScriptRateLimitEnabled || count <= 0) {
    return;
  }
  // Cap at the window max — asking for more can never succeed and busy-loops.
  const want = Math.min(
    DRIVE_SCRIPT_MAX_REQUESTS_PER_MINUTE,
    Math.max(1, Math.floor(count)),
  );
  for (;;) {
    const now = Date.now();
    driveScriptRequestTimestamps = driveScriptRequestTimestamps.filter(
      (timestamp) => now - timestamp < DRIVE_SCRIPT_RATE_WINDOW_MS,
    );
    const available = DRIVE_SCRIPT_MAX_REQUESTS_PER_MINUTE - driveScriptRequestTimestamps.length;
    if (available >= want) {
      const stamp = Date.now();
      for (let i = 0; i < want; i += 1) {
        driveScriptRequestTimestamps.push(stamp);
      }
      return;
    }
    const oldest = driveScriptRequestTimestamps[0];
    const elapsed = Number.isFinite(oldest) ? now - oldest : DRIVE_SCRIPT_RATE_WINDOW_MS;
    const waitMs = Math.max(DRIVE_SCRIPT_RATE_WINDOW_MS - elapsed + 50, 250);
    console.warn(
      `[drive] pacing script traffic (${driveScriptRequestTimestamps.length}/${DRIVE_SCRIPT_MAX_REQUESTS_PER_MINUTE} req/min); waiting ${Math.ceil(waitMs / 1000)}s`,
    );
    await sleep(waitMs);
  }
}

function sleep(ms) {
  const delay = Number.isFinite(ms) ? Math.max(0, ms) : 250;
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

/**
 * Transient 5xx and connection resets are retried on the same schedule.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableDriveError(error) {
  if (isDriveThrottleError(error)) {
    return true;
  }
  const status = driveErrorStatus(error);
  if (status === 500 || status === 502 || status === 503) {
    return true;
  }
  const code = String(error?.code || "").toUpperCase();
  return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "EPIPE"].includes(code);
}

/**
 * @param {unknown} error
 * @returns {number|null} milliseconds suggested by a Retry-After header, if any
 */
function driveRetryAfterMs(error) {
  const headers = error?.response?.headers || {};
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (raw == null || String(raw).trim() === "") {
    return null;
  }
  const seconds = Number(String(raw).trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, DRIVE_RETRY_AFTER_CAP_MS);
  }
  const dateMs = Date.parse(String(raw));
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), DRIVE_RETRY_AFTER_CAP_MS);
  }
  return null;
}

/**
 * Run a Drive API call, retrying 429s/rate limits with exponential backoff until
 * `deadlineAt`. Request paths use a short default budget; sync scripts pass a
 * deadline up to ~an hour away so throttled runs finish instead of failing.
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {{ deadlineAt?: number }} [options]
 * @returns {Promise<T>}
 */
async function withDriveRetry(label, fn, options = {}) {
  const deadlineAt = Number.isFinite(options.deadlineAt)
    ? Number(options.deadlineAt)
    : Date.now() + DRIVE_RETRY_DEFAULT_BUDGET_MS;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableDriveError(error)) {
        throw error;
      }
      attempt += 1;
      const backoffMs = Math.min(
        DRIVE_RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1),
        DRIVE_RETRY_BACKOFF_CAP_MS,
      );
      const jitteredMs = Math.round(backoffMs * (0.5 + Math.random() * 0.5));
      const waitMs = Math.max(driveRetryAfterMs(error) ?? 0, jitteredMs);
      if (Date.now() + waitMs > deadlineAt) {
        throw error;
      }
      console.warn(
        `[drive] ${label} throttled (HTTP ${driveErrorStatus(error) ?? "?"}); retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt})`,
      );
      await sleep(waitMs);
    }
  }
}

/**
 * Rate-limited (in script mode) wrapper around {@link withDriveRetry}.
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {{ deadlineAt?: number, requestSlots?: number }} [options]
 * @returns {Promise<T>}
 */
async function driveApiCall(label, fn, options = {}) {
  maybeEnableDriveScriptRateLimit(options.deadlineAt);
  const requestSlots = options.requestSlots ?? 1;
  return withDriveRetry(
    label,
    async () => {
      await acquireDriveRequestSlots(requestSlots);
      return fn();
    },
    options,
  );
}

/**
 * @param {string} responseText
 * @param {string} responseContentType
 * @returns {string|null}
 */
function parseMultipartBoundary(responseContentType) {
  const match = String(responseContentType || "").match(/boundary=([^;\s]+)/i);
  return match ? match[1].replace(/^"|"$/g, "") : null;
}

/**
 * @param {string} responseText
 * @param {string} boundary
 * @returns {Array<{ status: number, body: string }>}
 */
function parseMultipartMixedResponse(responseText, boundary) {
  const marker = `--${boundary}`;
  const parts = String(responseText || "").split(marker);
  /** @type {Array<{ status: number, body: string }>} */
  const parsed = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "--") {
      continue;
    }
    const statusMatch = part.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    const bodyIndex = part.search(/\r?\n\r?\n/);
    const body = bodyIndex >= 0 ? part.slice(bodyIndex).replace(/^\s+/, "") : "";
    parsed.push({ status, body: body.trim() });
  }
  return parsed;
}

/**
 * Batch Drive files.get metadata calls via Google's multipart batch endpoint.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string[]} fileIds
 * @param {string} fields
 * @param {{ deadlineAt?: number }} [retryOptions]
 * @returns {Promise<Map<string, import('googleapis').drive_v3.Schema$File>>}
 */
async function batchGetDriveFileMetadata(auth, fileIds, fields, retryOptions = {}) {
  const uniqueIds = [...new Set(fileIds.map((id) => String(id || "").trim()).filter(Boolean))];
  /** @type {Map<string, import('googleapis').drive_v3.Schema$File>} */
  const results = new Map();
  if (uniqueIds.length === 0) {
    return results;
  }

  const encodedFields = encodeURIComponent(fields);
  for (let offset = 0; offset < uniqueIds.length; offset += DRIVE_BATCH_MAX_SUBREQUESTS) {
    const chunk = uniqueIds.slice(offset, offset + DRIVE_BATCH_MAX_SUBREQUESTS);
    const boundary = `batch_${Date.now().toString(36)}_${offset}`;
    let body = "";
    for (let index = 0; index < chunk.length; index += 1) {
      const fileId = chunk[index];
      body += `--${boundary}\r\n`;
      body += "Content-Type: application/http\r\n";
      body += `Content-ID: ${index + 1}\r\n\r\n`;
      body += `GET /drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodedFields}&supportsAllDrives=true\r\n\r\n`;
    }
    body += `--${boundary}--\r\n`;

    const chunkResults = await driveApiCall(
      `files.get(batch metadata x${chunk.length})`,
      async () => {
        const tokenResponse = await auth.getAccessToken();
        const token = tokenResponse?.token || tokenResponse;
        if (!token) {
          throw new Error("Drive batch request requires an access token.");
        }
        const response = await fetch("https://www.googleapis.com/batch/drive/v3", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/mixed; boundary=${boundary}`,
          },
          body,
        });
        const responseText = await response.text();
        if (!response.ok && response.status !== 200) {
          const error = new Error(`Drive batch metadata failed (HTTP ${response.status}).`);
          error.response = { status: response.status, data: responseText };
          throw error;
        }
        const responseBoundary =
          parseMultipartBoundary(response.headers.get("content-type") || "") || boundary;
        const parts = parseMultipartMixedResponse(responseText, responseBoundary);
        /** @type {Map<string, import('googleapis').drive_v3.Schema$File>} */
        const chunkMap = new Map();
        for (const part of parts) {
          if (!part || part.status < 200 || part.status >= 300) {
            continue;
          }
          try {
            const data = JSON.parse(part.body);
            const fileId = String(data?.id || "").trim();
            if (fileId) {
              chunkMap.set(fileId, data);
            }
          } catch {
            // Skip malformed batch part; caller may fall back per file.
          }
        }
        return chunkMap;
      },
      { ...retryOptions, requestSlots: chunk.length },
    );

    for (const [fileId, data] of chunkResults.entries()) {
      results.set(fileId, data);
    }
    recordDriveFilesGet(chunkResults.size);
  }

  return results;
}

/**
 * Extract a Drive file id from a webViewLink-style URL
 * (e.g. https://drive.google.com/file/d/FILE_ID/view or ...?id=FILE_ID).
 * @param {string|null|undefined} link
 * @returns {string|null}
 */
function extractDriveFileIdFromLink(link) {
  const url = String(link || "").trim();
  if (!url) {
    return null;
  }
  const pathMatch = url.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (pathMatch) {
    return pathMatch[1];
  }
  const queryMatch = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (queryMatch) {
    return queryMatch[1];
  }
  return null;
}

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
 * @param {{ extension?: string, submissionTimeSource?: 'createdTime'|'modifiedTime', deadlineAt?: number }} [options]
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
  const retryOptions = { deadlineAt: options.deadlineAt };
  maybeEnableDriveScriptRateLimit(options.deadlineAt);

  const auth = await buildServiceAccountJwt([DRIVE_READONLY_SCOPE]);
  const drive = google.drive({ version: "v3", auth });

  /** @type {Array<{ aesopId: string, fileId: string, webViewLink: string, submittedAt: Date, fileName: string }>} */
  const parsedFiles = [];
  /** @type {string[]} */
  const invalidFileNames = [];
  let totalDriveFiles = 0;
  let pageToken;

  do {
    const currentPageToken = pageToken;
    const response = await driveApiCall(
      "files.list(voice memo folder)",
      () =>
        drive.files.list({
          q: `'${normalizedFolderId}' in parents and trashed=false`,
          fields: "nextPageToken, files(id, name, webViewLink, createdTime, modifiedTime)",
          pageSize: 1000,
          pageToken: currentPageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      retryOptions,
    );
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
function resolveVoiceMemoStreamMimeType(fileName, driveMimeType, buffer) {
  return resolveVoiceMemoMimeType({ fileName, driveMimeType, buffer });
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
 * @param {string} fileId
 * @param {string} [rangeHeader]
 * @returns {Promise<{ stream: import('stream').Readable, mimeType: string, fileName: string, size: number|null, status: number, contentRange: string|null, contentLength: string|null }>}
 */
async function streamVoiceMemoFile(fileId, rangeHeader) {
  const normalizedFileId = String(fileId || "").trim();
  if (!normalizedFileId) {
    throw new Error("A Drive file id is required.");
  }

  try {
    const auth = await buildServiceAccountJwt([DRIVE_READONLY_SCOPE]);
    const drive = google.drive({ version: "v3", auth });

    const meta = await driveApiCall("files.get(stream metadata)", () =>
      drive.files.get({
        fileId: normalizedFileId,
        fields: "mimeType,name,size",
        supportsAllDrives: true,
      }),
    );
    recordDriveFilesGet(1);

    const fileName = String(meta.data.name || "voice-memo.m4a");
    const extension = voiceMemoExtensionFromFileName(fileName);
    const shouldTranscode = extension != null && voiceMemoNeedsTranscodeForPlayback(extension) && (await isFfmpegAvailable());

    const requestOptions = { responseType: "stream" };
    if (rangeHeader && !shouldTranscode) {
      requestOptions.headers = { Range: rangeHeader };
    }

    const media = await driveApiCall("files.get(stream media)", () =>
      drive.files.get(
        { fileId: normalizedFileId, alt: "media", supportsAllDrives: true },
        requestOptions,
      ),
    );
    recordDriveFilesGet(1);

    const sizeRaw = meta.data.size;
    const size = sizeRaw != null && String(sizeRaw).trim() !== "" ? Number.parseInt(String(sizeRaw), 10) : null;

    if (shouldTranscode) {
      const { stream } = transcodeVoiceMemoToM4aStream(media.data);
      return {
        stream,
        mimeType: "audio/mp4",
        fileName: voiceMemoPlaybackFileName(fileName),
        size: null,
        status: 200,
        contentRange: null,
        contentLength: null,
      };
    }

    return {
      stream: media.data,
      mimeType: resolveVoiceMemoStreamMimeType(fileName, meta.data.mimeType),
      fileName,
      size: Number.isFinite(size) ? size : null,
      status: media.status || 200,
      contentRange: media.headers?.["content-range"] || null,
      contentLength: media.headers?.["content-length"] || null,
    };
  } catch (error) {
    throw mapVoiceMemoStreamError(error);
  }
}

/** Voice notes are small; reading the whole file avoids wrong lengths from partial m4a/ogg probes. */
const VOICE_MEMO_FULL_DURATION_PROBE_MAX_BYTES = 8 * 1024 * 1024;
/** Postgres audio cache limit; larger files stream from Drive on playback. */
const VOICE_MEMO_AUDIO_CACHE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * @param {string} fileName
 * @param {string} [mimeType]
 * @returns {boolean}
 */
function isLikelyAudioVoiceMemo(fileName, mimeType) {
  const name = String(fileName || "").trim().toLowerCase();
  if (/\.(m4a|aac|acc|mp3|mpga|mpg|ogg|oga|opus|wav|flac|mp4)$/i.test(name)) {
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
 * @param {{ timeoutMs?: number, deadlineAt?: number }} [options]
 * @returns {Promise<number|null>} duration in seconds, or null if unknown
 */
async function getVoiceMemoDurationSeconds(fileId, options = {}) {
  const normalizedFileId = String(fileId || "").trim();
  if (!normalizedFileId) {
    return null;
  }

  const deadlineAt = Number.isFinite(options.deadlineAt) ? Number(options.deadlineAt) : null;
  // With a retry deadline, don't let the overall timeout cut the retry budget short.
  const defaultTimeoutMs = deadlineAt ? Math.max(30000, deadlineAt - Date.now() + 5000) : 30000;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : defaultTimeoutMs;

  try {
    return await Promise.race([
      readVoiceMemoDurationSeconds(normalizedFileId, { deadlineAt: deadlineAt ?? undefined }),
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
  const mimeType = resolveVoiceMemoMimeType({
    fileName: fileInfo.fileName,
    driveMimeType: fileInfo.driveMimeType,
    buffer,
  });
  const metadata = await parseBuffer(
    buffer,
    {
      mimeType,
      size: Number.isFinite(fileInfo.size) ? fileInfo.size : buffer.length,
    },
    { duration: true },
  );
  return normalizeParsedDurationSeconds(metadata?.format?.duration);
}

/**
 * @param {import('googleapis').drive_v3.Schema$File|{ data?: import('googleapis').drive_v3.Schema$File }} meta
 * @returns {number|null}
 */
function durationSecondsFromDriveFileMetadata(meta) {
  const file = meta?.data ?? meta;
  const fileName = String(file?.name || "");
  const driveMimeType = String(file?.mimeType || "");
  if (!isLikelyAudioVoiceMemo(fileName, driveMimeType)) {
    const durationMillis = file?.videoMediaMetadata?.durationMillis;
    if (durationMillis != null && Number.isFinite(Number(durationMillis)) && Number(durationMillis) > 0) {
      return Number(durationMillis) / 1000;
    }
  }
  return null;
}

/**
 * @param {import('googleapis').drive_v3.Schema$File|{ data?: import('googleapis').drive_v3.Schema$File }} meta
 * @returns {{ fileName: string, driveMimeType: string, mimeType: string, knownSize: number|undefined }}
 */
function voiceMemoMetadataContext(meta) {
  const file = meta?.data ?? meta;
  const fileName = String(file?.name || "");
  const driveMimeType = String(file?.mimeType || "");
  const mimeType = resolveVoiceMemoStreamMimeType(fileName, driveMimeType);
  const sizeRaw = file?.size;
  const size =
    sizeRaw != null && String(sizeRaw).trim() !== "" ? Number.parseInt(String(sizeRaw), 10) : undefined;
  const knownSize = Number.isFinite(size) ? size : undefined;
  return { fileName, driveMimeType, mimeType, knownSize };
}

/**
 * @param {import('google-auth-library').OAuth2Client} auth
 * @returns {Promise<string>}
 */
async function getDriveAccessToken(auth) {
  const { token } = await auth.getAccessToken();
  const accessToken = token || auth.credentials?.access_token;
  if (!accessToken) {
    throw new Error("Google Drive access token is unavailable.");
  }
  return accessToken;
}

/**
 * @param {number} status
 * @param {unknown} body
 */
function buildDriveHttpError(status, body) {
  const payload = body && typeof body === "object" ? body : {};
  const message = String(payload?.error?.message || `Drive request failed with HTTP ${status}.`);
  const error = new Error(message);
  error.response = { status, data: payload };
  error.code = status;
  error.errors = payload?.error?.errors;
  return error;
}

/**
 * Drive v3 over native fetch. googleapis/gaxios can fail to attach Authorization on some
 * Node versions even when credentials exist; bearer fetch is reliable for local dev.
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} pathname
 * @param {Record<string, string|number|boolean|null|undefined>} [query]
 */
async function fetchDriveApi(auth, pathname, query = {}) {
  const accessToken = await getDriveAccessToken(auth);
  const url = new URL(`https://www.googleapis.com/drive/v3/${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw buildDriveHttpError(response.status, body);
  }
  return body;
}

/**
 * @param {import('google-auth-library').OAuth2Client} auth
 * @param {string} fileId
 * @returns {Promise<Buffer>}
 */
async function fetchDriveFileMedia(auth, fileId) {
  const accessToken = await getDriveAccessToken(auth);
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw buildDriveHttpError(response.status, body);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * @param {ReturnType<typeof google.drive>} drive
 * @param {string} fileId
 * @param {import('googleapis').drive_v3.Schema$File|{ data?: import('googleapis').drive_v3.Schema$File }} meta
 * @param {{ deadlineAt?: number }} [retryOptions]
 * @returns {Promise<number|null>}
 */
async function probeVoiceMemoDurationFromMedia(drive, fileId, meta, retryOptions = {}) {
  const { fileName, driveMimeType, knownSize } = voiceMemoMetadataContext(meta);
  if (knownSize != null && knownSize > VOICE_MEMO_FULL_DURATION_PROBE_MAX_BYTES) {
    return null;
  }

  const media = await driveApiCall(
    "files.get(duration media)",
    () =>
      drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      ),
    retryOptions,
  );
  recordDriveFilesGet(1);

  // Copy once, then drop the Drive response payload so GC can reclaim the
  // ArrayBuffer while music-metadata parses (up to 8 MB per file).
  let arrayBuffer = media.data;
  media.data = null;
  let buffer = Buffer.from(arrayBuffer);
  arrayBuffer = null;
  try {
    return await parseDurationFromAudioBuffer(buffer, {
      fileName,
      driveMimeType,
      size: knownSize ?? buffer.length,
    });
  } finally {
    buffer = null;
  }
}

/**
 * @param {string} fileId
 * @param {{ deadlineAt?: number, metadata?: import('googleapis').drive_v3.Schema$File, drive?: ReturnType<typeof google.drive> }} [options]
 * @returns {Promise<number|null>}
 */
async function readVoiceMemoDurationSeconds(fileId, options = {}) {
  const retryOptions = { deadlineAt: options.deadlineAt };
  maybeEnableDriveScriptRateLimit(options.deadlineAt);

  let meta = options.metadata;
  let drive = options.drive;
  if (!drive) {
    const auth = await buildServiceAccountJwt([DRIVE_READONLY_SCOPE]);
    drive = google.drive({ version: "v3", auth });
  }

  if (!meta) {
    const response = await driveApiCall(
      "files.get(duration metadata)",
      () =>
        drive.files.get({
          fileId,
          fields: "mimeType,name,size,videoMediaMetadata(durationMillis)",
          supportsAllDrives: true,
        }),
      retryOptions,
    );
    recordDriveFilesGet(1);
    meta = response.data;
  }

  const fromMetadata = durationSecondsFromDriveFileMetadata(meta);
  if (fromMetadata != null) {
    return fromMetadata;
  }

  return probeVoiceMemoDurationFromMedia(drive, fileId, meta, retryOptions);
}

/**
 * @param {string[]} fileIds
 * @param {{ concurrency?: number, timeoutMs?: number, deadlineAt?: number }} [options]
 * @returns {Promise<Map<string, number|null>>}
 */
async function resolveVoiceMemoDurationsMap(fileIds, options = {}) {
  const uniqueIds = [...new Set(fileIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const map = new Map();
  if (uniqueIds.length === 0) {
    return map;
  }

  maybeEnableDriveScriptRateLimit(options.deadlineAt);
  const retryOptions = { deadlineAt: options.deadlineAt };
  const auth = await buildServiceAccountJwt([DRIVE_READONLY_SCOPE]);
  const drive = google.drive({ version: "v3", auth });
  const metadataFields = "id,mimeType,name,size,videoMediaMetadata(durationMillis)";

  /** @type {Map<string, import('googleapis').drive_v3.Schema$File>} */
  let metadataByFileId = new Map();
  if (driveScriptRateLimitEnabled && uniqueIds.length > 1) {
    metadataByFileId = await batchGetDriveFileMetadata(auth, uniqueIds, metadataFields, retryOptions);
  }

  const scriptMode = driveScriptRateLimitEnabled;
  const concurrency = scriptMode
    ? 1
    : Math.min(Math.max(Number(options.concurrency) || 4, 1), 8);
  let index = 0;

  async function worker() {
    while (index < uniqueIds.length) {
      const current = index;
      index += 1;
      const fileId = uniqueIds[current];
      let duration = null;
      const prefetched = metadataByFileId.get(fileId);
      if (prefetched) {
        duration = durationSecondsFromDriveFileMetadata(prefetched);
        if (duration == null) {
          duration = await probeVoiceMemoDurationFromMedia(drive, fileId, prefetched, retryOptions);
        }
        // Drop metadata once used so the batch map can shrink during long probes.
        metadataByFileId.delete(fileId);
      } else {
        duration = await readVoiceMemoDurationSeconds(fileId, {
          deadlineAt: options.deadlineAt,
          drive,
        });
      }
      map.set(fileId, duration);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueIds.length) }, () => worker()));
  return map;
}

/**
 * Download a voice memo file from Drive for Postgres caching.
 * @param {string} fileId
 * @param {{ deadlineAt?: number, metadata?: import('googleapis').drive_v3.Schema$File, drive?: ReturnType<typeof google.drive> }} [options]
 * @returns {Promise<{ fileId: string, fileName: string, mimeType: string, sizeBytes: number, content: Buffer }|null>}
 */
async function downloadVoiceMemoFile(fileId, options = {}) {
  const normalizedFileId = String(fileId || "").trim();
  if (!normalizedFileId) {
    return null;
  }

  try {
    const retryOptions = { deadlineAt: options.deadlineAt };
    maybeEnableDriveScriptRateLimit(options.deadlineAt);

    let meta = options.metadata;
    const auth = await buildServiceAccountJwt([DRIVE_READONLY_SCOPE]);

    if (!meta) {
      meta = await driveApiCall(
        "files.get(download metadata)",
        () =>
          fetchDriveApi(auth, `files/${encodeURIComponent(normalizedFileId)}`, {
            fields: "mimeType,name,size",
            supportsAllDrives: true,
          }),
        retryOptions,
      );
      recordDriveFilesGet(1);
    }

    const { fileName, driveMimeType, knownSize } = voiceMemoMetadataContext(meta);
    if (knownSize != null && knownSize > VOICE_MEMO_AUDIO_CACHE_MAX_BYTES) {
      console.warn(
        `[voice-memo-audio] skipping ${fileName || normalizedFileId}: ` +
          `file exceeds ${VOICE_MEMO_AUDIO_CACHE_MAX_BYTES} byte cache limit`,
      );
      return null;
    }

    const content = await driveApiCall(
      "files.get(download media)",
      () => fetchDriveFileMedia(auth, normalizedFileId),
      retryOptions,
    );
    recordDriveFilesGet(1);

    return {
      fileId: normalizedFileId,
      fileName,
      mimeType: resolveVoiceMemoStreamMimeType(fileName, driveMimeType, content),
      sizeBytes: content.length,
      content,
    };
  } catch (error) {
    throw mapVoiceMemoStreamError(error);
  }
}

module.exports = {
  DRIVE_READONLY_SCOPE,
  VOICE_MEMO_AUDIO_CACHE_MAX_BYTES,
  normalizeVoiceMemoScanOptions,
  buildVoiceMemoFilenamePattern,
  withDriveRetry,
  setDriveScriptRateLimit,
  isDriveScriptRateLimitEnabled,
  isDriveThrottleError,
  DRIVE_TRY_AGAIN_LATER_MESSAGE,
  extractDriveFileIdFromLink,
  scanVoiceMemoFolder,
  listVoiceMemoFiles,
  getVoiceMemoFileForAesopId,
  streamVoiceMemoFile,
  downloadVoiceMemoFile,
  getVoiceMemoDurationSeconds,
  resolveVoiceMemoDurationsMap,
};
