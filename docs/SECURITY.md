# Security

v0.3 security model: atomic first-run claim (open by default, optional setup
token for public hosts), Argon2id logins with
`__Host-` Strict cookies, Origin + `Sec-Fetch-Site` CSRF checks, step-up for
destructive actions, hashed scoped MCP bearer tokens on an isolated listener,
0600 provider API-key files with fingerprint-only metadata, allowlisted
exact-byte backups with a typed-confirm restore, strict CSP/HSTS, 0600 file
secrets, non-root app user, and redacted logs. `docs/RUNBOOK.md` has the
operator procedures; this file states the controls and their exact limits.

## First-run setup

- `SETUP_MODE=open` (default): the first visitor to `/setup` creates the owner
  account. The gate is the atomic first-user insert, not a secret. Intended for
  a trusted LAN/VPN; the app logs a warning at boot if `APP_URL` is a public
  origin. Finish setup before exposing the port.
- `SETUP_MODE=token`: internet-facing deployments should set this before
  exposing the app. `deploy/init-env.sh` generates 32 random bytes (64 hex
  characters) into `SETUP_TOKEN` in `.env` and sets mode 0600. The server reads
  `SECRETS_DIR/setup_token` first, then the env value. Both are one-time
  bootstrap secrets, never logged.
- `POST /api/setup` accepts `{token?, password, timezone?}`; `token` is
  required only in token mode. The password is 12–256 characters. In token
  mode the comparison is constant-time over equal-length buffers
  (`setupTokensEqual`), and a bad token costs a dummy Argon2 verify so timing
  does not reveal token validity.
- The first-user insert runs in one SQLite transaction: user + first session
  commit together or not at all. Once any user exists, setup returns
  `409 setup_complete` before checking the token, so a valid token is not an
  oracle after provisioning.
- In token mode, success deletes `SECRETS_DIR/setup_token` (ENOENT is ignored)
  and issues the session cookie. A token left in `.env` is inert; blank it after
  setup to reduce exposure.
- Rotating the token only matters before setup: replace the value/file and
  restart the app (config is cached). After setup, use the CLI
  `reset-password` path instead; the setup token cannot recover or reset a
  password.

## Passwords and sessions

Argon2id (`@node-rs/argon2`), 64 MiB memory (`m=65536` KiB), `t=3`, `p=1`,
32-byte default output, unique random salt per hash. This exceeds the policy
floor of 19 MiB / t≥2 / p≥1. `hashNeedsRehash` upgrades a stored PHC string on
successful login when its parameters are weaker. Unknown-user login performs a
dummy Argon2 verify against a hash precomputed at boot; all failures return the
same `401 invalid_credentials`.

Session cookies:

| Context | Name | Flags |
|---|---|---|
| HTTPS, or `NODE_ENV=production` | `__Host-reminders_session` | `Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800` |
| Plain-http dev fallback | `reminders_session` | `HttpOnly; SameSite=Strict; Path=/; Max-Age=604800` (no `Secure`) |

`__Host-` requires `Secure`, `Path=/`, and no `Domain`; the app sets exactly
that. The raw token is 32 random bytes base64url (256 bits); SQLite stores only
its SHA-256 hex hash. Tokens rotate on login and password reset. Idle expiry is
7 days, refreshed only after half the window has elapsed; absolute expiry is 30
days and is never extended. Logout, current-session revoke, password reset, and
a live restore revoke the relevant sessions. There is no bearer session token in
JSON, `localStorage`, or logs.

## CSRF matrix

The check applies to unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) whose URL
starts with `/api/`. Safe methods and `/healthz`, `/readyz`, and static files
are not checked. `SameSite=Strict` is defense in depth, not the only control.

| Origin | `Sec-Fetch-Site` | Result |
|---|---|---|
| absent | absent | allow (non-browser client such as curl) |
| absent | `same-origin` | allow |
| absent | anything else | `403 csrf` |
| present, matches `APP_URL` origin | any | allow |
| present, different from `APP_URL` | `same-origin` | allow (alternate origin) |
| present, different from `APP_URL` | absent/anything else | `403 csrf` |

`APP_URL` is parsed as a URL; a browser `Origin` equal to its `.origin` is
sufficient on its own. Browsers on an alternate origin (another hostname or
port serving the same app) send `Sec-Fetch-Site: same-origin`, which is
sufficient proof that the request came from that origin. There is no separate
CSRF token or double-submit cookie. Set `APP_URL` to the canonical external
origin; alternate origins work in modern browsers but are separate sessions
(see RUNBOOK “Multiple sites and multiple origins”).

## Step-up surfaces

`POST /api/auth/password {password}` verifies the current password with Argon2
and stamps `sessions.step_up_at`. Freshness is 10 minutes. A wrong password is
`401 step_up_failed`; a missing/stale stamp is `403 step_up_required`.

Required for:

| Surface | Why |
|---|---|
| `DELETE /api/auth/sessions/:id` (target is not the current session) | revoke another device |
| `POST /api/backup/import` | both `dryRun=1` preview and the applying call |
| `DELETE /api/trash/tasks/:id`, `DELETE /api/trash/lists/:id` | permanent purge |
| `PATCH /api/mcp` | MCP kill switch |
| `POST /api/mcp/tokens/rotate` | issue a new MCP bearer |
| `DELETE /api/mcp/tokens/:id` | revoke an MCP bearer |
| `POST /api/providers`, `PATCH /api/providers/:id`, `PATCH /api/providers/:id/rotate`, `DELETE /api/providers/:id`, `POST /api/providers/:id/test`, `POST /api/providers/:id/discover-models` | connect, edit, rotate, remove, probe, or discover models for a provider key |

Applying a restore additionally requires the typed body field
`confirm: "RESTORE"`. A pre-restore backup is written before the live swap.
The CLI `reset-password` needs shell/container access (equivalent to host root)
rather than step-up.

## MCP bearer tokens

The MCP listener is a separate Fastify instance on **:3001**, reachable only on
the Docker `agent` network. It is never published in `compose.yaml`, never
proxied by Caddy, and is not part of the app’s `/api` surface. If
`REMINDERS_MCP_TOKEN` is absent, the listener is not started (AI-off); if
`MCP_ENABLED=false` or the DB kill switch is off, it does not start or answers
`503` before authentication.

- Bearer only: `Authorization: Bearer <token>`. The plaintext is stored only in
  `.env`/`SECRETS_DIR/reminders_mcp_token` (0600). SQLite stores a SHA-256 hash
  plus id, name, scopes, `createdAt`, `expiresAt`, `lastUsedAt`, and
  `revokedAt` under the `mcp.tokens.v1` setting. Authentication compares every
  stored hash in constant time and checks revocation/expiry.
- Scopes: `read`, `write`, `propose`. Tool mapping:
  - `read`: `reminders_list`, `reminders_get`, `reminders_search`,
    `reminders_lists`, `reminders_day`
  - `write`: `reminders_create`, `reminders_update`, `reminders_complete`,
    `reminders_snooze`, `reminders_skip`
  - `propose`: `reminders_propose`
- There are exactly 11 tools and **no delete tool**. Deletion exists only as a
  proposal operation that requires user approval in the app.
- Rotation (`POST /api/mcp/tokens/rotate`, step-up) returns the new plaintext
  once, revokes every live token including the env-bootstrapped `primary`, and
  stores only the new hash. A restart with an old `REMINDERS_MCP_TOKEN` cannot
  resurrect a revoked primary; update the sidecar env and restart it. Revoking
  individually is `DELETE /api/mcp/tokens/:id`; `GET /api/mcp/status` lists
  metadata without hashes.
- Kill switches: env `MCP_ENABLED=false` (requires app restart, and prevents
  listener start) or `PATCH /api/mcp {"enabled":false}` (immediate DB setting,
  step-up required). Disabled means `503` before bearer validation; existing
  tokens remain revocable.
- Transport hardening: `MCP_ALLOWED_HOSTS` host allowlist and Origin host check,
  256 KiB body cap, 120 requests/minute per token, 240/minute per IP, and
  per-session quotas of 30 tool calls/minute, 10 writes/run, 20 proposal
  operations (pending included). Task text is wrapped as untrusted data; the
  sidecar has no shell/file/web tools by construction.
- Admin endpoints (`/api/mcp/*`) use the session cookie; mutations require
  step-up. The MCP listener itself accepts only the bearer.

## AI provider credentials (M4.1)

Morrow owns provider metadata and a key file; the OpenCode sidecar owns all
model traffic. No app route calls a model. API keys are stored in a 0600 file,
not in SQLite, and are never returned, logged, audited, or included in a JSON
backup.

### Storage and write path

| Item | Location | Mode | Contents |
|---|---|---|---|
| Provider key | `SECRETS_DIR/providers/<providerId>.key` | 0600 | the plaintext API key |
| Key directory | `SECRETS_DIR/providers/` | 0700 | keys only; excluded from backups |
| Overlay | `PROVIDER_OVERLAY_PATH` (default `/data/opencode-providers/global.json`) | 0644 | references only: `{file:/data/secrets/providers/<id>.key}` |
| Credential row | SQLite `provider_credentials` | DB file mode | metadata, SHA-256 `key_fingerprint`, `key_last4`, base URL, models, header names/values, test state |
| Audit row | SQLite `activity` (`entity_type = provider`) | DB file mode | secret-free public projection before/after |

The key is **not** application-encrypted. The boundary is filesystem
permissions, the app-data volume, container access, and host disk encryption.
Treat a volume snapshot or host disk image as key-bearing even though JSON
backups are not.

Writes use a temp file in the key directory → `fsync` → `rename` → directory
`fsync`, then `chmod 0600`. A crash cannot leave a partial key at the canonical
path. Keys are 1–4096 characters and may not contain control characters or line
breaks. A whole `{env:NAME}` or `{file:/absolute/path}` key input is resolved
once at write time and then stored in the key file; the overlay still carries
only the app-owned `{file:...}` reference.

SQLite is metadata-only: `provider_id` (unique among live rows), label, kind,
base URL, `models_json`, `npm_pkg`, `headers_json`, `key_last4`,
`key_fingerprint`, enabled/test state, `rev`, timestamps, and `deleted_at`.
`inspectProviderKey` compares the on-disk file with the stored fingerprint on
every list/render. A missing or mismatched key marks the provider `degraded` and
omits it from the overlay rather than emitting an unreadable `{file:...}`
reference. It also computes a `modeWide` flag when group/other bits are set, but
that flag is diagnostic only; check `stat` during an audit. Hand-editing or
deleting a key does not crash the list; rotate the key to recover.

Header values are stored as supplied and rendered into the overlay. If a header
is itself a credential, put a `{env:NAME}` or `{file:PATH}` reference there;
only a whole-reference API key is resolved at write time, while header
references are resolved by the app for probes and by the sidecar at config load
(its env/file view must match).

The sidecar must read `SECRETS_DIR/providers` at the **same absolute path**.
The bundled compose runs the sidecar as root (the image default), so it can
read the app's 10001-owned 0600 keys. If you harden the sidecar to non-root, run
it as 10001 or align ownership of the provider directory; otherwise OpenCode
sees a missing key. Never widen a key to 0644; fix the mount or UID instead. The
overlay file is 0644 because it contains references, not secrets.

The bundled `opencode-secrets` volume mounts only the `providers/` subpath at
the same absolute path (`/data/secrets/providers`, read-only). The sidecar
sees provider keys for model traffic and nothing else: VAPID, backup HMAC,
MCP, setup, session, and readyz secrets stay app-only. Keep provider keys at
`SECRETS_DIR/providers` so `{file:/data/secrets/providers/<id>.key}` resolves
unchanged. Do not widen the sidecar to `/data/secrets`.

### Masking and responses

- `GET /api/providers` exposes `keyPresent`, `keyLast4`, `headerNames`, and test
  state. It never exposes the key, its path, the fingerprint, header values, or
  the sidecar credential.
- `POST`/`PATCH` responses use the same public provider projection; `DELETE`
  returns only `{ ok, clearedModel }`. `test`/`discover` return probe results and
  the projection; a probe result contains no key or authorization header.
- Errors and logs never include the key. Keys are not in JSON responses, SSE,
  `localStorage`, service-worker caches, or activity snapshots.
- Provider create/update/rotate/delete, test, and discover need the session
  cookie plus a fresh step-up (10 minutes). CSRF checks apply to every unsafe
  `/api` request, and the SSRF gate covers both probe paths.

### SSRF guard

Every provider probe (`test`, `discover-models`) runs through the app's guard
before any request:

- `https://` is required by default. Plain `http://` is accepted only when
  `ALLOW_PRIVATE_PROVIDER_URLS=true` **and** the host classifies as private,
  loopback, or link-local. This is the Ollama/LM Studio path.
- Cloud metadata is always blocked: `169.254.169.254`, `100.100.100.200`,
  `fd00:ec2::254`, `metadata.google.internal`, and `metadata`.
- Multicast/reserved-range addresses (`224.0.0.0/4`, `ff00::/8`), URL
  credentials, and malformed URLs are rejected. A URL may not carry a
  username/password; keys belong in the key field.
- DNS is resolved immediately before each probe. Every resolved address is
  classified; private/loopback/link-local answers reject the probe unless the
  private flag is on, while metadata and reserved answers reject even with the
  flag. Single-label Docker service names are treated as private.
- Requests are `GET {baseUrl}/models`, follow no redirects
  (`redirect: "error"`), and time out after 5 seconds. Discovery caps the
  response body at 1 MiB and the model list at 500; `test` reads only the
  status and cancels the body. Neither sends a model prompt.
- IPv4-mapped IPv6 is classified through its IPv4 form, so
  `::ffff:169.254.169.254` is metadata and `::ffff:10.0.0.1` is private.

The DNS answer is not pinned to the socket; a determined DNS-rebinding host can
still race the check (a pinned dispatcher is a future hardening pass). The
probes are owner-only admin actions and return no model output, which limits
the exposure. The guard protects **app-originated probes only**: the sidecar
dials the `baseURL` in the overlay itself. Provider configuration is therefore
admin-trusted, and the sidecar's network placement is the control for model
traffic: compose keeps MCP/app on the internal `agent` network and attaches the
sidecar to a dedicated non-internal `egress` network. The app and Caddy are not
on `egress`, and 4096/3001 stay unpublished.

`ALLOW_PRIVATE_PROVIDER_URLS=true` is process-wide and deliberately weakens the
probe guard. Enable it only when the app and sidecar are on a trusted network,
when local models are wanted, and with host-firewall rules that keep the model
server off the public internet. It does not unblock metadata or reserved
addresses, and it does not change the sidecar's egress.

### Backup exclusion

- `provider_credentials` is in `BACKUP_EXCLUDED_TABLES` and is not in the table
  allowlist. The JSON payload therefore has no fingerprint, `key_last4`, base
  URL, header values, or provider row.
- `SECRETS_DIR/providers` is outside the backup format. `exportBackup` refuses
  a `BACKUP_DIR` that equals, contains, or is contained by `SECRETS_DIR`
  (`BACKUP_DIR must not overlap SECRETS_DIR`), so a directory walk cannot pick
  up keys.
- `PROVIDER_BACKUP_CANARY_MARKERS` (`provider_credentials`,
  `key_fingerprint`, `key_last4`) plus `findBackupSecretLeaks` make an
  accidental future inclusion fail tests and diagnostics. The provider test
  also asserts the exported bytes contain no key material, marker, or
  fingerprint.
- `activity` **is** backed up, so provider audit snapshots must stay
  secret-free. They use `PublicProvider`, which contains only masked or public
  fields; never add the key or fingerprint to an audit payload.
- Volume snapshots and host disk images are not JSON backups and do include
  `SECRETS_DIR/providers`. Protect them like credentials, and rotate keys that
  may have been in a snapshot you no longer trust.

### Audit shapes

Provider mutations call `recordActivity` with `actor: "user"`, the owner's
`actorId`, `entityType: "provider"`, `entityId` = the credential row id
(`pcr_…`), `before`/`after` = `PublicProvider` or `null`, and a short summary:

| Action | Before | After | Summary |
|---|---|---|---|
| `provider.create` | `null` | new projection | `Connected <kind> provider <providerId>` |
| `provider.rotate` | old projection | new projection | `Rotated the key for <providerId> (last4 XXXX)` |
| `provider.delete` | old projection | `null` | `Removed provider <providerId> and its key file` |
| `provider.test` | `null` | current projection | `Tested <providerId>: <code>` |
| `provider.discover_models` | `null` | current projection | `Discovered N model(s) for <providerId>` |

`PublicProvider` carries `providerId`, label, kind, base URL, models,
`headerNames`, `keyPresent`, `keyLast4`, `status`, `statusMessage`, `enabled`,
test timestamps/state, `rev`, and timestamps. It does not carry the key,
fingerprint, key path, header values, or sidecar credential. The audit write is
best-effort; a failed audit insert does not roll back the provider change, so
rely on the activity row when present and on `rev`/test state otherwise.

### Rotation, deletion, and compromise

Use **Settings → AI → Providers → Rotate key**, or
`PATCH /api/providers/:id/rotate` with a new key and fresh step-up. The new key
overwrites the file atomically, `last_test_*` resets, `rev` increments, and the
overlay re-renders. Then test, and revoke the old key at the provider. For a
suspected compromise, revoke at the provider **first**, rotate in Morrow, test,
and inspect `activity` for unexpected `provider.*` rows.

Deleting a provider soft-deletes the row, deletes the key file, re-renders the
overlay, and clears `ai.model` if the selected model belonged to that provider.
A later rotate or re-add can reuse the `providerId`. A leftover key file after
a failed delete is not referenced by the overlay; rotate overwrites it. If a
delete cannot remove the file (permissions), remove it from the app container
as UID 10001 or fix the mount; do not leave it world-readable.

`PROVIDERS_ENABLED=false` is a write freeze: create/rotate/delete/discover
return `503 providers_disabled` before any key write, while list/test keep
working. It does **not** stop the sidecar from using an existing overlay. To
stop model traffic, turn the assistant off (`ai.enabled=false`), blank
`OPENCODE_URL`, or stop the sidecar. To stop MCP tools, use the MCP kill switch
separately.

## Backup format, allowlist, and integrity

JSON `morrow.backup` v1, schema version 3. Only allowlisted columns leave the
database:

- Tables: `lists`, `list_members`, `tags`, `tasks`, `task_tags`, `subtasks`,
  `task_completions`, `task_recurrence_exceptions`,
  `agent_conversations` (`conversations` in JSON), `activity`.
- Settings allowlist: `timezone`, `locale`, `week_start`, `weekStart`,
  `time_format`, `timeFormat`, `quiet_hours`, `quietHours`,
  `reminder_defaults`, `reminderDefaults`, `notification_defaults`,
  `notificationDefaults`, `backup`, `agent`, `ntfy`, `digest`, `theme`,
  `vapid_public_key`, `vapidPublicKey`.
- Excluded: `users` (password hashes), `sessions` (token hashes),
  `push_subscriptions` (endpoint/p256dh/auth), `capture_tokens`,
  `attachments` (bytes and metadata), `caldav_changes`, `deliveries`,
  `agent_messages`, `proposals`, `backup_runs`, `scheduler_state`,
  `provider_credentials`, `operations`, `sqlite_sequence`,
  `__drizzle_migrations`, VAPID private key, HMAC key, setup/MCP/OpenCode
  credentials, and provider key files under `SECRETS_DIR/providers`.
  Secret-like settings keys are rejected by the validator even if someone adds
  them to the allowlist. Attachment bytes live outside JSON backups; back up
  `ATTACHMENTS_DIR` at the volume level.
- Schema compatibility: older backup `schemaVersion` values are accepted;
  missing v0.2/v0.3 tables (`list_members`, `tags`, `task_tags`, `subtasks`,
  `task_recurrence_exceptions`) are treated as empty. A backup newer than the
  app is rejected.
- Pre-migration DB snapshots
  (`/data/morrow.db.pre-migration-*.bak`, mode 0600) are full SQLite copies of
  the live DB. They contain the same data as the DB, are not part of the JSON
  backup, and should be protected and pruned with the rest of the volume.
- JSON backups cap activity at the newest 5,000 rows. Activity is audit/undo
  history, not core reminder data; the live DB prunes rows older than
  `ACTIVITY_RETENTION_DAYS` (default 90; 0 disables) once per day.

Integrity:

- `sha256` is lowercase hex over the exact UTF-8 bytes of the canonical payload
  (fixed field order, no insignificant whitespace). Verification recomputes it
  and also requires the uploaded bytes to equal the canonical serialization, so
  pretty-printing, reordering, or any byte edit fails.
- Optional `hmac` is HMAC-SHA256 over the same payload bytes. The key is
  `BACKUP_HMAC_KEY` or `SECRETS_DIR/backup_hmac_key` (0600) and loading it from
  inside `BACKUP_DIR` is refused. If the backup has an HMAC but the verifier has
  no key, the result is `hmac: "unchecked"` and verification can still pass on
  SHA-256/canonical form. Configure the key on both export and import when you
  need tamper resistance; SHA-256 alone detects corruption, not a deliberate
  re-sign.
- Age encryption is implemented. Setting `BACKUP_AGE_RECIPIENT` writes an
  `age` envelope (`*.json.age`) and plaintext never touches the backup
  directory in that mode. Restore needs `BACKUP_AGE_IDENTITY` (file in
  `SECRETS_DIR/backup_age_identity` or the environment) for encrypted input;
  keep the identity outside the backup directory and never export it.

Restore is gated by fresh step-up plus `confirm: "RESTORE"`. The pipeline always
writes a `pre-restore` backup (one read transaction, so concurrent writes cannot
tear it), enters a process-wide maintenance gate, drains in-flight writes and a
running scheduler tick, checkpoints/closes the live handle, applies to a temp DB
with `integrity_check`/`foreign_key_check` inside the transaction, fsyncs it,
and atomically renames it over the live path (old `-wal`/`-shm` are removed on
both sides). It then reopens and re-verifies the live DB, rebinds the
scheduler/assistant/MCP, clears scheduler leases/`sending` deliveries, revokes
all sessions, invalidates capture/CalDAV/MCP credentials, proposals and
`operations`, closes SSE streams so stale cursors cannot replay, and sets
`login_reset_required`/`push_resubscribe_required`. While the gate is active
every unsafe `/api` request except `POST /api/backup/import` gets a retryable
`503 maintenance` + `Retry-After`, and `/readyz` reports `maintenance` rather
than green. Backup files are written 0600 with fsync; download paths are
contained under `BACKUP_DIR` with a safe filename pattern, never raw ledger
paths. Users are preserved on a normal restore (they are not in the payload); a
fresh-DB restore creates unusable stub users and requires the CLI
`reset-password`. MCP restarts without re-importing `REMINDERS_MCP_TOKEN`, so
the pre-restore bearer cannot become valid again; rotate a fresh token after
login.

Retention is 14 daily + 8 weekly + 6 monthly. `pre-restore` snapshots are
protected for 7 days so the undo button survives a crowded day.

## Caps and size limits

| Limit | Value |
|---|---|
| Backup upload / verification | 25 MiB default; `BACKUP_MAX_MB` (1–128) |
| Import multipart body limit | configured backup cap + 1 MiB |
| Backup JSON depth | 64 |
| Backup JSON nodes (objects/arrays/scalars) | 500,000 |
| Backup single string | 1,000,000 characters |
| Multipart fields | 10 fields, 1 file, 1 KiB field size, 100-byte field name |
| Push payload | 2,048 bytes (strictly < 2 KiB) |
| MCP request body | 256 KiB |
| Provider key | 1–4,096 characters, no control characters/CRLF |
| Provider headers | 20 headers, 2,000 characters per value |
| Provider models | 500 per provider |
| Provider probe | `GET /models`, 5 s timeout, no redirects, 1 MiB response cap |
| Settings value | 100,000 characters per value |
| Static JSON body (default Fastify) | 1 MiB; only the import route raises it |

An export larger than the configured cap (25 MiB default) will not be accepted
by import. Raise `BACKUP_MAX_MB` deliberately, or split/archive the data; do
not rely on a proxy limit alone.

## SSRF allowlist (Web Push)

Before storing or sending, `validatePushEndpoint` requires HTTPS, port 443, no
URL credentials, and a host ending in one of:

`fcm.googleapis.com`, `android.googleapis.com`,
`updates.push.services.mozilla.com`, `push.services.mozilla.com`,
`web.push.apple.com`, `push.apple.com`, `notify.windows.com`,
`push.yandex.ru`.

`PUSH_ENDPOINT_ALLOWLIST` (comma-separated) replaces this default host list;
the protocol, port, credential, and private-IP checks still apply. The suffix
match requires a dot boundary, so `evilnotify.windows.com` is not
`notify.windows.com`. It rejects localhost/`.localhost`, `.local`, `.internal`,
`.home.arpa`, `.lan`, private IPv4 (RFC1918, loopback, link-local/metadata,
CGNAT, documentation, multicast/reserved), and private IPv6 (loopback,
link-local, unique-local, multicast, IPv4-mapped private). No redirects are
followed and the send timeout is 5 seconds. `PUSH_ALLOW_ANY_PUBLIC_ENDPOINT=1`
is an explicit opt-in for a certified self-hosted relay; the private/loopback
and protocol checks still apply. VAPID subject must be a real `mailto:` or
`https:` contact; Apple rejects localhost.

## Rate limits

Limits are in-memory per app process (Compose runs one app replica); a restart
clears them. They are blast-radius controls, not a billing quota. “Per IP”
means Fastify’s `req.ip`; behind a proxy, set `TRUST_PROXY` to its exact CIDR
(or a comma-separated list for a chain; see RUNBOOK) or every client shares
the proxy’s address. When the app runs in Docker, a host-level proxy (bundled
Caddy, Tailscale Serve, or an external proxy publishing a Docker port) arrives
as the `edge` gateway, so trust the `edge` subnet. `127.0.0.1/32` is only for
an app running on the host or with host networking.

| Surface | Limit |
|---|---|
| All app routes (`@fastify/rate-limit`) | 300 requests/minute per IP |
| `POST /api/login` (plugin) | 30 requests/10 minutes per IP |
| `POST /api/login` (in-house) | 30/10 min per IP and 10/10 min per IP+account |
| `POST /api/push/subscriptions` | 30/minute |
| `POST /api/push/test` | 6/minute |
| MCP HTTP | 120/minute per token and 240/minute per IP |
| MCP tools | 30 tool calls/minute, 10 writes/run, 20 proposal operations |

App `429` responses are `application/problem+json`; MCP `429` is JSON-RPC with
`Retry-After: 60`. The in-house login bucket also sends `Retry-After: 600`.
Login failures are uniform `401`; the bucket is checked before Argon2, so a
burst spends the budget without hashing.

## Transport headers

The app CSP is pinned by `apps/server/test/headers.test.ts` and must stay equal
to the Caddyfile policy:

```
default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self' data:;object-src 'none';base-uri 'none';frame-ancestors 'none';form-action 'self';connect-src 'self';img-src 'self' data:;worker-src 'self'
```

No `upgrade-insecure-requests`. HSTS is sent by the app only when
`NODE_ENV=production` (`max-age=31536000; includeSubDomains`) and by Caddy at
the TLS edge; it is absent in development. `/api/*`, `/healthz`, and `/readyz`
are `Cache-Control: no-store`. Caddy adds `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`; the app
sets the CSP `frame-ancestors 'none'`. COOP is `same-origin` on every response,
but browsers only honour it on a potentially trustworthy origin (HTTPS, or
`http://localhost`); on plain-http LAN it is inert and is not an auth control.

## Secret rotation runbook

All secrets live in 0600 files under `SECRETS_DIR` or, for the compose scaffold,
in `.env` (which `init-env.sh` chmods 600). Never commit them; logs redact
`authorization`, `cookie`, `x-readyz-token`, `x-morrow-token`, `x-api-key`,
query `token`/`access_token`/`key`/`signature`/`password`, `set-cookie`,
`*.password`, `*.password_hash`, `*.token`, `*.token_hash`, `*setupToken*`, and
`*sessionToken*`. Fastify's request serializer keeps the path and non-sensitive
query parameters but replaces sensitive values with `[REDACTED]`; Caddy's
access log applies the same query filter for the calendar feed and email
webhook, which must keep query tokens for dumb clients. `apps/server/test/logging.test.ts`
pins both configurations.

| Secret | Where | Rotation and effect |
|---|---|---|
| `SETUP_TOKEN` | `.env` or `SECRETS_DIR/setup_token` | Used only with `SETUP_MODE=token`. Replace before setup and restart; after setup it is inert (`409`). Lost pre-setup token: generate a new one. |
| `SESSION_SECRET` | `.env` | Generated 0600 for deployment hygiene, but v0.1 auth does not sign/encrypt session tokens with it. Rotating it alone does **not** revoke sessions; use session revoke/reset-password. |
| Owner password | Argon2 hash in `users` | `sg docker -c 'docker compose exec -T app node apps/server/dist/reset-password.js --user owner "<new>"'` (omit `--user` for the default owner); hashes the named account and revokes only that account's sessions. Prefer piping the password on stdin with `-`. |
| `OPENCODE_PASSWORD` | `.env` | Change, restart `opencode` (and any client using basic auth). No app restart required. |
| `REMINDERS_MCP_TOKEN` | `.env` / `SECRETS_DIR/reminders_mcp_token` | Prefer `POST /api/mcp/tokens/rotate` with step-up; copy the one-time plaintext into `.env`, restart the sidecar. Rotation revokes the old primary. If editing env directly and restarting the app, the primary hash is replaced unless already revoked. |
| Provider API keys | `SECRETS_DIR/providers/<providerId>.key` | `PATCH /api/providers/:id/rotate` with fresh step-up (Settings → Rotate key); revoke the old key at the provider, test, and confirm the overlay. Deleting the provider removes the file. JSON backups exclude keys; volume snapshots do not. |
| VAPID key pair | `.env` / `SECRETS_DIR/vapid_*` | Generate a new pair, restart the app, then remove/re-enable push on every device. Existing `PushSubscription`s were created with the old applicationServerKey; launch resync reuses them, so it cannot repair a VAPID rotation by itself. Old subscriptions are disabled on 401/403/410. |
| `BACKUP_HMAC_KEY` | env or `SECRETS_DIR/backup_hmac_key` | New exports use the new key. Keep the old key for the retention window to verify old backups; without it old HMACs show `unchecked` but SHA/canonical checks still apply. Never store the key inside `BACKUP_DIR`. |
| `READYZ_TOKEN` | env or `SECRETS_DIR/readyz_token` | Change, restart, update the monitor’s `X-Readyz-Token`. Removing it makes `/readyz` open. |
| Session signing/cookie material | opaque tokens in `sessions` | Revoke a session via `DELETE /api/auth/sessions/:id` (step-up for other devices), or `reset-password --user <name>` to revoke that account's sessions (default owner). A restore also revokes all. |

Suspected compromise checklist: take the instance off the public edge or set
`MCP_ENABLED=false`; revoke MCP tokens and sessions; reset the owner password;
revoke and rotate provider keys at the provider, then rotate/delete them in
Morrow and inspect the overlay for unknown `providerId` entries; rotate
OpenCode/VAPID/HMAC/READYZ secrets; inspect `activity` and `backup_runs`; verify
compose has no published `3001`/`4096` and no Docker socket mount; rebuild from
pinned digests; then re-run the restore drill and
`apps/server/test/headers.test.ts` before re-exposing. Backup exports deliberately
omit credentials, so never add them back to “make restore easier.”

## v0.3 surfaces

- **Roles:** `users.role` is `owner` or `member` (default `member`). Setup
  creates the first user as owner; migrations/startup promote the earliest
  legacy user if no owner exists. Members can use their tasks, lists, shared
  lists, tags, attachments, push devices, capture tokens, and CalDAV tokens,
  but global/admin surfaces are owner-only. Members receive `403
  owner_only` from: all `/api/backup/*` routes; `GET /api/diagnostics`;
  `PATCH /api/settings`; `GET/POST /api/users`; all `/api/providers*`; all
  `/api/mcp*`; assistant status/model/settings/conversations/messages/stream/
  plan/capture-AI/undo; all `/api/proposals*`; and `POST /api/ntfy/test`. This
  is server-enforced, not just hidden in the UI. Members also do not receive
  workspace-global `ntfy`/`digest` or AI/backup/MCP settings in bootstrap or
  `GET /api/settings`; per-user preferences remain readable. Per-user AI/MCP
  sessions are a later phase.
- **Capture tokens (kind `capture`):** 192-bit random tokens, SHA-256 at rest,
  shown once, revocable per token. They can create one parsed task or email
  task; they cannot read the task database and cannot authenticate CalDAV.
  Use one token per client and revoke it independently. Quick capture honors
  `Idempotency-Key`; the email webhook dedupes by provider `Message-ID` when
  present, else by `Idempotency-Key`. A retry returns the existing task and
  never creates a second one. All capture/CalDAV tokens are invalidated by a
  live restore and by a password change or CLI password reset.
- **CalDAV tokens (kind `caldav`):** created from Settings → Integrations
  with purpose **CalDAV**. They can read the ICS feed and use `/caldav/`
  (read/write/soft-delete tasks), but cannot create capture or email tasks.
  Existing capture tokens from v0.2.0 are migrated as `capture` and therefore
  stop working for CalDAV: create a fresh CalDAV token and update each
  calendar client. `CALDAV_TOKEN` remains a deprecated headless fallback and
  maps only to the workspace owner, never an arbitrary first user. Live
  restore invalidates CalDAV tokens too.
- **Accounts and sharing:** additional accounts authenticate by username and
  are members; data stays scoped by `user_id`. List membership is an explicit
  `list_members` row. `GET /api/activity` returns all rows to the owner and
  only the member's own `actor_id` rows to a member; undo checks the direct
  activity seq plus task/list access, so a member cannot undo an owner action
  even on a shared list. SSE activity is filtered by actor or task/list
  ownership before it reaches a stream. Unsharing a list, deleting it, or
  moving a task to another list skips pending reminders for recipients who
  lost access, and the sender re-checks access immediately before every push.
- **Per-account timezone:** any authenticated account may `PATCH /api/me
  { timezone }` to change its own IANA zone. This is the fallback for that
  user's reminders and the zone used for their quiet hours; workspace-global
  settings remain owner-only.
- **Shared-task tags:** `PUT /api/tasks/:id/tags` replaces only the caller's
  own tag links. A member can add/remove their tags without deleting the
  owner's (or another member's) `task_tags` rows, and can only select tags
  they own.
- **Attachments:** 10 MiB per file, stored with generated names and 0600
  permissions outside SQLite; downloads require the session and re-check task
  access. HTML/SVG uploads are served as attachment downloads with
  `nosniff`.
- **CalDAV:** Basic auth with username `owner` plus a `kind = caldav` token
  (or `CALDAV_TOKEN`). The username is literally `owner` for members too;
  identity comes from the token. Capture tokens are rejected. Tokens are
  hashed at rest; CalDAV writes go through the same soft-delete/task policy as
  the API. The calendar home exposes one collection per accessible Morrow
  list plus the user's virtual Inbox; shared lists follow `list_members`, and
  an owner-only list returns `404` to a member. The legacy flat `morrow`
  collection remains readable for older clients but rejects writes with
  `403 legacy_collection_read_only`, because its flat href namespace can
  resolve a duplicate href to the wrong row. Sync tokens are scoped to one
  collection and are invalidated by a live restore. `MKCALENDAR`,
  `PROPPATCH`, collection `DELETE`, and task `MOVE` are authenticated CalDAV
  writes and are covered by the restore maintenance gate; only a list owner
  may rename or delete that list, and only a task's creator may move it.
  `POST /api/import/ics` is authenticated, targets only an accessible
  list/Inbox, caps the file at 1 MiB, never fetches `ATTACH` URLs, reports
  per-object failures, and rejects components carrying `RECURRENCE-ID` or
  `EXDATE` rather than silently dropping their exceptions.
- **ntfy:** URL/topic are non-secret settings; bearer token comes from
  `NTFY_TOKEN`/`SECRETS_DIR/ntfy_token` and is never exported. ntfy is one
  workspace-global channel configured by the owner, not a per-member
  destination. Only tasks the owner can read are published to it, so
  member-private reminders never leave their account through the shared topic;
  members use Web Push for their own notifications. Anyone who knows the topic
  URL can read the owner's notifications, so do not use a public/shared topic
  for sensitive content. Per-user ntfy topics are not implemented in v0.3.
- **age backups:** ciphertext is written when `BACKUP_AGE_RECIPIENT` is set;
  the identity stays in `SECRETS_DIR/backup_age_identity` (0600) or the
  environment. Plaintext never touches the backup directory in that mode.
- **Email webhook:** token-authenticated; optionally restrict senders with
  `EMAIL_ALLOWED_FROM`. HTML is stripped before parsing; no attachments are
  ingested.
