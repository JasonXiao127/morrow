#!/usr/bin/env bash
# Secondary volume-level SQLite snapshot (stopgap; not the supported path).
# Supported nightly path (§6): the app scheduler runs runBackupNow() daily
# (JSON export + 14 daily / 8 weekly / 6 monthly retention + /api/backup/runs
# ledger). Keep this script only as a secondary crash-consistency snapshot;
# do not rely on it for restore drills (use JSON export → wipe → import).
# Usage: BACKUP_DIR=/data/backups DATABASE_PATH=/data/morrow.db ./deploy/backup-cron.sh
# Cron (optional secondary): 0 3 * * * /opt/morrow/deploy/backup-cron.sh >>/var/log/morrow-backup.log 2>&1
set -euo pipefail

DATABASE_PATH="${DATABASE_PATH:-/data/morrow.db}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
KEEP_DAILY="${KEEP_DAILY:-14}"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DATABASE_PATH" ]]; then
  echo "backup-cron: no database at $DATABASE_PATH, nothing to do" >&2
  exit 0
fi

# -wal/-shm safe copy: prefer sqlite3 .backup, fall back to cp.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/morrow-$STAMP.db"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATABASE_PATH" ".backup '$DEST'"
else
  cp "$DATABASE_PATH" "$DEST"
fi
chmod 600 "$DEST"
sha256sum "$DEST" | awk '{print $1}' > "$DEST.sha256"

# Prune: keep newest $KEEP_DAILY snapshots.
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/morrow-*.db 2>/dev/null | tail -n +"$((KEEP_DAILY + 1))" | while read -r old; do
  rm -f "$old" "$old.sha256"
done

echo "backup-cron: wrote $DEST"
