# Roadmap

This roadmap is **non-binding**. It records the current state and candidate work
for discussion; it is not a promise of dates, scope, or compatibility. The
project is at **v0.3.0**, the first public evaluation snapshot.

Status vocabulary:

- **Shipped** — implemented and covered by the automated suite.
- **Beta** — implemented but optional, limited, or not proven against every
  manual release gate.
- **Not started** — design or scope only.

## State at 0.3.0

| Area | Status | Notes |
|---|---|---|
| Core reminders, lists, recurrence, Today/Upcoming/Inbox/Calendar | Shipped | Works with AI off; timezone/DST handling in `packages/shared`. |
| Web Push + ntfy, quiet hours, briefs, delivery ledger | Shipped | Real-device push remains a manual release gate. |
| Offline create/edit/complete/snooze/skip/delete outbox | Shipped | Stops on conflict; no CRDT merge. |
| JSON backup/restore, retention, pre-restore snapshots | Shipped | Age-encrypted export exists; encrypted restore drill is not proven on this snapshot. |
| Multi-account, owner/member roles, shared lists | Shipped | Assistant, providers, global settings, and backups are owner-only. |
| Tags, subtasks, attachments, priority, search, trash | Shipped | Attachments are outside JSON backups. |
| Capture tokens, email webhook, PWA share target | Shipped | Deterministic parser with an optional model fallback. |
| CalDAV VTODO + read-only VEVENT feed, ICS import | Beta | Implementation is broad; physical-client interop is not yet proven (`docs/CALDAV-INTEROP.md`). |
| Tailscale Serve / external proxy / loopback front doors | Beta | Compose overlays exist; not every front door has been exercised on real hardware. |
| AI assistant, proposals, undo, plan-my-day | Beta | Optional and owner-only; workspace-global session/config; no autonomous delete. |

Manual gates still open: real-device push, an age-encrypted restore drill, and a
physical CalDAV client round-trip. See the README "Release gate" section and
`docs/RUNBOOK.md`.

## Candidate work, prioritized

Ordering is a suggestion for evaluation, not a commitment. Security and
correctness come before new surface area.

### P1 — Prove and harden the existing product

1. **Release-gate drills.** Run and record real-device push, an encrypted
   backup → wipe → restore drill, and CalDAV discovery/round-trip in a physical
   client. Turn the honest checklists into repeatable evidence.
2. **Per-user AI sessions and isolation.** Replace the workspace-global
   assistant configuration with per-owner/per-user sessions, retaining the
   owner-only default until isolation is proven. Keep provider keys and quotas
   separated.
3. **Cost and usage controls.** Beyond the current per-run/per-minute quotas,
   add visible token/cost accounting, per-user or per-workspace budgets, and
   clear warnings before a provider bill surprises an operator.
4. **CalDAV physical-client interop.** Exercise Apple Calendar, Thunderbird, and
   DAVx5 against the documented matrix, then fix the gaps that only real clients
   reveal.

### P2 — Reminder ergonomics

5. **More reminder tools.** Strengthen tags, subtasks, and list management as
   first-class assistant tools (still proposal-gated for bulk/structural
   changes), with matching UI and tests.
6. **Proactive planning.** Move beyond on-demand plan-my-day to opt-in
   proactive planning (suggesting a day/week, flagging overdue work) while
   keeping every write proposal-based and dismissible.
7. **Scheduling depth.** More recurrence editing affordances, smarter
   rescheduling suggestions, and calendar views beyond the current month grid.

### P3 — Clients and reach

8. **iOS actionable notifications / native client.** Safari ignores
   `Notification.actions`; a native shell or richer PWA path could offer
   complete/snooze from the notification shade. A desktop shell remains a
   legacy stub, not a release artifact.
9. **Offline and sharing depth.** Conflict-free offline merges (CRDT or an
   equivalent), month-grid drag rescheduling, and further shared-list
   collaboration.

### P4 — Deliberately out of scope unless requirements change

- Full end-to-end encryption (would move scheduling and notifications to
  clients).
- IMAP polling (email ingestion stays webhook-based).
- Attachments inside the JSON backup (keep binary volume backups).
- CalDAV uploads and advanced this-and-future range semantics.

## How to propose a change

Open an issue with the problem, the user-visible behavior, the security and
AI-off impact, and the tests you expect. Read [`AGENTS.md`](AGENTS.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md) before sending a patch. Preserve the
proposal/approval and undo invariants and keep the manual-gate language honest.
