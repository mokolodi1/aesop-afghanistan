#!/usr/bin/env bash
#
# Provision Fly Managed Postgres for aesop-afghanistan and attach it to the app.
#
# Usage:
#   bash scripts/provision-postgres.sh
#   FLY_APP=my-app FLY_ORG=my-org bash scripts/provision-postgres.sh
#
# After this script completes:
#   1. Fly sets DATABASE_URL on the app automatically when Postgres is attached.
#   2. Deploy the app, then run migrations:
#        fly deploy -a "$APP"
#        fly machine exec <machine-id> -a "$APP" "sh -c 'cd /app && node db/migrate.js'"
#   3. Backups and HA are handled by Fly Managed Postgres.
#
set -euo pipefail

APP="${FLY_APP:-aesop-afghanistan}"
ORG="${FLY_ORG:-aesop-afghanistan-934}"
REGION="${FLY_REGION:-iad}"
PG_NAME="${FLY_PG_NAME:-${APP}-mpg}"
PG_PLAN="${FLY_PG_PLAN:-basic}"
VOLUME_SIZE="${FLY_PG_VOLUME_SIZE:-10}"

if ! command -v fly >/dev/null 2>&1; then
  echo "Error: flyctl ('fly') is not installed or not on PATH." >&2
  exit 1
fi

echo "App:        $APP"
echo "Postgres:   $PG_NAME (Managed)"
echo "Org:        $ORG"
echo "Region:     $REGION"
echo "Plan:       $PG_PLAN"
echo

CLUSTER_ID=""
if fly mpg list -o "$ORG" 2>/dev/null | grep -q "$PG_NAME"; then
  echo "Managed Postgres cluster '$PG_NAME' already exists."
  CLUSTER_ID="$(fly mpg list -o "$ORG" --json 2>/dev/null | node -e "
    const rows = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const match = rows.find((row) => row.name === process.argv[1]);
    if (!match) process.exit(1);
    process.stdout.write(match.id);
  " "$PG_NAME")"
else
  echo "Creating Managed Postgres cluster '$PG_NAME'..."
  CREATE_OUTPUT="$(fly mpg create \
    -n "$PG_NAME" \
    -o "$ORG" \
    -r "$REGION" \
    --plan "$PG_PLAN" \
    --volume-size "$VOLUME_SIZE")"
  echo "$CREATE_OUTPUT"
  CLUSTER_ID="$(echo "$CREATE_OUTPUT" | sed -n 's/^  ID: //p' | head -1)"
fi

if [ -z "$CLUSTER_ID" ]; then
  echo "Error: could not determine Managed Postgres cluster ID." >&2
  exit 1
fi

echo
if fly secrets list -a "$APP" 2>/dev/null | awk '{print $1}' | grep -qx "DATABASE_URL"; then
  echo "DATABASE_URL is already set on '$APP'. Skipping attach."
else
  echo "Attaching Managed Postgres '$PG_NAME' ($CLUSTER_ID) to app '$APP'..."
  fly mpg attach "$CLUSTER_ID" -a "$APP"
fi

echo
echo "Done. Next steps:"
echo "  fly secrets list -a $APP | grep DATABASE_URL"
echo "  fly secrets deploy -a $APP"
echo "  fly deploy -a $APP"
echo "  fly machine list -a $APP"
echo "  fly machine exec <machine-id> -a $APP \"sh -c 'cd /app && node db/migrate.js'\""
echo "  bash scripts/schedule-classroom-sync.sh"
echo
echo "Managed Postgres dashboard:"
echo "  https://fly.io/dashboard/$ORG/managed_postgres/$CLUSTER_ID"
