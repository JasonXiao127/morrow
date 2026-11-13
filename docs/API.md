# API (v0.3 contract: v0.1 §5 + product surfaces)

Base `/api` on same-origin session cookie with `ETag: "rev-N"` + `If-Match` concurrency, `Idempotency-Key` replay, `application/problem+json` errors, and an SSE envelope `{v:1,id,type,at,entity,data}` with `Last-Event-ID` replay; see also `/healthz` (liveness) and `/readyz` (DB, scheduler, OpenCode with Basic auth probe). `/readyz` answers `503 {status:"maintenance"}` while a live restore holds the maintenance gate.

## Assistant (M4)

- `GET /api/assistant/status` — optional sidecar status; `enabled`, `available`,
  `connected`, `status`, `model`, `message`, version/pin.
- `GET /api/model` — proxies the sidecar model catalog for Settings → AI,
  including `capabilities.tools`; the browser never receives the sidecar URL or
  credential.
- `POST /api/assistant/settings` — `{ aiEnabled?, model? }`; validates the model
  supports tools and any requested variant.
- `POST /api/assistant/conversations`, `GET .../:id/messages`,
  `POST .../:id/messages` (202 enqueue), `GET .../:id/stream` (fetch/ReadableStream
  SSE), `POST .../:id/stop`.
- `POST /api/capture/parse` — M1 deterministic parser; M4 `ai: true` or
  `mode: "auto"|"model"` adds a validated one-shot model fallback.
- `POST /api/assistant/plan-my-day` — deterministic proposal.
- `GET /api/proposals?status=pending`, `GET /api/proposals/:id`,
  `POST /api/proposals/:id/apply` (selected operations, payload/base-rev checks,
  atomic), `POST /api/proposals/:id/dismiss`, `POST /api/proposals/:id/undo`.
- `POST /api/assistant/undo` — undo one immediate tool batch.

Assistant SSE envelope mirrors the main SSE contract:
`{v:1,id,type,at,data}` with `retry`, heartbeat, snapshot, and `Last-Event-ID`
replay from an in-memory ring plus transcript resync after reconnect.

## Providers (M4.1)

Provider endpoints manage API-key providers for the assistant. The session
cookie authenticates every call; create, update, rotate, and delete additionally
need a fresh step-up (`POST /api/auth/password`, 10 minutes). The plaintext key
is accepted once, written to `SECRETS_DIR/providers/<providerId>.key` (0600),
and never returned, logged, or audited. Responses expose only `keyLast4`.

No provider route calls a model. `test` and `discover-models` are the only
outbound requests; both are bounded `GET {baseUrl}/models` probes through the
SSRF guard.

| Method | Path | Step-up | Result |
|---|---|---|---|
| `GET` | `/api/providers` | no | masked providers, presets, OAuth note, overlay state |
| `POST` | `/api/providers` | yes | `201 { provider }` |
| `PATCH` | `/api/providers/:id` | yes | `{ provider }`; update label/baseUrl/models/headers/enabled, optional `key` |
| `PATCH` | `/api/providers/:id/rotate` | yes | `{ provider }`; body `{ key }` only |
| `DELETE` | `/api/providers/:id` | yes | `{ ok: true, clearedModel }` |
| `POST` | `/api/providers/:id/test` | yes | `{ provider, test }` |
| `POST` | `/api/providers/:id/discover-models` | yes | `{ provider, discovery, saved }` |

`:id` accepts either the row id (`pcr_<24 hex>`) or the stable `providerId`
(for example `openai`).

### `GET /api/providers`

```json
{
  "enabled": true,
  "overlayPath": "/data/opencode-providers/global.json",
  "providers": [
    {
      "id": "pcr_0123456789abcdef01234567",
      "providerId": "openai",
      "label": "OpenAI",
      "kind": "preset",
      "baseUrl": "https://api.openai.com/v1",
      "models": [{ "id": "gpt-4.1-mini", "name": "GPT-4.1 mini" }],
      "npm": null,
      "headerNames": ["X-Team"],
      "keyPresent": true,
      "keyLast4": "1234",
      "status": "ready",
      "statusMessage": null,
      "enabled": true,
      "lastTestAt": "2026-11-02T12:00:00.000Z",
      "lastTestOk": true,
      "lastError": null,
      "rev": 3,
      "createdAt": "2026-11-02T11:00:00.000Z",
      "updatedAt": "2026-11-02T12:00:00.000Z"
    }
  ],
  "presets": [
    {
      "id": "openai",
      "label": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "npm": null,
      "requiresKey": true,
      "local": false,
      "custom": false
    }
  ],
  "oauth": {
    "cliOnly": true,
    "providers": ["ChatGPT Plus/Pro (OpenAI OAuth)", "GitHub Copilot", "GitLab Duo"],
    "message": "Subscription OAuth sign-in stays in the OpenCode CLI. Run `docker compose exec opencode opencode auth login`; Morrow manages API-key providers only."
  },
  "overlay": { "path": "/data/opencode-providers/global.json", "present": true }
}
```

`status` is `ready` (last test passed), `degraded` (key missing/tampered or last
test failed), `untested`, or `disabled`. The server does not expose a separate
`connected` boolean; clients derive it from `status`/`keyPresent`. `headerNames`
are names only; header values, the key path, and the fingerprint are never
returned. `keyLast4` is `null` for keyless local/custom providers. The top-level
`enabled` is the provider write switch (`PROVIDERS_ENABLED`), not `ai.enabled`.

### Request bodies

`POST /api/providers` (strict; unknown fields are rejected):

| Field | Rules |
|---|---|
| `kind` | required, `"preset"` or `"custom"` |
| `preset` | preset id; required in practice for `kind: "preset"` unless `providerId` names it |
| `providerId` | optional slug, `^[a-z0-9][a-z0-9._-]{0,63}$`; must equal the preset id for non-custom presets; defaults to `custom` for the custom shape |
| `label` | optional, at most 100 characters |
| `baseUrl` | optional for presets (prefilled), required for custom; absolute `http(s)`, at most 2048 characters, no URL credentials |
| `models` | array of strings or `{ id, name? }`, at most 500, or an OpenCode-style `{ modelId: { name } }` map |
| `key` | optional string 1–4096 characters, no control characters or line breaks; required for presets with `requiresKey` |
| `headers` | optional flat object, at most 20; names `[A-Za-z0-9-]{1,64}`; values at most 2000 characters, no CRLF; `host`, `content-length`, `transfer-encoding`, `connection`, `upgrade`, `keep-alive`, `proxy-authorization` blocked |
| `npm` | optional; only `@ai-sdk/openai-compatible` is accepted |

A key may be a whole `{env:NAME}` or `{file:/absolute/path}` reference; it is
resolved once at write time and stored in the key file. `{env:}`/`{file:}` in
`baseUrl` and header values remain as references in the row and overlay; the
app resolves them only for probes, and the sidecar resolves them when it loads
the overlay.

Provider updates use `POST /api/providers` for create and
`PATCH /api/providers/:id/rotate` to replace a key; there is no generic
`PATCH /api/providers/:id` route. A disabled provider stays in the database but
is omitted from the overlay. `PATCH /api/providers/:id/rotate` accepts exactly
`{ "key": "..." }`.

`DELETE` is a soft delete (`deleted_at`, `enabled = 0`, `rev + 1`), removes the
key file, and clears `ai.model` when the selected model is owned by that
provider (`providerId` or `providerId/...`); `clearedModel` is the old value or
`null`. A deleted `providerId` can be connected again.

### Test and discovery

`POST /api/providers/:id/test` returns HTTP 200 for a completed probe even when
the probe failed; inspect `test.ok`/`test.code`. The row's `lastTestAt`,
`lastTestOk`, `lastError`, and `rev` are updated. A missing or tampered key is a
probe result (`test.code = key_unavailable`), not an HTTP 409; the provider is
marked `degraded` and omitted from the overlay.

```json
{
  "provider": { "providerId": "openai", "status": "ready" },
  "test": {
    "ok": true,
    "code": "ok",
    "httpStatus": 200,
    "message": null,
    "latencyMs": 84,
    "checkedAt": "2026-11-02T12:00:00.000Z"
  }
}
```

`POST /api/providers/:id/discover-models` returns `{ provider, discovery,
saved }`. `discovery.models` is an array of `{ id, name? }`, sorted and capped
at 500. `saved` is true only when `discovery.ok` and at least one model was
found; the list is persisted and the overlay re-rendered. A completed probe is
still HTTP 200 when `ok` is false.

Probe mapping (5 s timeout, no redirects, GET only; discovery caps the body at
1 MiB):

| Upstream / failure | `ok` | `code` | Meaning |
|---|---|---|---|
| 2xx | true | `ok` | key accepted / endpoint reachable |
| 401 | false | `invalid_key` | key rejected |
| 403 | false | `forbidden` | key lacks permission |
| 404, 405 | true | `endpoint_missing` | host reachable but no `GET /models` |
| 429 | false | `rate_limited` | provider throttled the probe |
| 5xx | false | `provider_error` | provider-side failure |
| other HTTP | false | `http_error` | unexpected status |
| timeout | false | `timeout` | no answer within 5 s |
| network/redirect | false | `unreachable` | connection failed; redirects are not followed |
| HTTPS private/loopback (flag off) | false | `private_address` | SSRF guard |
| metadata endpoint | false | `blocked_metadata_url` | always blocked |
| `http://` without the private flag | false | `https_required` | use HTTPS or enable the local flag |
| bad URL/DNS | false | `invalid_base_url`, `dns_failed`, `blocked_url` | validation |
| discovery: provider listed no models | true | `empty` | reachable, nothing to save |
| discovery: non-JSON or oversized body | false | `invalid_response`, `response_too_large` | parse/size failure |

A provider-side 429 is **not** an HTTP 429 from Morrow; it is a probe result in
the JSON body. The Settings panel aborts a probe after 25 s.

### Errors, step-up, and limits

Errors are `application/problem+json` with `type`, `title`, `status`, `detail`,
`code`, and `traceId`.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | Zod shape failure (unknown field, bad type, too long) |
| 400 | `invalid_provider_id`, `unknown_preset` | bad slug or preset |
| 400 | `base_url_required`, `invalid_base_url`, `https_required` | missing/malformed/insecure URL |
| 400 | `private_address`, `blocked_metadata_url`, `blocked_url` | SSRF/DNS rejection at create/rotate |
| 400 | `invalid_key`, `key_required` | key shape/required preset |
| 400 | `invalid_models`, `invalid_headers`, `invalid_npm` | list/header/package validation |
| 400 | `missing_env_reference`, `invalid_file_reference`, `missing_file_reference` | `{env:}`/`{file:}` resolution |
| 401 | `unauthorized` | no/expired session cookie |
| 401 | `step_up_failed` | wrong password on `POST /api/auth/password` |
| 403 | `csrf` | Origin/`Sec-Fetch-Site` mismatch |
| 403 | `step_up_required` | fresh password confirmation missing/stale |
| 404 | `not_found`, `provider_not_found` | unknown row/provider id |
| 409 | `provider_exists` | a live row already uses that `providerId` |
| 412 | `stale_revision` | standard If-Match guard; not used by provider routes |
| 428 | `precondition_required` | standard missing-If-Match guard; not emitted by provider routes today |
| 429 | `rate_limited` | app-wide 300 requests/minute per IP; `Retry-After` |
| 500 | `internal_error` | unexpected failure (detail is redacted) |
| 503 | `providers_disabled` | `PROVIDERS_ENABLED=false` on a write |

`428` is not a step-up response; step-up is `403 step_up_required` (or
`401 step_up_failed` for a bad password). Provider routes do not require
`If-Match` today, so 428 is listed for the shared `/api` vocabulary and future
revision guards.

Step-up is `POST /api/auth/password {password}`. A wrong password is
`401 step_up_failed`; a stale/missing stamp is `403 step_up_required`. Create,
update, rotate, delete, `test`, and `discover-models` all require step-up. The
provider routes add no separate limiter; the global `@fastify/rate-limit`
bucket applies.

### Kill switch

`PROVIDERS_ENABLED=false` (read at app start; restart to change) makes
`POST /api/providers`, `PATCH /api/providers/:id`, `PATCH .../rotate`,
`DELETE`, `POST .../test`, and `POST .../discover-models` return
`503 providers_disabled` before touching the key or DB. `GET /api/providers`
keeps working. The overlay is
not removed and the sidecar may keep using it; this is a change freeze, not an
AI-off switch. For AI-off, use `ai.enabled=false` or blank `OPENCODE_URL` (see
`docs/AGENT.md`).

If the overlay write fails, the credential row is still saved; the next
mutation or app start retries, and `GET /api/providers` reports
`overlay.present: false`.

## v0.3 product surfaces

### Tags

- `GET /api/tags` → `{ tags }` with `open_count`.
- `POST /api/tags` `{ id?, name, color? }`; client ids replay.
- `PATCH /api/tags/:id` `{ name?, color? }`; requires `If-Match`.
- `DELETE /api/tags/:id`; soft-delete + unlink; requires `If-Match`.
- `GET/PUT /api/tasks/:id/tags`; PUT replaces with `{ tagIds: [...] }` (max 20).
- `GET /api/tasks?...&tagId=…` filters task views.

### Subtasks and attachments

- `GET/POST /api/tasks/:id/subtasks`, `PATCH/DELETE /api/subtasks/:id`.
- `GET/POST /api/tasks/:id/attachments` (multipart field `file`, ≤10 MiB,
  ≤20 per task), `GET /api/attachments/:id/download`,
  `DELETE /api/attachments/:id`.
- Attachment bytes live under `ATTACHMENTS_DIR` (default next to the DB);
  JSON backups leave them out.

### Accounts, sharing, and step-up

- `GET /api/users`, `POST /api/users` `{ username, password, timezone }`
  (owner only; POST also needs fresh step-up). Additional accounts are
  `member` and independent.
- `GET /api/lists/:id/members`, `POST /api/lists/:id/share { username }`,
  `DELETE /api/lists/:id/share/:userId` (owner + step-up).
- `POST /api/auth/change-password { currentPassword, newPassword }`; revokes
  every other session.
- `PATCH /api/me { timezone }` — any authenticated account may change its own
  IANA timezone. This is the fallback for that user's reminders and the zone
  used for their quiet hours, including shared lists.
- List/task access is owner-or-member; shared-list reminders fan out to every
  member's push devices, resolved in each recipient's own timezone.
- Global/admin routes are owner-only (`403 owner_only`): `/api/backup/*`,
  `/api/diagnostics`, `PATCH /api/settings`, `/api/users`, `/api/providers*`,
  `/api/mcp*`, `/api/assistant/*`, `/api/model`, `/api/proposals*`, and
  `/api/ntfy/test`.
- `GET /api/settings` and `GET /api/bootstrap` hide workspace-global
  notification settings (`ntfy`, `digest`) plus AI/provider/backup/MCP keys
  from members. Per-user preferences (`theme`, `quietHours`, `timezone`, …)
  remain readable; every settings write is owner-only. Account timezone is the
  exception: members change their own through `PATCH /api/me`.
- During a live restore, every unsafe `/api` request except
  `POST /api/backup/import` returns `503` problem+json with code
  `maintenance` and `Retry-After: 5`. `GET /readyz` returns 503
  `status: "maintenance"` for the duration.
- `GET /api/activity` is owner-wide and member-self only; undo re-checks the
  direct activity seq. Add `order=desc` for newest-first history (the default
  is ascending for SSE replay); the `cursor` pages backward in that mode.
  `POST /api/activity/:id/undo` reverses one task/list action and writes an
  `*.undo` row; `GET /api/events` is the SSE stream.
- `GET /api/tasks/:id/ledger` returns completion/missed history.
- `GET /api/trash` lists soft-deleted tasks and lists;
  `POST /api/trash/tasks/:id/restore`, `DELETE /api/trash/tasks/:id`,
  `POST /api/trash/lists/:id/restore`, and `DELETE /api/trash/lists/:id`
  restore or permanently purge them. Purges require fresh step-up.

### Capture tokens and email

- `GET/POST /api/capture/tokens`, `DELETE /api/capture/tokens/:id`.
  POST accepts `{ id?, name, kind?: "capture" | "caldav" }`; omitted `kind`
  defaults to `capture`.
- `POST /api/capture/quick` with `Authorization: Bearer <capture-kind token>`
  and `{ text, timezone? }`. Send `Idempotency-Key` to make retries return the
  existing task (`200`, `idempotent-replayed: true`) instead of creating a
  duplicate.
- `POST /api/inbound/email?token=<capture-kind token>` with
  `{ subject, text?, html?, from?, headers? }`; `EMAIL_ALLOWED_FROM` is
  optional. A provider `Message-ID` (body field or `headers` string/object) or
  an `Idempotency-Key` header dedupes redeliveries. Prefer
  `Authorization: Bearer` when the sender supports it; the query token remains
  for dumb webhook clients and is redacted from Fastify/Caddy access logs.
- Capture-matcher routes reject CalDAV tokens, and CalDAV/ICS routes reject
  capture tokens.

### Calendar / CalDAV

- `GET /api/calendar.ics?token=…` read-only **VEVENT** feed (CalDAV token).
  Its shape is unchanged by the VTODO work.
- `GET /api/tasks.ics?token=…` separate read-only **VTODO** feed for task
  subscribers.
- `/caldav/` discovery: `/.well-known/caldav` (GET/PROPFIND redirect),
  `/caldav/principal/`, `/caldav/calendars/`, `/caldav/calendars/morrow/`;
  Basic auth with username `owner` and a
  `kind: "caldav"` token. `CALDAV_TOKEN` is a deprecated headless fallback and
  maps only to the workspace owner (never an arbitrary first account).
- The CalDAV home lists one VTODO collection per Morrow list plus a virtual
  Inbox collection. The legacy `/caldav/calendars/morrow/` all-tasks alias
  remains readable but is no longer advertised and rejects `PUT`, `DELETE`,
  `MOVE` and `PROPPATCH` with `403 legacy_collection_read_only`. `MKCALENDAR`
  creates a list,
  `PROPPATCH` renames/recolors it, collection `DELETE` removes it and moves its
  tasks to Inbox, and `MOVE` moves a task between list/Inbox collections.
  Clients may choose the resource path (`<anything>.ics`), not just a UUID.
  PUT creates or updates by `UID`; duplicate UID within the same collection and
  href/UID mismatch return `409` with the existing href. UID/href uniqueness is
  per collection, so the same UID may exist in two lists.
  `If-Match`/`If-None-Match: *` are enforced with representation ETags. DELETE
  is a soft delete; a later GET is `404`. Shared lists appear to members with
  list-scoped read/write access.
- `POST /api/import/ics` accepts raw `text/calendar` or JSON `{ ics, listId? }`
  and imports VTODO/VEVENT objects into an accessible list or Inbox. Foreign
  UIDs are adopted, `SEQUENCE` controls update/idempotency/conflict, per-object
  failures are reported, and the file is capped at 1 MiB. See
  [`docs/CALDAV.md`](CALDAV.md).
- PROPFIND returns resource `getetag`, `getcontenttype`, and `resourcetype`;
  `calendar-query` (VCALENDAR/VTODO), `calendar-multiget`, and
  `sync-collection`/sync-token are supported per collection, and `getctag` is
  dynamic. Unsupported filters return an explicit CalDAV precondition.
  `RECURRENCE-ID` resources and `EXDATE`-derived cancellations are exposed;
  task attachments are emitted as `ATTACH` and downloadable at
  `/caldav/attachments/:id` with the CalDAV credential. See
  [`docs/CALDAV.md`](CALDAV.md) for the exact support matrix and remaining
  gaps (`RANGE`, open-override reminder timing, managed attachment upload,
  live clients). CalDAV Basic auth requires the literal username `owner` even
  for a member token; identity comes from the token, not the username.

### Delivery, briefs, and backups

- `POST /api/ntfy/test`; ntfy lives in `settings.ntfy`
  `{ enabled, url, topic, priority }`; token from `NTFY_TOKEN`.
- Morning/weekly briefs live in `settings.digest`.
- `GET /api/backup/export` and `/api/backup/runs` return `.json` or
  `.json.age` depending on `BACKUP_AGE_RECIPIENT`; restore decrypts when
  `BACKUP_AGE_IDENTITY` is configured. Export/download/run require fresh
  step-up. `POST /api/backup/run` writes one backup now and
  `GET /api/backup/download/:id` downloads a retained run.
- `POST /api/backup/import` (step-up + `confirm: "RESTORE"`) is the only
  mutation allowed during maintenance. A successful restore revokes all
  sessions and invalidates capture/CalDAV/MCP credentials, proposals,
  `operations`, pending deliveries/leases, and live SSE cursors; clients must
  re-bootstrap. The response includes `maintenance.restarted`
  (`scheduler`, `assistant`, `mcp` where those consumers were running).
