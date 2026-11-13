#!/usr/bin/env bash
# Morrow local OpenCode harness (plan: morrow-local-opencode-harness).
# Dedicated pinned 2.2.5 sidecar for development/field testing.
# Production `config/opencode.jsonc` and `compose.yaml` are untouched.
#
# Usage:
#   OPENCODE_PASSWORD=... REMINDERS_MCP_TOKEN=... ./deploy/harness.sh
#   ./deploy/harness.sh --status | --logs | --stop
#
# The sidecar uses host networking so it reaches the app MCP at 127.0.0.1:3001.
# On Docker Desktop, replace 127.0.0.1 with host.docker.internal in the harness
# config copy and use a specific non-wildcard MCP_HOST in the app env below.
set -euo pipefail

PINNED="2.2.5"
IMAGE="ghcr.io/anomalyco/opencode:${PINNED}"
NAME="morrow-harness"
HARNESS_DIR="${MORROW_HARNESS_DIR:-$HOME/.morrow-harness}"
HARNESS_PORT="${MORROW_HARNESS_PORT:-4098}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Usage: OPENCODE_PASSWORD=... REMINDERS_MCP_TOKEN=... ./deploy/harness.sh [--stop|--logs|--status]
  --stop    remove the harness container
  --logs    follow the harness container logs
  --status  check the image pin + /api/info version
Env: MORROW_HARNESS_DIR (default \$HOME/.morrow-harness),
     MORROW_HARNESS_PORT (default 4098), OPENCODE_PASSWORD*, REMINDERS_MCP_TOKEN*.
EOF
}

need_docker() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if command -v sg >/dev/null 2>&1 && sg docker -c 'docker info' >/dev/null 2>&1; then
    echo "note: using 'sg docker -c' for Docker access" >&2
    return 0
  fi
  echo "error: docker is not available" >&2
  exit 1
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    sg docker -c "docker $*"
  fi
}

harness_status() {
  local info
  if ! info="$(curl -fsS -u "opencode:${OPENCODE_PASSWORD}" "http://127.0.0.1:${HARNESS_PORT}/api/info" 2>/dev/null)"; then
    echo "harness: not reachable at http://127.0.0.1:${HARNESS_PORT}/api/info"
    return 1
  fi
  echo "harness info: ${info}"
  local running
  running="$(docker_cmd ps --filter "name=${NAME}" --format '{{.Image}}' 2>/dev/null || true)"
  echo "harness container image: ${running:-<not found>}"
  case "${running}" in
    *":${PINNED}"*) echo "harness: pinned image ${PINNED} OK" ;;
    *) echo "error: harness is not running pinned ${PINNED} (got '${running}')" >&2; return 1 ;;
  esac
  case "${info}" in
    *"${PINNED}"*) echo "harness: /api/info reports ${PINNED} OK" ;;
    *) echo "error: /api/info does not report ${PINNED}: ${info}" >&2; return 1 ;;
  esac
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --stop)
    docker_cmd rm -f "${NAME}" 2>/dev/null || true
    echo "harness: stopped ${NAME}"
    exit 0
    ;;
  --logs)
    docker_cmd logs -f "${NAME}"
    exit 0
    ;;
  --status)
    need_docker
    harness_status
    exit 0
    ;;
  "") ;;
  *) echo "unknown flag: $1" >&2; usage; exit 1 ;;
esac

need_docker

if [ -z "${OPENCODE_PASSWORD:-}" ]; then
  echo "error: OPENCODE_PASSWORD is required (harness password, separate from production)" >&2
  exit 1
fi
if [ -z "${REMINDERS_MCP_TOKEN:-}" ]; then
  echo "error: REMINDERS_MCP_TOKEN is required (harness MCP token, separate from production)" >&2
  exit 1
fi

# Refuse to start if a local image exists but is not the pinned version.
if docker_cmd image inspect "${IMAGE}" >/dev/null 2>&1; then
  :
else
  echo "harness: pulling ${IMAGE}…"
  docker_cmd pull "${IMAGE}"
fi
# Guard against a stale `latest` or wrong-tag container with the same name.
existing_image="$(docker_cmd ps -a --filter "name=${NAME}" --format '{{.Image}}' 2>/dev/null || true)"
if [ -n "${existing_image}" ] && [ "${existing_image}" != "${IMAGE}" ]; then
  echo "error: existing container ${NAME} uses ${existing_image}, not ${IMAGE}. Remove it first." >&2
  exit 1
fi

docker_cmd rm -f "${NAME}" 2>/dev/null || true
mkdir -p "${HARNESS_DIR}/prompts"
# Keep the stub provider across restarts: `stub-provider.mjs --write-config`
# patches $HARNESS_DIR/opencode.jsonc with a local `stub` provider. A plain
# `cp` on every start would wipe it, forcing a re-run and a new stub port.
# Preserve any existing `"stub"` provider block and re-merge after refresh.
STUB_BACKUP=""
if [[ -f "${HARNESS_DIR}/opencode.jsonc" ]] && grep -q '"stub"' "${HARNESS_DIR}/opencode.jsonc" 2>/dev/null; then
  STUB_BACKUP="$(mktemp)"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    try {
      const text = fs.readFileSync(file, "utf8");
      // JSONC: strip // and /* */ comments for a best-effort parse.
      const json = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const cfg = JSON.parse(json);
      const stub = cfg?.provider?.stub;
      if (stub) fs.writeFileSync(process.argv[2], JSON.stringify(stub));
    } catch (e) {
      process.exit(1);
    }
  ' "${HARNESS_DIR}/opencode.jsonc" "$STUB_BACKUP" 2>/dev/null || STUB_BACKUP=""
fi
cp "${ROOT}/config/opencode.harness.jsonc" "${HARNESS_DIR}/opencode.jsonc"
cp "${ROOT}/packages/agent/prompts/reminders.md" "${HARNESS_DIR}/prompts/reminders.md"
if [[ -n "$STUB_BACKUP" && -f "$STUB_BACKUP" ]]; then
  node -e '
    const fs = require("fs");
    const [cfgFile, stubFile] = process.argv.slice(1);
    const stub = JSON.parse(fs.readFileSync(stubFile, "utf8"));
    let text = fs.readFileSync(cfgFile, "utf8");
    const json = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const cfg = JSON.parse(json);
    cfg.provider = cfg.provider || {};
    cfg.provider.stub = stub;
    // Re-emit as JSON (comments in the template are not preserved, but the
    // stub survives restarts, which is the point).
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  ' "${HARNESS_DIR}/opencode.jsonc" "$STUB_BACKUP" 2>/dev/null && echo "harness: preserved stub provider across restart" || true
  rm -f "$STUB_BACKUP"
fi

docker_cmd run -d --rm --name "${NAME}" --network host \
  -e OPENCODE_PASSWORD \
  -e OPENCODE_CONFIG=/workspace/opencode.jsonc \
  -e REMINDERS_MCP_TOKEN \
  -v "${HARNESS_DIR}:/workspace" \
  "${IMAGE}" \
  serve --hostname 127.0.0.1 --port "${HARNESS_PORT}"

echo "harness: waiting for http://127.0.0.1:${HARNESS_PORT}/api/info …"
for i in $(seq 1 50); do
  if curl -fsS -u "opencode:${OPENCODE_PASSWORD}" "http://127.0.0.1:${HARNESS_PORT}/api/info" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
  if [ "$i" = 50 ]; then
    echo "error: harness did not start; logs:" >&2
    docker_cmd logs "${NAME}" 2>&1 | tail -30 >&2 || true
    exit 1
  fi
done

harness_status

cat <<EOF

harness: ready. Run the app against it with:

  export DATABASE_PATH=/tmp/morrow-harness/app.db
  export SECRETS_DIR=/tmp/morrow-harness/secrets
  export SETUP_TOKEN=harness-setup-token
  export PORT=4605
  export APP_URL=http://127.0.0.1:4605
  export OPENCODE_URL=http://127.0.0.1:${HARNESS_PORT}
  export OPENCODE_PASSWORD='<harness password>'
  export OPENCODE_WORKSPACE=/workspace
  export MCP_ENABLED=true
  export MCP_HOST=127.0.0.1
  export MCP_PORT=3001
  export REMINDERS_MCP_TOKEN='<harness token>'
  pnpm -r build
  node apps/server/dist/index.js

Then: GET /api/assistant/status should report ready and the model.
Stop with: ./deploy/harness.sh --stop
EOF
