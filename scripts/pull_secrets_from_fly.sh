#!/usr/bin/env bash
#
# Pull production SECRETS_JSON from a running Fly machine into config/secrets.json.
# Inverse of scripts/update_secrets.sh (which pushes local → Fly).
#
# Usage:
#   bash scripts/pull_secrets_from_fly.sh
#   FLY_APP=aesop-afghanistan FLY_ORG=aesop-afghanistan-934 bash scripts/pull_secrets_from_fly.sh
#
# Also writes config/secrets.pull.raw.txt (+ .err.txt) — raw SSH stdout/stderr (gitignored).
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS_PATH="$ROOT/config/secrets.json"
RAW_PATH="$ROOT/config/secrets.pull.raw.txt"
APP="${FLY_APP:-aesop-afghanistan}"
ORG="${FLY_ORG:-aesop-afghanistan-934}"
REGION="${FLY_REGION:-iad}"

if ! command -v fly >/dev/null 2>&1; then
  echo "flyctl not found. Install: https://fly.io/docs/hands-on/install-flyctl/" >&2
  exit 1
fi

if ! fly apps list -o "$ORG" -q 2>/dev/null | grep -Fxq "$APP"; then
  echo "Warning: app '$APP' not listed in org '$ORG'. Check fly auth whoami / fly orgs list." >&2
fi

pick_machine_id() {
  if ! command -v jq >/dev/null 2>&1; then
    fly machine list -a "$APP" -q 2>/dev/null | head -1
    return
  fi
  fly machine list -a "$APP" --json | jq -r "
    [.[] | select(.region == \"${REGION}\") | select(.state == \"started\" or .state == \"running\") | .id][0]
    // [.[] | select(.region == \"${REGION}\") | .id][0]
    // .[0].id
  "
}

MACHINE_ID="$(pick_machine_id)"
if [[ -z "$MACHINE_ID" ]]; then
  echo "Error: no machine found for app=${APP} in region=${REGION}." >&2
  echo "Try: fly machine list -a ${APP}" >&2
  exit 1
fi

echo "Pulling SECRETS_JSON from app=${APP} machine=${MACHINE_ID} (${REGION}) ..."

RAW_ERR="${RAW_PATH%.txt}.err.txt"
mkdir -p "$(dirname "$RAW_PATH")"
if ! fly ssh console \
  -a "$APP" \
  -o "$ORG" \
  --machine "$MACHINE_ID" \
  -C "printenv SECRETS_JSON" \
  --pty=false \
  -q >"$RAW_PATH" 2>"$RAW_ERR"; then
  echo "Error: fly ssh console failed." >&2
  echo "  stdout: ${RAW_PATH}" >&2
  echo "  stderr: ${RAW_ERR}" >&2
  exit 1
fi

chmod 600 "$RAW_PATH" "$RAW_ERR" 2>/dev/null || chmod 600 "$RAW_PATH"
echo "Saved raw SECRETS_JSON to ${RAW_PATH}"
if [[ -s "$RAW_ERR" ]]; then
  echo "Fly stderr (non-fatal): ${RAW_ERR}"
fi

mkdir -p "$(dirname "$SECRETS_PATH")"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! node - "$RAW_PATH" "$TMP" <<'NODE'
const fs = require('fs');

const rawPath = process.argv[2];
const outPath = process.argv[3];

function fail(message) {
  console.error(`Error: ${message}`);
  console.error(`Raw SSH output is in ${rawPath}`);
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(rawPath, 'utf8').replace(/\r/g, '');
} catch (err) {
  fail(`Could not read ${rawPath}: ${err.message}`);
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found (missing "{"). Fly may have printed a status line before the secret.');
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  throw new Error('Unbalanced JSON in SSH output.');
}

let parsed;
try {
  const jsonText = extractJsonObject(raw);
  parsed = JSON.parse(jsonText);
} catch (err) {
  fail(`${err.message}`);
}

const dbMatch = raw.match(/^DATABASE_URL=(.+)$/m);
if (dbMatch) {
  parsed.database = parsed.database && typeof parsed.database === 'object' ? parsed.database : {};
  parsed.database.url = dbMatch[1].trim();
}

fs.writeFileSync(outPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
NODE
then
  echo "Could not parse SECRETS_JSON. Raw output kept at ${RAW_PATH}" >&2
  exit 1
fi

# DATABASE_URL is often a separate Fly secret, not inside SECRETS_JSON.
DB_RAW="$(mktemp)"
fly ssh console -a "$APP" -o "$ORG" --machine "$MACHINE_ID" -C "printenv DATABASE_URL" --pty=false -q >"$DB_RAW" 2>/dev/null || true
DB_URL="$(node -e "
const fs=require('fs');
const raw=fs.readFileSync(process.argv[1],'utf8').replace(/\r/g,'').trim();
const lines=raw.split('\n').map(l=>l.trim()).filter(Boolean);
const last=lines[lines.length-1]||'';
process.stdout.write(last.startsWith('No machine')?'':last);
" "$DB_RAW")"
rm -f "$DB_RAW"

if [[ -n "$DB_URL" ]]; then
  if command -v jq >/dev/null 2>&1; then
    jq --arg url "$DB_URL" '.database = ((.database // {}) | .url = $url)' "$TMP" >"${TMP}.db"
    mv "${TMP}.db" "$TMP"
  else
    node -e "
      const fs = require('fs');
      const p = process.argv[1];
      const url = process.argv[2];
      const o = JSON.parse(fs.readFileSync(p, 'utf8'));
      o.database = o.database && typeof o.database === 'object' ? o.database : {};
      o.database.url = url;
      fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', { mode: 0o600 });
    " "$TMP" "$DB_URL"
  fi
  echo "Merged DATABASE_URL into database.url"
fi

if [[ -f "$SECRETS_PATH" ]]; then
  backup="${SECRETS_PATH}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$SECRETS_PATH" "$backup"
  echo "Backed up previous secrets.json to ${backup}"
fi

mv "$TMP" "$SECRETS_PATH"
chmod 600 "$SECRETS_PATH"
trap - EXIT

echo "Wrote ${SECRETS_PATH}"
echo "This file contains production credentials — never commit it."
echo ""
echo "Note: database.url uses Fly's internal pgBouncer host and will not resolve locally."
echo "  For local dev: clear database.url (magic links use in-memory store), or run:"
echo "    fly mpg proxy kyzl60x1wgxopj9g -p 16380"
echo "  and set DATABASE_URL to postgres://fly-user:<pass>@127.0.0.1:16380/fly-db"
