#!/usr/bin/env sh
# Liveness probe for Morrow app (plan §5 GET /healthz, §10 Setup).
# Container HEALTHCHECK and host-side `docker compose exec app` both use this.
# Usage: ./deploy/healthcheck.sh [base_url]  (default http://127.0.0.1:3000)
set -eu

BASE="${1:-${APP_URL:-http://127.0.0.1:3000}}"

if command -v curl >/dev/null 2>&1; then
  exec curl -fsS --max-time 5 "$BASE/healthz" >/dev/null
elif command -v wget >/dev/null 2>&1; then
  exec wget -qO- --timeout=5 "$BASE/healthz" >/dev/null
else
  node -e "fetch(process.argv[1]+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" "$BASE"
fi
