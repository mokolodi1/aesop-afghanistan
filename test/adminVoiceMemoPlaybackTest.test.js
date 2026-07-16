#!/usr/bin/env node
const test = require("node:test");
const assert = require("node:assert/strict");

const { formatAdminVoiceMemoPlaybackTestError } = require("../services/adminVoiceMemoPlaybackTest");
const {
  resolveVoiceMemoStreamError,
  VOICE_MEMO_ERROR_CODES,
} = require("../services/voiceMemoStreamErrors");

test("createPlaybackTestSteps initializes all playback test steps as pending", () => {
  const { createPlaybackTestSteps, PLAYBACK_TEST_STEP_DEFINITIONS } = require("../services/adminVoiceMemoPlaybackTest");
  const steps = createPlaybackTestSteps();
  assert.equal(steps.length, PLAYBACK_TEST_STEP_DEFINITIONS.length);
  assert.equal(steps.every((step) => step.status === "pending"), true);
  assert.equal(steps[0].id, "resolve");
});

test("resolveVoiceMemoStreamError maps unregistered Drive callers to VMDR15", () => {
  const error = new Error("Method doesn't allow unregistered callers");
  error.code = 403;
  const resolved = resolveVoiceMemoStreamError(error);
  assert.equal(resolved.errorCode, VOICE_MEMO_ERROR_CODES.DRIVE_ACCESS);
});

test("formatAdminVoiceMemoPlaybackTestError maps transcode failures to VMTR14", () => {
  const error = new Error("transcode failed");
  error.statusCode = 503;
  error.code = "TRANSCODE_FAILED";
  const formatted = formatAdminVoiceMemoPlaybackTestError(error);
  assert.equal(formatted.errorCode, VOICE_MEMO_ERROR_CODES.TRANSCODE_FAILED);
  assert.equal(formatted.statusCode, 503);
});

test("formatAdminVoiceMemoPlaybackTestError preserves generic admin errors", () => {
  const error = new Error("No applicant found for AESOP ID abc.");
  error.statusCode = 404;
  const formatted = formatAdminVoiceMemoPlaybackTestError(error);
  assert.equal(formatted.message, error.message);
  assert.equal(formatted.statusCode, 404);
});
