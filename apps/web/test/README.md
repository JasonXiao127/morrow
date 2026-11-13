# Web unit tests

`apps/web` uses [Vitest](https://vitest.dev/) for pure-logic unit tests. The
suite runs in the `node` environment: no browser, jsdom, or happy-dom is
needed. Event-bus modules use a small `EventTarget` fake, IndexedDB is mocked,
and React hooks are not exercised here.

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

`vitest.config.ts` pins `TZ=America/New_York` so the DST assertions are
deterministic on any machine.

## Browser E2E stays separate

Browser end-to-end tests live in `apps/web/e2e/` and use Playwright against a
real server and database. They are intentionally not part of
`pnpm --filter @morrow/web test`; run them from the repository root with:

```bash
./e2e.sh
```
