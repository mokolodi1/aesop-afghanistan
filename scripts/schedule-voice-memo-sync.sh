#!/usr/bin/env bash
#
# Create (or re-create) a Fly.io scheduled Machine that syncs voice memos from Google Drive
# to the Applicants sheet.
#
# Usage:
#   bash scripts/schedule-voice-memo-sync.sh
#   FLY_APP=my-app SCHEDULE=hourly bash scripts/schedule-voice-memo-sync.sh
#   bash scripts/schedule-voice-memo-sync.sh <image-ref>
#
set -euo pipefail

APP="${FLY_APP:-aesop-afghanistan}"
SCHEDULE="${SCHEDULE:-hourly}"
IMAGE="${1:-}"

if ! command -v fly >/dev/null 2>&1; then
  echo "Error: flyctl ('fly') is not installed or not on PATH." >&2
  exit 1
fi

if [ -z "$IMAGE" ]; then
  echo "Resolving current image for app '$APP'..."
  IMAGE="$(fly image show -a "$APP" --json 2>/dev/null | node -e "
    const rows = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const row = rows.find((entry) => entry.Registry && entry.Repository && entry.Tag) || rows[0];
    if (!row || !row.Registry || !row.Repository || !row.Tag) process.exit(1);
    process.stdout.write(row.Registry + '/' + row.Repository + ':' + row.Tag);
  " || true)"
  if [ -z "$IMAGE" ]; then
    echo "Error: could not resolve the deployed image automatically." >&2
    exit 1
  fi
fi

echo "App:      $APP"
echo "Image:    $IMAGE"
echo "Schedule: $SCHEDULE"
echo "Command:  node scripts/sync-voice-memos.js"
echo

fly machine run "$IMAGE" \
  -a "$APP" \
  --schedule "$SCHEDULE" \
  node scripts/sync-voice-memos.js

echo
echo "Scheduled Machine created. Inspect with: fly machine list -a $APP"
