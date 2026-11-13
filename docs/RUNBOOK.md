# Runbook

Operator path for a self-hosted Morrow v0.3 instance. Fresh boot is
`cp .env.example .env && ./deploy/init-env.sh && sg docker -c 'docker compose up -d --build'`,
then setup-token → password → login, a restore drill, and a nightly backup.

Docker examples below use `sg docker -c '…'` because the login user may not be
in the `docker` socket group (the default on this host). If `docker ps` works
without it, drop the wrapper. Do not add users to the `docker` group on a shared
host just to run Morrow.

## Deploy (fresh host)

Prerequisites: Docker Engine with Compose v2, ports 80/443 reachable (or the
Tailscale path below), and enough disk for the SQLite file plus backups.

```sh
cd /opt/morrow
cp .env.example .env
./deploy/init-env.sh
sg docker -c 'docker compose up -d --build'
```

`init-env.sh` is idempotent: it fills only empty values, generates
`SESSION_SECRET`, `SETUP_TOKEN`, `OPENCODE_PASSWORD`, and
`REMINDERS_MCP_TOKEN`, then `chmod 600 .env`. It never prints or overwrites a
secret that is already set. `SETUP_TOKEN` is only used when
`SETUP_MODE=token`; open first-run (the default) ignores it.

Set the public address **before** first start if you have a domain. `APP_URL`
is the canonical origin (`scheme://host[:port]`, no trailing slash) used for
absolute links (digests/ntfy) and the default VAPID subject. The manifest,
CalDAV hrefs, and Web Push click URLs are relative, so alternate origins can
still serve the app. Same-origin browser requests are accepted from a LAN IP
or alternate hostname, but keep this value accurate:

```dotenv
SITE_ADDRESS=morrow.example.com
APP_URL=https://morrow.example.com
```

Keep `SITE_ADDRESS` as `localhost` for local-only work: Caddy treats a hostname
as automatic HTTPS and uses its internal CA, so set `APP_URL=https://localhost`
and trust the Caddy root, or use `SITE_ADDRESS=:80` with
`APP_URL=http://localhost` for plain HTTP local-only. A bare `:80` is HTTP, not
TLS. Choose one pair before the first setup. The app warns at boot when the
pair disagrees; the scheme/host still affects absolute links and the default
VAPID subject, even though same-origin mutations and relative PWA/CalDAV/push
URLs continue to work. See “TLS options” before exposing the instance.

Check the stack:

```sh
sg docker -c 'docker compose ps'
./deploy/healthcheck.sh https://morrow.example.com
curl -fsS https://morrow.example.com/healthz
curl -fsS -H "X-Readyz-Token: $READYZ_TOKEN" https://morrow.example.com/readyz
```

`/healthz` is liveness (no auth, no DB). `/readyz` reports DB, scheduler, and
optional OpenCode state; it is open when `READYZ_TOKEN` is unset, so set a
0600 `SECRETS_DIR/readyz_token` (or `READYZ_TOKEN`) and pass
`X-Readyz-Token` from your monitor. OpenCode being down does not fail
readiness — AI is optional.

Behind the bundled Caddy, set `TRUST_PROXY` to the exact `edge` network CIDR so
login/IP rate limits see client addresses instead of Caddy’s container IP:

```sh
sg docker -c 'docker network inspect morrow_edge --format "{{range .IPAM.Config}}{{.Subnet}}{{end}}"'
# default: TRUST_PROXY=172.22.0.0/16 (MORROW_EDGE_SUBNET) in .env, then restart
```

The compose bundle pins the `edge` subnet with `MORROW_EDGE_SUBNET`
(default `172.22.0.0/16`). If you change it, change `TRUST_PROXY` to match.
Use exact CIDRs only; the app refuses `true`, `*`, and `0.0.0.0/0`. Leave it
unset when no proxy is in front and you do not need forwarded client IPs.

## First-run setup

1. Open `APP_URL`. With no users, `/` and `/login` redirect to `/setup`
   automatically (the server logs a first-run line at boot).
2. Default `SETUP_MODE=open`: the first visitor creates the owner account
   (password ≥12 characters + timezone). There is no token. This is intended
   for a trusted LAN or Tailscale; finish setup before exposing the port. If
   `APP_URL` is public, the server logs a warning at boot.
3. Internet-facing host? Set `SETUP_MODE=token` before exposing it. Setup then
   requires `SETUP_TOKEN` (print it with
   `grep '^SETUP_TOKEN=' .env | cut -d= -f2-`, or read
   `SECRETS_DIR/setup_token`), and `/setup?token=…` prefills it.
4. Submit once. The first-user insert is atomic; every later setup attempt is
   `409 setup_complete`, so setup is closed even with the correct token.
5. In token mode, the server deletes `SECRETS_DIR/setup_token` after success;
   the `.env` copy is inert. Blank it after setup if you like:
   `sed -i 's/^SETUP_TOKEN=.*/SETUP_TOKEN=/' .env`.
6. Log in, create a task, then install the PWA and enable notifications
   (`docs/PWA.md`). If push is wanted, generate VAPID keys first
   (`npx web-push generate-vapid-keys`) and set `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY`, and a real `VAPID_SUBJECT`
   (`mailto:you@example.com` or `https://…`); Apple rejects `localhost`.
   Restart the app after changing VAPID keys.

Lost the password after setup? The setup token cannot recover it. Use the CLI
on the app container. It resets the named account (default: the workspace
owner) and revokes only that account's sessions; other members stay signed in:

```sh
printf '%s' 'new-strong-password' |
  sg docker -c 'docker compose exec -T app node apps/server/dist/reset-password.js -'
# or target a member explicitly:
printf '%s' 'new-strong-password' |
  sg docker -c 'docker compose exec -T app node apps/server/dist/reset-password.js --user alice -'
```

## Nightly backup and retention check

Two layers exist. Use both if the data matters.

### App JSON backup (portable, preferred)

`POST /api/backup/run` writes a canonical `morrow.backup` JSON to
`BACKUP_DIR`, records a `backup_runs` row, then enforces retention. The API is
session-authenticated, so a cron entry can either call it with a live cookie or
invoke the same code inside the container:

```sh
# Manual, from a logged-in browser/curl:
#   POST https://morrow.example.com/api/backup/run
# Nightly at 03:00, no cookie to expire:
0 3 * * * cd /opt/morrow && sg docker -c 'docker compose exec -T app node --input-type=module -e "import { runBackupNow } from \"/app/apps/server/dist/backup.js\"; const out = await runBackupNow(); console.log(JSON.stringify({ run: out.run.name, pruned: out.pruned.length }));"' >>/var/log/morrow-backup.log 2>&1
```

Retention is **14 daily + 8 weekly + 6 monthly**, newest per period; a
`pre-restore` snapshot is protected for its first 7 days even on a crowded day.
Check the ledger from Settings → Backup or:

```sh
curl -fsS -b /tmp/morrow.cookies https://morrow.example.com/api/backup/runs \
  | jq '.runs | group_by(.status) | map({status: .[0].status, count: length})'
```

Expected: no unexpected growth beyond those buckets (plus recent
`pre-restore` rows), newest `createdAt` is from the last night, and
`fileExists` is true. Alert when the newest successful run is older than 26
hours, or when any expected run has `fileExists: false`.

### Volume snapshot cron (stopgap)

`deploy/backup-cron.sh` makes a SQLite-level copy (prefers `sqlite3 .backup`,
falls back to `cp`) and keeps the newest `KEEP_DAILY` (default 14). The script’s
own cron contract:

```sh
0 3 * * * cd /opt/morrow && sg docker -c 'docker compose exec -T app /app/deploy/backup-cron.sh' >>/var/log/morrow-backup.log 2>&1
```

The `sqlite3` CLI is not in the base Node image, so the in-container fallback is
`cp`; that is only WAL-safe for a quiet database. For a strict snapshot, run
the script on the host with `sqlite3` installed and point `DATABASE_PATH` at the
volume mount (`sg docker -c 'docker volume inspect morrow_app-data'` shows the
host mountpoint), or rely on the app JSON run above.

Retention check for the volume layer:

```sh
sg docker -c 'docker compose exec -T app sh -c "ls -1 /data/backups/morrow-*.db | wc -l"'
# expect <= 14
sg docker -c 'docker compose exec -T app sh -c "for f in /data/backups/morrow-*.db; do h=\$(sha256sum \"\$f\" | cut -d\" \" -f1); [ \"\$h\" = \"\$(cat \"\$f.sha256\")\" ] || echo BAD \"\$f\"; done"'
```

Keep `BACKUP_DIR` on a different disk or machine from the SQLite file. A backup
next to the database is not a backup. The app JSON export excludes secrets
(`docs/SECURITY.md`), so it is safe to copy off-box; protect it anyway because
task text is personal data. It also excludes `provider_credentials` and
`SECRETS_DIR/providers`, so a JSON backup cannot restore a provider key; see
“Restore re-entry” below.

## Restore drill

Run this before you need it. It uses the same endpoints the UI uses and proves
export → dry-run → tamper rejection → import → reverse. The session must have a
fresh step-up (`POST /api/auth/password`) for every import, including dry-run.

```sh
BASE=https://morrow.example.com
JAR=/tmp/morrow.cookies
PASS='your-current-password'

curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d "{\"username\":\"owner\",\"password\":\"$PASS\"}" "$BASE/api/login"
curl -fsS -b "$JAR" -X POST -H 'content-type: application/json' \
  -d "{\"password\":\"$PASS\"}" "$BASE/api/auth/password"
```

1. **Export** a known-good copy (or use Settings → Backup → Download JSON):

   ```sh
   curl -fsS -b "$JAR" "$BASE/api/backup/export" -o morrow-export.json
   ```

2. **Dry-run** and read the diff. It never touches the live DB:

   ```sh
   curl -fsS -b "$JAR" -F backup=@morrow-export.json \
     "$BASE/api/backup/import?dryRun=1" | jq '{counts, diff}'
   ```

   Review `diff.added/updated/deleted` and `diff.conflicts` (a conflict means
   the live row is newer than the backup copy). Expect zero changes for an
   immediately-taken export.

3. **Tamper check**: flip one byte; the exact-byte SHA-256/canonical check must
   reject it with `400 invalid_backup`, not import it.

   ```sh
   cp morrow-export.json tampered.json
   python3 - <<'PY'
   p = "tampered.json"
   b = bytearray(open(p, "rb").read())
   b[200] ^= 0x01
   open(p, "wb").write(b)
   PY
   curl -sS -o /tmp/tamper-body -w '%{http_code}\n' -b "$JAR" \
     -F backup=@tampered.json "$BASE/api/backup/import?dryRun=1"
   # expect 400; body code is "invalid_backup" and mentions sha256/canonical
   ```

4. **Apply** with the typed confirmation. A pre-restore snapshot is written
   first; sessions are revoked:

   ```sh
   curl -fsS -b "$JAR" -F backup=@morrow-export.json -F confirm=RESTORE \
     "$BASE/api/backup/import" | jq
   ```

   Record `preRestore.path`, `.sha256`, and `.bytes` from the response. During
   the swap the server enters maintenance: other mutating `/api` calls get
   `503 maintenance` + `Retry-After: 5` and `/readyz` returns
   `503 {status:"maintenance"}`. The restore sets `login_reset_required` and
   `push_resubscribe_required`, invalidates capture/CalDAV/MCP tokens,
   proposals, `operations`, pending deliveries/leases, and SSE cursors, then
   logs you out everywhere. Log in again with the existing password (password
   hashes live in the current DB and are not part of the backup); if this was a
   fresh-instance restore, run `reset-password` as above. Re-create capture and
   CalDAV tokens and rotate an MCP token if the sidecar uses one. Re-enable push
   on each device. Verify `/api/bootstrap`, the task list, and Settings → Backup
   for the new `backup.restore` activity row.

5. **Reverse** the restore with the automatic pre-restore snapshot. Log in,
   refresh step-up, find the newest `pre-restore` run, download it, dry-run,
   then apply with `confirm=RESTORE`:

   ```sh
   curl -fsS -b "$JAR" "$BASE/api/backup/runs" \
     | jq '.runs[] | select(.status == "pre-restore") | {id,name,createdAt,sha256}'
   ID=<id-from-above>
   curl -fsS -b "$JAR" -o pre-restore.json "$BASE/api/backup/download/$ID"
   curl -fsS -b "$JAR" -X POST -H 'content-type: application/json' \
     -d "{\"password\":\"$PASS\"}" "$BASE/api/auth/password"
   curl -fsS -b "$JAR" -F backup=@pre-restore.json \
     "$BASE/api/backup/import?dryRun=1" | jq '{counts, diff}'
   curl -fsS -b "$JAR" -F backup=@pre-restore.json -F confirm=RESTORE \
     "$BASE/api/backup/import" | jq '{counts, preRestore}'
   ```

   Each apply writes another pre-restore snapshot, so the drill leaves two;
   retention protects them for 7 days. Verify the original task state and that
   no queued outbox writes were applied twice (`docs/PWA.md`).

If the app will not start, restore the previous volume snapshot while the
stack is stopped instead of using the API:

```sh
sg docker -c 'docker compose down'
sg docker -c 'docker run --rm -v morrow_app-data:/data -v /var/backups/morrow:/backup:ro alpine sh -c "cp /backup/morrow-<stamp>.db /data/morrow.db && rm -f /data/morrow.db-wal /data/morrow.db-shm"'
sg docker -c 'docker compose up -d'
```

That restores only the database volume. Provider keys live in
`opencode-secrets` and the overlay in `opencode-providers`; if those volumes
are older/newer than the DB, expect `degraded` rows or a stale overlay. Restore
all three consistently, or re-add/rotate providers after a DB-only restore.

## Upgrades

Images are tagged in `compose.yaml` for the scaffold; production should pin
digests. TODO comments in `compose.yaml` mark each service. Before changing
anything:

1. Run or download a JSON backup, and keep a volume snapshot. Include
   `opencode-secrets` (provider keys) and `opencode-providers` (overlay), not
   just `app-data`.
2. Record the running image digests:

   ```sh
   sg docker -c 'docker compose images'
   sg docker -c 'docker images --digests'
   ```

3. Replace each `image:` tag with `repository@sha256:<digest>` (Caddy and
   OpenCode), and publish/pin the app image digest if you build your own. The
   app currently builds from `Dockerfile.app`; pin its base
   `node:22-bookworm-slim` there when the image track does the same.

Apply:

```sh
sg docker -c 'docker compose pull'
sg docker -c 'docker compose up -d --build'
sg docker -c 'docker compose ps'
```

Drizzle migrations run automatically when the app opens the DB
(`packages/db`), so there is no separate production migrate step. Before
pending migrations, the app writes a complete SQLite snapshot at
`/data/morrow.db.pre-migration-<timestamp>-<id>.bak` using `VACUUM INTO` and
keeps the newest 3. The migrations themselves run in one transaction, so a
failed migration rolls back. Watch boot logs for migration/health errors:

```sh
sg docker -c 'docker compose logs --tail=100 app'
```

`/readyz` now reports `schema: { applied, bundled, pending, newer }`. `pending`
should be 0 after startup; `newer` means the database was migrated by a newer
app and this build refused to start.

Activity/audit rows are pruned daily by the scheduler. `ACTIVITY_RETENTION_DAYS`
defaults to 90; set it to 0 to disable activity pruning. The same daily pass
prunes terminal deliveries (90 days), idempotency operations (7 days),
assistant messages (90 days), terminal proposals (30 days), and expired/revoked
sessions (30 days). Core reminder data is never pruned. JSON backups cap
activity at the newest 5,000 rows, and the upload/restore cap is
`BACKUP_MAX_MB` (default 25, range 1–128).

Verify `/healthz`, `/readyz`, login, `/api/bootstrap`, create/complete a task,
SSE reconnect, and the contract suite in a source checkout
(`pnpm --filter @morrow/server test`). Send a test push if push is enabled.

Rollback:

- Pin the previous image digests and keep the pre-upgrade JSON + volume
  snapshot until the new version has run for a full backup cycle.
- If the new app still runs, restore the pre-upgrade JSON through the normal
  dry-run → `confirm=RESTORE` flow, then roll the digests back.
- If the new app cannot start (or the migration is not backward compatible),
  stop the stack and restore the newest pre-migration `.bak` (or the volume
  snapshot) as shown in the restore drill, then start the old digests.
  Remove `morrow.db-wal` / `morrow.db-shm` before replacing the DB file.
- Migrations are forward-only; a downgrade without the pre-upgrade DB snapshot
  is not supported. The app refuses to open a database newer than its bundled
  migrations, so a rollback cannot silently run old code against a new schema.
  Re-check `/readyz` and the task list after rollback.

## TLS options

`APP_URL` must match the browser origin exactly; changing TLS scheme/host means
changing `APP_URL` and restarting. `TRUST_PROXY` must be an exact proxy CIDR
(never `true`/`*`); omit it when the app is reached directly.

### Public domain (recommended)

Point DNS A/AAAA at the host, forward TCP 80 and 443, and set:

```dotenv
SITE_ADDRESS=morrow.example.com
APP_URL=https://morrow.example.com
```

Caddy obtains and renews a public certificate automatically (HTTP-01 or
TLS-ALPN). It also sends HSTS at the edge; the app sends HSTS itself only when
`NODE_ENV=production` (the container image sets it). Do not put a TLS-terminating
proxy in front unless you also set `TRUST_PROXY` to that proxy’s exact CIDR and
forward `X-Forwarded-Proto`/`Host` correctly.

### Tailscale Serve (private, trusted HTTPS)

Tailscale Serve terminates TLS with a `*.ts.net` certificate trusted by iOS
and the other devices on the tailnet. That is a real secure origin: PWA
install and Web Push work, including on iOS 16.4+ Home Screen apps. The
service is tailnet-only; `tailscale serve` is not `tailscale funnel`, so no
public port is opened.

1. Enable **HTTPS certificates** for the tailnet in the Tailscale admin
   console (DNS page). The first `tailscale serve` may open a consent URL.
2. The repo ships the overlay, so no local compose file is needed:

   ```sh
   sg docker -c 'docker compose -f compose.yaml -f compose.tailscale.yaml up -d --build app'
   tailscale serve --bg --https=8443 http://127.0.0.1:3300
   tailscale serve status
   ```

   The overlay publishes the app on
   `127.0.0.1:${MORROW_LOOPBACK_PORT:-3300}` and disables bundled Caddy. It
   also clears `SITE_ADDRESS` for the app, because that value only describes
   Caddy.

   If Tailscale reports `Access denied: serve config denied`, run the command
   with `sudo`, or grant your login user operator rights once:
   `sudo tailscale set --operator=$USER`.

   Keep **8443** for Morrow so Caddy (or another front door) can own 443 for
   other sites. If Morrow is the only site on this host, use
   `--https=443` and omit the port from `APP_URL` instead. Pick the final
   origin before installing the PWA; changing origins means reinstalling the
   Home Screen app and re-subscribing to push.

3. In `.env`:

   ```dotenv
   APP_URL=https://<machine>.<tailnet>.ts.net:8443
   TRUST_PROXY=172.22.0.0/16
   ```

   Use the actual `edge` network subnet:

   ```sh
   sg docker -c 'docker network inspect morrow_edge --format "{{range .IPAM.Config}}{{.Subnet}}{{end}}"'
   ```

   The app runs in Docker, so even a host-level Tailscale Serve connection
   arrives as the `edge` gateway, not loopback. Trusting the edge subnet lets
   Fastify read the forwarded client address; `127.0.0.1/32` alone would make
   every client share the gateway address.

   Restart the app after changing `APP_URL`. The app still sends its own CSP,
   HSTS (production), and no-store headers when Caddy is bypassed.

4. Verify from another tailnet device:

   ```sh
   curl -fsS https://<machine>.<tailnet>.ts.net:8443/healthz
   ```

   Then open the same URL in Safari on the iPhone, add it to the Home Screen,
   launch it from the icon, and enable notifications from
   Settings → Devices & notifications. A Safari tab cannot subscribe to push.

5. `--bg` persists across Tailscale restarts. Remove one mapping with
   `tailscale serve --https=8443 off`, or clear all with
   `tailscale serve reset`.

Operational notes:

- **iOS does not support notification action buttons.** Safari ignores
  `Notification.actions`, so the Complete/Snooze buttons are not available in
  the notification shade. The notification still shows the title/body, sets
  the app badge, and opens the task on tap.
- **A notification may arrive with Tailscale off** because Apple delivers it
  through APNs, but tapping it or opening the app needs the VPN. Enable
  Tailscale's **VPN On Demand** for the tailnet so links open reliably away
  from home Wi-Fi.
- **`SITE_ADDRESS` must not be set for the app in this mode.** The overlay
  clears it. If you run the app without the overlay, unset it or ignore the
  boot warning; it only describes Caddy.
- **`TRUST_PROXY` must name the actual proxy hop.** For the Docker app behind
  a host-level Tailscale Serve, Caddy, or an external proxy, that is the
  `edge` network subnet (the app sees the Docker gateway). Use
  `127.0.0.1/32` only when the app itself runs on the host or with host
  networking. For a chain, add each exact CIDR, comma-separated.

### External TLS reverse proxy

Use `compose.external.yaml` when nginx, Traefik, HAProxy, or a host-level
Caddy terminates TLS:

```sh
sg docker -c 'docker compose -f compose.yaml -f compose.external.yaml up -d --build app'
```

The app is published on `127.0.0.1:${MORROW_LOOPBACK_PORT:-3300}` and Caddy is
disabled. Point the proxy at `http://127.0.0.1:3300`, forward `Host` and
`X-Forwarded-For/Proto`, and disable response buffering for
`/api/events` (SSE). Then set:

```dotenv
APP_URL=https://morrow.example.com
TRUST_PROXY=172.22.0.0/16
SITE_ADDRESS=
```

Use the actual `edge` subnet (or `MORROW_EDGE_SUBNET` if changed). The app
runs in Docker, so the peer is the edge gateway even for a host-level proxy;
`127.0.0.1/32` would only apply if the app itself ran on the host. Add each
extra hop in a chain, comma-separated.

If the proxy runs in another container, attach it to the `edge` network and
proxy to `app:3000`; the loopback publish is only for a host-level proxy.
Set `MORROW_PROXY_BIND=0.0.0.0` only if a remote proxy cannot reach loopback,
and firewall the port.

### Multiple sites and multiple origins

**One owner of 443 per host.** Run either the bundled Caddy or Tailscale Serve
on 443, or move one of them to a second port. Do not point both at 443.

**Additional services behind Caddy.** Add a site block to `Caddyfile`:

```caddyfile
other.example.com {
    reverse_proxy other-service:3000
}
```

Join the service to the compose `edge` network. Keep Morrow's strict CSP and
SSE rules scoped to its own block; other apps should define their own headers.
`SITE_ADDRESS` only names Caddy's primary site; additional hostnames are
Caddyfile edits, not env changes.

**Caddy plus a private Morrow front door.** If Caddy keeps 443 for other
sites and Tailscale Serve should also serve Morrow, use the loopback overlay:

```sh
sg docker -c 'docker compose -f compose.yaml -f compose.loopback.yaml up -d --build app caddy'
tailscale serve --bg --https=8443 http://127.0.0.1:3300
```

Caddy keeps its own `SITE_ADDRESS`; the overlay clears the app's copy so
`APP_URL` can name the Tailscale origin without a false warning. If the
Caddyfile still contains a Morrow site, that origin is an alternate access
path with its own session; remove or redirect it if you want Tailscale to be
the only way in.

**Additional services behind Tailscale Serve.** Serve one `*.ts.net` name per
node. Use a different HTTPS port (443, 8443, 10000) or `--set-path` for each
service. For multiple tailnet hostnames, use Tailscale Services or separate
nodes; Tailscale Serve does not do arbitrary SNI routing.

**Morrow at multiple origins.** Each origin is a separate install: its own
`__Host-` cookie, service worker, and push subscription. Access works, but
there is no shared login, and installing at two HTTPS origins produces
duplicate notifications. `APP_URL` remains the single canonical origin for
absolute links (digests, ntfy, external integrations); Web Push click URLs and
CalDAV hrefs are relative. All origins must be HTTPS in production because
`APP_URL=https` makes session cookies `Secure`. See `docs/PWA.md` ("Multiple
origins").

### LAN only, and iOS caveats

Plain HTTP on a LAN IP is not a supported production origin:

- The production image sets `NODE_ENV=production`, so session cookies are
  `Secure`; browsers will not store/send them over `http://192.168.x.x` and
  login will fail. `http://localhost` is exempt because it is a trustworthy
  origin; a phone is not localhost.
- Service workers, PWA install, Notification/Push, and Web Locks require a
  secure context. iOS Safari will not offer Home Screen push on plain HTTP;
  iOS 16.4+ also requires the app to be **installed to the Home Screen**.
- Self-signed certificates are not trusted by iOS for push; install the CA on
  the device or use a public/Tailscale certificate.

For a throwaway LAN lab, `docker compose -f compose.yaml -f compose.dev.yaml`
sets `NODE_ENV=development` and publishes `:3100` by default (`MORROW_DEV_PORT`);
tasks work on desktop, but treat install/push as unavailable. Set `APP_URL` to
the URL you actually browse there (for example `http://localhost:3100` or
`http://192.168.1.10:3100`). Same-origin mutations are accepted regardless;
`APP_URL` controls absolute links and the default VAPID subject; the PWA
manifest, CalDAV hrefs, and Web Push click URLs are relative. For real LAN/iOS
use, use a domain with Caddy, Tailscale Serve (`compose.tailscale.yaml`), or an
external TLS proxy (`compose.external.yaml`).

## AI-off deployments

AI is optional and off is first-class. Reminders, recurrence, scheduler, push,
backup/restore, search, and the PWA do not need OpenCode or a model.

To run without the sidecar:

```dotenv
OPENCODE_URL=
MCP_ENABLED=false
```

Keep `OPENCODE_PASSWORD` and `REMINDERS_MCP_TOKEN` non-empty (the generated
values are fine). Compose interpolates `${…:?}` for every service even when the
`opencode` service is not started; blanking them makes `docker compose` fail
before app/caddy start. The app will not start MCP for this deployment.

```sh
sg docker -c 'docker compose up -d caddy app'
```

The app logs “MCP not started: REMINDERS_MCP_TOKEN is not configured (AI-off is
supported)” only when the token is actually absent; with the kill switch path
it logs the disabled state instead. `/readyz` reports `opencode: disabled` when
`OPENCODE_URL` is blank. Do not publish `:3001` or `:4096`; when AI is enabled,
MCP stays on the internal `agent` network while outbound provider traffic uses
the sidecar-only `egress` network.

## Local AI harness (dev/field-test)

The harness is a dedicated pinned `2.2.5` sidecar for development. It is not
the production Compose sidecar: `compose.yaml` and `config/opencode.jsonc`
stay unchanged, and harness secrets stay out of `.env`.

```sh
OPENCODE_PASSWORD='<harness password>' REMINDERS_MCP_TOKEN='<harness token>' ./deploy/harness.sh
./deploy/harness.sh --status   # pin + /api/info check
./deploy/harness.sh --logs     # follow sidecar logs
./deploy/harness.sh --stop     # remove the container
```

Runtime state lives in `$HOME/.morrow-harness/` (outside the repo; never
committed). Override with `MORROW_HARNESS_DIR=` and `MORROW_HARNESS_PORT=`
(4098). The launcher refuses to start when the image is not 2.2.5 and waits
for `http://127.0.0.1:4098/api/info`.

Run the app against it (localhost only; the app rejects wildcard MCP hosts):

```sh
export DATABASE_PATH=/tmp/morrow-harness/app.db
export SECRETS_DIR=/tmp/morrow-harness/secrets
export SETUP_TOKEN=harness-setup-token
export PORT=4605
export APP_URL=http://127.0.0.1:4605
export OPENCODE_URL=http://127.0.0.1:4098
export OPENCODE_PASSWORD='<harness password>'
export OPENCODE_WORKSPACE=/workspace
export MCP_ENABLED=true
export MCP_HOST=127.0.0.1
export MCP_PORT=3001
export REMINDERS_MCP_TOKEN='<harness token>'
pnpm -r build
node apps/server/dist/index.js
```

The sidecar uses host networking so it reaches the app MCP at
`127.0.0.1:3001`. On Docker Desktop use `host.docker.internal` and a
specific non-wildcard `MCP_HOST` instead. Stop/cleanup: `./deploy/harness.sh
--stop`, then delete `/tmp/morrow-harness` if the scratch DB is no longer
needed. No secrets, auth files, or `.morrow-harness` contents belong in the
repo.

Verify with the contract suite, the smoke prompts, and the stub provider
(spends no tokens):

```sh
OPENCODE_URL=http://127.0.0.1:4098 OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
  OPENCODE_WORKSPACE=/workspace MCP_URL=http://127.0.0.1:3001/mcp \
  REMINDERS_MCP_TOKEN="$REMINDERS_MCP_TOKEN" pnpm --filter @morrow/agent contract
APP_URL=http://127.0.0.1:4605 APP_PASSWORD='...' node deploy/harness-smoke.mjs
# With the no-token stub provider instead of a real model, run the phases
# separately (selecting stub/pong then stub/toolsmoke in Settings → AI):
#   node deploy/harness-smoke.mjs --live-only
#   node deploy/harness-smoke.mjs --tool-only
node packages/agent/test/stub-provider.mjs
```

## AI provider operations (M4.1)

Provider credentials are managed in **Settings → AI → Providers** or through
`/api/providers`. The app writes a 0600 key file and an OpenCode overlay; the
sidecar performs all model traffic. `docs/API.md` has the endpoint contract and
`docs/MCP.md` has the overlay/mount rules.

Log in and refresh step-up once per shell before the commands below:

```sh
BASE=https://morrow.example.com
JAR=/tmp/morrow.cookies
read -rsp 'Morrow password: ' PASS; echo
curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d "{\"username\":\"owner\",\"password\":\"$PASS\"}" "$BASE/api/login" >/dev/null
curl -fsS -b "$JAR" -X POST -H 'content-type: application/json' \
  -d "{\"password\":\"$PASS\"}" "$BASE/api/auth/password" >/dev/null
unset PASS
```

Step-up lasts 10 minutes; re-run the second curl if a mutation returns
`403 step_up_required`.

### Rotate or revoke a provider key

Normal rotation keeps the old key valid until the new one is proven:

1. Create a second key at the provider console.
2. Rotate it into Morrow (below), test, then revoke the old key at the provider.
3. If the key is **compromised**, reverse the order: revoke it at the provider
   first, then rotate in Morrow. Expect a brief assistant outage.

```sh
PROVIDER_ID=openai
read -rsp 'New provider key: ' NEWKEY; echo
jq -nc --arg k "$NEWKEY" '{key:$k}' \
  | curl -fsS -b "$JAR" -X PATCH -H 'content-type: application/json' \
      --data-binary @- "$BASE/api/providers/$PROVIDER_ID/rotate" \
  | jq '{providerId:.provider.providerId,status:.provider.status,keyLast4:.provider.keyLast4}'
unset NEWKEY
```

The old key file is overwritten, `lastTest*` is cleared, `rev` increments, and
the overlay is re-rendered. Test and confirm the projection:

```sh
curl -fsS -b "$JAR" -X POST "$BASE/api/providers/$PROVIDER_ID/test" \
  | jq '{ok:.test.ok,code:.test.code,httpStatus:.test.httpStatus,latencyMs:.test.latencyMs}'
curl -fsS -b "$JAR" "$BASE/api/providers" \
  | jq '{overlay,providers:[.providers[]|{providerId,status,keyPresent,keyLast4,lastTestOk,lastError}]}'
```

Then revoke the old key at the provider. If the test fails with `invalid_key`,
the provider has already rejected the new key or the paste was wrong; rotate
again. `degraded` with “key file is missing” means the file was removed or the
volume/mount changed; “does not match its fingerprint” means it was edited by
hand. Rotate in either case.

To remove a provider instead of rotating it:

```sh
curl -fsS -b "$JAR" -X DELETE "$BASE/api/providers/$PROVIDER_ID" | jq
```

This soft-deletes the row, deletes the key file, re-renders the overlay, and
returns `clearedModel` if `ai.model` belonged to that provider. Choose another
model in Settings → AI if it was the active one.

Audit check (the key is never present):

```sh
curl -fsS -b "$JAR" "$BASE/api/activity?limit=100" \
  | jq '[.activities[] | select(.action|startswith("provider.")) | {action,entityId,summary,createdAt}]'
```

### Overlay out of sync

Symptoms: a provider is saved but the sidecar does not list its models;
`status` is `degraded`; `GET /api/providers` shows `overlay.present: false`; or
a removed provider still appears to the assistant.

```sh
# 1. What the app thinks it has.
curl -fsS -b "$JAR" "$BASE/api/providers" \
  | jq '{enabled,overlayPath,overlay,providers:[.providers[]|{providerId,status,keyPresent,lastError}]}'

# 2. The overlay is valid JSON and only references keys (never prints a key).
sg docker -c 'docker compose exec -T app node -e "const fs=require(\"fs\");const d=JSON.parse(fs.readFileSync(\"/data/opencode-providers/global.json\",\"utf8\"));console.log(d.provider && Object.keys(d.provider))"'

# 3. Key files are 0600 and owned by the app user; the bundled sidecar is root.
sg docker -c 'docker compose exec -T app sh -c "stat -c \"%a %U:%G %n\" /data/secrets/providers/*.key"'
sg docker -c 'docker compose exec -T app id'
sg docker -c 'docker compose exec -T opencode id'
```

`overlay.present: false` with providers configured means the app could not
write `PROVIDER_OVERLAY_PATH`: check that `/data/opencode-providers` exists, is
writable by UID 10001, and is not shadowed by a read-only mount. The one-shot
`providers-init` service prepares the shared volumes; re-run it if ownership is
wrong:

```sh
sg docker -c 'docker compose run --rm providers-init'
```

A valid JSON overlay with the right IDs but no effect in the sidecar usually
means:

- the sidecar does not mount `opencode-providers` at the path in
  `OPENCODE_CONFIG`, or `OPENCODE_CONFIG` points somewhere else;
- the sidecar is not using `/workspace` as its working directory, so the
  workspace project config and overlay are not merged;
- a single-file bind mount is pinned to the old inode after an atomic rename;
- the sidecar runs non-root as a UID other than 10001 and cannot read the 0600
  key file (the bundled sidecar runs as root and can);
- the sidecar watcher did not reload.

Fix the mount/UID, then restart the app (startup reconciliation re-renders when
rows exist) and the sidecar:

```sh
sg docker -c 'docker compose restart app'
sg docker -c 'docker compose restart opencode'
```

Do not hand-edit the overlay while the sidecar is running. If the database has
**zero** provider rows, startup reconciliation deliberately does not touch
`/data`; a stale overlay can survive a DB-only restore. In that case stop the
sidecar, write a valid empty overlay, and start it again:

```sh
sg docker -c 'docker compose stop opencode'
sg docker -c 'docker compose exec -T app node -e "const fs=require(\"fs\");fs.writeFileSync(\"/data/opencode-providers/global.json\",JSON.stringify({\"\$schema\":\"https://opencode.ai/config.json\",provider:{}},null,2)+\"\\n\")"'
sg docker -c 'docker compose start opencode'
```

If a provider row exists but its key file is gone after a volume change,
rotate the key. If the provider should no longer exist, delete the row; both
paths re-render the overlay.

### Local-model networking (Ollama / LM Studio)

The app container runs the probe; the sidecar container runs inference. Both
need a route to the model host, and `ALLOW_PRIVATE_PROVIDER_URLS=true` must be
set for the app. Cloud metadata endpoints stay blocked even with the flag.

Ollama listens on loopback by default. Bind it to the host's Docker-facing
address (or all interfaces on a trusted host):

```sh
sudo systemctl edit ollama
# [Service]
# Environment="OLLAMA_HOST=0.0.0.0:11434"
sudo systemctl restart ollama
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null && echo ollama-ok
```

LM Studio: enable **Serve on Local Network** (Developer tab) and keep the port
at 1234. Do not expose either service to the public internet; restrict the
firewall to the Docker bridge/agent subnets:

```sh
sg docker -c 'docker network inspect morrow_agent --format "{{range .IPAM.Config}}{{.Subnet}}{{end}}"'
# ufw example for a trusted 172.x Docker subnet:
# sudo ufw allow from 172.18.0.0/16 to any port 11434 proto tcp
```

Add the host gateway to **both** containers (Docker Desktop provides it; Linux
needs this mapping), then recreate them:

```yaml
services:
  app:
    extra_hosts: ["host.docker.internal:host-gateway"]
  opencode:
    extra_hosts: ["host.docker.internal:host-gateway"]
```

```dotenv
ALLOW_PRIVATE_PROVIDER_URLS=true
```

```sh
sg docker -c 'docker compose up -d app opencode'
```

Use `http://host.docker.internal:11434/v1` (Ollama) or
`http://host.docker.internal:1234/v1` (LM Studio), with a model ID such as
`qwen3:8b`. `127.0.0.1`/`localhost` inside a container is the container itself,
not the host.

Verify the probe path from the app container without printing any key:

```sh
sg docker -c 'docker compose exec -T app node -e "fetch(\"http://host.docker.internal:11434/api/tags\").then(r=>console.log(r.status)).catch(e=>{console.error(e.message);process.exit(1)})"'
```

The sidecar needs the same DNS name; if the app can reach it but the assistant
cannot, check the sidecar's `extra_hosts`, the host firewall, and the sidecar
logs. Compose attaches `opencode` to the internal `agent` network (MCP) **and**
a dedicated non-internal `egress` network for model traffic. `egress` is not
shared with the app or Caddy, and 4096/3001 remain unpublished. Do not remove
`internal: true` from `agent`; add host routes/firewall rules to `egress`
instead.

Prove provider inference from the sidecar itself (an app-side
`GET /api/providers/:id/test` only proves the app's probe path). This reads the
key file inside the sidecar and calls the provider without printing the key:

```sh
sg docker -c 'docker compose exec -T opencode node -e "const fs=require(\"fs\");const k=fs.readFileSync(\"/data/secrets/providers/openai.key\",\"utf8\").trim();fetch(\"https://api.openai.com/v1/models\",{headers:{authorization:\"Bearer \"+k}}).then(async r=>{console.log(\"provider-http\",r.status);process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"'
```

Then send one short assistant prompt in the app and check
`GET /api/assistant/status` reports `ready`/`connected`; `docker compose logs
--tail=50 opencode` should show the provider request, not a DNS/TLS error. For
an OpenAI-compatible/Ollama provider, substitute its base URL and model ID. If
the direct call works but the assistant does not, the overlay/model selection
is wrong; if the direct call fails with DNS/connection errors, inspect the
sidecar's `egress` network and host firewall.

If Ollama is a Compose service instead, attach it to the `agent` network and use
`http://ollama:11434/v1`; single-label/service names are treated as private and
still need the flag. Pull models before starting, or give that service a
separate egress network for downloads.

### Restore re-entry

JSON backups deliberately exclude `provider_credentials` and
`SECRETS_DIR/providers`, and `ai.enabled`/`ai.model` are not in the settings
allowlist. Provider API keys are therefore **not recoverable** from a JSON
backup. Do not add them to “make restore easier.”

| Restore source | Provider rows | Key files | Overlay | Re-entry |
|---|---|---|---|---|
| JSON backup (`morrow.backup`) | gone | unchanged volume files (orphans) | possibly stale | Re-add each API-key provider, test, discover, choose a model, enable the assistant. Delete stale overlay if zero rows. |
| Volume snapshot (DB + `app-data` + `opencode-secrets` + `opencode-providers`) | restored | restored with DB | restored | Restart app and sidecar; verify status/key fingerprint. Rotate any key revoked at the provider after the snapshot. |
| DB-only restore / fresh DB | gone | may remain orphaned in `opencode-secrets` | stale | Same as JSON: re-add, test, choose model; remove stale overlay. |
| Fresh host | gone | gone | gone | Re-add API keys; redo OAuth in the sidecar CLI. |

If you replaced the named volumes, run the one-shot helper before starting the
app so UID 10001 can write the key and overlay volumes:

```sh
sg docker -c 'docker compose run --rm providers-init'
```

After any restore, sessions are revoked. Log in again, refresh step-up, then:

```sh
curl -fsS -b "$JAR" "$BASE/api/providers" | jq '.providers | length'
```

Zero is expected after a JSON restore. Re-add each provider from Settings (or
`POST /api/providers`), run **Test** and **Refresh models**, select a
tool-capable model under **Chat model**, and turn the assistant on. Confirm
`GET /api/assistant/status` reports `ready` and `GET /api/providers` shows
`overlay.present: true`. Restart the sidecar only if the overlay is correct but
not loaded. If the sidecar volumes were also lost, re-run
`docker compose exec -it opencode opencode auth login` for OAuth providers;
Morrow API-key providers do not need it.
