/**
 * Sniff audio container type from file bytes. Some Signal/phone uploads use the
 * wrong extension (for example MP4/AMR saved as .mp3).
 * @param {Buffer|Uint8Array|null|undefined} buffer
 * @returns {string|null}
 */
function sniffVoiceMemoMimeTypeFromBuffer(buffer) {
  if (!buffer || buffer.length < 12) {
    return null;
  }

  const start4 = buffer.subarray(0, 4).toString("ascii");
  const boxType = buffer.subarray(4, 8).toString("ascii");
  const riffType = buffer.subarray(8, 12).toString("ascii");

  if (start4 === "OggS") {
    return "audio/ogg";
  }
  if (start4 === "fLaC") {
    return "audio/flac";
  }
  if (start4 === "RIFF" && riffType === "WAVE") {
    return "audio/wav";
  }
  if (boxType === "ftyp") {
    return "audio/mp4";
  }
  if (start4 === "ID3") {
    return "audio/mpeg";
  }
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }

  return null;
}

/**
 * @param {string} fileName
 * @param {string} [driveMimeType]
 * @returns {string}
 */
function voiceMemoMimeTypeFromFileName(fileName, driveMimeType) {
  const name = String(fileName || "").trim().toLowerCase();
  if (name.endsWith(".m4a")) {
    return "audio/mp4";
  }
  if (name.endsWith(".aac") || name.endsWith(".acc")) {
    return "audio/aac";
  }
  if (name.endsWith(".mp3") || name.endsWith(".mpga")) {
    return "audio/mpeg";
  }
  if (name.endsWith(".ogg") || name.endsWith(".oga")) {
    return "audio/ogg";
  }
  if (name.endsWith(".opus")) {
    return "audio/opus";
  }
  if (name.endsWith(".wav")) {
    return "audio/wav";
  }
  if (name.endsWith(".mpg")) {
    return "video/mpeg";
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
 * Prefer sniffed bytes over filename when they disagree.
 * @param {{ fileName?: string, driveMimeType?: string, buffer?: Buffer|Uint8Array|null }} input
 * @returns {string}
 */
function resolveVoiceMemoMimeType(input = {}) {
  const sniffedMimeType = sniffVoiceMemoMimeTypeFromBuffer(input.buffer);
  if (sniffedMimeType) {
    return sniffedMimeType;
  }
  return voiceMemoMimeTypeFromFileName(input.fileName, input.driveMimeType);
}

module.exports = {
  sniffVoiceMemoMimeTypeFromBuffer,
  voiceMemoMimeTypeFromFileName,
  resolveVoiceMemoMimeType,
};
