# Web unit tests

`apps/web` uses [Vitest](https://vitest.dev/) for unit and component tests. The
default suite runs in the `node` environment: pure-logic tests need no browser
or DOM. Event-bus modules use a small `EventTarget` fake and IndexedDB is
mocked. Component tests opt in per file with `// @vitest-environment jsdom` and
use `@testing-library/react`; only the assistant panel currently needs a DOM.

## Run

```bash
pnpm --filter @morrow/web test
```

Watch mode:

```bash
pnpm --filter @morrow/web exec vitest
```

Run one file:

```bash
pnpm --filter @morrow/web exec vitest run test/schedule.test.ts
```

## Layout

| File | Covers |
| --- | --- |
| `schedule.test.ts` | Schedule payloads, all-day/timed fields, recurrence values and labels, capture/task hydration, snooze helpers, DST gaps and folds. |
| `format.test.ts` | Local date keys, task day/instant selection, grouping, sorting, display formatting, recurrence summaries. |
| `timezone.test.ts` | Detected zone, zone list fallbacks, local time formatting, DST edge behaviour. |
| `conflict.test.ts` | Conflict event bus and resolver callback handoff. |
| `outbox.test.ts` | FIFO replay, same-tab coalescing, conflict/offline stops, retry re-basing (mocked IndexedDB and API). |
| `undo.test.ts` | Undo registration, persistence cap, activity-history undo, local fallbacks, conflict reporting. |
| `task-cache.test.ts` | Paginated list updates, bootstrap/detail sync, upserts/removals, snapshot rollback. |
| `push-dedupe.test.ts` | Service-worker delivery dedupe, payload normalisation, VAPID key decoding. |
| `assistant-panel.test.tsx` | Assistant conversation bootstrap: existing/new conversation, StrictMode, failure and retry. |

`vitest.config.ts` pins `TZ=America/New_York` so the DST assertions are
deterministic on any machine.

## Browser E2E stays separate

Browser end-to-end tests live in `apps/web/e2e-browser/` (Playwright) and the
Node API suite in `apps/web/e2e/`. They are intentionally not part of
`pnpm --filter @morrow/web test`; run them from the repository root with:

```bash
./e2e.sh
```

The assistant AI-off test runs in the default suite. Its ready-path companion
skips unless `/api/assistant/status` reports a ready OpenCode sidecar.
