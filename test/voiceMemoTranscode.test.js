#!/usr/bin/env node
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getMp4FtypBrand,
  voiceMemoNeedsBrowserPlaybackTranscode,
} = require("../utils/voiceMemoTranscode");

test("getMp4FtypBrand reads the MP4 file type brand", () => {
  const buffer = Buffer.concat([
    Buffer.alloc(4, 0),
    Buffer.from("ftyp"),
    Buffer.from("3gp4"),
  ]);
  assert.equal(getMp4FtypBrand(buffer), "3gp4");
});

test("voiceMemoNeedsBrowserPlaybackTranscode flags 3GP voice notes without ffprobe", async () => {
  const buffer = Buffer.concat([
    Buffer.alloc(4, 0),
    Buffer.from("ftyp"),
    Buffer.from("3gp5"),
    Buffer.from("more-bytes"),
  ]);
  const needsTranscode = await voiceMemoNeedsBrowserPlaybackTranscode(buffer, "voice.m4a");
  assert.equal(needsTranscode, true);
});
