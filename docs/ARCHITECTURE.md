# Architecture

TLS front door (bundled Caddy by default; Tailscale Serve or an external proxy
via compose overlays) → App server :3000 (REST + SSE + static PWA, SQLite +
scheduler + Web Push + JSON backup, internal MCP :3001) ←
OpenCode sidecar :4096 over the private `agent` network, with a separate
non-internal `egress` network for provider inference. The `packages/agent`
shim owns the OpenCode client, prompts, policy, quotas, and event fan-out. The
PWA is list-first (Today/Upcoming/Inbox + lists) with an assistant panel and
command palette, never a chat home. AI-off is first-class: reminders, push,
offline, and backup work without the sidecar.

## Components

- **TLS front door:** bundled Caddy is the default (ports 80/443, reverse
  proxy to `app:3000`, `flush_interval -1` + no `encode` on SSE
  (`/api/events`, assistant stream), CSP/HSTS/nosniff/referrer-policy matching
  the app helmet policy). `compose.tailscale.yaml` serves the app over a
  private `*.ts.net` certificate with Caddy disabled; `compose.external.yaml`
  publishes the app on loopback for nginx/Traefik/host Caddy. In every mode
  the app sees an exact `TRUST_PROXY` hop list and `APP_URL` is the canonical
  origin.
- **App server (Node 22 + Fastify + better-sqlite3):** owns auth (open
  first-run claim or optional setup token, Argon2id, Strict cookies, CSRF,
  step-up), domain data (lists/tasks with ETag
  + `If-Match` + idempotency), scheduler (15s tick, lease, enqueue/claim/send,
  quiet hours, catch-up digest, at-least-once with `deliveryId` dedupe),
  Web Push (VAPID, TTL/urgency/Topic, 404/410 disable, 429/5xx backoff),
  JSON backup/restore (allowlist, SHA-256/HMAC, 14/8/6 retention, nightly via
  scheduler lease, temp-DB restore), static PWA, SSE, and the internal MCP
  server (`:3001`, agent-network only, bearer token, Host/Origin allowlist).
- **OpenCode sidecar (pinned `ghcr.io/anomalyco/opencode:2.2.5`):** `serve`
  on `:4096`, private `agent` network for MCP, separate non-internal `egress`
  network for cloud provider traffic, Basic auth, no published port. Gets only
  the app's `reminders_*` MCP tools (deny-by-default permissions + deny
  policies for shell/edit/read/webfetch/websearch). Config from
  `config/opencode.jsonc` (prod, `/workspace`) or harness config; providers
  via overlay + `SECRETS_DIR/providers/*.key` (0600, same absolute path in
  both containers). AI-off: blank `OPENCODE_URL` + `MCP_ENABLED=false`.
- **Product modules (v0.2+):** `tags`, `subtasks`, `attachments`, `captureTokens`
  (Shortcuts/email webhook), `caldav` (VEVENT feed + VTODO CalDAV collection),
  `ntfy`, and `digests` (morning/weekly briefs). `access.ts` is the single
  source of truth for
  owner-or-shared-list task access; `list_members` is duplicated into backup
  schema v2.
- **PWA (React 19 + Vite + TanStack):** installable desktop/mobile, offline
  shell (precached), IndexedDB outbox (create/complete/snooze only, FIFO, Web
  Locks, replay before bootstrap), TanStack Query persistence, push service
  worker (`showNotification`, `notificationclick` deep link, `deliveryId`
  dedupe, Badging API), SSE with `Last-Event-ID` replay, delivery ledger
  (“Next … · N devices · Last sent …”), TaskDetail reminder control
  (at-due / -10m / -1h / custom offset + all-day time).
- **Scheduler + time:** `packages/shared` owns time/recurrence/reminder
  derivation. `rrule` generates floating locals from `dtstart_local`; Temporal
  `compatible` resolves DST (gap 02:30→03:30, fold first 01:30). Timed:
  `remind_at = dueAt + offset`; all-day: `dueDate + reminder_time_local`
  (default 09:00) in task/user timezone → UTC + offset; recurring: first
  occurrence → `next_occurrence_at` (real instant even for all-day) +
  `remind_at = occurrence + offset`. Edits recompute and cancel stale pending
  deliveries; timezone changes re-resolve; the scheduler also has due-date
  fallbacks for legacy rows.

## Data flow

Browser → TLS front door (Caddy / Tailscale Serve / external proxy) → App
(`/api/*`, `/events`, static). Scheduler tick (lease):
enqueue due (including `due_at`/`due_date` fallbacks) → claim (lease/token) →
send (outside TX, mark `sent` only with claim token) → ledger activity. Backup
tick (same lease, daily): `runBackupNow()` → JSON + retention + `/api/backup/runs`.
Assistant: browser → app (`/api/assistant/*`, `/api/proposals`, `/api/model`)
→ shim → sidecar (`/api/event` subscribe, `session.prompt`, `session.wait`) →
MCP tools (`reminders_*`) → TaskStore (same validation/audit/policy as REST)
→ SSE fan-out to browser. No OpenCode URL/password/provider keys in the browser.

## Database upgrades

- `packages/db` owns the schema and the ordered migrations. `openDatabase()`
  runs Drizzle migrations before the app server accepts traffic. Drizzle wraps
  every pending migration in one transaction, so a failed migration rolls back
  to the previous schema instead of leaving a half-upgraded database.
- Before applying pending migrations, the app writes a raw SQLite snapshot next
  to the DB: `<db>.pre-migration-<timestamp>-<id>.bak`, using `VACUUM INTO`
  (consistent in WAL mode). The newest 3 snapshots are kept. This is the
  rollback point for a bad upgrade; the nightly JSON backup is separate.
- The app refuses to start when the database is ahead of the app build (for
  example, an app rollback after a newer migration). The error names the
  applied and bundled migration watermarks. Restore the pre-upgrade `.bak` or
  upgrade the app; never run an older app against a newer schema.
- After migrations, `PRAGMA foreign_key_check` must pass or startup fails.
  `/readyz` reports `schema: { applied, bundled, pending, newer }`.
- Core data is never dropped by a migration: users, lists, tasks, completions,
  tags, subtasks, list members, settings, and recurrence exceptions.
  `packages/db/test/migration-upgrade.test.ts` creates a database at every
  migration prefix, inserts core rows, upgrades to current, and asserts the
  rows survive. Separate tests prove failed-migration rollback and snapshot
  retention.
- Activity is the fastest-growing table because it carries before/after JSON.
  The scheduler prunes rows older than `ACTIVITY_RETENTION_DAYS` (default 90;
  0 disables) once per day. JSON backups independently cap activity at the
  newest 5,000 rows, so old audit history cannot push a backup past the restore
  upload cap. The activity API supports `order=desc`, backed by an
  `(entity_id, action, seq)` index, so latest-history/undo does not scan the
  whole log.
- Operational logs are bounded by the same daily retention pass: terminal
  deliveries 90 days, idempotency operations 7 days, assistant messages 90
  days, terminal proposals 30 days, and expired/revoked sessions 30 days.
  Core reminder data is never pruned.
- The backup upload/restore cap is `BACKUP_MAX_MB` (default 25, range 1–128);
  raise it for a long-lived workspace whose core JSON export legitimately
  exceeds the default.
- JSON backups carry `schemaVersion`; older versions are accepted with optional
  fields, newer versions are rejected. Restore applies migrations to a temp DB,
  runs `integrity_check` + `foreign_key_check`, then swaps the file atomically.
- Rollback: stop the stack, replace `/data/morrow.db` (and remove
  `morrow.db-wal` / `morrow.db-shm`) with the pre-migration `.bak`, then start
  the previous app image.

## Deployment

`compose.yaml`: Caddy + app (`/data` volume, `MCP_HOST` on agent IP, non-root)
+ OpenCode (workspace + prompts read-only, providers overlay + keys read-only
subpath, config/data/state/cache volumes). `compose.tailscale.yaml` and
`compose.external.yaml` disable Caddy and publish the app on
`127.0.0.1:${MORROW_LOOPBACK_PORT:-3300}` for a private Tailscale or external
TLS front door. `compose.dev.yaml` exposes :3100 by default
(`MORROW_DEV_PORT`).
`Dockerfile.app` is multi-stage (frozen lockfile, fatal builds, pruned prod
deps, non-root, only `dist` + migrations + prompts + PWA + prod modules).
`deploy/init-env.sh` generates 0600 secrets + VAPID + dirs + prod config.
Fresh clone → `cp .env.example .env` → `./deploy/init-env.sh` →
`docker compose up -d --build` → setup/login works. Pin all images by digest
before calling it production.
