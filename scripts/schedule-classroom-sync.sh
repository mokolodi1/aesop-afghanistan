#!/usr/bin/env bash
#
# Create (or re-create) a Fly.io scheduled Machine that runs the Google Classroom
# sync on a timer. The Machine reuses the app's current image and inherits the
# app secrets (SECRETS_JSON), so no extra credentials are needed.
#
# Usage:
#   bash scripts/schedule-classroom-sync.sh                 # daily, app aesop-afghanistan
#   FLY_APP=my-app SCHEDULE=hourly bash scripts/schedule-classroom-sync.sh
#   bash scripts/schedule-classroom-sync.sh <image-ref>     # pin a specific image
#
# Schedule values accepted by Fly: hourly | daily | weekly | monthly.
#
# Prerequisites:
#   - flyctl installed and authenticated (fly auth login)
#   - classroom.enabled=true and classroom.impersonateEmail set in SECRETS_JSON
#     (push with: bash scripts/update_secrets.sh)
set -euo pipefail

APP="${FLY_APP:-aesop-afghanistan}"
SCHEDULE="${SCHEDULE:-daily}"
IMAGE="${1:-}"

if ! command -v fly >/dev/null 2>&1; then
  echo "Error: flyctl ('fly') is not installed or not on PATH." >&2
  echo "Install: https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

# Resolve the app's current image when not provided explicitly.
if [ -z "$IMAGE" ]; then
  echo "Resolving current image for app '$APP'..."
  info="$(fly image show -a "$APP" 2>/dev/null || true)"
  reg="$(printf '%s\n' "$info" | awk -F'= ' '/Registry/{print $2}'  | tr -d '[:space:]')"
  repo="$(printf '%s\n' "$info" | awk -F'= ' '/Repository/{print $2}' | tr -d '[:space:]')"
  tag="$(printf '%s\n' "$info" | awk -F'= ' '/Tag/{print $2}'        | tr -d '[:space:]')"
  if [ -z "$reg" ] || [ -z "$repo" ] || [ -z "$tag" ]; then
    echo "Error: could not resolve the deployed image automatically." >&2
    echo "Run 'fly image show -a $APP' and pass the image ref as the first argument." >&2
    exit 1
  fi
  IMAGE="$reg/$repo:$tag"
fi

echo "App:      $APP"
echo "Image:    $IMAGE"
echo "Schedule: $SCHEDULE"
echo "Command:  node scripts/sync-classroom.js"
echo

fly machine run "$IMAGE" \
  -a "$APP" \
  --schedule "$SCHEDULE" \
  node scripts/sync-classroom.js

echo
echo "Scheduled Machine created. Inspect with: fly machine list -a $APP"
echo "Logs after it runs:                      fly logs -a $APP"
