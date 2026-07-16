const { spawn } = require("child_process");
const { randomBytes } = require("crypto");
const { mkdtemp, readFile, rm, writeFile } = require("fs/promises");
const { tmpdir } = require("os");
const { join } = require("path");
const { PassThrough, Readable } = require("stream");
const { sniffVoiceMemoMimeTypeFromBuffer } = require("./voiceMemoContentType");
const { voiceMemoExtensionFromFileName } = require("./voiceMemoExtensions");

/** Extensions that browsers may not play reliably; normalize to m4a when ffmpeg is available. */
const VOICE_MEMO_TRANSCODE_EXTENSIONS = new Set(["acc", "mpg", "mpga"]);

/** Codecs that <audio> can usually play inside MP4 without server-side re-encode. */
const BROWSER_SAFE_MP4_AUDIO_CODECS = new Set(["aac", "mp3"]);

/** @type {boolean|null} */
let ffmpegAvailableCache = null;

/**
 * @param {string} extension
 * @returns {boolean}
 */
function voiceMemoNeedsTranscodeForPlayback(extension) {
  const normalized = String(extension || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase();
  return VOICE_MEMO_TRANSCODE_EXTENSIONS.has(normalized);
}

/**
 * ffmpeg/ffprobe close stdin early when input is invalid; swallow broken-pipe noise.
 * @param {import('stream').Writable|null|undefined} stream
 */
function ignoreBrokenPipeErrors(stream) {
  if (!stream || typeof stream.on !== "function") {
    return;
  }
  stream.on("error", (error) => {
    const code = error && typeof error === "object" ? error.code : "";
    if (code === "EPIPE" || code === "ECONNRESET") {
      return;
    }
  });
}

/**
 * @returns {Promise<boolean>}
 */
async function isFfmpegAvailable() {
  if (ffmpegAvailableCache != null) {
    return ffmpegAvailableCache;
  }
  ffmpegAvailableCache = await new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  return ffmpegAvailableCache;
}

/**
 * @returns {Promise<{ ffmpeg: boolean, ffprobe: boolean }>}
 */
async function getFfmpegToolingStatus() {
  const check = (command) =>
    new Promise((resolve) => {
      const child = spawn(command, ["-version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  const [ffmpeg, ffprobe] = await Promise.all([check("ffmpeg"), check("ffprobe")]);
  return { ffmpeg, ffprobe };
}

/**
 * @param {Buffer} buffer
 * @returns {string|null}
 */
function getMp4FtypBrand(buffer) {
  if (!isMp4FamilyBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  return buffer.subarray(8, 12).toString("ascii");
}

/**
 * @param {Buffer} buffer
 * @param {string[]} ffprobeArgs
 * @returns {Promise<string|null>}
 */
function runFfprobeBufferQuery(buffer, ffprobeArgs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const child = spawn("ffprobe", ffprobeArgs, { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk || "");
    });
    ignoreBrokenPipeErrors(child.stdin);
    child.on("error", () => finish(null));
    child.on("close", () => {
      finish(String(output).trim() || null);
    });
    try {
      child.stdin.end(buffer);
    } catch {
      finish(null);
    }
  });
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<string|null>}
 */
async function probeVoiceMemoAudioCodecName(buffer) {
  if (!(await isFfmpegAvailable()) || !buffer || buffer.length === 0) {
    return null;
  }

  const output = await runFfprobeBufferQuery(buffer, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "csv=p=0",
    "-i",
    "pipe:0",
  ]);
  return output ? output.toLowerCase() : null;
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<boolean>}
 */
async function probeVoiceMemoHasVideoStream(buffer) {
  if (!(await isFfmpegAvailable()) || !buffer || buffer.length === 0) {
    return false;
  }

  const output = await runFfprobeBufferQuery(buffer, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "csv=p=0",
    "-i",
    "pipe:0",
  ]);
  return String(output || "").trim().toLowerCase() === "video";
}

/**
 * Signal/Android voice notes are often 3GP containers with AMR audio that browsers
 * reject as audio/mp4 even when range streaming succeeds.
 * @param {Buffer} buffer
 * @param {string} [fileName]
 * @returns {Promise<boolean>}
 */
async function voiceMemoNeedsBrowserPlaybackTranscode(buffer, fileName = "") {
  const extension = voiceMemoExtensionFromFileName(fileName);
  if (extension != null && voiceMemoNeedsTranscodeForPlayback(extension)) {
    return true;
  }

  const sniffedMimeType = sniffVoiceMemoMimeTypeFromBuffer(buffer);
  if (
    sniffedMimeType === "audio/ogg" ||
    sniffedMimeType === "audio/opus" ||
    sniffedMimeType === "audio/flac" ||
    sniffedMimeType === "audio/wav"
  ) {
    return true;
  }

  if (!isMp4FamilyBuffer(buffer)) {
    return false;
  }

  const brand = getMp4FtypBrand(buffer);
  if (brand && /^3gp/i.test(brand)) {
    return true;
  }

  if (await probeVoiceMemoHasVideoStream(buffer)) {
    console.warn(
      `[voice-memo-transcode] video track in ${fileName || "voice memo"} needs audio-only remux`,
    );
    return true;
  }

  const codecName = await probeVoiceMemoAudioCodecName(buffer);
  if (codecName && !BROWSER_SAFE_MP4_AUDIO_CODECS.has(codecName)) {
    console.warn(
      `[voice-memo-transcode] codec ${codecName} in ${fileName || "voice memo"} needs browser transcode`,
    );
    return true;
  }

  return false;
}

/**
 * @param {Buffer|null|undefined} buffer
 * @returns {boolean}
 */
function isValidVoiceMemoPlaybackM4a(buffer) {
  return Boolean(buffer && buffer.length >= 16 && isMp4FamilyBuffer(buffer));
}

/**
 * @returns {string[]}
 */
function voiceMemoFfmpegInputFlags() {
  return ["-fflags", "+genpts+igndts+discardcorrupt", "-err_detect", "ignore_err"];
}

/**
 * @param {Buffer} buffer
 * @param {string[]} ffmpegArgs
 * @returns {Promise<Buffer>}
 */
function runFfmpegBufferTransform(buffer, ffmpegArgs, options = {}) {
  const fallbackToInput = options.fallbackToInput !== false;
  return new Promise((resolve) => {
    let settled = false;
    /** @type {Buffer[]} */
    const chunks = [];
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ffmpeg.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(result);
    };

    ffmpeg.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });
    ffmpeg.stderr.on("data", (chunk) => {
      const message = String(chunk || "").trim();
      if (message) {
        console.warn("[voice-memo-transcode]", message);
      }
    });
    ignoreBrokenPipeErrors(ffmpeg.stdin);
    ffmpeg.on("error", () => finish(fallbackToInput ? buffer : null));
    ffmpeg.on("close", (code) => {
      if (code === 0 && chunks.length > 0) {
        finish(Buffer.concat(chunks));
        return;
      }
      finish(fallbackToInput ? buffer : null);
    });
    try {
      ffmpeg.stdin.end(buffer);
    } catch {
      finish(fallbackToInput ? buffer : null);
    }
  });
}

/**
 * @param {Buffer} buffer
 * @param {{ audioOnly?: boolean }} [options]
 * @returns {Promise<Buffer|null>}
 */
async function remuxVoiceMemoMp4FaststartViaTempFiles(buffer, options = {}) {
  const audioOnly = options.audioOnly === true;
  const tempRoot = await mkdtemp(join(tmpdir(), "voice-memo-remux-"));
  const inputPath = join(tempRoot, `input-${randomBytes(6).toString("hex")}`);
  const outputPath = join(tempRoot, `output-${randomBytes(6).toString("hex")}.m4a`);
  try {
    await writeFile(inputPath, buffer);
    const result = await new Promise((resolve) => {
      const ffmpegArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        ...voiceMemoFfmpegInputFlags(),
        "-i",
        inputPath,
      ];
      if (audioOnly) {
        ffmpegArgs.push("-vn");
      }
      ffmpegArgs.push(
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        outputPath,
      );

      const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "ignore", "pipe"] });
      ffmpeg.stderr.on("data", (chunk) => {
        const message = String(chunk || "").trim();
        if (message) {
          console.warn("[voice-memo-transcode]", message);
        }
      });
      ffmpeg.on("error", () => resolve(null));
      ffmpeg.on("close", async (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        try {
          const output = await readFile(outputPath);
          resolve(isValidVoiceMemoPlaybackM4a(output) ? output : null);
        } catch {
          resolve(null);
        }
      });
    });
    return result;
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<Buffer|null>}
 */
async function transcodeVoiceMemoToM4aViaTempFiles(buffer) {
  const tempRoot = await mkdtemp(join(tmpdir(), "voice-memo-transcode-"));
  const inputPath = join(tempRoot, `input-${randomBytes(6).toString("hex")}`);
  const outputPath = join(tempRoot, `output-${randomBytes(6).toString("hex")}.m4a`);
  try {
    await writeFile(inputPath, buffer);
    const result = await new Promise((resolve) => {
      const ffmpeg = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          ...voiceMemoFfmpegInputFlags(),
          "-i",
          inputPath,
          "-vn",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          "-f",
          "mp4",
          outputPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      ffmpeg.stderr.on("data", (chunk) => {
        const message = String(chunk || "").trim();
        if (message) {
          console.warn("[voice-memo-transcode]", message);
        }
      });
      ffmpeg.on("error", () => resolve(null));
      ffmpeg.on("close", async (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        try {
          const output = await readFile(outputPath);
          resolve(isValidVoiceMemoPlaybackM4a(output) ? output : null);
        } catch {
          resolve(null);
        }
      });
    });
    return result;
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Re-encode any voice memo to AAC-in-MP4 with faststart for cache storage.
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>}
 */
async function transcodeVoiceMemoToM4aBuffer(buffer) {
  if (!(await isFfmpegAvailable()) || !buffer || buffer.length === 0) {
    return null;
  }

  if (await probeVoiceMemoHasVideoStream(buffer)) {
    const codecName = await probeVoiceMemoAudioCodecName(buffer);
    if (codecName && BROWSER_SAFE_MP4_AUDIO_CODECS.has(codecName)) {
      const remuxed = await remuxVoiceMemoMp4FaststartViaTempFiles(buffer, { audioOnly: true });
      if (isValidVoiceMemoPlaybackM4a(remuxed)) {
        return remuxed;
      }
    }
  }

  const pipeResult = await runFfmpegBufferTransform(
    buffer,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...voiceMemoFfmpegInputFlags(),
      "-i",
      "pipe:0",
      "-vn",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { fallbackToInput: false },
  );

  if (isValidVoiceMemoPlaybackM4a(pipeResult)) {
    return pipeResult;
  }

  return transcodeVoiceMemoToM4aViaTempFiles(buffer);
}

/**
 * Pipe a Drive download through ffmpeg and emit an AAC-in-MP4 stream for <audio>.
 * @param {import('stream').Readable} inputStream
 * @returns {{ stream: import('stream').Readable, kill: () => void }}
 */
function transcodeVoiceMemoToM4aStream(inputStream) {
  const output = new PassThrough();
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-c:a",
      "aac",
      "-movflags",
      "frag_keyframe+empty_moov",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const kill = () => {
    inputStream.destroy();
    ffmpeg.stdin.destroy();
    ffmpeg.stdout.destroy();
    ffmpeg.kill("SIGKILL");
    output.destroy();
  };

  inputStream.on("error", (error) => {
    output.destroy(error);
    kill();
  });
  ignoreBrokenPipeErrors(ffmpeg.stdin);
  ignoreBrokenPipeErrors(inputStream);
  ffmpeg.stdout.on("error", (error) => {
    output.destroy(error);
    kill();
  });
  ffmpeg.stderr.on("data", (chunk) => {
    const message = String(chunk || "").trim();
    if (message) {
      console.warn("[voice-memo-transcode]", message);
    }
  });
  ffmpeg.on("error", (error) => {
    output.destroy(error);
    kill();
  });
  ffmpeg.on("close", (code) => {
    if (code !== 0 && !output.destroyed) {
      output.destroy(new Error(`ffmpeg exited with code ${code}`));
    }
  });

  inputStream.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(output);

  return { stream: output, kill };
}

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isMp4FamilyBuffer(buffer) {
  return Boolean(buffer && buffer.length >= 8 && buffer.subarray(4, 8).toString("ascii") === "ftyp");
}

/**
 * Move the MP4 moov atom to the front so browsers can read metadata via range requests.
 * @param {Buffer} buffer
 * @param {{ fallbackToInput?: boolean }} [options]
 * @returns {Promise<Buffer|null>}
 */
async function remuxVoiceMemoMp4Faststart(buffer, options = {}) {
  const fallbackToInput = options.fallbackToInput !== false;
  if (!isMp4FamilyBuffer(buffer) || !(await isFfmpegAvailable())) {
    return fallbackToInput ? buffer : null;
  }

  const audioOnly = await probeVoiceMemoHasVideoStream(buffer);
  const result = await remuxVoiceMemoMp4FaststartViaTempFiles(buffer, { audioOnly });

  if (isValidVoiceMemoPlaybackM4a(result)) {
    return result;
  }
  return fallbackToInput ? buffer : null;
}

module.exports = {
  VOICE_MEMO_TRANSCODE_EXTENSIONS,
  BROWSER_SAFE_MP4_AUDIO_CODECS,
  voiceMemoNeedsTranscodeForPlayback,
  voiceMemoNeedsBrowserPlaybackTranscode,
  probeVoiceMemoAudioCodecName,
  probeVoiceMemoHasVideoStream,
  getMp4FtypBrand,
  isFfmpegAvailable,
  getFfmpegToolingStatus,
  isMp4FamilyBuffer,
  isValidVoiceMemoPlaybackM4a,
  transcodeVoiceMemoToM4aStream,
  transcodeVoiceMemoToM4aBuffer,
  remuxVoiceMemoMp4Faststart,
};
