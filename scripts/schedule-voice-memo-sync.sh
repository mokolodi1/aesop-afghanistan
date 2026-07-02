#!/usr/bin/env bash
#
# Create (or re-create) a Fly.io scheduled Machine that syncs voice memos from Google Drive
# to the Applicants sheet.
#
# Usage:
#   bash scripts/schedule-voice-memo-sync.sh                 # daily, app aesop-afghanistan
#   FLY_APP=my-app SCHEDULE=hourly bash scripts/schedule-voice-memo-sync.sh
#   bash scripts/schedule-voice-memo-sync.sh <image-ref>
#
# Schedule values accepted by Fly: hourly | daily | weekly | monthly.
# Voice memo sync scans Drive and reads audio metadata; 256MB is often too small.
set -euo pipefail

APP="${FLY_APP:-aesop-afghanistan}"
SCHEDULE="${SCHEDULE:-daily}"
VM_MEMORY="${VM_MEMORY:-512}"
IMAGE="${1:-}"

if ! command -v fly >/dev/null 2>&1; then
  echo "Error: flyctl ('fly') is not installed or not on PATH." >&2
  exit 1
fi

if [ -z "$IMAGE" ]; then
  echo "Resolving current image for app '$APP'..."
  IMAGE="$(fly machines list -a "$APP" --json 2>/dev/null | node -e "
    const machines = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    function imageRef(machine) {
      const ref = machine.image_ref;
      if (ref?.registry && ref?.repository && ref?.tag) {
        return ref.registry + '/' + ref.repository + ':' + ref.tag;
      }
      const cfg = machine.config?.image;
      if (typeof cfg === 'string') return cfg.split('@')[0];
      return '';
    }
    const appMachine = machines.find(
      (m) =>
        m.config?.metadata?.fly_process_group === 'app' ||
        m.config?.env?.FLY_PROCESS_GROUP === 'app',
    );
    const fromApp = appMachine ? imageRef(appMachine) : '';
    if (fromApp) {
      process.stdout.write(fromApp);
      process.exit(0);
    }
    const tags = [...new Set(machines.map((m) => m.image_ref?.tag).filter(Boolean))].sort();
    const newestTag = tags[tags.length - 1];
    const newest = machines.find((m) => m.image_ref?.tag === newestTag);
    const fallback = newest ? imageRef(newest) : '';
    if (!fallback) process.exit(1);
    process.stdout.write(fallback);
  " || true)"
  if [ -z "$IMAGE" ]; then
    echo "Error: could not resolve the deployed image automatically." >&2
    exit 1
  fi
fi

echo "App:      $APP"
echo "Image:    $IMAGE"
echo "Schedule: $SCHEDULE"
echo "Memory:   ${VM_MEMORY}MB"
echo "Command:  node scripts/sync-voice-memos.js"
echo

fly machine run "$IMAGE" \
  -a "$APP" \
  --schedule "$SCHEDULE" \
  --vm-memory "$VM_MEMORY" \
  node scripts/sync-voice-memos.js

echo
echo "Scheduled Machine created. Inspect with: fly machine list -a $APP"
