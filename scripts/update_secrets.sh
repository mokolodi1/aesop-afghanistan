#!/usr/bin/env bash
# Push local config/secrets.json → Fly SECRETS_JSON.
# Pull prod → local: bash scripts/pull_secrets_from_fly.sh
fly secrets set SECRETS_JSON="$(cat config/secrets.json)" -a aesop-afghanistan
