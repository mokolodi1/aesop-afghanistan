const { spawn } = require("child_process");
const { PassThrough } = require("stream");

/** Extensions that browsers may not play reliably; normalize to m4a when ffmpeg is available. */
const VOICE_MEMO_TRANSCODE_EXTENSIONS = new Set(["acc", "mpg", "mpga"]);

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
  ffmpeg.stdin.on("error", () => {});
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

module.exports = {
  VOICE_MEMO_TRANSCODE_EXTENSIONS,
  voiceMemoNeedsTranscodeForPlayback,
  isFfmpegAvailable,
  transcodeVoiceMemoToM4aStream,
};
