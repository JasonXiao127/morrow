#!/usr/bin/env bash
# Pre-upgrade snapshot + rolling rebuild for Morrow.
#
# Usage:
#   ./deploy/upgrade.sh
#   COMPOSE_OVERLAY=compose.tailscale.yaml ./deploy/upgrade.sh
#   COMPOSE_FILES="compose.yaml compose.tailscale.yaml" ./deploy/upgrade.sh
#
# The script never runs `docker compose down -v`: the named volumes hold the
# database, attachments, backups and provider credentials.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

COMPOSE_ARGS=(-f compose.yaml)
if [[ -n "${COMPOSE_FILES:-}" ]]; then
  read -r -a FILES <<< "${COMPOSE_FILES}"
  COMPOSE_ARGS=()
  for file in "${FILES[@]}"; do COMPOSE_ARGS+=(-f "${file}"); done
elif [[ -n "${COMPOSE_OVERLAY:-}" ]]; then
  COMPOSE_ARGS+=(-f "${COMPOSE_OVERLAY}")
fi

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

if compose ps --status running --services 2>/dev/null | grep -qx "app"; then
  echo "1/4 snapshotting SQLite before the upgrade..."
  compose exec -T app node --input-type=commonjs - <<'NODE'
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

const databasePath = process.env.DATABASE_PATH || "/data/morrow.db";
const backupDir =
  process.env.BACKUP_DIR || path.join(path.dirname(databasePath), "backups");
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(backupDir, `pre-upgrade-${stamp}.db`);
const quoted = `'${target.replaceAll("'", "''")}'`;

const db = new Database(databasePath);
try {
  db.pragma("busy_timeout = 5000");
  // VACUUM INTO writes a consistent standalone file from a live WAL database
  // without blocking readers.
  db.exec(`VACUUM INTO ${quoted}`);
} finally {
  db.close();
}

const check = new Database(target, { readonly: true });
let rows;
try {
  rows = check.pragma("integrity_check");
} finally {
  check.close();
}
const ok =
  Array.isArray(rows) &&
  rows.length > 0 &&
  rows.every((row) => row.integrity_check === "ok");
if (!ok) {
  console.error("pre-upgrade snapshot failed integrity_check", rows);
  process.exit(1);
}
console.log(target);
NODE
else
  echo "1/4 app is not running; skipping the pre-upgrade snapshot"
fi

echo "2/4 building images..."
compose build --pull

echo "3/4 recreating containers (volumes preserved)..."
compose up -d --remove-orphans

echo "4/4 waiting for /readyz..."
for _ in $(seq 1 30); do
  if compose exec -T app node -e '
    const fs = require("node:fs");
    const dir = process.env.SECRETS_DIR || "/data/secrets";
    let token = process.env.READYZ_TOKEN;
    if (!token) {
      try { token = fs.readFileSync(`${dir}/readyz_token`, "utf8").trim(); } catch {}
    }
    fetch("http://127.0.0.1:3000/readyz", {
      headers: token ? { "x-readyz-token": token } : {},
    }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));
  ' >/dev/null 2>&1; then
    echo "upgrade complete; /readyz is healthy"
    exit 0
  fi
  sleep 1
done

echo "FAIL: /readyz did not become healthy" >&2
compose logs --tail=100 app >&2 || true
echo "The pre-upgrade snapshot, if one was taken, is under /data/backups." >&2
exit 1
