#!/usr/bin/env bash
# Generate 0600 secrets for Morrow v0.1 (plan §8 Setup + §10 Setup step 2).
# Idempotent: fills only empty/missing values in .env, never overwrites set ones.
# Usage: cp .env.example .env && ./deploy/init-env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

# Host-side data root. Container paths under /data are mirrored here so
# host-side tools and bind-mount deployments get the same layout. Compose's
# named volumes are created/prepared by the `providers-init` service.
DATA_ROOT="${MORROW_DATA_DIR:-$ROOT/data}"
case "$DATA_ROOT" in
  /*) ;;
  *) DATA_ROOT="$ROOT/$DATA_ROOT" ;;
esac
DATA_ROOT="${DATA_ROOT%/}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Copying .env.example -> .env"
  cp "$ROOT/.env.example" "$ENV_FILE"
fi

rand_hex() { # $1 = bytes
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# key => bytes
declare -A SECRETS=(
  [SESSION_SECRET]=32
  [SETUP_TOKEN]=32
  [OPENCODE_PASSWORD]=24
  [REMINDERS_MCP_TOKEN]=32
)

get_val() {
  local key="$1" line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 || true)"
  echo "${line#*=}"
}

set_val() {
  local key="$1" val="$2" esc
  esc="$(printf '%s' "$val" | sed -e 's/[\/&]/\\&/g')"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i -E "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

for key in "${!SECRETS[@]}"; do
  if [[ -z "$(get_val "$key")" ]]; then
    set_val "$key" "$(rand_hex "${SECRETS[$key]}")"
    echo "Generated $key"
  else
    echo "Kept existing $key"
  fi
done

# Canonical sidecar password. Copy an existing OPENCODE_PASSWORD so upgrades do
# not rotate the sidecar credential; otherwise use the generated value.
if [[ -z "$(get_val MORROW_OPENCODE_PASSWORD)" ]]; then
  if [[ -n "$(get_val OPENCODE_PASSWORD)" ]]; then
    set_val "MORROW_OPENCODE_PASSWORD" "$(get_val OPENCODE_PASSWORD)"
    echo "Copied OPENCODE_PASSWORD to MORROW_OPENCODE_PASSWORD"
  else
    set_val "MORROW_OPENCODE_PASSWORD" "$(rand_hex 24)"
    echo "Generated MORROW_OPENCODE_PASSWORD"
  fi
else
  echo "Kept existing MORROW_OPENCODE_PASSWORD"
fi

# Map container paths (/data/...) to their host-side equivalents. Absolute
# paths elsewhere are honoured as-is, so a host bind deployment can point
# SECRETS_DIR / BACKUP_DIR / PROVIDER_OVERLAY_PATH at /srv or similar.
host_path() {
  local p="${1%/}"
  case "$p" in
    /data) printf '%s\n' "$DATA_ROOT" ;;
    /data/*) printf '%s%s\n' "$DATA_ROOT" "${p#/data}" ;;
    /*) printf '%s\n' "$p" ;;
    *) printf '%s/%s\n' "$ROOT" "$p" ;;
  esac
}

ensure_dir() {
  install -d -m 0700 "$1"
  chmod 0700 "$1"
}

BACKUP_DIR_VAL="$(get_val BACKUP_DIR)"
SECRETS_DIR_VAL="$(get_val SECRETS_DIR)"
OVERLAY_PATH_VAL="$(get_val PROVIDER_OVERLAY_PATH)"
[[ -n "$BACKUP_DIR_VAL" ]] || BACKUP_DIR_VAL=/data/backups
[[ -n "$SECRETS_DIR_VAL" ]] || SECRETS_DIR_VAL=/data/secrets
[[ -n "$OVERLAY_PATH_VAL" ]] || OVERLAY_PATH_VAL=/data/opencode-providers/global.json

BACKUP_HOST="$(host_path "$BACKUP_DIR_VAL")"
SECRETS_HOST="$(host_path "$SECRETS_DIR_VAL")"
OVERLAY_HOST="$(host_path "$OVERLAY_PATH_VAL")"
OVERLAY_DIR="$(dirname "$OVERLAY_HOST")"

# 0700 directories; 0600 key files; 0644 overlay (references, not secrets).
ensure_dir "$BACKUP_HOST"
ensure_dir "$SECRETS_HOST"
ensure_dir "$SECRETS_HOST/providers"
ensure_dir "$OVERLAY_DIR"

if [[ ! -f "$OVERLAY_HOST" ]]; then
  printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "provider": {}\n}\n' \
    > "$OVERLAY_HOST"
fi
chmod 0644 "$OVERLAY_HOST"
find "$SECRETS_HOST/providers" -type f -name '*.key' -exec chmod 0600 {} +

# Production agent config has no secrets, so a fresh clone must have it.
# Compose mounts ./config/opencode.jsonc read-only at /workspace; without it
# `docker compose up` fails. Keep it committed; only create a placeholder if
# a packaging step stripped it.
if [[ ! -f "$ROOT/config/opencode.jsonc" ]]; then
  echo "Creating placeholder config/opencode.jsonc (committed in git; this is a fallback)"
  mkdir -p "$ROOT/config"
  cat > "$ROOT/config/opencode.jsonc" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "reminders",
  "agents": {
    "reminders": {
      "description": "Self-hosted reminders assistant",
      "mode": "primary",
      "system": "{file:/workspace/prompts/reminders.md}",
      "steps": 8,
      "permissions": [
        { "action": "*", "resource": "*", "effect": "deny" },
        { "action": "morrow_reminders_*", "resource": "*", "effect": "allow" }
      ]
    }
  },
  "policies": [
    { "action": "tool.use", "resource": "shell:*", "effect": "deny" },
    { "action": "tool.use", "resource": "edit:*", "effect": "deny" },
    { "action": "tool.use", "resource": "read:*", "effect": "deny" },
    { "action": "tool.use", "resource": "webfetch:*", "effect": "deny" },
    { "action": "tool.use", "resource": "websearch:*", "effect": "deny" }
  ],
  "mcp": {
    "servers": {
      "morrow": {
        "type": "remote",
        "url": "http://app:3001/mcp",
        "oauth": false,
        "codemode": false,
        "protocol": "auto",
        "headers": { "Authorization": "Bearer {env:REMINDERS_MCP_TOKEN}" },
        "timeout": { "startup": 30000, "catalog": 30000, "execution": 30000 }
      }
    }
  }
}
JSON
fi

# VAPID keys for Web Push. Generate once via `npx web-push generate-vapid-keys`
# (same output shape as `web-push generate-vapid-keys`); never overwrite set
# values. Push stays off (503 push_not_configured) until these are present and
# the app restarts over HTTPS (or localhost for dev).
if [[ -z "$(get_val VAPID_PUBLIC_KEY)" || -z "$(get_val VAPID_PRIVATE_KEY)" ]]; then
  if command -v npx >/dev/null 2>&1; then
    echo "Generating VAPID keys (web-push)…"
    VAPID_OUT="$(npx -y web-push generate-vapid-keys 2>/dev/null || true)"
    PUB="$(printf '%s\n' "$VAPID_OUT" | grep -i 'public' | sed -E 's/.*[:=][[:space:]]*//' | tr -d '\r' | head -n1 || true)"
    PRIV="$(printf '%s\n' "$VAPID_OUT" | grep -i 'private' | sed -E 's/.*[:=][[:space:]]*//' | tr -d '\r' | head -n1 || true)"
    if [[ -n "$PUB" && -n "$PRIV" ]]; then
      [[ -z "$(get_val VAPID_PUBLIC_KEY)" ]] && set_val "VAPID_PUBLIC_KEY" "$PUB" && echo "Generated VAPID_PUBLIC_KEY"
      [[ -z "$(get_val VAPID_PRIVATE_KEY)" ]] && set_val "VAPID_PRIVATE_KEY" "$PRIV" && echo "Generated VAPID_PRIVATE_KEY"
    else
      echo "Could not parse web-push output; set VAPID keys manually:"
      echo "  npx web-push generate-vapid-keys"
    fi
  else
    echo "npx not found; set VAPID keys manually: npx web-push generate-vapid-keys"
  fi
else
  echo "Kept existing VAPID keys"
fi
# Sane default subject (Apple rejects localhost; use a real mailto:/https:).
if [[ -z "$(get_val VAPID_SUBJECT)" ]]; then
  set_val "VAPID_SUBJECT" "mailto:admin@example.com"
  echo "Set default VAPID_SUBJECT=mailto:admin@example.com (change to your contact)"
fi

chmod 600 "$ENV_FILE"
echo "Prepared host data dirs under $DATA_ROOT (0700 dirs, 0600 keys, 0644 overlay)."
echo "Secrets are 0600 in $ENV_FILE. Next: docker compose up -d --build"
