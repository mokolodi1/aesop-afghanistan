#!/usr/bin/env node
/**
 * Sync Round 2 / Voice note link / Voice note last updated on the Applicants sheet from Google Drive voice memos.
 */
const { syncVoiceMemoRound2Status } = require("../services/voiceMemoSync");

async function main() {
  const result = await syncVoiceMemoRound2Status();
  console.log(
    `[sync-voice-memos] updated=${result.updated} upToDate=${result.skippedUpToDate} noFile=${result.skippedNoFile} notAccepted=${result.skippedNotAccepted} noId=${result.skippedNoId} driveFiles=${result.driveFileCount}`,
  );
}

main().catch((error) => {
  console.error("[sync-voice-memos] failed:", error.message);
  process.exit(1);
});
