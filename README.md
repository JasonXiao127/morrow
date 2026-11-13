# Morrow v0.3 — self-hosted reminders PWA

Self-hosted reminders that keep up, with an optional assistant that proposes
and never surprises. List-first and useful with AI off: lists/tasks, due dates,
recurrence, Today/Upcoming/Inbox/Calendar, tags, subtasks, attachments,
capture, reminders with Web Push + ntfy, morning/weekly briefs, offline
create/edit/complete/snooze/skip/delete, encrypted JSON backup/restore,
multi-account support with shared lists, CalDAV + an iCalendar feed,
email/Shortcuts capture, and an assistant that is honest about its state.

## Public evaluation snapshot

This repository is the first public evaluation snapshot at **v0.3.0** (see
`package.json`). Treat it as reviewable self-hosted code, not a production-ready
release. The AI assistant is optional, beta, and owner-only; reminders,
proposals, undo, offline use, push, CalDAV, capture, and backup/restore all work
with AI off. The manual release gates below — real-device push, an age-encrypted
restore drill, and a physical CalDAV client — are not all proven on this
snapshot. Licensed under the [MIT license](LICENSE). Start with
[`AGENTS.md`](AGENTS.md) for the code map and invariants and
[`docs/ROADMAP.md`](docs/ROADMAP.md) for non-binding candidate work.

## Repository hygiene

No `.env`, SQLite database, backup archive, attachment, or provider key file is
tracked in this repository. `.gitignore` excludes `.env`, `data/`, `backups/`,
`*.db`/`*.db-wal`/`*.db-shm`, `secrets/`, and generated build output;
`.env.example` is the only environment template. A fresh clone creates a new
empty database on first start — there is no seed or demo database. Run
`./deploy/init-env.sh` to generate local secrets into an ignored `.env`, and
never commit that file.

## Quickstart (first boot)

1. `cp .env.example .env` — zero-config local pair is `SITE_ADDRESS=:80` +
   `APP_URL=http://localhost` (plain HTTP). For local HTTPS use
   `SITE_ADDRESS=localhost` + `APP_URL=https://localhost` (Caddy internal CA);
   for a real domain use `SITE_ADDRESS=morrow.example.com` +
   `APP_URL=https://morrow.example.com`.
2. `./deploy/init-env.sh` — generates 0600 `SESSION_SECRET`, `SETUP_TOKEN`
   (only used with `SETUP_MODE=token`), `OPENCODE_PASSWORD`,
   `REMINDERS_MCP_TOKEN`, VAPID keys
   (`npx web-push generate-vapid-keys` shape), sane `VAPID_SUBJECT`, host data
   dirs (0700), and ensures `config/opencode.jsonc` exists (committed, no
   secrets). Never commit `.env`, `data/`, or provider keys.
3. `docker compose up -d --build` — Caddy (80/443) + app (3000, MCP 3001 on
   the private `agent` network only) + OpenCode 2.2.5 sidecar (4096, never
   published; `agent` is internal for MCP, `egress` is a dedicated outbound
   network for cloud model inference). `docker compose config` stays valid.
4. Open `$APP_URL`; with no users, `/` redirects to `/setup`. By default the
   first visitor creates the owner account (password ≥12 chars + timezone).
   For an internet-facing host, set `SETUP_MODE=token` before exposing the
   port. Setup is atomic; afterwards it returns `409 setup_complete`.
5. Create a due-date task — the reminder arms automatically (`dueAt` or
   `dueDate + reminder_time_local`, offset supported). The scheduler ticks
   every 15s; the ledger shows “Next … · N devices · Last sent …”.
6. Enable notifications (Settings → Devices, user gesture required) and send a
   test ping. Push needs HTTPS (except localhost) and VAPID keys; iOS needs an
   installed Home Screen app on 16.4+.
7. Backups: the app scheduler runs nightly JSON exports automatically
   (`/api/backup/runs`, 14 daily + 8 weekly + 6 monthly). Set
   `BACKUP_AGE_RECIPIENT` for real age-encrypted `.json.age` exports and
   `BACKUP_AGE_IDENTITY` (or `SECRETS_DIR/backup_age_identity`) to restore
   them. `deploy/backup-cron.sh` is only a secondary SQLite snapshot
   (stopgap). Run a restore drill: export → wipe temp DB → import → verify.
   Live restore enters a process-wide maintenance gate: mutating API calls get
   retryable `503` + `Retry-After`, `/readyz` reports `maintenance`, scheduler
   ticks drain, and the DB file is fsynced then atomically renamed before the
   scheduler/assistant/MCP are rebound. Sessions, capture/CalDAV/MCP tokens,
   proposals, operations, and SSE cursors are invalidated.
8. Integrations (Settings → Integrations): create a **capture** token for
   Shortcuts/Siri/voice and point an email webhook at
   `POST /api/inbound/email?token=…`. Email retries are deduped by
   `Message-ID` (Mailgun/SendGrid) or an `Idempotency-Key` header; quick
   capture also honors `Idempotency-Key`. Create a separate **CalDAV** token
   and use that as the CalDAV password for Apple Calendar / Thunderbird /
   DAVx5; the calendar feed is `GET /api/calendar.ics?token=…` with the same
   CalDAV token. Capture and CalDAV credentials are not interchangeable.
9. Assistant (optional, beta): connect a model (provider env vars or
   `docker compose exec -it opencode opencode auth login`), select a
   tool-capable model in Settings → AI. With AI off the reminders core is
   fully useful; the agent only writes single items with undo and proposes
   bulk/delete changes.

## Deployment front doors

Morrow is proxy-agnostic: any TLS terminator works if it forwards `Host` and
`X-Forwarded-For/Proto` and supports SSE. `APP_URL` is the canonical HTTPS
origin; `TRUST_PROXY` is the exact proxy CIDR (comma-separated for a chain).

| Front door | Command | Notes |
| --- | --- | --- |
| Bundled Caddy (default) | `docker compose up -d --build` | Caddy owns 80/443 and proxies `app:3000` |
| Tailscale Serve | `docker compose -f compose.yaml -f compose.tailscale.yaml up -d --build app` | App on `127.0.0.1:3300`; `tailscale serve --bg --https=8443 http://127.0.0.1:3300`; set `APP_URL=https://<machine>.<tailnet>.ts.net:8443` and `TRUST_PROXY` to the `edge` subnet (inspect `morrow_edge`) |
| External TLS proxy | `docker compose -f compose.yaml -f compose.external.yaml up -d --build app` | App on `127.0.0.1:${MORROW_LOOPBACK_PORT:-3300}`; point nginx/Traefik/host Caddy at it; set `TRUST_PROXY` to the `edge` subnet |
| Caddy + private Tailscale | `docker compose -f compose.yaml -f compose.loopback.yaml up -d --build app caddy` | Caddy keeps 80/443 for other sites; Morrow is published on loopback for Tailscale/another proxy |
| Dev | `pnpm dev` | App on `:3100`; keep Caddy in the loop; not a production origin |

The Tailscale/external overlays disable bundled Caddy and clear
`SITE_ADDRESS` for the app. Choose one owner of 443 per host: keep Caddy for
public/LAN hostnames and put private Morrow on 8443, or let Tailscale Serve own
443 when Morrow is the only site. See `docs/RUNBOOK.md` ("TLS options") for the
full matrix, multi-site Caddy notes, and multi-origin behaviour.

## Layout

- `compose.yaml` — Caddy + app + OpenCode 2.2.5 (pinned image; internal
  `agent` network for MCP plus a dedicated non-internal `egress` network for
  provider inference; `providers/`-only secret mount).
- `compose.tailscale.yaml` / `compose.external.yaml` — production overlays
  that disable Caddy and publish the app on loopback for Tailscale Serve or
  another TLS proxy. `compose.loopback.yaml` keeps Caddy for other sites and
  publishes the app for a host-level proxy. `compose.dev.yaml` — dev override
  (`pnpm dev`, app on :3100 by default).
- `Caddyfile` — proxy to `app:3000`, `flush_interval -1` + no `encode` on SSE;
  add site blocks there for additional hostnames.
- `Dockerfile.app` — multi-stage (`node:22-bookworm-slim`), frozen lockfile,
  fatal builds, non-root, only runtime files, `/healthz` healthcheck. Pin base
  + Caddy + OpenCode images by digest before calling it production.
- `deploy/` — `init-env.sh` (secrets, VAPID, dirs, prod config),
  `healthcheck.sh`, `backup-cron.sh` (secondary snapshot), `harness.sh`
  (local 2.2.5 sidecar on 4098, host networking, stub durable).
- `config/opencode.jsonc` — production agent (committed, no secrets);
  `config/opencode.harness.jsonc` — local harness (127.0.0.1:3001 MCP).
- `apps/server` — Fastify + SQLite + scheduler + push/ntfy + backup + MCP
  :3001 + CalDAV/ICS + account/list sharing + capture/CalDAV tokens.
- `apps/web` — React PWA (Today/Upcoming/Inbox/Calendar, tags, subtasks,
  attachments, capture, TaskDetail with reminder offset/recurrence-end
  control, offline outbox, SSE, delivery ledger).
- `packages/shared` — time/recurrence/reminder derivation (DST via Temporal
  `compatible`, offset applied, timezone re-resolve).
- `packages/agent` — OpenCode shim (MCP tools, policy, proposals, honest
  errors + vision).
- `docs/` — `ARCHITECTURE.md`, `API.md`, `MCP.md`, `AGENT.md`, `RUNBOOK.md`,
  `PWA.md`, `SECURITY.md`, `ROADMAP.md`.

## Commands

- `pnpm dev` — compose with dev override (app on :3100 by default;
  override with `MORROW_DEV_PORT`). Point `APP_URL` at the URL you browse
  (e.g. `http://localhost:3100`); same-origin requests work either way, but
  absolute links use `APP_URL`.
- `pnpm typecheck` — all workspaces.
- `pnpm test` — Vitest unit/integration (625 tests: server 395, web 107, shared 56, db 39, agent 28).
- `pnpm e2e` / `./e2e.sh` — fresh DB + Node API (28 pass, 0 pending) + real
  Playwright browser gate (desktop + mobile 390px, reminder firing via ledger,
  AI-off honesty, keyboard path, tags/subtasks/attachments/calendar/settings).
  Artifacts in `/tmp/morrow-playwright`.
- `OPENCODE_URL=... pnpm --filter @morrow/agent contract` — pinned 2.2.5
  sidecar contract (11 `reminders_*` tools, no shell/file/web).
- `docker compose config` — validate the bundle.
- `docker compose -f compose.yaml -f compose.tailscale.yaml config` (or
  `compose.external.yaml`) — validate a non-Caddy front door.
- `./deploy/healthcheck.sh` — probe `/healthz` + `/readyz` (OpenCode probe
  uses Basic auth; `http-401` means missing `OPENCODE_PASSWORD`).

## Local AI harness (optional)

Field-test against a dedicated pinned OpenCode 2.2.5 sidecar without touching
production: `config/opencode.harness.jsonc` + `./deploy/harness.sh`
(`--status`/`--logs`/`--stop`), app on `:4605` with MCP on `127.0.0.1:3001`,
smoke via `node deploy/harness-smoke.mjs` (“Say pong”, create/undo, forced
error shows real provider message, survives reload), no-token stub via
`node packages/agent/test/stub-provider.mjs` (durable across restarts). See
`docs/AGENT.md` (“Local harness”) and `docs/RUNBOOK.md`. Never reuse the
OpenChamber 2.2.4 server or `*-free` models for acceptance.

## v0.3 scope and limits

Shipped in v0.3:

- **Security foundation:** owner/member roles, scoped capture and CalDAV
  tokens, authorization checks on every shared/list/attachment route,
  step-up-gated destructive actions, restore maintenance gating (including
  WebDAV writes), log redaction, and an allowlisted backup/restore pipeline.
- **Accounts + sharing:** the first account is the workspace owner; additional
  private accounts (username login) are members with per-list membership.
  Members can see/edit tasks in shared lists. Quiet hours use each recipient's
  timezone, and one-off all-day reminders fire at each member's own local
  wall-clock time; recurring series keep the owner's series anchor in v0.3.
  Each account can change its own timezone in Account settings. Global settings,
  backups, users, providers, MCP, and the assistant are owner-only; members do
  not see another account's activity feed.
- **Organisation:** tags, subtasks, priority editing, recurrence end
  (date/count), list colours, month calendar, search, command palette, trash.
- **Attachments:** up to 20 files per task, 10 MiB each, stored under
  `ATTACHMENTS_DIR` (default next to the database).
- **Delivery:** Web Push and ntfy, quiet hours, morning brief, weekly review,
  delivery ledger. Push still requires HTTPS (except localhost), VAPID keys,
  and a user gesture; iOS needs an installed Home Screen app on 16.4+.
- **Calendar:** read-only VEVENT feed (`/api/calendar.ics`), a separate VTODO
  feed (`/api/tasks.ics`), and CalDAV VTODO collections with
  principal/calendar discovery, PROPFIND, calendar-query/multiget,
  sync-collection, collection management, MOVE, shared-list access, timezone
  output, recurrence exceptions, read-only attachments, and ICS file import.
  The legacy all-tasks `morrow` alias stays readable but rejects writes. See
  [`docs/CALDAV.md`](docs/CALDAV.md) for the support matrix.
- **Capture:** Shortcuts/Siri/voice via a personal capture token, email
  webhook ingestion, and a PWA share target. The deterministic parser handles
  dates, times, `#p1`–`#p4`, `@list`, and simple recurrence. Retries are
  idempotent via provider `Message-ID` or `Idempotency-Key`.
- **Backups:** schema 3 JSON includes lists/members, tags, task-tag links,
  subtasks, completions, and recurrence exceptions. Set
  `BACKUP_AGE_RECIPIENT` to write real age-encrypted `.json.age` exports.
  Restore requires `BACKUP_AGE_IDENTITY` for encrypted files, forces a password
  reset, and push re-subscribe. Attachment bytes and the CalDAV journal are
  deliberately outside the JSON backup.

Still intentionally not included:

- **Full E2EE.** Server-side reminders, push, CalDAV, email ingestion, search,
  and the AI assistant need readable task data. Encrypted backups are the
  supported at-rest protection; whole-app E2EE would require moving scheduling
  and notifications to clients.
- **Native mobile apps / Electron.** The installable PWA is the client.
- **IMAP polling.** Email ingestion uses a webhook (Mailgun/SendGrid/Cloudflare
  Email Workers).
- **Attachments in JSON backups.** Binary files are excluded; include
  `ATTACHMENTS_DIR` in your volume backup.
- **CRDT/conflict-free offline merges, month-grid drag rescheduling, and full
  conflict-free sharing.** The offline outbox now covers create, ordinary edits,
  complete, snooze, skip, and delete; it stops on a conflict instead of
  last-write-wins.
- **Advanced CalDAV sync.** VTODO task round-trips, per-list collections,
  collection create/rename/delete, task MOVE, shared-list access,
  per-collection UID/href identities, IANA TZID/`VTIMEZONE` output,
  `sync-collection` tokens, ICS file import, recurrence overrides, and
  read-only `ATTACH` downloads are supported. Remaining: `RANGE`-style
  this-and-future changes, uploads over CalDAV, and the live-client matrix
  (see `docs/CALDAV.md`; the honest manual checklist is
  `docs/CALDAV-INTEROP.md`, currently NOT RUN against physical clients).
- **Agent autonomy.** The agent is optional/beta: single-item writes have undo,
  bulk/delete/recurrence edits require proposal approval, and there is no
  autonomous delete.

## Release gate (v0.3.0)

Core must be true before tagging: due-date/all-day/offset/timezone reminders
arm and fire (scheduler tests + `reminder-arming.test.ts`); fresh clone boots
via Docker without baked secrets; one real device receives a push ≤30s late
(manual, locked phone); an age-encrypted restore drill succeeds on a temp DB;
CalDAV discovery + VTODO task round-trip works in a real client (the VEVENT
feed remains read-only); offline capture syncs; JSON round-trip + nightly run
in `/api/backup/runs`; `pnpm typecheck`,
`pnpm test`, Playwright green; docs match the app; a11y (keyboard-only, focus
trap/return, 44px targets, 200% zoom) and device matrix recorded. Tag only when
the manual device push, encrypted restore, and CalDAV client drills are proven.
