#!/usr/bin/env bash
# E2E runner: fresh DB, local server, node suite, teardown.
# Usage: E2E_BASE=http://127.0.0.1:4591 ./e2e.sh   (PORT default 4591)
set -euo pipefail
PORT="${PORT:-4591}"
E2E_BASE="${E2E_BASE:-http://127.0.0.1:${PORT}}"
DB_DIR="/tmp/morrow-refine-e2e"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rm -rf "${DB_DIR}"
mkdir -p "${DB_DIR}/secrets" "${DB_DIR}/data"

export DATABASE_PATH="${DB_DIR}/app.db"
export SECRETS_DIR="${DB_DIR}/secrets"
export SETUP_TOKEN="${SETUP_TOKEN:-e2e-refine-123}"
# First-run is open by default; the gate below asserts the simplified form.
export SETUP_MODE=open
export NODE_ENV=development
export PORT
export HOST=0.0.0.0
export APP_URL="http://127.0.0.1:${PORT}"

node "${ROOT}/apps/server/dist/index.js" > "${DB_DIR}/server.log" 2>&1 &
SRV=$!
trap 'kill ${SRV} 2>/dev/null || true' EXIT

for i in $(seq 1 50); do
  if curl -sf "${E2E_BASE}/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.2
  if [ "$i" = 50 ]; then echo "FAIL server did not start"; tail -20 "${DB_DIR}/server.log"; exit 1; fi
done

export E2E_BASE

# Fresh-install gate: before any owner exists, the real browser must be sent
# to /setup from both / and /login. This runs before the API suite provisions
# the owner; the same spec skips itself in the normal run.
if [ -f "${ROOT}/apps/web/dist/index.html" ]; then
  echo "browser: fresh-install setup routing"
  (cd "${ROOT}/apps/web" && MORROW_FRESH_E2E=1 npx playwright test e2e-browser/first-run.spec.ts)
  FRESH_CODE=$?
  if [ "${FRESH_CODE}" -ne 0 ]; then
    echo "FAIL fresh-install browser gate (${FRESH_CODE})"
    exit "${FRESH_CODE}"
  fi
else
  echo "fresh-install browser gate skipped: build apps/web first"
fi

node "${ROOT}/apps/web/e2e/run.mjs"
CODE=$?
if [ "${CODE}" -ne 0 ]; then
  echo "node e2e failed with ${CODE}; skipping browser suite"
  echo "rerun: E2E_BASE=${E2E_BASE} ./e2e.sh"
  exit "${CODE}"
fi

# After setup, the first-run paths must flip back to sign-in.
SETUP_LOCATION="$(curl -s -o /dev/null -w '%{redirect_url}' -H 'Accept: text/html' "${E2E_BASE}/setup")"
case "${SETUP_LOCATION}" in
  *"/login") ;;
  *)
    echo "FAIL /setup should redirect to /login after setup (got ${SETUP_LOCATION})"
    exit 1
    ;;
esac
SETUP_STATUS_JSON="$(curl -s "${E2E_BASE}/api/setup/status")"
case "${SETUP_STATUS_JSON}" in
  *'"setupRequired":false'*) ;;
  *)
    echo "FAIL setup status after provisioning: ${SETUP_STATUS_JSON}"
    exit 1
    ;;
esac
echo "PASS first-run routing flips to sign-in after setup"

# Real browser gate (§4): Playwright proves the UI, not just the API.
# Artifacts go to /tmp/morrow-playwright (outside the repo).
if [ "${SKIP_BROWSER:-0}" != "1" ]; then
  echo "browser: playwright core + reminder + assistant + mobile"
  (cd "${ROOT}/apps/web" && npx playwright test --config=playwright.config.ts)
  BROWSER_CODE=$?
  if [ "${BROWSER_CODE}" -ne 0 ]; then
    echo "FAIL browser suite (${BROWSER_CODE}); see /tmp/morrow-playwright"
    exit "${BROWSER_CODE}"
  fi
else
  echo "browser: skipped (SKIP_BROWSER=1)"
fi
echo "rerun: E2E_BASE=${E2E_BASE} ./e2e.sh"
exit 0
