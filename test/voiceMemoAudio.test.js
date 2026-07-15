#!/usr/bin/env node
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectDriveFileIdsFromScan,
  parseVoiceMemoByteRange,
} = require("../services/voiceMemoAudio");

test("collectDriveFileIdsFromScan returns unique file ids from parsed files", () => {
  const ids = collectDriveFileIdsFromScan({
    parsedFiles: [
      { fileId: "abc", fileName: "1.m4a" },
      { fileId: "def", fileName: "2.m4a" },
      { fileId: "abc", fileName: "1-resubmit.m4a" },
      { fileId: "", fileName: "bad.m4a" },
    ],
  });
  assert.deepEqual(ids.sort(), ["abc", "def"]);
});

test("collectDriveFileIdsFromScan handles empty scan", () => {
  assert.deepEqual(collectDriveFileIdsFromScan(null), []);
  assert.deepEqual(collectDriveFileIdsFromScan({ parsedFiles: [] }), []);
});

test("parseVoiceMemoByteRange returns full file when range is absent", () => {
  const range = parseVoiceMemoByteRange("", 1200);
  assert.equal(range.start, 0);
  assert.equal(range.end, 1199);
  assert.equal(range.status, 200);
  assert.equal(range.contentLength, "1200");
  assert.equal(range.contentRange, null);
});

test("parseVoiceMemoByteRange parses open-ended and closed ranges", () => {
  const openStart = parseVoiceMemoByteRange("bytes=500-", 1200);
  assert.equal(openStart.start, 500);
  assert.equal(openStart.end, 1199);
  assert.equal(openStart.status, 206);
  assert.equal(openStart.contentRange, "bytes 500-1199/1200");
  assert.equal(openStart.contentLength, "700");

  const closed = parseVoiceMemoByteRange("bytes=10-19", 1200);
  assert.equal(closed.start, 10);
  assert.equal(closed.end, 19);
  assert.equal(closed.status, 206);
  assert.equal(closed.contentLength, "10");
});

test("parseVoiceMemoByteRange rejects invalid ranges", () => {
  assert.throws(
    () => parseVoiceMemoByteRange("bytes=2000-3000", 1200),
    (error) => error.statusCode === 416,
  );
});
