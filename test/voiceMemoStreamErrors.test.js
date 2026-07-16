#!/usr/bin/env node
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  VOICE_MEMO_ERROR_CODES,
  VOICE_MEMO_NOT_CACHED_MESSAGE,
  resolveVoiceMemoStreamError,
  mapVoiceMemoStreamError,
} = require("../services/voiceMemoStreamErrors");

test("resolveVoiceMemoStreamError maps cache misses to VMNC01", () => {
  const error = new Error(VOICE_MEMO_NOT_CACHED_MESSAGE);
  error.statusCode = 503;
  error.code = "VOICE_MEMO_NOT_CACHED";
  error.errorCode = VOICE_MEMO_ERROR_CODES.NOT_CACHED;

  const resolved = resolveVoiceMemoStreamError(error);
  assert.equal(resolved.errorCode, "VMNC01");
  assert.equal(resolved.code, "VOICE_MEMO_NOT_CACHED");
  assert.equal(resolved.statusCode, 503);
});

test("resolveVoiceMemoStreamError maps expired stream tokens to VMXP04", () => {
  const error = new Error("This voice memo link has expired. Refresh the stream and try again.");
  error.statusCode = 403;

  const resolved = resolveVoiceMemoStreamError(error);
  assert.equal(resolved.errorCode, "VMXP04");
  assert.equal(resolved.code, "STREAM_EXPIRED");
});

test("resolveVoiceMemoStreamError maps missing stream token to VMTK08", () => {
  const error = new Error("Missing stream token.");
  error.statusCode = 400;

  const resolved = resolveVoiceMemoStreamError(error);
  assert.equal(resolved.errorCode, "VMTK08");
  assert.equal(resolved.code, "MISSING_TOKEN");
});

test("resolveVoiceMemoStreamError maps not-found playback errors to VMNF06", () => {
  const error = new Error("No voice memo file was found for your account.");
  error.statusCode = 404;

  const resolved = resolveVoiceMemoStreamError(error);
  assert.equal(resolved.errorCode, "VMNF06");
  assert.equal(resolved.code, "NOT_FOUND");
});

test("mapVoiceMemoStreamError preserves searchable errorCode on mapped errors", () => {
  const error = new Error(VOICE_MEMO_NOT_CACHED_MESSAGE);
  error.statusCode = 503;
  error.code = "VOICE_MEMO_NOT_CACHED";
  error.errorCode = VOICE_MEMO_ERROR_CODES.NOT_CACHED;

  const mapped = mapVoiceMemoStreamError(error);
  assert.equal(mapped.message, VOICE_MEMO_NOT_CACHED_MESSAGE);
  assert.equal(mapped.code, "VOICE_MEMO_NOT_CACHED");
  assert.equal(mapped.errorCode, "VMNC01");
  assert.equal(mapped.statusCode, 503);
});

test("resolveVoiceMemoStreamError maps ffmpeg partial-file failures to VMTR14", () => {
  const error = new Error("stream 0, offset 0x28: partial file");
  const resolved = resolveVoiceMemoStreamError(error);
  assert.equal(resolved.errorCode, VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED);
  assert.equal(resolved.code, "TRANSCODE_FAILED");
});

test("all voice memo error codes are unique 6-character identifiers", () => {
  const codes = Object.values(VOICE_MEMO_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) {
    assert.match(code, /^[A-Z0-9]{6}$/);
  }
  assert.equal(VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED, "VMTR14");
});
