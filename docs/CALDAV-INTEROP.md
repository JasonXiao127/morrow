# CalDAV client interoperability runbook

**Status: not run against physical clients in this workspace.** The automated
server suite proves the protocol surface (discovery, PROPFIND, PUT/GET/DELETE,
ETags, reports, sync tokens, timezone output, recurrence exceptions, and
read-only attachments). It does not prove a particular desktop or mobile client.
Do not mark the v0.3 release gate complete until at least Thunderbird Tasks and
DAVx5 + Tasks.org pass on real devices, with evidence recorded below.

## Preconditions

1. A non-production workspace or a test account with a disposable list.
2. A CalDAV token created in **Settings → Integrations** with purpose
   **CalDAV** (not a capture token).
3. The instance reachable over HTTP(S); the client must trust the certificate.
4. For DST checks, set the account timezone to a zone with DST, for example
   `Europe/Berlin`, and use dates on both sides of a transition.
5. Record the Morrow version (`GET /healthz`), client version, OS, and date in
   the evidence table. Never paste a token into a screenshot or a log.

Use `/caldav/` as the server URL and username `owner`; the password is the
CalDAV token. Identity comes from the token, so the username is the same for
owners and members.

## Automated pre-flight

Run the dependency-free HTTP smoke test first. It creates, reads, conditionally
updates, reports on, syncs, and deletes a clearly labelled smoke task in Inbox.

```bash
MORROW_URL=http://127.0.0.1:4591 \
MORROW_CALDAV_TOKEN='<caldav token>' \
node scripts/caldav-smoke.mjs
```

A pass means the server is reachable and the CalDAV route is coherent. It does
not replace the manual checks. The script sends the token only in a Basic
authorization header and cleans up its resource on a best-effort basis.

## Manual matrix

Mark a cell **PASS**, **FAIL**, or **NOT RUN**. A release-gate pass requires
Thunderbird and DAVx5 + Tasks.org to pass every applicable row.

| Check | Thunderbird Tasks | DAVx5 + Tasks.org | jtx Board (optional) |
| --- | --- | --- | --- |
| Discover `/caldav/` and list per-list + Inbox collections | NOT RUN | NOT RUN | NOT RUN |
| Create a task with summary + all-day due date | NOT RUN | NOT RUN | NOT RUN |
| Create a task with timed due date and reminder | NOT RUN | NOT RUN | NOT RUN |
| Edit summary, notes, priority, and category | NOT RUN | NOT RUN | NOT RUN |
| Complete and uncomplete a one-off task | NOT RUN | NOT RUN | NOT RUN |
| Delete a task; it appears in Recently deleted | NOT RUN | NOT RUN | NOT RUN |
| Stale edit is refused (no silent overwrite) | NOT RUN | NOT RUN | NOT RUN |
| Daily recurring task appears at the same wall time across DST | NOT RUN | NOT RUN | NOT RUN |
| Edit one occurrence; the series has no duplicate task row | NOT RUN | NOT RUN | NOT RUN |
| Cancel one occurrence with EXDATE; the rest remain | NOT RUN | NOT RUN | NOT RUN |
| Download an attachment from a task with one upload | NOT RUN | NOT RUN | NOT RUN |
| Import a `.ics` file from the app and see it in the client | NOT RUN | NOT RUN | NOT RUN |

### Per-client steps

For each client:

1. Add a new CalDAV account with the server URL, username `owner`, and the
   CalDAV token. Confirm it discovers collections without asking for a
   collection path.
2. Create **`Interop all-day`** due on a fixed date. Confirm the app and a
   direct `GET` of the resource agree on `DUE;VALUE=DATE`.
3. Create **`Interop timed`** due at `09:30` in the account zone with a
   reminder 30 minutes before. Confirm the app shows the same wall time. Run
   `GET` and confirm a `TZID` plus a matching `VTIMEZONE` (non-UTC account).
4. Edit the title, notes, priority, and category in the client; refresh the
   app. Edit in the app; refresh the client. Record any field the client
   silently drops.
5. Complete the task in the client. Confirm the app shows it done, then
   uncomplete it and confirm both sides agree.
6. Delete the task in the client. Confirm it is absent from the app and
   `GET` returns `404`; confirm it is restorable from Recently deleted.
7. Open the same task in two clients, make a stale edit in one after the other
   has saved, and confirm the stale write is refused rather than overwriting.
8. Create **`Interop DST 09:00`** as a daily task starting before a DST
   transition. Confirm every occurrence is still 09:00 local in both the app
   and the client after the transition.
9. Edit **one** occurrence in the client. Confirm the app still has exactly one
   task for the series, the base remains at 09:00, and the override appears
   only for that date. Repeat with cancel/EXDATE.
10. If the task has an attachment uploaded in the app, open it from the client.
    Uploads over CalDAV are not supported; only read-only download is in scope.
11. Import a small `.ics` file through `POST /api/import/ics` (or the app's
    import UI if present) and confirm the imported tasks appear in the client
    after a refresh/sync.

### What to capture

- Client name and exact version, OS/device, UTC timestamp.
- The collection href used and the task UID (the token, never the full
  authorization header).
- A screenshot of the client and the app showing the same task, or the raw
  `GET` representation with `DTSTAMP`/`LAST-MODIFIED` values.
- For a failure: the HTTP status, CalDAV precondition from the response body,
  and the server log line with the request id (tokens are redacted).

## Known limits to state honestly

- `RANGE=THISANDFUTURE` recurrence changes are rejected.
- An open per-occurrence override keeps the base reminder timing in v0.3;
  moving only the occurrence's due time does not move its reminder.
- `ATTACH` is read-only and only supports Morrow-uploaded attachments.
  RFC 8607 managed attachments and CalDAV uploads are deferred.
- Unknown `TZID` values are rejected; clients should use IANA zone names.
- The legacy `/caldav/calendars/morrow/` alias is readable for old
  subscriptions but rejects writes and is not advertised.
- Floating date-times are interpreted as UTC; clients should send a `TZID` or
  `Z` for timed values.

## Release decision

Leave the plan checkbox for the interoperability matrix unchecked until the
matrix above has real passes. A single-client pass is not enough for the
release gate. If a client fails, link the failing row to an issue and state the
limitation in `docs/CALDAV.md` rather than claiming compatibility.
