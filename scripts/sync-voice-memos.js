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
  for (const warning of result.warnings || []) {
    console.warn(`[sync-voice-memos] warning: ${warning}`);
  }
  if (Array.isArray(result.duplicateAesopIds) && result.duplicateAesopIds.length > 0) {
    for (const entry of result.duplicateAesopIds.slice(0, 10)) {
      const names = (entry.files || []).map((file) => file.fileName).join(", ");
      console.warn(`[sync-voice-memos] duplicate AESOP ID ${entry.aesopId}: ${names}`);
    }
    if (result.duplicateAesopIds.length > 10) {
      console.warn(`[sync-voice-memos] ...and ${result.duplicateAesopIds.length - 10} more duplicate IDs`);
    }
  }
  if (Array.isArray(result.unmatchedFiles) && result.unmatchedFiles.length > 0) {
    for (const entry of result.unmatchedFiles.slice(0, 10)) {
      console.warn(
        `[sync-voice-memos] unmatched file ${entry.fileName} (AESOP ID ${entry.aesopId} not on Applicants sheet)`,
      );
    }
    if (result.unmatchedFiles.length > 10) {
      console.warn(`[sync-voice-memos] ...and ${result.unmatchedFiles.length - 10} more unmatched files`);
    }
  }
}

main().catch((error) => {
  console.error("[sync-voice-memos] failed:", error.message);
  process.exit(1);
});
