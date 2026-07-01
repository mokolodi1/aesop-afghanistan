#!/usr/bin/env bash
# Pin the app to iad only and run two web Machines there (no bom or other regions).
#
# Run once after logging into the correct Fly org/account:
#   fly auth login
#   bash scripts/fly-scale-two-iad.sh
#
# Optional overrides:
#   FLY_APP=my-app FLY_ORG=aesop-afghanistan-934 bash scripts/fly-scale-two-iad.sh

set -euo pipefail

APP="${FLY_APP:-aesop-afghanistan}"
ORG="${FLY_ORG:-aesop-afghanistan-934}"
REGION="${FLY_REGION:-iad}"

if ! command -v fly >/dev/null 2>&1; then
  echo "flyctl not found. Install: https://fly.io/docs/hands-on/install-flyctl/" >&2
  exit 1
fi

echo "App: $APP  Org: $ORG  Region: $REGION"
echo

if ! fly apps list -o "$ORG" -q 2>/dev/null | grep -Fxq "$APP"; then
  echo "Warning: app '$APP' not listed in org '$ORG'. Check fly auth whoami / fly orgs list." >&2
fi

echo "Current machines:"
fly machine list -a "$APP"
echo

read -r -p "Remove machines outside ${REGION}, then scale to 2 in ${REGION}? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

if command -v jq >/dev/null 2>&1; then
  OTHER_IDS="$(fly machine list -a "$APP" --json | jq -r ".[] | select(.region != \"${REGION}\") | .id")"
  if [[ -n "$OTHER_IDS" ]]; then
    echo "Destroying machine(s) outside ${REGION}..."
    while IFS= read -r id; do
      [[ -z "$id" ]] && continue
      echo "  fly machine destroy ${id} -a ${APP} --force"
      fly machine destroy "$id" -a "$APP" --force
    done <<< "$OTHER_IDS"
  else
    echo "No machines outside ${REGION}."
  fi
else
  echo "Note: install jq to auto-destroy machines in other regions."
  echo "Otherwise destroy them manually: fly machine list -a ${APP}"
fi

echo "Scaling to 2 machines in ${REGION}..."
fly scale count 2 --region "$REGION" -a "$APP"

echo
echo "Done. Verify:"
fly machine list -a "$APP"
echo
echo "fly.toml sets min_machines_running = 2 in ${REGION} (primary_region)."
echo "Deploy when ready: fly deploy -a ${APP}"
