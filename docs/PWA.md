# PWA, push, and offline

Morrow is an installable React PWA built with `vite-plugin-pwa` in
`injectManifest` mode. The service worker precaches the hashed app shell, sends
`/api/*` and SSE to the network only, and never calls `skipWaiting` on install.
Push is at-least-once and deduped client-side; reminders expose **Complete**
and **Snooze 10m** actions, and the app badge follows today's open work. The
offline outbox accepts create, edits, complete, snooze, skip, and delete.
HTTPS is required except on `localhost`. Tailscale Serve's `*.ts.net`
certificate is publicly trusted, so it is a valid secure origin for PWA
install and iOS Web Push (see RUNBOOK, "Tailscale Serve").

## Install flows

Installability requires a secure origin (HTTPS, or `http://localhost`), a
served manifest, and an active service worker. The manifest uses
`launch_handler: {client_mode: "focus-existing"}` so shortcuts, share targets,
and notification clicks reuse an open window instead of spawning duplicates.
The service worker is registered
only in a production build (`import.meta.env.PROD`), from `main.tsx`, with
`scope: "/"` and `updateViaCache: "none"`.

- **Desktop (Chrome/Edge):** use the install icon in the address bar or
  ⋮/⋯ → “Install Morrow”. The app captures `beforeinstallprompt` app-wide;
  Settings → Install / `/install` shows an **Install** button when the browser
  offered the prompt. `appinstalled` clears the deferred prompt. Standalone
  display mode is detected via `matchMedia("(display-mode: standalone)")`.
- **Android (Chrome):** ⋮ → “Add to Home screen” / “Install app”. The same
  deferred prompt path applies; the installed app opens without browser chrome
  and can receive Web Push.
- **iOS/iPadOS 16.4+:** Safari → Share → **Add to Home Screen**, then launch
  Morrow **from the Home Screen icon**. Web Push is available only to the
  installed Home Screen app on 16.4+; a Safari tab cannot subscribe, and older
  iOS has no Web Push. Use a trusted certificate (public CA or an installed
  private CA) — iOS will not trust an untrusted origin for push. A phone cannot
  use `localhost`, so a LAN HTTP address cannot install/push on iOS.
- Private/incognito windows and browsers without service-worker/Push support
  show the unsupported state; the reminder app still works in a normal tab.

## Permission must come from a gesture

`Notification.requestPermission()` is called only from the user’s click on
**Enable notifications** (Settings → Devices & notifications). If it returns
`granted`, the same gesture calls `PushManager.subscribe({userVisibleOnly:true,
applicationServerKey})` and upserts the subscription. Nothing prompts on page
load, on launch, or from a background timer. iOS enforces the gesture rule
strictly.

- A granted permission is never re-prompted; a denied permission is never
  re-prompted either. Launch-time repair only runs when permission is already
  `granted`.
- If VAPID keys are not configured, `GET /api/push/vapid-public-key` and
  `POST /api/push/test` return `503 push_not_configured`; subscribe cannot
  complete.
- Subscription upsert is idempotent by SHA-256 endpoint hash, so repeated
  subscribes/launch repairs do not create duplicate device rows.
- Server-side push payloads are under 2 KiB; reminder TTL is 900 s, digest TTL
  86,400 s, test TTL 0 s. `deliveryId` dedupes a replayed delivery; `tag`
  (server `Topic`, ≤32 chars) coalesces bursts. iOS may ignore `tag`, so the
  server also limits bursts.

## Notification actions and badge

Reminder notifications expose **Complete** and **Snooze 10m** when the payload
carries a task revision. The service worker sends the action to the existing
complete/snooze APIs with `If-Match` and `Idempotency-Key`; a stale revision
falls back to opening the task instead of pretending it succeeded. The app
badge is set from today/overdue open tasks on the page and decremented after a
notification action; an empty count calls `clearAppBadge()`.

Action buttons are platform-dependent. Chromium-based browsers show them;
**Safari on iOS does not implement `Notification.actions`**, so iOS users get
the title, body, tap-to-open, and the app badge, but no Complete/Snooze buttons
in the notification shade. The tap still opens the task. Do not promise
actionable Web Push notifications on iOS.

## Multiple origins

Each browser origin (`https://host:port`) is a separate app installation:
separate session cookie (`__Host-` is host-only), separate service worker, and
separate push subscription. Serving Morrow at more than one HTTPS origin is
supported for access, but:

- `APP_URL` remains the single canonical origin used for absolute links
  (digests, ntfy, external integrations). Pick the origin that is always
  reachable.
- Installing the PWA at two HTTPS origins produces two push subscriptions and
  therefore duplicate notifications. Install once, on the canonical origin.
- There is no shared login across origins. A single sign-on setup would need a
  different cookie strategy or an auth proxy.
- Web Push click URLs are relative, so a notification opens the origin whose
  service worker received it; CalDAV clients use the host you configure.

## Test ping

Settings → Devices & notifications → **Send test ping** calls
`POST /api/push/test` (authenticated, same-origin). It is rate-limited to
6/minute and returns counts `{sent, failed, disabled}`:

- `503 push_not_configured` when VAPID is missing;
- `409 no_subscriptions` when this account has no registered device;
- `200` after attempting every registered device; failures are recorded in the
  delivery ledger and dead-lettered/disabled per the push response policy.

Settings → Devices & notifications → **Send test ping** is live; call it from
the authenticated app origin. A test notification uses TTL 0, so it is not
queued for a later wake-up.

## Launch resync (especially iOS)

iOS never fires `pushsubscriptionchange`, and subscriptions can disappear after
an OS update, backup restore, or browser data clear. The page therefore repairs
on every launch:

1. After the first refresh, ~1.5 s after launch, if
   `Notification.permission === "granted"`, get the active service-worker
   registration.
2. If `pushManager.getSubscription()` is missing, re-subscribe with the current
   VAPID public key and upsert the endpoint. If the server lost its row, the
   same upsert restores it.
3. Visibility changes refresh push state; the service worker can also post
   `MORROW_PUSH_RESYNC`, which triggers a refresh and resync. The SW’s
   `pushsubscriptionchange` handler is best-effort where supported, but it is
   not the iOS recovery path.
4. If a service worker update is installing and no active worker exists yet,
   the page waits up to 3 s for `navigator.serviceWorker.ready` before giving
   up. There is no subscription without an active worker.

A VAPID key rotation is not repaired by launch resync: the existing browser
`PushSubscription` still belongs to the old applicationServerKey. Remove the
device subscription (or unsubscribe in browser settings) and enable
notifications again after rotating keys.

## Denied path

If `Notification.permission === "denied"`, subscribe returns `null`, no prompt
is shown, and the UI reports **Blocked in browser**. The only recovery is the
browser/OS site settings:

- Desktop/Android Chrome: site settings → Notifications → Allow, then reload.
- iOS: Settings → Notifications → Morrow (the Home Screen app), or remove and
  re-add the Home Screen app if the entry is missing.

Reminders remain visible in-app; no push is sent to a denied device. The
server row may remain until a send returns 404/410/401/403 or the user removes
the device; unsubscribe drops the local subscription first, then the server
row. Denial is never bypassed by re-prompting.

## Service-worker update prompt

`registerType` is `"prompt"`, and registration is manual so the app controls
activation. A new worker installs and waits; it never calls `skipWaiting` on
install and never reloads the page by itself.

- On load, an existing `registration.waiting` worker triggers
  `morrow:sw-update`; otherwise `updatefound` + `installed` does when a
  controller already exists.
- The app shows a persistent toast: “A new version of Morrow is ready.” with a
  **Reload** action.
- Reload calls `applyServiceWorkerUpdate()`, which posts `SKIP_WAITING` to the
  waiting worker and reloads on `controllerchange`.
- Visibility changes call `registration.update()` at most once per 60 s;
  offline failures are expected and retried on the next visibility change.
- There is no `controllerchange` reload unless the user chose Reload, so an
  update cannot interrupt an in-progress capture or outbox replay.

## Offline scope

Queued mutations: **create**, **update** (ordinary task fields), **complete**,
**snooze**, **skip**, and **delete**. Settings, proposals, assistant runs, list
moves, and recurrence changes still require a connection. The UI marks queued
tasks as pending sync instead of pretending they reached the server.

- Queue: IndexedDB `outbox`, FIFO by `createdAt`, one record per operation with
  `opId` (uuidv7), `kind`, `entityId`, payload, attempts, last error, conflict
  flag. Replay uses the stable task id for a create’s `Idempotency-Key` and the
  queued `opId` for update/complete/snooze/skip/delete, so a retry after a
  dropped response does not duplicate a mutation.
- Triggers: replay **before the first bootstrap** on launch (so a fresh server
  snapshot cannot overwrite an unacked local change), on `online`, on
  `visibilitychange` (phone unlock), and on the explicit Sync now / retry
  events. `navigator.locks.request("morrow-outbox")` serializes tabs where Web
  Locks exists; older Safari falls back to one in-tab replay guard.
- Failure policy: 409/412/428 stop the queue at that record, mark it conflicted,
  and show the Outbox panel/conflict UI. Nothing is silently discarded or
  last-write-wins. The server snapshot may refresh while the queued item stays
  visible.
- Resolution: “keep mine” retries update/complete/snooze/skip/delete by GETting
  the current task revision (and occurrence key where applicable), rebasing the
  queued payload, clearing the conflict, then replaying FIFO; create retries
  after clearing. “Discard” removes the queued record explicitly. A stopped
  queue is visible via the outbox count and last-synced timestamp.
- Storage: the app calls `navigator.storage.persist()` on launch and keeps the
  last authenticated bootstrap for up to 7 days. The request is best-effort;
  a denied result does not block the app.
- Offline reads: the app shell and the last bootstrap/task cache are available
  as a read-only snapshot. `/api/*`, `/events`, `/healthz`, and `/readyz` are
  `NetworkOnly` in the service worker; authenticated API responses and 401s are
  never cached. The assistant, proposals, and settings are online-only.
- Sign-out clears local caches and the outbox (per the Settings security note),
  so do not sign out with unsynced work unless you intend to discard it.

Push and outbox are intentionally at-least-once: a notification can be
delivered twice (deduped by `deliveryId` where possible), and a queued mutation
can be retried after a dropped response (deduped by `Idempotency-Key`). Neither
is exactly-once.

## v0.3 capture surfaces

- The manifest declares a `share_target` (`/today`, GET, `title`/`text`/`url`).
  Android/desktop share sheets prefill the capture sheet; the URL is stripped
  from history after it opens.
- A capture token can be used from Shortcuts/Siri or any HTTP client:
  `POST /api/capture/quick` with `Authorization: Bearer <token>` and
  `{ "text": "call Sam tomorrow at 9 #p2 @Work" }`. Tokens are shown once and
  stored only as SHA-256.
- Voice capture is the OS dictation keyboard plus either the share target or
  the Shortcuts token endpoint; there is no separate speech-to-text service.
