# CalDAV VTODO support

Morrow exposes one CalDAV VTODO collection per list at
`/caldav/calendars/<list-id>/`, plus a virtual `/caldav/calendars/inbox/`
collection. The pre-existing `/api/calendar.ics` VEVENT feed stays separate and
read-only. `/caldav/calendars/morrow/` remains reachable as a legacy
all-tasks alias for clients subscribed before per-list collections, but it is
not advertised in discovery. This document records what the implementation
actually supports so client behaviour is predictable.

## Authentication

- Basic auth with username `owner` (or an empty username) and a token created
  with `kind: "caldav"`.
- `CALDAV_TOKEN` remains a deprecated headless fallback for the workspace
  owner only.
- Capture/email tokens are rejected on CalDAV routes.

## Data model

| Column | Purpose |
| --- | --- |
| `tasks.ical_uid` | Stable client UID. Null falls back to `<task id>@morrow`. |
| `tasks.caldav_href` | Client-chosen relative resource path. Null falls back to `<task id>.ics`. |

Both identities are unique **per collection**, not globally: the list id for
listed tasks, or the user id for unlisted/inbox tasks. Soft-deleting a task
releases its UID/href for reuse. The migration 0007 backfill is deterministic
(`<id>@morrow`, `<id>.ics`); migration 0010 swaps to per-collection indexes and
deterministically repairs any pre-existing shared-list duplicates. The same
UID may therefore exist in two different lists of one account without a
conflict. The legacy all-tasks `morrow` alias still has a single flat href
namespace across the user's lists. It is read-only: `PUT`, `DELETE`, `MOVE`
and `PROPPATCH` return `403 legacy_collection_read_only`, while
`GET`/`PROPFIND`/`REPORT` remain available for older subscribers. A duplicate
href read through the alias may resolve to any matching row, so use per-list
collections for unambiguous addresses.

## Supported VTODO surface

### Serializer (`GET`, `calendar-multiget`, `calendar-query`)

- Exactly one `VTODO` inside `VCALENDAR`; no `METHOD` on a calendar object
  resource.
- `UID`, `DTSTAMP`, `CREATED`, `LAST-MODIFIED`, `SUMMARY`, `DESCRIPTION`.
- `DUE;VALUE=DATE:YYYYMMDD` for all-day tasks and `DUE:<UTC>` for timed tasks.
  No synthetic `DTEND`.
- `DTSTART` only when a real start/recurrence anchor exists. A simple due-only
  task omits it.
- `STATUS`: `NEEDS-ACTION` (open), `COMPLETED` + `COMPLETED:<UTC>` (done),
  `CANCELLED`.
- `PRIORITY` mapping (Morrow 0–4 → iCalendar 0–9):
  `0→0`, `1→9`, `2→5`, `3→3`, `4→1`.
- `CATEGORIES` from the user's tags, sorted and escaped.
- `SEQUENCE` from the task `rev`; a higher client-supplied value is honoured
  and the sequence never decreases.
- `RRULE` is emitted when present (the base rule, `COUNT`, or date `UNTIL`).
- `VALARM` with `ACTION:DISPLAY` and a relative `TRIGGER` from
  `remind_offset_minutes`. If only an absolute reminder instant exists, an
  absolute `TRIGGER;VALUE=DATE-TIME:<UTC>` is emitted.
- Timed values with a real IANA timezone are emitted as `TZID=<zone>` plus a
  matching `VTIMEZONE` block; UTC tasks stay byte-compatible as `Z`. The parser
  accepts UTC, floating values (interpreted as UTC), and IANA `TZID` wall
  times (resolved to the correct UTC instant).

### Parser (`PUT`)

- `VCALENDAR` + exactly one `VTODO`; `VEVENT` is rejected with
  `403` and `<cal:supported-calendar-component/>`.
- `UID`, `SUMMARY`, `DESCRIPTION`, `DUE`, `DTSTART`, `STATUS`, `COMPLETED`,
  `PRIORITY`, `CATEGORIES`, `SEQUENCE`, `RRULE`, and `VALARM`.
  `STATUS:IN-PROCESS` and other non-terminal values map to Morrow `open`.
- Relative (`-PT30M`, `P1D`, …) and absolute (`VALUE=DATE-TIME`) alarm triggers.
- `DUE` + `DURATION` together is rejected (`400`); `DTSTART` + `DURATION`
  without `DUE` computes the deadline from the start.
- An `RRULE` that the recurrence engine cannot parse is rejected (`400`).
- Missing `UID` on create is rejected (`400`).
- Duplicate UID in the same user's collection returns `409` with the existing
  href in `Location` and `<cal:no-uid-conflict>`.
- A client UID is preserved on every update; Morrow never replaces it with
  `<id>@morrow`.
- `VTIMEZONE` blocks are skipped, so their `DTSTART` cannot overwrite the
  task's `DTSTART`.
- Folded lines, UTF-8 text, escaped commas/semicolons/newlines, and multiple
  `CATEGORIES` lines are handled.
- `CATEGORIES` replace only the authenticated user's tag links for that task
  (up to 20), preserving a co-owner's labels on a shared list.

### Hrefs and writes

- Client-chosen relative paths are accepted (not only UUIDs), including nested
  safe paths. Traversal, control characters, and over-long paths are rejected.
- Legacy `<uuid>.ics` PUTs still create that UUID task id.
- `PUT` creates by UID (`201`) or updates the href (`204`).
  - href exists but UID differs → `409`.
  - UID exists under another href → `409` with the existing href.
- `DELETE` is a soft delete (`204`); a later `GET` is `404`.
- A top-level `GET` returns only that resource. Collection `GET` is not a
  bulk download; use the feeds or REPORT.

### ETags and conditional writes

- ETag is a strong SHA-1 of the exact VTODO representation (including tags and
  alarms), so tag-only or alarm changes invalidate it even when `rev` does not
  move.
- `If-Match` is enforced on PUT/DELETE and on MOVE when supplied: wildcard or
  opaque tag matching, stale/missing resource → `412` with no mutation.
- `If-None-Match: *` is enforced on create: an existing resource → `412`.
- PUT/GET/PROPFIND/REPORT return a fresh `ETag`.
- GET with a matching `If-None-Match` returns `304`.
- CalDAV uses its own opaque ETag parser; the REST `"rev-N"` parser is not
  reused. Collection-level `MKCALENDAR`, `PROPPATCH`, and collection `DELETE`
  do not expose a resource ETag, so clients should not send `If-Match` on
  those operations.

### Discovery and reports

- `GET` and `PROPFIND` on `/.well-known/caldav` redirect (`301`) to
  `/caldav/`, the RFC 6764 discovery path.
- `supported-calendar-component-set` advertises only `VTODO`.
- `supported-report-set` advertises `calendar-query`, `calendar-multiget`, and
  `sync-collection`.
- Resource PROPFIND returns `getetag`, `getcontenttype`, and `resourcetype`.
- `calendar-multiget` returns exactly the requested hrefs and a
  `HTTP/1.1 404 Not Found` response for missing resources.
- `calendar-query` supports the `VCALENDAR` → `VTODO` component filter.
  `VEVENT` or other unsupported filters return `403` with
  `<cal:supported-calendar-component/>` or `<cal:supported-filter/>`.
- `<cs:getctag>` is derived from the CalDAV change journal
  (`ctag-<epoch>-<seq>`), so every journaled task/tag change moves it. It is
  no longer the constant `"morrow"`.

### Feeds

- `GET /api/calendar.ics?token=…` keeps the existing VEVENT feed shape
  (`METHOD:PUBLISH`, synthetic `DTEND`, no VTODO).
- `GET /api/tasks.ics?token=…` is a separate multi-task VTODO feed for task
  subscribers.

## Client interop notes

The automated suite and `scripts/caldav-smoke.mjs` prove the server surface.
They do not prove a physical client: use the manual, evidence-recording
[`CALDAV-INTEROP.md`](CALDAV-INTEROP.md) runbook before claiming compatibility.

- **Thunderbird Tasks** is expected to work with the VTODO object shape and
  relative alarms. Live-client testing is still pending; the automated suite
  covers the object shape, ETags, and reports. It may send `TZID=` for
  local-time values; known IANA zones are resolved to UTC on import, and
  unknown zones are rejected with `400` rather than guessed.
- **DAVx5 / Tasks.org** is expected to discover the collection and round-trip
  `SUMMARY`, `DESCRIPTION`, `DUE`, `STATUS`, `PRIORITY`, `CATEGORIES`, and
  alarms. This has not yet been exercised against a physical device, so treat
  it as the next release-gate check rather than a verified claim. Fields
  outside the list above are ignored on import (for example
  `PERCENT-COMPLETE`, `RELATED-TO`, custom `X-` properties).
- Floating date-times are accepted and interpreted as UTC. `TZID=UTC` is
  accepted; any known IANA `TZID` is resolved using its zone rules. Unknown
  zones are rejected with a clear `400`.
- `sync-collection` is supported per collection with `sync-level` 1 (and
  `infinite`). Send an empty `<d:sync-token>` for the initial full sync; later
  requests return only resources changed since the token, plus `404` tombstones
  for deleted resources. An expired or unknown token returns `403
  valid-sync-token`, so the client should full-sync. A token is scoped to its
  collection; using it on another collection returns `403`. A live restore
  rotates the token epoch, invalidating every pre-restore token. `getctag` is
  derived from the same change journal per collection. Task, tag-link, and
  tag-name changes are journaled by SQLite triggers, so
  scheduler/undo/import writes are covered too.
- Each non-inbox Morrow list appears as its own collection with the list name
  and colour. The Inbox is a virtual collection for unlisted/inbox tasks. The
  legacy `morrow` collection is not advertised; it remains as an all-tasks
  compatibility alias.
- Collection management is supported: `MKCALENDAR` creates a list (the
  requested path segment becomes the list id), `PROPPATCH` updates
  `displayname`/`calendar-color`, and collection `DELETE` soft-deletes the list
  and moves its tasks to Inbox. Only the list owner may rename or delete it.
- `MOVE` moves a base series between list and Inbox collections, updates its
  href, and journals the old-list tombstone plus the new-list update for the
  base and each live recurrence exception. The legacy all-tasks `morrow` alias
  cannot be a MOVE source or destination. An existing destination resource
  returns `412`; a destination UID or exception-href conflict returns `409`.
  Only the task creator may move a shared-list task; moving a single
  `RECURRENCE-ID` resource is rejected because its collection follows the
  base series.
- Shared lists appear to members who have a `list_members` row. Members can
  read and write tasks in the shared collection according to list access; an
  owner-only list returns `404` to a member. Changes made by one member in a
  shared list are visible to the other members through the same collection and
  sync token.
- Per-occurrence overrides are represented as separate resources with the same
  UID and a `RECURRENCE-ID`. `EXDATE` becomes a cancelled exception resource;
  the base resource emits `EXDATE` for those cancellations, and removing the
  line in a full-resource PUT soft-deletes the synthetic exception and reopens
  the occurrence. `RANGE=THISANDFUTURE` is rejected. Completed/cancelled
  exceptions suppress the scheduler reminder for that occurrence. An open
  override still uses the base reminder timing: moving only an occurrence's
  due time does not move its reminder. This is a documented experimental
  limitation of the v0.3 recurrence MVP, not a promised behavior.
- Attachments are exposed read-only as `ATTACH;FMTTYPE=…;FILENAME=…:
  /caldav/attachments/<id>`; the download route accepts the same CalDAV
  credential and re-checks task access. Uploads remain in the REST attachment
  API, and RFC 8607 managed attachments are deferred. Attachment bytes stay
  outside JSON backups.
- Backup schema 3 includes recurrence-exception rows; attachment metadata and
  bytes remain excluded from JSON backups.

### ICS file import

`POST /api/import/ics` accepts a raw `text/calendar` body (optional
`?listId=…`) or JSON `{ ics, listId? }`. The target must be an accessible list
or the Inbox. It imports VTODO objects and accepts VEVENT objects by mapping
their start/end to a task due date; it never emits VEVENT for a task.

- Foreign UIDs are adopted into `ical_uid`; a missing UID gets a native one.
- `SEQUENCE` orders versions: a higher sequence updates, an equal sequence with
  identical normalized content is idempotent, and an equal sequence with
  different content is reported as a conflict instead of creating a duplicate.
- Per-object failures are reported and the valid objects still import.
- The file is capped at 1 MiB and 1000 components; lines and descriptions are
  bounded. `ATTACH` is ignored (no server-side fetch or SSRF) and HTML from
  `X-ALT-DESC` is stripped before use.
- Components carrying `RECURRENCE-ID` or `EXDATE` fail individually with
  `recurrence_unsupported`; the valid objects still import. This avoids
  silently collapsing a series and its exceptions into one base task. Use a
  CalDAV client for recurrence overrides/exclusions.

## Remaining phases (explicitly out of scope)

- `RANGE=THISANDFUTURE` recurrence changes.
- Per-occurrence reminder timing for open overrides; the base time remains the
  reminder anchor.
- Uploading/managed attachments over CalDAV (RFC 8607) and attachment bytes in
  JSON backups.
- A real-client interoperability matrix (Thunderbird/DAVx5/Tasks.org); the
  automated suite covers the protocol surface but not physical devices. Run
  the manual checklist in [`CALDAV-INTEROP.md`](CALDAV-INTEROP.md); its rows
  are deliberately marked NOT RUN until a real client pass is recorded.

## Tests

- `apps/server/test/caldav-vtodo.test.ts` — golden serializer fixtures,
  component-aware parser, TZID/VTIMEZONE, folded/unicode, ETag parsing.
- `apps/server/test/caldav.test.ts` — href/UID round-trips, conditional
  writes, per-list collections, collection create/rename/delete, shared-list
  access, task MOVE, PROPFIND, multiget/query, sync-collection
  tokens/tombstones, dynamic ctag, TZID/VTIMEZONE, recurrence exceptions,
  attachments, and feed separation.
- `apps/server/test/ics-import.test.ts` — multi-component import, UID/SEQUENCE
  idempotency/conflicts, VEVENT mapping, partial failures, and hostile input.
- `apps/server/test/vtimezone.test.ts` — VTIMEZONE offsets/DST, TZID
  serialization, gap/fold behavior, and recurring wall-time preservation.
- `packages/db/test/schema.test.ts` — migrations, per-collection uniqueness,
  exception storage, and the deterministic 0007/0010 backfills.
- `scripts/caldav-smoke.mjs` — dependency-free HTTP pre-flight for a running
  instance (discovery, VTODO PUT/GET/conditional update, reports, sync token,
  delete). It does not replace the physical-client runbook.
