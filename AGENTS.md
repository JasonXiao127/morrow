# AGENTS.md

Guidance for coding agents and orchestrators working on Morrow. Read this with
`README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and
`docs/ROADMAP.md`. Deep operator details live in `docs/RUNBOOK.md`; this file is
the short map, the commands, and the invariants not to break.

Morrow is a self-hosted reminders PWA (v0.3.0). The AI assistant is optional,
beta, and owner-only. Core reminders, proposals, undo, offline use, push,
CalDAV, capture, and backup/restore must work with AI off.

## Architecture map

- `apps/server` — Node 22 + Fastify + better-sqlite3 app on `:3000`. Owns REST +
  SSE + static PWA, auth/CSRF/step-up, tasks/lists/tags/subtasks/attachments,
  scheduler and delivery ledger, Web Push + ntfy, JSON backup/restore, CalDAV +
  ICS, capture/email, and the internal MCP server on `:3001`.
- `apps/web` — React 19 + Vite PWA. Today/Upcoming/Inbox/Calendar, lists,
  TaskDetail, assistant panel, Settings, offline IndexedDB outbox, service
  worker, SSE, and the delivery ledger. It talks only to same-origin `/api`.
- `packages/shared` — time, recurrence, and reminder derivation (`rrule` +
  Temporal DST handling). Single source of truth for scheduling math.
- `packages/db` — Drizzle schema, ordered migrations, DB open/upgrade and
  pre-migration snapshots.
- `packages/agent` — OpenCode shim: client, session mapping, MCP tools, prompt,
  policy, proposals, quotas, capture fallback, plan-my-day.
- `config/` — committed OpenCode configs (`opencode.jsonc` production,
  `opencode.harness.jsonc` local harness); no secrets.
- `deploy/` — env bootstrap, healthcheck, backup cron, agent harness scripts.
- `compose.yaml` + `compose.*.yaml` — bundled Caddy, Tailscale Serve, external
  proxy, loopback, and dev overlays.
- `docs/` — architecture, API, MCP, agent, PWA, CalDAV, security, runbook,
  roadmap. `apps/desktop` is a legacy stub and is not built or shipped.

## Commands

Run from the repository root. Node 22 and pnpm 9.12.3 match CI.

```sh
pnpm install
pnpm typecheck      # all workspaces
pnpm test           # Vitest unit/integration, no network or paid models
pnpm build          # all workspaces (server, web PWA, shared, db, agent)
pnpm e2e            # Docker + Node API + Playwright; not part of CI
./e2e.sh
docker compose config
docker compose -f compose.yaml -f compose.tailscale.yaml config
docker compose -f compose.yaml -f compose.external.yaml config
```

Local setup: `cp .env.example .env && ./deploy/init-env.sh`, then
`docker compose up -d --build`. Do not use sudo or touch a live deployment as a
side effect of code changes. The local AI harness is documented in
`docs/AGENT.md` and `docs/RUNBOOK.md`.

## Test expectations

- CI runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, and
  `pnpm test` on Node 22 with pnpm 9.12.3. Build first: workspace packages
  resolve each other through `dist/*` declarations on a clean runner. Keep all
  four green.
- The current suite is 629 tests: server 395, web 111, shared 56, db 39, agent
  28. Counts may grow; do not weaken or delete tests to pass.
- Add focused tests for behavior changes. Server integration tests use the
  in-memory/temp-DB helpers in `apps/server/test/helpers.ts`; policy and undo
  invariants have dedicated tests.
- A confirmed P0/P1 browser-QA finding is an open bug. Convert it into a failing
  automated test (or a tracked issue with an owner) before calling the QA pass
  complete; a QA report alone is not a release gate. Run `./e2e.sh` before
  publishing a snapshot. The assistant ready-path browser test skips unless a
  ready OpenCode sidecar is configured.
- `pnpm e2e`, the OpenCode contract suite, and live model checks are manual and
  need extra services. Never call a paid model provider in automated tests.
- Do not commit generated `dist/`, `data/`, `.env`, backups, or test artifacts.

## Key invariants

- **AI-off is first-class.** Never make OpenCode, MCP, or a model required for
  reminders, recurrence, scheduler, push, backup/restore, search, or the PWA.
  Blank `OPENCODE_URL` + `MCP_ENABLED=false` must remain a supported deployment.
- **No autonomous delete.** There is no delete tool. Deletes and destructive
  changes are proposals that a user must approve; there is no silent delete
  path for the assistant.
- **Proposals are required for bulk or structural changes.** Any batch, delete,
  recurrence change, list move, or more-than-one-item change goes through
  `reminders_propose` / `POST /api/proposals/:id/apply`.
- **Single-item writes have undo.** Create/update/complete/snooze/skip are
  audited and undoable. Preserve actor, session, before/after, batch ID, and
  summary in activity.
- **The assistant is owner-only and workspace-global.** Members do not get
  providers, global settings, MCP controls, backups, or the assistant. Do not
  leak one account's assistant or activity into another.
- **`APP_URL` is the canonical origin** used for absolute links and default
  VAPID subject. Keep the browser origin, `APP_URL`, and `SITE_ADDRESS` (Caddy)
  consistent. Same-origin relative PWA/CalDAV/push URLs must keep working.
- **`TRUST_PROXY` must be an exact proxy CIDR, never `true`/`*`.** When the app
  runs in Docker, that is the `edge` network subnet even for a host-level
  Tailscale Serve or external proxy. Main deployment front doors: bundled
  Caddy, Tailscale Serve, an external TLS proxy, and Caddy + loopback.
- **Never commit `.env`, `data/`, backups, secrets, provider keys, or tokens.**
  `.env.example` is the only env template. Keep logs redacted.
- **Migrations are forward-only.** Add a new ordered migration; never edit an
  applied one. Do not run an older app against a newer schema.
- Preserve the existing API contracts: ETag/`If-Match`, idempotency keys,
  SSE `Last-Event-ID` replay, and the offline outbox conflict behavior.
- Keep image/build versions unchanged unless the task explicitly asks.

## Where to add features

- Domain routes and validation: `apps/server/src/routes.ts`, `tasks.ts`,
  `lists.ts`, `tags.ts`, `subtasks.ts`, `attachments.ts`. Access checks belong
  in `access.ts` / `authz.ts`.
- Schema and migrations: `packages/db/src/schema.ts` plus a new file in
  `packages/db/migrations/`.
- Time/recurrence/reminder math: `packages/shared/src/`.
- Scheduler, delivery, backup, CalDAV, capture: the matching module in
  `apps/server/src/`; update `docs/API.md` and tests.
- PWA pages and UI: `apps/web/src/pages/`, shared client code in
  `apps/web/src/lib/`. Keep it list-first, not chat-home.
- Assistant tools/policy/prompt: `packages/agent/src/tools.ts`, `policy.ts`,
  `proposals.ts`, `quotas.ts`, and `packages/agent/prompts/reminders.md`. MCP
  surface is `apps/server/src/mcp.ts`. Keep the 11-tool surface and its tests
  in sync; no delete/shell/file/web tools.
- Provider/settings UI: `apps/server/src/providers.ts`,
  `routesProviders.ts`, and the Settings page.
- Operator procedures and limits: `docs/RUNBOOK.md`, `docs/SECURITY.md`,
  `docs/CALDAV.md`, `docs/AGENT.md`, `README.md`.

## Known limitations

- The assistant is beta, owner-only, and single workspace-level configuration;
  there are no per-user AI sessions, providers, or quotas.
- Manual release gates are not all proven on this snapshot: real-device Web
  Push at scale, an age-encrypted restore drill, and physical-client CalDAV
  interop (`docs/CALDAV-INTEROP.md` is not run against real clients).
- No full E2EE, native mobile/Electron app, IMAP polling, attachments in JSON
  backups, CRDT offline merge, or CalDAV uploads.
- Offline outbox stops on conflicts rather than last-write-wins.
- Images and containers should be pinned by digest before any production claim;
  the repository is an evaluation snapshot, not a production-ready release.

See `docs/ROADMAP.md` for non-binding candidate work.
